import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { MultiPicker, Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Badge, Button, Card, ErrorNotice, Field, Icon, Input, PageHeader, Switch, Tabs, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtBytes } from "@/lib/format";
import { type Image, useBootImages } from "@/lib/image";
import {
  type Flavor,
  type Port,
  gib,
  portLabel,
  quotaPct,
  ruleSummary,
  useComputeAZs,
  useComputeLimits,
  useFlavors,
  useInvalidate,
  useKeypairs,
  useNetworks,
  usePorts,
  useSecurityGroups,
  useSnapshots,
  useSubnets,
  useVolumeLimits,
  useVolumes,
  useVolumeTypes,
  defaultVolumeType,
  useServerGroups,
  useServers,
} from "@/lib/os";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { type GuestFeatures, featureProblem, guestFeatures } from "@/lib/flavorPresets";
import { FeatureBadges } from "@/components/FeatureBadges";
import { useSgOptions } from "../network/networkActions";
import { MetadataEditor, useMetadataErrors } from "@/components/MetadataEditor";
import { SERVER_METADATA } from "@/lib/metadefs";
import { CreateKeypairDialog, ImportKeypairDialog } from "./KeyPairs";
import { NO_SCHEDULING, type Scheduling, SchedulingStep, schedulingBody, schedulingProblem, schedulingSummary } from "./launchScheduling";
import { tr, trx } from "@/lib/i18n";

type Step = "details" | "source" | "flavor" | "network" | "security" | "volumes" | "scheduling" | "keypair" | "config" | "review";
type SourceKind = "image" | "volume" | "volume_snapshot";

/** Reference for the user data formats (step "Configuration"). */
const CLOUD_INIT_DOCS = "https://docs.cloud-init.io/en/latest/howto/index.html";

const STEPS: { id: Step; label: string }[] = [
  { id: "details", label: tr("Details") },
  { id: "source", label: tr("Source") },
  { id: "flavor", label: tr("Flavor") },
  { id: "network", label: tr("Networks & ports") },
  { id: "security", label: tr("Security groups") },
  { id: "volumes", label: tr("Data volumes") },
  { id: "scheduling", label: tr("Scheduling") },
  { id: "keypair", label: tr("Key pair") },
  { id: "config", label: tr("Configuration") },
  { id: "review", label: tr("Review") },
];

const GiB = 1024 ** 3;

/** Smallest sensible root volume for an image: its min_disk, or its (virtual) size rounded up. */
function imageMinGb(img?: Image) {
  if (!img) return 1;
  const bytes = img.virtual_size ?? img.size ?? 0;
  return Math.max(img.min_disk ?? 0, Math.ceil(bytes / GiB), 1);
}

/**
 * One interface: a new port on a network, or an existing port. `sgs` are the interface's own
 * security groups; empty on a network interface means "use the groups of step 5".
 */
type Nic = { key: string; kind: "network"; id: string; fixedIp: string; sgs: string[] } | { key: string; kind: "port"; id: string; sgs: string[] };
/** Where a disk shows up in the guest; empty fields are left to Nova. */
type Placement = { deviceName: string; diskBus: string; deviceType: string; open?: boolean };
/** One data volume: an existing one, a new blank one, or a new one from an image (ISO…). */
type Extra = Placement &
  (
    | { key: string; kind: "existing"; id: string; dot: boolean }
    | { key: string; kind: "new"; size: number; type: string; dot: boolean }
    | { key: string; kind: "image"; imageId: string; size: number; type: string; dot: boolean }
  );
const NO_PLACEMENT: Placement = { deviceName: "", diskBus: "", deviceType: "" };

const DISK_BUSES = [
  { value: "", label: tr("Default"), description: tr("Let Nova and the image decide") },
  { value: "virtio", label: tr("virtio"), description: tr("Paravirtual, fastest (vdX)") },
  { value: "scsi", label: tr("scsi"), description: tr("virtio-scsi; needs hw_scsi_model on the image (sdX)") },
  { value: "sata", label: tr("sata"), description: tr("For guests without virtio drivers (sdX)") },
  { value: "ide", label: tr("ide"), description: tr("Legacy guests (hdX)") },
  { value: "usb", label: tr("usb") },
  { value: "fdc", label: tr("fdc"), description: tr("Floppy controller") },
];
const DEVICE_TYPES = [
  { value: "", label: tr("Default"), description: tr("disk") },
  { value: "disk", label: tr("disk") },
  { value: "cdrom", label: tr("cdrom"), description: tr("Read-only optical drive, e.g. an ISO") },
  { value: "floppy", label: tr("floppy") },
  { value: "lun", label: tr("lun"), description: tr("SCSI pass-through (needs scsi bus)") },
];
const placementBody = (p: Placement) => ({
  device_name: p.deviceName.trim() || undefined,
  disk_bus: p.diskBus || undefined,
  device_type: p.deviceType || undefined,
});
/** Columns of a data volume row (disk, source, size, type, on delete, options); stacks when the card is narrow. */
const VOL_GRID = "grid-cols-[3rem_minmax(0,1fr)] @3xl:grid-cols-[3rem_minmax(0,1fr)_7rem_11rem_auto_auto]";
const DEVICE_NAME = /^(\/dev\/)?[a-z][a-z0-9]{1,15}$/;

let seq = 0;
const nextKey = () => `k${++seq}`;

export default function Launch() {
  const session = useSession().data!;
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [params] = useSearchParams();

  // data
  const images = useBootImages();
  const volumes = useVolumes();
  const snapshots = useSnapshots();
  const types = useVolumeTypes();
  const flavors = useFlavors();
  const networks = useNetworks();
  const subnets = useSubnets();
  const ports = usePorts({ project_id: session.project?.id });
  const groups = useSecurityGroups({ project_id: session.project?.id });
  const keypairs = useKeypairs();
  const azs = useComputeAZs();
  const limits = useComputeLimits();
  const vlimits = useVolumeLimits();

  // form
  const preSource = params.get("source") as SourceKind | null;
  const [step, setStep] = useState<Step>("details");
  const [name, setName] = useState("");
  const [count, setCount] = useState(1);
  const [description, setDescription] = useState("");
  const [az, setAz] = useState("");
  const [kind, setKind] = useState<SourceKind>(preSource && ["image", "volume", "volume_snapshot"].includes(preSource) ? preSource : "image");
  const [sourceId, setSourceId] = useState(params.get("id") ?? "");
  const [bfv, setBfv] = useState(true);
  const [size, setSize] = useState<number | null>(null);
  const [volumeType, setVolumeType] = useState("");
  const [rootBus, setRootBus] = useState("");
  // "" = not chosen yet: use "__DEFAULT__" or the first type the cloud lists.
  const typeFallback = defaultVolumeType(types.data);
  const rootType = volumeType || typeFallback;
  const [deleteOnTerm, setDeleteOnTerm] = useState(kind !== "volume");
  const [flavorId, setFlavorId] = useState(params.get("flavor") ?? "");
  const [nics, setNics] = useState<Nic[] | null>(() => {
    const n = params.get("network");
    return n ? [{ key: nextKey(), kind: "network", id: n, fixedIp: "", sgs: [] }] : null;
  });
  const [sgs, setSgs] = useState<string[] | null>(null);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [key, setKey] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  const [userData, setUserData] = useState("");
  const [configDrive, setConfigDrive] = useState(false);
  const [scheduling, setScheduling] = useState<Scheduling>(() => ({ ...NO_SCHEDULING, group: params.get("group") ?? "" }));
  const [metadata, setMetadata] = useState<Record<string, string>>({});
  const metaErrors = useMetadataErrors(metadata, SERVER_METADATA);
  const serverGroups = useServerGroups();
  const allServers = useServers();
  const [sourceQ, setSourceQ] = useState("");

  const bootVolumes = (volumes.data ?? []).filter((v) => v.status === "available" && v.bootable === "true");
  const freeSnapshots = (snapshots.data ?? []).filter((s) => s.status === "available");
  const image = kind === "image" ? images.data?.find((i) => i.id === sourceId) : undefined;
  const volume = kind === "volume" ? bootVolumes.find((v) => v.id === sourceId) : undefined;
  const snap = kind === "volume_snapshot" ? freeSnapshots.find((s) => s.id === sourceId) : undefined;
  const newVolume = (kind === "image" && bfv) || kind === "volume_snapshot";
  const minSize = kind === "image" ? imageMinGb(image) : (snap?.size ?? 1);
  const rootSize = size ?? Math.max(minSize, kind === "image" ? 10 : minSize);
  const flavor = flavors.data?.find((f) => f.id === flavorId);
  // Image properties the guest gets (vTPM, memory encryption…): the image's, or the boot volume's copy.
  const imageProps: Record<string, unknown> = image ?? volume?.volume_image_metadata ?? {};
  const features = guestFeatures(flavor?.extra_specs, imageProps);

  // Networks the project can attach to (own + shared), external ones last.
  const usableNets = (networks.data ?? [])
    .filter((n) => n.status === "ACTIVE" && (n.project_id === session.project?.id || n.shared || !n["router:external"]))
    .sort((a, b) => Number(!!a["router:external"]) - Number(!!b["router:external"]) || a.name.localeCompare(b.name));
  const netName = (id: string) => networks.data?.find((n) => n.id === id)?.name ?? id;
  const cidrsOf = (id: string) => (subnets.data ?? []).filter((s) => s.network_id === id).map((s) => s.cidr);
  const defaultNics: Nic[] = usableNets
    .filter((n) => !n["router:external"])
    .slice(0, 1)
    .map((n) => ({ key: `default-${n.id}`, kind: "network", id: n.id, fixedIp: "", sgs: [] }));
  const chosenNics = nics ?? defaultNics;
  const freePorts = (ports.data ?? []).filter((p) => !p.device_id && !p.device_owner);
  const defaultSg = groups.data?.filter((g) => g.name === "default").map((g) => g.id) ?? [];
  const chosenSgs = sgs ?? defaultSg;
  const chosenKey = key ?? (keypairs.data?.length === 1 ? keypairs.data[0].name : "");
  const setNicList = (f: (l: Nic[]) => Nic[]) => setNics(f(chosenNics));

  // A pre-selected boot volume shouldn't be deleted with the instance by default.
  useEffect(() => {
    if (preSource === "volume") setDeleteOnTerm(false);
  }, [preSource]);

  // quota left
  const L = limits.data;
  const left = L && {
    instances: L.maxTotalInstances < 0 ? Infinity : L.maxTotalInstances - L.totalInstancesUsed,
    cores: L.maxTotalCores < 0 ? Infinity : L.maxTotalCores - L.totalCoresUsed,
    ram: L.maxTotalRAMSize < 0 ? Infinity : L.maxTotalRAMSize - L.totalRAMUsed,
  };
  const V = vlimits.data;
  const gbLeft = V ? (V.maxTotalVolumeGigabytes < 0 ? Infinity : V.maxTotalVolumeGigabytes - V.totalGigabytesUsed) : Infinity;
  const newGb = (newVolume ? rootSize : 0) + extras.reduce((n, e) => n + (e.kind !== "existing" ? e.size : 0), 0);
  // Interfaces that take the instance-wide groups of step 5.
  const inheriting = chosenNics.map((n, i) => ({ n, i })).filter(({ n }) => n.kind === "network" && n.sgs.length === 0);

  function flavorProblem(f: Flavor): string | null {
    const fp = featureProblem(f.extra_specs, imageProps);
    if (fp) return fp;
    if (image && f.ram < (image.min_ram ?? 0)) return tr("Image needs {min_ram} RAM", { min_ram: gib(image.min_ram) });
    if (kind === "image" && !bfv && image && f.disk > 0 && f.disk < imageMinGb(image)) return tr("Image needs a {imageMinGb} GB disk", { imageMinGb: imageMinGb(image) });
    if (kind === "image" && !bfv && f.disk === 0) return tr("No root disk; boot from a volume instead");
    if (left && f.vcpus * count > left.cores) return tr("Only {cores} vCPUs left in quota", { cores: left.cores });
    if (left && f.ram * count > left.ram) return tr("Only {ram} RAM left in quota", { ram: gib(left.ram) });
    return null;
  }

  const problems: Partial<Record<Step, string>> = {};
  if (!name.trim()) problems.details = tr("Enter a name");
  else if (left && count > left.instances) problems.details = tr("Only {instances} more instances fit in the quota", { instances: left.instances });
  if (!sourceId) problems.source = tr("Choose what to boot from");
  else if (newVolume && rootSize < minSize) problems.source = tr("The volume must be at least {minSize} GiB", { minSize });
  else if (kind === "volume" && count > 1) problems.source = tr("An existing volume can boot only one instance");
  if (!flavor) problems.flavor = tr("Choose a flavor");
  else if (flavorProblem(flavor)) problems.flavor = flavorProblem(flavor)!;
  if (chosenNics.length === 0 && usableNets.filter((n) => !n["router:external"]).length > 1) problems.network = tr("Add at least one network or port");
  else if (count > 1 && chosenNics.some((n) => n.kind === "port" || n.sgs.length > 0 || (n.kind === "network" && n.fixedIp.trim())))
    problems.network = tr("Existing ports, fixed IPs and per-interface security groups work only when launching one instance");
  if (count > 1 && extras.some((e) => e.kind === "existing")) problems.volumes = tr("Existing volumes can be attached to one instance only");
  else if (extras.some((e) => e.kind !== "existing" && e.size < 1)) problems.volumes = tr("Give every new volume a size");
  else if (extras.some((e) => e.kind === "image" && !e.imageId)) problems.volumes = tr("Choose an image for every volume made from one");
  else if (extras.some((e) => e.deviceName.trim() && !DEVICE_NAME.test(e.deviceName.trim()))) problems.volumes = tr("Device names look like /dev/vdb");
  else if (newGb * count > gbLeft) problems.volumes = tr("Only {gbLeft} GiB of volume quota left", { gbLeft });

  if (schedulingProblem(scheduling)) problems.scheduling = schedulingProblem(scheduling)!;
  if (Object.keys(metaErrors).length) problems.config = `Metadata: ${Object.entries(metaErrors)[0].join(" – ")}`;
  else if (Object.keys(metadata).length > 128) problems.config = tr("At most 128 metadata items");
  else if (Object.keys(metadata).some((k) => !k.trim())) problems.config = tr("Metadata keys can't be empty");

  const launch = useMutation({
    mutationFn: () =>
      api.post<{ server?: { id?: string } }>("/compute/launch", {
        name: name.trim(),
        count,
        description: description || undefined,
        availability_zone: az || undefined,
        source: kind,
        source_id: sourceId,
        boot_from_volume: kind === "image" ? bfv : true,
        volume_size: newVolume ? rootSize : undefined,
        volume_type: newVolume ? rootType || undefined : undefined,
        delete_on_termination: deleteOnTerm,
        root_disk_bus: rootBus || undefined,
        flavor_id: flavorId,
        nics: chosenNics.map((n) =>
          n.kind === "network"
            ? { network_id: n.id, fixed_ip: n.fixedIp.trim() || undefined, security_groups: n.sgs.length ? n.sgs : undefined }
            : { port_id: n.id, security_groups: n.sgs },
        ),
        volumes: extras.map((e) => ({
          ...placementBody(e),
          delete_on_termination: e.dot,
          ...(e.kind === "existing"
            ? { volume_id: e.id }
            : e.kind === "image"
              ? { image_id: e.imageId, size: e.size, volume_type: e.type || typeFallback || undefined }
              : { size: e.size, volume_type: e.type || typeFallback || undefined }),
        })),
        security_groups: chosenSgs,
        key_name: chosenKey || undefined,
        user_data: userData || undefined,
        config_drive: configDrive,
        metadata: Object.keys(metadata).length ? metadata : undefined,
        ...schedulingBody(scheduling),
      }),
    onSuccess: (r) => {
      toast(count > 1 ? tr("Launching {count} instances named {name}", { count, name }) : tr("Launching {name}", { name }));
      invalidate("compute", "volume", "network");
      const id = r?.server?.id;
      navigate(count === 1 && id ? `/compute/instances/${id}` : "/compute/instances");
    },
  });

  const idx = STEPS.findIndex((s) => s.id === step);
  const ready = Object.keys(problems).length === 0;
  const q = sourceQ.toLowerCase();
  const groupName = (id: string) => groups.data?.find((g) => g.id === id)?.name ?? id;

  return (
    <>
      <Link to="/compute/instances" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Instances")}
      </Link>
      <PageHeader title={tr("Launch instance")} description={tr("In project {name}, region {v}.", { name: session.project?.name, v: session.region ?? tr("default") })} />

      <div className="grid items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        {/* Steps */}
        <nav aria-label={tr("Steps")} className="flex gap-1 overflow-x-auto lg:sticky lg:top-4 lg:flex-col">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStep(s.id)}
              aria-current={step === s.id ? "step" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap transition-colors",
                step === s.id ? "bg-cable-soft font-medium text-cable" : "text-muted hover:bg-ink/5 hover:text-ink",
              )}
            >
              <span
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full border text-[11px] tabular-nums",
                  problems[s.id] ? "border-led-amber text-[#9a6412] dark:text-led-amber" : i < idx ? "border-cable bg-cable text-white" : "border-line",
                )}
              >
                {i < idx && !problems[s.id] ? <Icon name="check" className="size-3" /> : i + 1}
              </span>
              {s.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-4">
          {step === "details" && (
            <Card title={tr("Details")}>
              <div className="space-y-4">
                <Field label={tr("Instance name")} hint={count > 1 ? tr("Nova names them {v}-1 … {v}-{count}.", { v: name || tr("name"), count }) : undefined}>
                  {(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("web-01")} />}
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={tr("Count")} hint={left && Number.isFinite(left.instances) ? tr("{instances} more fit in the quota.", { instances: left.instances }) : undefined}>
                    {(id) => (
                      <Input id={id} type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
                    )}
                  </Field>
                  <Field label={tr("Availability zone")}>
                    {(id) => (
                      <Picker
                        id={id}
                        value={az}
                        onChange={setAz}
                        options={[{ value: "", label: tr("Any zone"), description: tr("Let the scheduler choose") }, ...(azs.data ?? []).map((z) => ({ value: z, label: z, icon: "map-pin" }))]}
                      />
                    )}
                  </Field>
                </div>
                <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
              </div>
            </Card>
          )}

          {step === "source" && (
            <Card title={tr("Boot source")}>
              <Tabs
                value={kind}
                onChange={(k) => {
                  setKind(k);
                  setSourceId("");
                  setSize(null);
                  setDeleteOnTerm(k !== "volume");
                }}
                className="mb-4"
                tabs={[
                  { id: "image", label: tr("Image") },
                  { id: "volume", label: tr("Volume") },
                  { id: "volume_snapshot", label: tr("Volume snapshot") },
                ]}
              />
              <SearchBox value={sourceQ} onChange={setSourceQ} placeholder={kind === "image" ? tr("Search images by name or OS") : tr("Search by name")} />
              <PickList
                value={sourceId}
                onChange={(v) => {
                  setSourceId(v);
                  setSize(null);
                }}
                loading={kind === "image" ? images.isPending : kind === "volume" ? volumes.isPending : snapshots.isPending}
                empty={kind === "image" ? tr("No active images.") : kind === "volume" ? tr("No available bootable volumes.") : tr("No available volume snapshots.")}
                items={
                  kind === "image"
                    ? (images.data ?? [])
                        .filter((i) => !q || `${i.name} ${i.os_distro ?? ""} ${i.os_version ?? ""}`.toLowerCase().includes(q))
                        .map((i) => ({
                          id: i.id,
                          title: i.name || i.id,
                          meta: [i.os_distro && `${i.os_distro} ${i.os_version ?? ""}`.trim(), i.disk_format, fmtBytes(i.size), i.visibility].filter(Boolean).join(", "),
                        }))
                    : kind === "volume"
                      ? bootVolumes
                          .filter((v) => !q || `${v.name} ${v.id}`.toLowerCase().includes(q))
                          .map((v) => ({ id: v.id, title: v.name || v.id, meta: tr("{size} GiB{v}{v2}", { size: v.size, v: v.volume_type ? `, ${v.volume_type}` : "", v2: v.volume_image_metadata?.image_name ? tr(", from {image_name}", { image_name: v.volume_image_metadata.image_name }) : "" }) }))
                      : freeSnapshots.filter((s) => !q || `${s.name} ${s.id}`.toLowerCase().includes(q)).map((s) => ({ id: s.id, title: s.name || s.id, meta: tr("{size} GiB", { size: s.size }) }))
                }
              />
              <div className="mt-5 space-y-4 border-t border-line pt-4">
                {kind === "image" && (
                  <Switch
                    checked={bfv}
                    onChange={setBfv}
                    label={tr("Create a new volume for the root disk")}
                    hint={tr("Recommended. The disk lives in Cinder, survives host failures and can be snapshotted, resized and moved. Turn off to use the hypervisor's local disk.")}
                  />
                )}
                {newVolume && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={tr("Volume size (GiB)")} hint={tr("At least {minSize} GiB for this {v}.{v2}", { minSize, v: kind === "image" ? tr("image") : tr("snapshot"), v2: Number.isFinite(gbLeft) ? tr(" {gbLeft} GiB left in quota.", { gbLeft }) : "" })}>
                      {(id) => <Input id={id} type="number" min={minSize} value={rootSize} onChange={(e) => setSize(Number(e.target.value) || 0)} />}
                    </Field>
                    <Field label={tr("Volume type")}>
                      {(id) => <VolumeTypePicker id={id} value={rootType} onChange={setVolumeType} types={types.data} />}
                    </Field>
                  </div>
                )}
                <Field label={tr("Root disk bus")} hint={tr("Optional. Leave on Default unless the guest needs a specific controller (e.g. no virtio drivers).")}>
                  {(id) => (
                    <div className="sm:max-w-xs">
                      <Picker id={id} value={rootBus} onChange={setRootBus} options={DISK_BUSES} />
                    </div>
                  )}
                </Field>
                {kind !== "image" || bfv ? (
                  <Switch
                    checked={deleteOnTerm}
                    onChange={setDeleteOnTerm}
                    label={tr("Delete the volume when the instance is deleted")}
                    hint={kind === "volume" ? tr("Off keeps your existing volume when the instance goes away.") : tr("Turn off to keep the root volume after deleting the instance.")}
                  />
                ) : null}
              </div>
            </Card>
          )}

          {step === "flavor" && (
            <FlavorStep flavors={flavors} value={flavorId} onChange={setFlavorId} problem={flavorProblem} left={left} count={count} localDisk={kind === "image" && !bfv} imageProps={imageProps} />
          )}

          {step === "network" && (
            <Card title={tr("Interfaces")} flush actions={<span className="text-xs text-muted">{tr("First one is the primary (eth0)")}</span>}>
              <ul>
                {chosenNics.map((n, i) => {
                  const port = n.kind === "port" ? ports.data?.find((p) => p.id === n.id) : undefined;
                  return (
                    <li key={n.key} className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-3 text-sm last:border-0">
                      <span className="mt-0.5 grid h-6 shrink-0 place-items-center rounded-md bg-ink/6 px-1.5 font-mono text-[11.5px]">{trx("eth{i}", { i })}</span>
                      <div className="min-w-0 flex-1 basis-60 space-y-2">
                        <p className="flex min-w-0 items-center gap-2">
                          <Icon name={n.kind === "port" ? "cable" : "network"} className="text-muted" />
                          <span className="truncate font-medium">{n.kind === "port" ? (port ? portLabel(port) : n.id) : netName(n.id)}</span>
                          <span className="truncate font-mono text-xs text-muted">
                            {n.kind === "port" ? `${port ? netName(port.network_id) : ""} · ${port?.fixed_ips.map((f) => f.ip_address).join(", ") ?? ""}` : cidrsOf(n.id).join(", ") || tr("no subnet")}
                          </span>
                          <Badge tone={n.kind === "port" ? "accent" : "neutral"}>{n.kind === "port" ? tr("existing port") : tr("new port")}</Badge>
                        </p>
                        {n.kind === "network" && (
                          <div className="flex flex-wrap items-start gap-2">
                            {count === 1 && (
                              <Input
                                aria-label={tr("Fixed IP for {netName}", { netName: netName(n.id) })}
                                value={n.fixedIp}
                                onChange={(e) => setNicList((l) => l.map((x) => (x.key === n.key && x.kind === "network" ? { ...x, fixedIp: e.target.value } : x)))}
                                placeholder={tr("Fixed IP (optional)")}
                                className="h-8 w-52 font-mono text-[13px]"
                              />
                            )}
                            <div className="min-w-56 flex-1">
                              <NicSgs
                                label={tr("Security groups for {netName}", { netName: netName(n.id) })}
                                value={n.sgs}
                                onChange={(v) => setNicList((l) => l.map((x) => (x.key === n.key ? { ...x, sgs: v } : x)))}
                                placeholder={tr("Use the security groups of step 5")}
                              />
                            </div>
                          </div>
                        )}
                        {n.kind === "port" && (
                          <PortSgs
                            port={port}
                            value={n.sgs}
                            onChange={(v) => setNicList((l) => l.map((x) => (x.key === n.key && x.kind === "port" ? { ...x, sgs: v } : x)))}
                          />
                        )}
                      </div>
                      <div className="flex shrink-0 gap-0.5">
                        <IconBtn label={tr("Move up")} icon="arrow-up" disabled={i === 0} onClick={() => setNicList((l) => swap(l, i, i - 1))} />
                        <IconBtn label={tr("Move down")} icon="arrow-down" disabled={i === chosenNics.length - 1} onClick={() => setNicList((l) => swap(l, i, i + 1))} />
                        <IconBtn label={tr("Remove")} icon="x" onClick={() => setNicList((l) => l.filter((x) => x.key !== n.key))} />
                      </div>
                    </li>
                  );
                })}
                {chosenNics.length === 0 && (
                  <li className="px-5 py-6 text-center text-sm text-muted">{tr("No interfaces. Nova picks the project's network automatically if there is exactly one.")}</li>
                )}
              </ul>
              <div className="grid gap-4 border-t border-line bg-surface/40 px-5 py-4 sm:grid-cols-2">
                <Field label={tr("Add a network")} hint={tr("The instance gets a new port on it. Pick security groups for it, or leave them empty to use step 5's.")}>
                  {(id) => (
                    <Picker
                      id={id}
                      value=""
                      onChange={(v) => v && setNicList((l) => [...l, { key: nextKey(), kind: "network", id: v, fixedIp: "", sgs: [] }])}
                      searchable
                      loading={networks.isPending}
                      placeholder={tr("Search networks…")}
                      searchPlaceholder={tr("Name or CIDR")}
                      options={usableNets.map((n) => ({
                        value: n.id,
                        label: n.name || n.id,
                        icon: "network",
                        description: cidrsOf(n.id).join(", ") || tr("no subnet"),
                        keywords: cidrsOf(n.id).join(" "),
                        meta: n["router:external"] ? tr("external") : n.shared ? tr("shared") : undefined,
                        disabled: chosenNics.some((x) => x.kind === "network" && x.id === n.id) ? tr("Already added") : false,
                      }))}
                    />
                  )}
                </Field>
                <Field label={tr("Add an existing port")} hint={count > 1 ? tr("Only when launching one instance.") : tr("Keeps its addresses; set its security groups here.")}>
                  {(id) => (
                    <Picker
                      id={id}
                      value=""
                      disabled={count > 1}
                      onChange={(v) => {
                        const p = freePorts.find((x) => x.id === v);
                        if (p) setNicList((l) => [...l, { key: nextKey(), kind: "port", id: p.id, sgs: p.security_groups ?? [] }]);
                      }}
                      searchable
                      loading={ports.isPending}
                      placeholder={tr("Search unattached ports…")}
                      searchPlaceholder={tr("Name, IP or network")}
                      emptyText={tr("No unattached ports. Create one on a network's Ports tab.")}
                      options={freePorts.map((p) => ({
                        value: p.id,
                        label: portLabel(p),
                        icon: "cable",
                        description: `${netName(p.network_id)} · ${p.fixed_ips.map((f) => f.ip_address).join(", ")}`,
                        keywords: `${netName(p.network_id)} ${p.fixed_ips.map((f) => f.ip_address).join(" ")} ${p.mac_address}`,
                        disabled: chosenNics.some((x) => x.kind === "port" && x.id === p.id) ? tr("Already added") : false,
                      }))}
                    />
                  )}
                </Field>
              </div>
            </Card>
          )}

          {step === "security" && (
            <SecurityStep
              groups={groups}
              value={chosenSgs}
              onChange={setSgs}
              nics={chosenNics.length}
              inheriting={inheriting.map(({ n, i }) => `eth${i} (${netName(n.id)})`)}
            />
          )}

          {step === "volumes" && (
            <Card title={tr("Data volumes")} flush actions={<span className="text-xs text-muted">{tr("Attached after the root disk, in this order")}</span>}>
              <div className="@container">
                {extras.length > 0 && (
                  <div className={cn(VOL_GRID, "hidden border-b border-line px-5 py-2 text-xs font-medium text-muted @3xl:grid")}>
                    <span>{tr("Disk")}</span>
                    <span>{tr("Source")}</span>
                    <span>{tr("Size")}</span>
                    <span>{tr("Volume type")}</span>
                    <span>{tr("On delete")}</span>
                    <span className="sr-only">{tr("Options")}</span>
                  </div>
                )}
                <ul>
                  {extras.map((e, i) => {
                    const v = e.kind === "existing" ? volumes.data?.find((x) => x.id === e.id) : undefined;
                    const set = (patch: Partial<Extra>) => setExtras((l) => l.map((x) => (x.key === e.key ? ({ ...x, ...patch } as Extra) : x)));
                    const guess = `/dev/vd${"bcdefghijklmnopq"[i]}`;
                    const custom = !!(e.deviceName || e.diskBus || e.deviceType);
                    const badName = !!e.deviceName.trim() && !DEVICE_NAME.test(e.deviceName.trim());
                    const label = (t: string) => <span className="text-xs font-medium text-muted @3xl:hidden">{t}</span>;
                    return (
                      <li key={e.key} className="border-b border-line px-5 py-3 text-sm last:border-0">
                        <div className={cn(VOL_GRID, "grid items-center gap-x-3 gap-y-2")}>
                          <span className="grid h-7 w-fit place-items-center rounded-md bg-ink/6 px-2 font-mono text-[12px]" title={tr("Device name in the guest (may differ)")}>
                            {e.deviceName.trim() ? e.deviceName.trim().replace(/^\/dev\//, "") : guess.slice(5)}
                          </span>
                          <div className="flex min-w-0 items-center gap-2 @max-3xl:col-span-full @max-3xl:row-start-2">
                            {e.kind === "existing" ? (
                              <>
                                <Icon name="hard-drive" className="text-muted" />
                                <span className="min-w-0">
                                  <span className="block truncate font-medium">{v?.name || e.id}</span>
                                  <span className="block text-xs text-muted">{tr("Existing volume")}</span>
                                </span>
                              </>
                            ) : e.kind === "image" ? (
                              <div className="min-w-0 flex-1">
                                <Picker
                                  aria-label={tr("Image")}
                                  size="sm"
                                  className="h-9"
                                  value={e.imageId}
                                  searchable
                                  loading={images.isPending}
                                  placeholder={tr("Choose an image…")}
                                  panelWidth={320}
                                  onChange={(id) => {
                                    const img = images.data?.find((x) => x.id === id);
                                    set({
                                      imageId: id,
                                      size: Math.max(e.size, imageMinGb(img)),
                                      // An ISO is most useful as a CD-ROM.
                                      ...(img?.disk_format === "iso" && !e.deviceType ? { deviceType: "cdrom", open: true } : {}),
                                    } as Partial<Extra>);
                                  }}
                                  options={(images.data ?? []).map((x) => ({ value: x.id, label: x.name || x.id, icon: "disc-3", meta: x.disk_format ?? undefined }))}
                                />
                              </div>
                            ) : (
                              <>
                                <Icon name="plus" className="text-muted" />
                                <span className="font-medium">{tr("New blank volume")}</span>
                              </>
                            )}
                          </div>
                          <div className="flex flex-col gap-1 @max-3xl:col-span-full">
                            {label(tr("Size"))}
                            {e.kind === "existing" ? (
                              <span className="tabular-nums">{v ? tr("{size} GiB", { size: v.size }) : "—"}</span>
                            ) : (
                              <div className="relative">
                                <Input
                                  aria-label={tr("Size in GiB")}
                                  type="number"
                                  min={1}
                                  value={e.size}
                                  onChange={(ev) => set({ size: Number(ev.target.value) || 0 } as Partial<Extra>)}
                                  className="h-9 pr-11 tabular-nums"
                                />
                                <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted">{tr("GiB")}</span>
                              </div>
                            )}
                          </div>
                          <div className="flex min-w-0 flex-col gap-1 @max-3xl:col-span-full">
                            {label(tr("Volume type"))}
                            {e.kind === "existing" ? (
                              <span className="truncate">{v?.volume_type ?? "—"}</span>
                            ) : (
                              <VolumeTypePicker value={e.type || typeFallback} onChange={(t) => set({ type: t } as Partial<Extra>)} types={types.data} size="sm" className="h-9" />
                            )}
                          </div>
                          <label className="flex items-center gap-2 text-xs whitespace-nowrap text-muted @max-3xl:col-span-full" title={tr("Delete this volume when the instance is deleted")}>
                            <input type="checkbox" checked={e.dot} onChange={(ev) => set({ dot: ev.target.checked })} className="size-4 accent-cable" />
                            {tr("Delete with instance")}
                          </label>
                          <div className="flex items-center justify-end gap-1 @max-3xl:col-start-2 @max-3xl:row-start-1">
                            <button
                              type="button"
                              onClick={() => set({ open: !e.open })}
                              aria-expanded={!!e.open}
                              title={custom ? [e.deviceName.trim(), e.diskBus, e.deviceType].filter(Boolean).join(" · ") : tr("Device name, bus and type")}
                              className={cn(
                                "inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-ink/5",
                                custom ? "bg-cable-soft/60 text-cable" : "text-muted",
                                e.open && "bg-ink/5",
                              )}
                            >
                              <Icon name="settings" className="size-3.5" />
                              {tr("Device")}
                              <Icon name="chevron-down" className={cn("size-3 transition-transform", e.open && "rotate-180")} />
                            </button>
                            <IconBtn label={tr("Remove")} icon="x" onClick={() => setExtras((l) => l.filter((x) => x.key !== e.key))} />
                          </div>
                        </div>
                        {e.open && (
                          <div className="mt-3 grid animate-fade-in gap-3 rounded-lg border border-line bg-surface/40 p-3 @xl:grid-cols-3 @3xl:ml-[3.75rem]">
                            <Field label={tr("Mount point (device)")} hint={badName ? tr("Use a name like /dev/vdb") : tr("Optional. The hypervisor may still pick its own.")}>
                              {(id) => (
                                <Input
                                  id={id}
                                  value={e.deviceName}
                                  onChange={(ev) => set({ deviceName: ev.target.value })}
                                  placeholder={guess}
                                  aria-invalid={badName}
                                  className={cn("h-9 font-mono text-[13px]", badName && "border-led-red")}
                                />
                              )}
                            </Field>
                            <Field label={tr("Disk bus")}>{(id) => <Picker id={id} size="sm" className="h-9" value={e.diskBus} onChange={(b) => set({ diskBus: b })} options={DISK_BUSES} panelWidth={300} />}</Field>
                            <Field label={tr("Device type")}>
                              {(id) => <Picker id={id} size="sm" className="h-9" value={e.deviceType} onChange={(t) => set({ deviceType: t })} options={DEVICE_TYPES} panelWidth={300} />}
                            </Field>
                          </div>
                        )}
                      </li>
                    );
                  })}
                  {extras.length === 0 && <li className="px-5 py-6 text-center text-sm text-muted">{tr("No data volumes. The instance gets only its root disk.")}</li>}
                </ul>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface/40 px-5 py-4">
                <Button onClick={() => setExtras((l) => [...l, { key: nextKey(), kind: "new", size: 20, type: "", dot: true, ...NO_PLACEMENT }])}>
                  <Icon name="plus" />
                  {tr("New blank volume")}
                </Button>
                <Button onClick={() => setExtras((l) => [...l, { key: nextKey(), kind: "image", imageId: "", size: 1, type: "", dot: true, ...NO_PLACEMENT }])}>
                  <Icon name="disc-3" />
                  {tr("From image (ISO…)")}
                </Button>
                <div className="min-w-60 flex-1" title={count > 1 ? tr("Only when launching one instance") : undefined}>
                  <Picker
                    aria-label={tr("Attach an existing volume")}
                    value=""
                    disabled={count > 1}
                    onChange={(v) => v && setExtras((l) => [...l, { key: nextKey(), kind: "existing", id: v, dot: false, ...NO_PLACEMENT }])}
                    searchable
                    loading={volumes.isPending}
                    placeholder={count > 1 ? tr("Attach an existing volume (one instance only)") : tr("Attach an existing volume…")}
                    emptyText={tr("No available volumes.")}
                    options={(volumes.data ?? [])
                      .filter((v) => v.status === "available" && v.id !== sourceId)
                      .map((v) => ({
                        value: v.id,
                        label: v.name || v.id,
                        icon: "hard-drive",
                        meta: tr("{size} GiB", { size: v.size }),
                        description: [v.volume_type, v.description].filter(Boolean).join(" · ") || undefined,
                        disabled: extras.some((x) => x.kind === "existing" && x.id === v.id) ? tr("Already added") : false,
                      }))}
                  />
                </div>
              </div>
            </Card>
          )}

          {step === "keypair" && (
            <KeypairStep keypairs={keypairs} value={chosenKey} onChange={setKey} onImport={() => setImporting(true)} onCreate={() => setCreatingKey(true)} />
          )}

          {step === "config" && (
            <Card
              title={tr("Configuration")}
              actions={
                <a
                  href={CLOUD_INIT_DOCS}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 text-sm text-cable hover:underline"
                >
                  <Icon name="external-link" />
                  {tr("cloud-init documentation")}
                </a>
              }
            >
              <div className="space-y-4">
                <Field
                  label={tr("User data")}
                  hint={
                    <>
                      {tr("A cloud-init script or #cloud-config document, run on first boot. See the")}
                      <a href={CLOUD_INIT_DOCS} target="_blank" rel="noreferrer noopener" className="text-cable hover:underline">
                        {tr("cloud-init docs")}
                      </a>{" "}{tr("for the formats, modules and examples.")}
                    </>
                  }
                >
                  {(id) => (
                    <Textarea
                      id={id}
                      rows={10}
                      value={userData}
                      onChange={(e) => setUserData(e.target.value)}
                      placeholder={"#cloud-config\npackage_update: true\npackages:\n  - nginx"}
                      className="font-mono text-[13px]"
                    />
                  )}
                </Field>
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-cable hover:underline">
                  <Icon name="upload" />
                  {tr("Load from a file")}
                  <input type="file" className="hidden" onChange={async (e) => e.target.files?.[0] && setUserData(await e.target.files[0].text())} />
                </label>
                <Switch checked={configDrive} onChange={setConfigDrive} label={tr("Use a config drive")} hint={tr("Provide metadata on a virtual disk instead of the metadata service.")} />
              </div>
            </Card>
          )}
          {step === "config" && (
            <Card title={tr("Metadata")} actions={<span className="text-xs text-muted">{tr("Key–value pairs on the instance; editable later")}</span>}>
              <MetadataEditor value={metadata} onChange={setMetadata} scope={SERVER_METADATA} />
            </Card>
          )}

          {step === "scheduling" && <SchedulingStep value={scheduling} onChange={setScheduling} count={count} />}

          {step === "review" && (
            <Card title={tr("Review")}>
              <dl className="text-sm">
                <Row label={tr("Name")} problem={problems.details} go={() => setStep("details")}>
                  {name || "—"}
                  {count > 1 && ` × ${count}`}
                </Row>
                <Row label={tr("Boot source")} problem={problems.source} go={() => setStep("source")}>
                  {image ? image.name : volume ? volume.name || volume.id : snap ? snap.name || snap.id : "—"}
                  {newVolume && (
                    <span className="text-muted">
                      {trx("on a new {rootSize} GiB {v} volume{v2}", { rootSize, v: rootType || tr("default"), v2: deleteOnTerm ? tr(", deleted with the instance") : tr(", kept after deletion") })}
                    </span>
                  )}
                  {kind === "image" && !bfv && <span className="text-muted">{" "}{tr("on local disk")}</span>}
                  {rootBus && <span className="text-muted">{trx(", {rootBus} bus", { rootBus })}</span>}
                </Row>
                <Row label={tr("Flavor")} problem={problems.flavor} go={() => setStep("flavor")}>
                  {flavor ? tr("{name} ({vcpus} vCPU, {ram})", { name: flavor.name, vcpus: flavor.vcpus, ram: gib(flavor.ram) }) : "—"}
                </Row>
                <Row label={tr("Security features")} go={() => setStep("flavor")}>
                  {featureText(features) || <span className="text-muted">{tr("Standard (no vTPM, no memory encryption)")}</span>}
                </Row>
                <Row label={tr("Interfaces")} problem={problems.network} go={() => setStep("network")}>
                  {chosenNics
                    .map((n) => {
                      const own = n.sgs.length ? ` [${n.sgs.map(groupName).join(", ")}]` : "";
                      if (n.kind === "network") return `${netName(n.id)}${n.fixedIp ? ` (${n.fixedIp})` : ""}${own}`;
                      const p = ports.data?.find((x) => x.id === n.id);
                      return `port ${p ? portLabel(p) : n.id}${own}`;
                    })
                    .join(", ") || tr("Automatic")}
                </Row>
                <Row label={tr("Security groups")} go={() => setStep("security")}>
                  {inheriting.length || chosenNics.length === 0 ? chosenSgs.map(groupName).join(", ") || tr("None") : <span className="text-muted">{tr("Not used: every interface has its own")}</span>}
                  {inheriting.length > 0 && inheriting.length < chosenNics.length && (
                    <span className="text-muted">{" "}{tr("(on")}{" "}{inheriting.map(({ i }) => `eth${i}`).join(", ")}{tr("; other interfaces use their own)")}</span>
                  )}
                </Row>
                <Row label={tr("Data volumes")} problem={problems.volumes} go={() => setStep("volumes")}>
                  {extras
                    .map((e) => {
                      const what =
                        e.kind === "new"
                          ? tr("new {size} GiB {v}", { size: e.size, v: e.type || typeFallback }).trim()
                          : e.kind === "image"
                            ? tr("{v} ({size} GiB {v2})", { v: images.data?.find((i) => i.id === e.imageId)?.name ?? tr("image"), size: e.size, v2: e.type || typeFallback })
                            : volumes.data?.find((v) => v.id === e.id)?.name || e.id;
                      const where = [e.deviceName.trim(), e.diskBus, e.deviceType].filter(Boolean).join(" ");
                      return where ? `${what} as ${where}` : what;
                    })
                    .join(", ") || tr("None")}
                </Row>
                <Row label={tr("Scheduling")} problem={problems.scheduling} go={() => setStep("scheduling")}>
                  {schedulingSummary(
                    scheduling,
                    (id) => serverGroups.data?.find((g) => g.id === id)?.name ?? id,
                    (id) => allServers.data?.find((x) => x.id === id)?.name ?? id,
                  ) || tr("Default")}
                </Row>
                <Row label={tr("Key pair")} go={() => setStep("keypair")}>
                  {chosenKey || tr("None")}
                </Row>
                <Row label={tr("Configuration")} problem={problems.config} go={() => setStep("config")}>
                  {[
                    userData && tr("user data"),
                    configDrive && tr("config drive"),
                    az && tr("zone {az}", { az }),
                    Object.keys(metadata).length && tr("{n} metadata item{s}", { n: Object.keys(metadata).length, s: Object.keys(metadata).length === 1 ? "" : "s" }),
                  ]
                    .filter(Boolean)
                    .join(", ") || tr("Defaults")}
                </Row>
              </dl>
              {L && flavor && (
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Usage label={tr("Instances")} used={L.totalInstancesUsed} add={count} max={L.maxTotalInstances} />
                  <Usage label={tr("vCPUs")} used={L.totalCoresUsed} add={flavor.vcpus * count} max={L.maxTotalCores} />
                  <Usage label={tr("RAM (MiB)")} used={L.totalRAMUsed} add={flavor.ram * count} max={L.maxTotalRAMSize} />
                  {V && <Usage label={tr("Volume GiB")} used={V.totalGigabytesUsed} add={newGb * count} max={V.maxTotalVolumeGigabytes} />}
                </div>
              )}
              <ErrorNotice error={launch.error} className="mt-4" />
            </Card>
          )}

          <div className="flex items-center gap-2">
            {problems[step] && <p className="text-sm text-[#9a6412] dark:text-led-amber">{problems[step]}</p>}
            <div className="ml-auto flex gap-2">
              <Button onClick={() => setStep(STEPS[idx - 1].id)} disabled={idx === 0}>
                {tr("Back")}
              </Button>
              {step !== "review" ? (
                <Button variant="primary" onClick={() => setStep(STEPS[idx + 1].id)}>
                  {tr("Next")}
                </Button>
              ) : (
                <Button variant="primary" onClick={() => launch.mutate()} busy={launch.isPending} disabled={!ready}>
                  <Icon name="power" />
                  {count > 1 ? tr("Launch {count} instances", { count }) : tr("Launch instance")}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
      <ImportKeypairDialog open={importing} onClose={() => setImporting(false)} onImported={(k) => setKey(k)} />
      <CreateKeypairDialog open={creatingKey} onClose={() => setCreatingKey(false)} onCreated={(k) => setKey(k)} />
    </>
  );
}

// =========================================================================== steps

function FlavorStep({
  flavors,
  value,
  onChange,
  problem,
  left,
  count,
  localDisk,
  imageProps,
}: {
  flavors: ReturnType<typeof useFlavors>;
  imageProps: Record<string, unknown>;
  value: string;
  onChange: (id: string) => void;
  problem: (f: Flavor) => string | null;
  left?: { cores: number; ram: number } | null;
  count: number;
  localDisk: boolean;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"size" | "name" | "vcpus" | "ram">("size");
  const [fitOnly, setFitOnly] = useState(false);
  const imageTpm = imageProps.hw_tpm_version != null ? String(imageProps.hw_tpm_version) : "";
  const [tpmOnly, setTpmOnly] = useState(false);
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    let out = [...(flavors.data ?? [])].filter(
      (f) => !n || `${f.name} ${f.vcpus}vcpu ${gib(f.ram)} ${f.description ?? ""} ${Object.entries(f.extra_specs ?? {}).flat().join(" ")}`.toLowerCase().includes(n),
    );
    if (fitOnly) out = out.filter((f) => !problem(f));
    if (tpmOnly && !imageTpm) out = out.filter((f) => !!f.extra_specs?.["hw:tpm_version"]);
    const by = {
      size: (a: Flavor, b: Flavor) => a.vcpus - b.vcpus || a.ram - b.ram,
      name: (a: Flavor, b: Flavor) => a.name.localeCompare(b.name),
      vcpus: (a: Flavor, b: Flavor) => a.vcpus - b.vcpus,
      ram: (a: Flavor, b: Flavor) => a.ram - b.ram,
    }[sort];
    return out.sort(by);
  }, [flavors.data, q, sort, fitOnly, problem, tpmOnly, imageTpm]);
  const head = (k: typeof sort, label: string, cls?: string) => (
    <button type="button" onClick={() => setSort(k)} className={cn("text-left hover:text-ink", sort === k && "text-ink", cls)}>
      {label}
      {sort === k && <Icon name="chevron-up" className="ml-0.5 inline size-3" />}
    </button>
  );
  return (
    <Card title={tr("Flavor")} flush>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <SearchBox value={q} onChange={setQ} placeholder={tr("Search flavors (name, vCPU, RAM, extra specs)")} className="mb-0 sm:max-w-sm" />
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={fitOnly} onChange={(e) => setFitOnly(e.target.checked)} className="size-4 accent-cable" />
          {tr("Only flavors that fit")}
        </label>
        {imageTpm ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted" title={tr("The image sets hw_tpm_version, so every flavor gives the instance a vTPM.")}>
            <Icon name="shield-check" className="size-4 text-cable" />
            {tr("The image adds a vTPM {v}", { v: imageTpm })}
          </span>
        ) : (
          <label className="flex items-center gap-2 text-sm text-muted" title={tr("A virtual TPM comes from the flavor (hw:tpm_version) or the image (hw_tpm_version).")}>
            <input type="checkbox" checked={tpmOnly} onChange={(e) => setTpmOnly(e.target.checked)} className="size-4 accent-cable" />
            {tr("Require a vTPM")}
          </label>
        )}
        {left && (
          <span className="ml-auto text-xs text-muted">
            {trx("Quota left: {v}, {v2}{v3}", { v: Number.isFinite(left.cores) ? tr("{cores} vCPUs", { cores: left.cores }) : tr("unlimited vCPUs"), v2: Number.isFinite(left.ram) ? `${gib(left.ram)} RAM` : tr("unlimited RAM"), v3: count > 1 && tr(" (for {count} instances)", { count }) })}
          </span>
        )}
      </div>
      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_4.5rem_5.5rem] gap-3 border-b border-line px-5 py-2 text-xs font-medium text-muted sm:grid-cols-[1.5rem_minmax(0,1fr)_5rem_6rem_7rem]">
        <span />
        {head("name", "Name")}
        {head("vcpus", "vCPUs")}
        {head("ram", "RAM")}
        <span className="hidden sm:block">{tr("Disk")}</span>
      </div>
      <ul className="max-h-[28rem] overflow-y-auto">
        {list.map((f) => {
          const p = problem(f);
          return (
            <li key={f.id} className="border-b border-line last:border-0">
              <label
                className={cn(
                  "grid cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)_4.5rem_5.5rem] items-center gap-3 px-5 py-2.5 text-sm transition-colors hover:bg-surface/60 sm:grid-cols-[1.5rem_minmax(0,1fr)_5rem_6rem_7rem]",
                  p && "opacity-55",
                  value === f.id && "bg-cable-soft/50",
                )}
              >
                <input type="radio" name="flavor" checked={value === f.id} onChange={() => onChange(f.id)} className="accent-cable" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {f.name}
                    {f["os-flavor-access:is_public"] === false && <span className="ml-2 text-xs font-normal text-muted">{tr("private")}</span>}
                    <FeatureBadges specs={f.extra_specs} />
                  </span>
                  {p ? (
                    <span className="block truncate text-xs text-[#9a6412] dark:text-led-amber">{p}</span>
                  ) : (
                    Object.keys(f.extra_specs ?? {}).length > 0 && (
                      <span className="block truncate font-mono text-[11px] text-muted">
                        {Object.entries(f.extra_specs ?? {})
                          .map(([k, v]) => `${k}=${v}`)
                          .join(" ")}
                      </span>
                    )
                  )}
                </span>
                <span className="tabular-nums">{trx("{vcpus} vCPU", { vcpus: f.vcpus })}</span>
                <span className="tabular-nums">{gib(f.ram)}</span>
                <span className="hidden text-muted tabular-nums sm:block">{localDisk ? tr("{disk} GB disk", { disk: f.disk }) : f.disk ? tr("{disk} GB (unused)", { disk: f.disk }) : tr("volume root")}</span>
              </label>
            </li>
          );
        })}
        {flavors.isPending && <li className="px-5 py-4 text-sm text-muted">{tr("Loading…")}</li>}
        {flavors.data && list.length === 0 && (
          <li className="px-5 py-6 text-center text-sm text-muted">
            {q ? tr("No flavor matches “{q}”.", { q }) : tpmOnly ? tr("No flavor gives a vTPM. Ask an admin for one (hw:tpm_version), or use an image with hw_tpm_version.") : tr("No flavors fit.")}
          </li>
        )}
      </ul>
      <ErrorNotice error={flavors.error} className="m-4" />
    </Card>
  );
}

function SecurityStep({
  groups,
  value,
  onChange,
  nics,
  inheriting,
}: {
  groups: ReturnType<typeof useSecurityGroups>;
  value: string[];
  onChange: (v: string[]) => void;
  /** Number of interfaces, and those (named) that take these groups. */
  nics: number;
  inheriting: string[];
}) {
  const [q, setQ] = useState("");
  const n = q.trim().toLowerCase();
  const list = (groups.data ?? []).filter((g) => !n || `${g.name} ${g.description} ${g.security_group_rules.map(ruleSummary).join(" ")}`.toLowerCase().includes(n));
  return (
    <Card title={tr("Security groups")} flush actions={<span className="text-xs text-muted">{trx("{length} selected", { length: value.length })}</span>}>
      {nics > 0 && inheriting.length === 0 ? (
        <p className="border-b border-line bg-led-amber/8 px-5 py-2.5 text-xs">
          {tr("Every interface has its own security groups (set on the Networks & ports step), so these aren't used.")}
        </p>
      ) : (
        nics > 0 &&
        inheriting.length < nics && (
          <p className="border-b border-line bg-surface/60 px-5 py-2.5 text-xs text-muted">
            {trx("Applied to {inheriting}. Interfaces with their own security groups ignore these.", { inheriting: inheriting.join(", ") })}
          </p>
        )
      )}
      <div className="border-b border-line px-5 py-3">
        <SearchBox value={q} onChange={setQ} placeholder={tr("Search security groups or rules")} className="mb-0 sm:max-w-sm" />
      </div>
      <ul className="max-h-[28rem] overflow-y-auto">
        {list.map((g) => {
          const on = value.includes(g.id);
          const inbound = g.security_group_rules.filter((r) => r.direction === "ingress");
          return (
            <li key={g.id} className="border-b border-line last:border-0">
              <label className={cn("flex cursor-pointer items-start gap-3 px-5 py-2.5 text-sm transition-colors hover:bg-surface/60", on && "bg-cable-soft/40")}>
                <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? [...value, g.id] : value.filter((x) => x !== g.id))} className="mt-0.5 size-4 accent-cable" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{g.name}</span>
                  {g.description && <span className="ml-2 text-xs text-muted">{g.description}</span>}
                  <span className="block truncate text-xs text-muted">
                    {tr("In:")}{" "}{inbound.map((r) => `${ruleSummary(r)}${r.remote_ip_prefix && r.remote_ip_prefix !== "0.0.0.0/0" ? ` from ${r.remote_ip_prefix}` : ""}`).join("; ") || tr("nothing")}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
        {groups.data && list.length === 0 && <li className="px-5 py-6 text-center text-sm text-muted">{q ? tr("Nothing matches “{q}”.", { q }) : tr("No security groups.")}</li>}
      </ul>
    </Card>
  );
}

function KeypairStep({
  keypairs,
  value,
  onChange,
  onImport,
  onCreate,
}: {
  keypairs: ReturnType<typeof useKeypairs>;
  value: string;
  onChange: (k: string) => void;
  onImport: () => void;
  onCreate: () => void;
}) {
  const [q, setQ] = useState("");
  const n = q.trim().toLowerCase();
  const list = (keypairs.data ?? []).filter((k) => !n || `${k.name} ${k.fingerprint} ${k.type ?? ""}`.toLowerCase().includes(n));
  return (
    <Card
      title={tr("Key pair")}
      flush
      actions={
        <>
          <Button className="h-8" onClick={onCreate}>
            <Icon name="key" />
            {tr("Create key pair")}
          </Button>
          <Button className="h-8" onClick={onImport}>
            <Icon name="upload" />
            {tr("Import")}
          </Button>
        </>
      }
    >
      {(keypairs.data?.length ?? 0) > 5 && (
        <div className="border-b border-line px-5 py-3">
          <SearchBox value={q} onChange={setQ} placeholder={tr("Search key pairs")} className="mb-0 sm:max-w-sm" />
        </div>
      )}
      <ul className="max-h-[28rem] overflow-y-auto">
        {list.map((k) => (
          <li key={k.name} className="border-b border-line last:border-0">
            <label className={cn("flex cursor-pointer items-center gap-3 px-5 py-2.5 text-sm transition-colors hover:bg-surface/60", value === k.name && "bg-cable-soft/50")}>
              <input type="radio" name="key" checked={value === k.name} onChange={() => onChange(k.name)} className="accent-cable" />
              <Icon name="key" className="text-muted" />
              <span className="font-medium">{k.name}</span>
              <span className="truncate font-mono text-xs text-muted">{k.fingerprint}</span>
            </label>
          </li>
        ))}
        {keypairs.data && list.length === 0 && q && <li className="px-5 py-4 text-sm text-muted">{trx("Nothing matches “{q}”.", { q })}</li>}
        <li>
          <label className={cn("flex cursor-pointer items-center gap-3 px-5 py-2.5 text-sm hover:bg-surface/60", value === "" && "bg-cable-soft/50")}>
            <input type="radio" name="key" checked={value === ""} onChange={() => onChange("")} className="accent-cable" />
            <span>{tr("No key pair")}</span>
            <span className="text-xs text-muted">{tr("You'll need a password or another way in, set through user data.")}</span>
          </label>
        </li>
      </ul>
    </Card>
  );
}

// =========================================================================== bits

/** Security groups of one new-port interface; empty = the instance-wide ones. */
function NicSgs({ label, value, onChange, placeholder }: { label: string; value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const { options, loading } = useSgOptions();
  return (
    <MultiPicker aria-label={label} values={value} onChange={onChange} options={options} loading={loading} searchable size="sm" placeholder={placeholder} />
  );
}

function PortSgs({ port, value, onChange }: { port?: Port; value: string[]; onChange: (v: string[]) => void }) {
  const { options, loading } = useSgOptions(port?.project_id);
  if (port?.port_security_enabled === false) return <p className="text-xs text-muted">{tr("Port security is off on this port; security groups don't apply.")}</p>;
  return (
    <div className="max-w-xl">
      <MultiPicker
        aria-label={tr("Security groups of this port")}
        values={value}
        onChange={onChange}
        options={options}
        loading={loading}
        searchable
        size="sm"
        placeholder={tr("No security groups (all traffic blocked)")}
      />
    </div>
  );
}

function VolumeTypePicker({
  id,
  value,
  onChange,
  types,
  size,
  className,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  types?: { id: string; name: string; description?: string | null }[];
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <Picker
      id={id}
      size={size}
      value={value}
      onChange={onChange}
      className={className}
      panelWidth={260}
      placeholder={tr("No volume types")}
      options={(types ?? []).map((t) => ({ value: t.name, label: t.name, description: t.description ?? undefined }))}
    />
  );
}

function SearchBox({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) {
  return (
    <div className={cn("relative mb-3 w-full sm:max-w-xs", className)}>
      <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-9 pl-9" />
    </div>
  );
}

function IconBtn({ label, icon, onClick, disabled }: { label: string; icon: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-8 place-items-center rounded-md text-muted transition-colors hover:bg-ink/5 hover:text-ink disabled:opacity-30"
    >
      <Icon name={icon} />
    </button>
  );
}

function swap<T>(list: T[], a: number, b: number) {
  const out = [...list];
  [out[a], out[b]] = [out[b], out[a]];
  return out;
}

function PickList({
  items,
  value,
  onChange,
  loading,
  empty,
}: {
  items: { id: string; title: string; meta?: string }[];
  value: string;
  onChange: (id: string) => void;
  loading?: boolean;
  empty: string;
}) {
  return (
    <ul role="radiogroup" className="max-h-80 overflow-y-auto rounded-md border border-line">
      {loading && <li className="px-4 py-3 text-sm text-muted">{tr("Loading…")}</li>}
      {items.map((i) => (
        <li key={i.id} className="border-b border-line last:border-0">
          <label className={cn("flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-surface/60", value === i.id && "bg-cable-soft/50")}>
            <input type="radio" checked={value === i.id} onChange={() => onChange(i.id)} className="accent-cable" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium" title={i.title}>
                {i.title}
              </span>
              {i.meta && <span className="block truncate text-xs text-muted">{i.meta}</span>}
            </span>
          </label>
        </li>
      ))}
      {!loading && items.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">{empty}</li>}
    </ul>
  );
}

function Row({ label, children, problem, go }: { label: string; children: ReactNode; problem?: string; go: () => void }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)_auto] items-start gap-3 border-b border-line py-2.5 last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">
        <span className="block truncate">{children}</span>
        {problem && <span className="block text-xs text-[#9a6412] dark:text-led-amber">{problem}</span>}
      </dd>
      <button type="button" onClick={go} className="text-xs text-cable hover:underline">
        {tr("Change")}
      </button>
    </div>
  );
}

function Usage({ label, used, add, max }: { label: string; used: number; add: number; max: number }) {
  const after = used + add;
  const over = max >= 0 && after > max;
  return (
    <div className="rounded-md border border-line px-3 py-2.5 text-xs">
      <p className="flex justify-between text-muted">
        <span>{label}</span>
        <span className={cn("tabular-nums", over && "text-led-red")}>
          {after} / {max < 0 ? "∞" : max}
        </span>
      </p>
      <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-ink/8">
        <div className="bg-muted/50" style={{ width: `${quotaPct(used, max)}%` }} />
        <div className={over ? "bg-led-red" : "bg-cable"} style={{ width: `${Math.max(0, quotaPct(after, max) - quotaPct(used, max))}%` }} />
      </div>
    </div>
  );
}

/** "vTPM 2.0 (tpm-crb, live-migratable) · Intel TDX · 1 vGPU" */
function featureText(g: GuestFeatures) {
  return [
    g.tpm && tr("vTPM {v}{m}", { v: g.tpm.version, m: g.tpm.model || g.tpm.migratable ? ` (${[g.tpm.model, g.tpm.migratable && tr("live-migratable")].filter(Boolean).join(", ")})` : "" }),
    g.confidential && tr("{label} memory encryption", { label: g.confidential.label }),
    g.vgpu,
  ]
    .filter(Boolean)
    .join(" · ");
}
