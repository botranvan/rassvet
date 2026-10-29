/** Cluster templates for the Cluster API driver: list (project and admin view), create / edit / clone and delete. */
import { useEffect, useMemo, useState } from "react";
import {
  ActionDialog,
  Badge,
  Button,
  type Column,
  DataTable,
  ErrorNotice,
  Field,
  Icon,
  Input,
  KeyValueEditor,
  type KvRow,
  type MenuEntry,
  PageHeader,
  Picker,
  Switch,
  Tabs,
  age,
  fmtDate,
  fromRows,
  kvError,
  os,
  toRows,
  tr,
  useBootImages,
  useFlavors,
  useInAdmin,
  useInvalidate,
  useKeypairs,
  useNetworks,
  useNewParam,
  useProjects,
  useSearchParams,
  useSession,
  useSubnets,
} from "@rassvet/sdk";
import {
  CAPI_DRIVER,
  type ClusterTemplate,
  LABEL_SUGGESTIONS,
  MG,
  NETWORK_DRIVERS,
  OCTAVIA_PROVIDERS,
  diffPatch,
  flavorTooSmall,
  imageKubeVersion,
  imageProblem,
  labelOn,
  labelsOf,
  mgName,
  patchTemplate,
  useClusters,
  useTemplateVersion,
  useTemplates,
} from "./api";

export default function Templates() {
  const admin = useInAdmin();
  const session = useSession();
  const templates = useTemplates();
  const clusters = useClusters();
  const projects = useProjects(admin);
  const images = useBootImages();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "create" | "edit" | "clone" | "delete"; t?: ClusterTemplate } | null>(null);
  const close = () => setOpen(null);
  useNewParam(() => setOpen({ kind: "create" }));
  // `?edit=<uuid>` (command palette search) opens that template once the list is loaded.
  const [params, setParams] = useSearchParams();
  const editId = params.get("edit");
  useEffect(() => {
    const t = editId && templates.data?.find((x) => x.uuid === editId);
    if (!t) return;
    setOpen({ kind: "edit", t });
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("edit");
        return next;
      },
      { replace: true },
    );
  }, [editId, templates.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const inUse = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of clusters.data ?? []) m.set(c.cluster_template_id, (m.get(c.cluster_template_id) ?? 0) + 1);
    return m;
  }, [clusters.data]);
  const projectName = (id?: string) => (id ? (projects.data?.find((p) => p.id === id)?.name ?? id) : "");
  const imageName = (id: string) => images.data?.find((i) => i.id === id || i.name === id)?.name ?? id;
  const mine = (t: ClusterTemplate) => admin || !t.project_id || t.project_id === session.data?.project?.id;
  const version = useTemplateVersion();

  const columns: Column<ClusterTemplate>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (t) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{mgName(t)}</p>
          <p className="truncate text-xs text-muted">{[version(t) && `Kubernetes ${version(t)}`, t.network_driver].filter(Boolean).join(" · ")}</p>
        </div>
      ),
      value: (t) => `${t.name} ${t.uuid} ${version(t) ?? ""}`,
      csv: (t) => t.name,
    },
    ...(admin
      ? [{ key: "project", header: tr("Project"), width: "9rem", hideBelow: "md" as const, cell: (t: ClusterTemplate) => projectName(t.project_id), value: (t: ClusterTemplate) => projectName(t.project_id) }]
      : []),
    { key: "image", header: tr("Image"), width: "12rem", hideBelow: "md", cell: (t) => imageName(t.image_id), value: (t) => imageName(t.image_id) },
    { key: "network", header: tr("Network driver"), width: "8rem", hideBelow: "lg", cell: (t) => t.network_driver || "—", value: (t) => t.network_driver ?? "" },
    {
      key: "flags",
      header: tr("Visibility"),
      width: "10rem",
      wrap: true,
      cell: (t) => (
        <span className="flex flex-wrap gap-1">
          {t.public ? <Badge tone="accent">{tr("Public")}</Badge> : <Badge>{tr("Private")}</Badge>}
          {t.hidden && <Badge tone="warn">{tr("Hidden")}</Badge>}
          {t.driver && t.driver !== CAPI_DRIVER && <Badge tone="warn">{tr("Not Cluster API")}</Badge>}
        </span>
      ),
      value: (t) => `${t.public ? "public" : "private"} ${t.hidden ? "hidden" : ""}`,
    },
    { key: "clusters", header: tr("Clusters"), width: "6rem", className: "text-right", cell: (t) => inUse.get(t.uuid) ?? 0, value: (t) => inUse.get(t.uuid) ?? 0 },
    { key: "age", header: tr("Age"), width: "7rem", hideBelow: "xl", cell: (t) => <span title={fmtDate(t.created_at) ?? ""}>{age(t.created_at)}</span>, value: (t) => t.created_at ?? "" },
  ];

  const items = (t: ClusterTemplate): MenuEntry[] => {
    const used = inUse.get(t.uuid) ? tr("In use by {n} cluster(s)", { n: inUse.get(t.uuid)! }) : false;
    return [
      { label: tr("Edit template"), icon: "edit", disabled: !mine(t) && tr("Owned by another project"), onSelect: () => setOpen({ kind: "edit", t }) },
      { label: tr("Clone template"), icon: "copy-plus", onSelect: () => setOpen({ kind: "clone", t }) },
      "-",
      { label: tr("Delete template"), icon: "trash", danger: true, disabled: used || (!mine(t) && tr("Owned by another project")), onSelect: () => setOpen({ kind: "delete", t }) },
    ];
  };

  return (
    <>
      <PageHeader
        title={tr("Cluster templates")}
        description={tr("A template fixes how Magnum's Cluster API driver builds a Kubernetes cluster: the node image (which sets the Kubernetes version), flavors, networks, CNI and labels.")}
        actions={
          <Button variant="primary" onClick={() => setOpen({ kind: "create" })}>
            <Icon name="plus" />
            {tr("Create template")}
          </Button>
        }
      />
      <ErrorNotice error={templates.error} className="mb-4" />
      <DataTable
        rows={templates.data}
        columns={columns}
        rowKey={(t) => t.uuid}
        loading={templates.isPending}
        tableId={admin ? "magnum-admin-templates" : "magnum-templates"}
        noun={tr("cluster templates")}
        rowLabel={mgName}
        onRefresh={() => templates.refetch()}
        refreshing={templates.isFetching}
        onBulkDone={() => invalidate(MG)}
        empty={tr("No cluster templates yet. Ask your cloud admins for a public one, or create your own.")}
        filterPlaceholder={tr("Filter by name, version or image")}
        rowActions={items}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete cluster templates?"),
            past: tr("deleted"),
            body: tr("Templates still used by a cluster can't be deleted."),
            check: (t) => (inUse.get(t.uuid) ? tr("In use by {n} cluster(s)", { n: inUse.get(t.uuid)! }) : true),
            run: (t) => os.del(MG, `clustertemplates/${t.uuid}`),
          },
        ]}
      />
      {open?.kind === "create" && <TemplateDialog onClose={close} />}
      {open?.kind === "clone" && open.t && <TemplateDialog from={open.t} onClose={close} />}
      {open?.kind === "edit" && open.t && <TemplateDialog template={open.t} inUse={inUse.get(open.t.uuid) ?? 0} onClose={close} />}
      {open?.kind === "delete" && open.t && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete {name}?", { name: mgName(open.t) })}
          submitLabel={tr("Delete template")}
          done={tr("Template deleted")}
          refresh={[MG]}
          run={() => os.del(MG, `clustertemplates/${open.t!.uuid}`)}
        >
          <p className="text-sm">{tr("Clusters made from it must be deleted first; Magnum refuses otherwise.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

// =========================================================================== create / edit

const STEPS = ["basics", "network", "nodes", "labels"] as const;
type Step = (typeof STEPS)[number];

/** Template attributes the form edits; the driver ignores the rest. */
type Form = Pick<
  ClusterTemplate,
  | "name"
  | "coe"
  | "image_id"
  | "keypair_id"
  | "external_network_id"
  | "fixed_network"
  | "fixed_subnet"
  | "dns_nameserver"
  | "flavor_id"
  | "master_flavor_id"
  | "network_driver"
  | "master_lb_enabled"
  | "public"
  | "hidden"
  | "labels"
>;

const empty = (s: string) => (s.trim() === "" ? null : s.trim());

/** `template`: edit it; `from`: clone it into a new one; neither: a new template. */
export function TemplateDialog({ template, from, inUse = 0, onClose }: { template?: ClusterTemplate; from?: ClusterTemplate; inUse?: number; onClose: () => void }) {
  const admin = useSession().data?.is_admin;
  const images = useBootImages();
  const keypairs = useKeypairs();
  const nets = useNetworks();
  const subnets = useSubnets();
  const flavors = useFlavors();
  const base = template ?? from;
  const [step, setStep] = useState<Step>("basics");
  const [name, setName] = useState(template ? template.name : from ? `${from.name}-copy` : "");
  const [image, setImage] = useState(base?.image_id ?? "");
  const [keypair, setKeypair] = useState(base?.keypair_id ?? "");
  const [extNet, setExtNet] = useState(base?.external_network_id ?? "");
  const [fixedNet, setFixedNet] = useState(base?.fixed_network ?? "");
  const [fixedSubnet, setFixedSubnet] = useState(base?.fixed_subnet ?? "");
  const [dns, setDns] = useState(base?.dns_nameserver ?? "");
  // Older templates may hold a flavor id: shown (and saved, when changed) as its name.
  const [flavor, setFlavor] = useState<string | null>(null);
  const [masterFlavor, setMasterFlavor] = useState<string | null>(null);
  const [cni, setCni] = useState(base?.network_driver && NETWORK_DRIVERS.includes(base.network_driver) ? base.network_driver : "calico");
  const [pub, setPub] = useState(template?.public ?? false);
  const [hidden, setHidden] = useState(template?.hidden ?? false);
  const [labels, setLabels] = useState<KvRow[]>(toRows(labelsOf(base?.labels)));

  // Labels with their own field in the form, kept in the label rows.
  const lbl = fromRows(labels);
  const setLabel = (key: string, value: string | null) => {
    const rest = labels.filter((r) => r.key.trim() !== key);
    setLabels(value === null ? rest : [...rest, { key, value }]);
  };
  const apiFip = labelOn(lbl, "master_lb_floating_ip_enabled", true);
  const provider = lbl.octavia_provider ?? "";

  const external = (nets.data ?? []).filter((n) => n["router:external"]);
  const internal = (nets.data ?? []).filter((n) => !n["router:external"]);
  const netSubnets = (subnets.data ?? []).filter((s) => s.network_id === fixedNet);
  // Flavors are sent by name: the driver passes the value to capi-helm-charts as `machineFlavor`,
  // which Cluster API (CAPO) looks up by name, so an id is accepted by Magnum but no server is built.
  const flavorOpts = (flavors.data ?? []).map((f) => ({
    value: f.name,
    label: f.name,
    description: `${f.vcpus} vCPU · ${Math.round(f.ram / 1024)} GiB RAM · ${f.disk} GB`,
    disabled: flavorTooSmall(f),
  }));
  const asName = (v?: string | null) => (v ? (flavors.data?.find((f) => f.id === v)?.name ?? v) : "");
  const flavorV = flavor ?? asName(base?.flavor_id);
  const masterFlavorV = masterFlavor ?? asName(base?.master_flavor_id);
  const img = images.data?.find((i) => i.id === image || i.name === image);
  const problems: Partial<Record<Step, string>> = {};
  if (!name.trim()) problems.basics = tr("Enter a name");
  if (!image) problems.basics = tr("Choose an image");
  else if (img && imageProblem(img)) problems.basics = imageProblem(img) as string;
  if (!extNet) problems.network = tr("Choose the external network");
  if (!flavorV || !masterFlavorV) problems.nodes = tr("Choose the master and worker flavors");
  const kvProblem = kvError(labels);
  if (kvProblem) problems.labels = kvProblem;

  const form: Form = {
    name: name.trim(),
    coe: "kubernetes",
    image_id: image,
    keypair_id: empty(keypair),
    external_network_id: extNet,
    fixed_network: empty(fixedNet),
    fixed_subnet: empty(fixedSubnet),
    dns_nameserver: empty(dns),
    // Editing without touching the flavor keeps the template's value (no patch); a new or cloned
    // template always gets the name.
    flavor_id: template && flavor === null ? template.flavor_id : empty(flavorV),
    master_flavor_id: template && masterFlavor === null ? template.master_flavor_id : empty(masterFlavorV),
    network_driver: cni,
    // The driver always puts a load balancer in front of the API; Magnum needs this for 3+ masters.
    master_lb_enabled: true,
    labels: lbl,
    ...(admin ? { public: pub, hidden } : {}),
  };

  const run = async () => {
    if (template) {
      const before: Record<string, unknown> = { ...template, labels: labelsOf(template.labels) };
      const ops = diffPatch(before, form as Record<string, unknown>).filter((o) => o.path !== "/coe");
      if (!ops.length) return template;
      return patchTemplate(template.uuid, ops);
    }
    const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== null && v !== ""));
    return os.post<ClusterTemplate>(MG, "clustertemplates", body);
  };

  const stepLabel: Record<Step, string> = { basics: tr("Basics"), network: tr("Network"), nodes: tr("Nodes"), labels: tr("Labels") };
  const imgOpts = (images.data ?? [])
    .map((i) => ({
      value: i.id,
      label: i.name ?? i.id,
      description: [imageKubeVersion(i) && `Kubernetes ${imageKubeVersion(i)}`, i.os_distro as string | undefined, i.visibility].filter(Boolean).join(" · "),
      disabled: imageProblem(i),
      group: imageProblem(i) ? tr("Other images") : tr("Kubernetes images"),
    }))
    .sort((a, b) => (a.group === b.group ? 0 : a.disabled ? 1 : -1));
  return (
    <ActionDialog<ClusterTemplate>
      onClose={onClose}
      size="xl"
      title={template ? tr("Edit {name}", { name: mgName(template) }) : tr("Create cluster template")}
      description={
        template && inUse
          ? tr("This template is used by {n} cluster(s); Magnum only lets admins change a template in use, and only some attributes.", { n: inUse })
          : tr("Clusters copy the template's settings when they are created; later changes don't touch existing clusters.")
      }
      submitLabel={template ? tr("Save") : tr("Create template")}
      canSubmit={Object.keys(problems).length === 0}
      done={(t) => (template ? tr("Template updated") : tr("Template {name} created", { name: mgName(t) }))}
      refresh={[MG]}
      run={run}
    >
      <Tabs value={step} onChange={setStep} tabs={STEPS.map((s, i) => ({ id: s, label: `${i + 1}. ${stepLabel[s]}${problems[s] ? " •" : ""}` }))} />
      {step === "basics" && (
        <>
          <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="k8s-1.30" />}</Field>
          <Field
            label={tr("Image")}
            hint={tr("A Cluster API node image. Its os_distro (ubuntu or flatcar) and kube_version properties tell the driver how to set it up and which Kubernetes version to run.")}
          >
            {(id) => <Picker id={id} value={image} onChange={setImage} loading={images.isPending} options={imgOpts} />}
          </Field>
          {img && imageKubeVersion(img) && <p className="text-sm text-muted">{tr("Clusters from this template run Kubernetes {v}.", { v: imageKubeVersion(img)! })}</p>}
          <Field label={tr("Key pair")} hint={tr("SSH key put on every node. Clusters can choose another one.")}>
            {(id) => (
              <Picker
                id={id}
                value={keypair}
                onChange={setKeypair}
                loading={keypairs.isPending}
                options={[{ value: "", label: tr("None") }, ...(keypairs.data ?? []).map((k) => ({ value: k.name, label: k.name, description: k.fingerprint }))]}
              />
            )}
          </Field>
          {admin && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Switch checked={pub} onChange={setPub} label={tr("Public")} hint={tr("Every project can create clusters from it.")} />
              <Switch checked={hidden} onChange={setHidden} label={tr("Hidden")} hint={tr("Kept for existing clusters but not offered for new ones.")} />
            </div>
          )}
        </>
      )}
      {step === "network" && (
        <>
          <Field label={tr("External network")} hint={tr("Where floating IPs and the API load balancer's public address come from.")}>
            {(id) => <Picker id={id} value={extNet} onChange={setExtNet} loading={nets.isPending} options={external.map((n) => ({ value: n.id, label: n.name || n.id }))} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("Fixed network")} hint={tr("Empty: Magnum creates a network and router for each cluster.")}>
              {(id) => (
                <Picker
                  id={id}
                  value={fixedNet}
                  onChange={(v) => {
                    setFixedNet(v);
                    setFixedSubnet("");
                  }}
                  options={[{ value: "", label: tr("New network per cluster") }, ...internal.map((n) => ({ value: n.id, label: n.name || n.id }))]}
                />
              )}
            </Field>
            <Field label={tr("Fixed subnet")}>
              {(id) => (
                <Picker
                  id={id}
                  value={fixedSubnet}
                  onChange={setFixedSubnet}
                  options={[{ value: "", label: fixedNet ? tr("Choose a subnet") : "—" }, ...netSubnets.map((s) => ({ value: s.id, label: s.name || s.id, description: s.cidr }))]}
                />
              )}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={tr("CNI")} hint={tr("Pod networking of the cluster.")}>
              {(id) => <Picker id={id} value={cni} onChange={setCni} options={NETWORK_DRIVERS.map((d) => ({ value: d, label: d }))} />}
            </Field>
            <Field label={tr("Load balancer provider")} hint={tr("For the API and for Services of type LoadBalancer.")}>
              {(id) => (
                <Picker
                  id={id}
                  value={provider}
                  onChange={(v) => setLabel("octavia_provider", v || null)}
                  options={[{ value: "", label: tr("Cloud default") }, ...OCTAVIA_PROVIDERS.map((p) => ({ value: p, label: p }))]}
                />
              )}
            </Field>
            <Field label={tr("DNS nameserver")} hint={tr("Comma-separated.")}>
              {(id) => <Input id={id} value={dns} onChange={(e) => setDns(e.target.value)} placeholder="8.8.8.8" />}
            </Field>
          </div>
          <Switch
            checked={apiFip}
            onChange={(v) => setLabel("master_lb_floating_ip_enabled", v ? null : "false")}
            label={tr("Public address for the API")}
            hint={tr("A floating IP on the API load balancer (label master_lb_floating_ip_enabled). Off: the API is only reachable from the cluster's network.")}
          />
        </>
      )}
      {step === "nodes" && (
        <>
          <p className="text-sm text-muted">{tr("The driver needs at least {mb} MB RAM and {n} vCPUs per node (magnum.conf may set other minimums).", { mb: 2048, n: 2 })}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("Master flavor")}>{(id) => <Picker id={id} value={masterFlavorV} onChange={setMasterFlavor} loading={flavors.isPending} options={flavorOpts} />}</Field>
            <Field label={tr("Worker flavor")}>{(id) => <Picker id={id} value={flavorV} onChange={setFlavor} loading={flavors.isPending} options={flavorOpts} />}</Field>
          </div>
          <p className="text-sm text-muted">{tr("Root disk, etcd disk and persistent volume settings are labels: boot_volume_size, etcd_blockdevice_size, csi_cinder_*.")}</p>
        </>
      )}
      {step === "labels" && (
        <>
          <p className="text-sm text-muted">{tr("Labels tune the driver: add-ons, autoscaling, load balancers, storage… Clusters inherit them and can override them.")}</p>
          <KeyValueEditor rows={labels} onChange={setLabels} suggestions={LABEL_SUGGESTIONS} addLabel={tr("Add label")} empty={tr("No labels: the driver's defaults apply.")} />
        </>
      )}
    </ActionDialog>
  );
}
