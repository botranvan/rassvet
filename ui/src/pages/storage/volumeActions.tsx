/**
 * Volume and volume snapshot actions shared by the lists, the volume detail page and
 * the instance's Volumes tab, plus the "Create volume" dialog.
 */
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useInAdmin, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { Dialog } from "@/components/Dialog";
import type { MenuEntry } from "@/components/Menu";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Button, ErrorNotice, Field, Input, Mono, Switch, Tabs, Textarea } from "@/components/ui";
import { datedName } from "@/lib/format";
import { DISK_FORMATS, useImages } from "@/lib/image";
import {
  defaultVolumeType,
  type Snapshot,
  type Volume,
  os,
  useInvalidate,
  useOsGet,
  useServers,
  useSnapshots,
  useVolumeAZs,
  useVolumeLimits,
  useVolumeTypes,
  useVolumes,
} from "@/lib/os";
import { useSession } from "@/lib/session";
import { CreateBackupDialog } from "./Backups";
import { CreateTransferDialog } from "./Transfers";
import { tr } from "@/lib/i18n";

export function useServerNames() {
  // On admin screens the instances may belong to any project.
  const servers = useServers(useInAdmin() ? { all_tenants: 1 } : undefined);
  return useMemo(() => {
    const m = new Map(servers.data?.map((s) => [s.id, s.name]));
    return (id: string) => m.get(id) ?? id;
  }, [servers.data]);
}

const READY = ["available", "in-use"];
const volName = (v: Volume) => v.name || v.id;

type Kind =
  | "edit"
  | "extend"
  | "attach"
  | "detach"
  | "snapshot"
  | "backup"
  | "transfer"
  | "retype"
  | "upload"
  | "copy"
  | "bootable"
  | "reset"
  | "migrate"
  | "delete";

export function useVolumeActions({ onDeleted }: { onDeleted?: () => void } = {}) {
  const navigate = useNavigate();
  const session = useSession().data!;
  const serverName = useServerNames();
  const [open, setOpen] = useState<{ kind: Kind; volume: Volume } | null>(null);
  const close = () => setOpen(null);
  const dlg = (v: Volume, kind: Kind) => () => setOpen({ kind, volume: v });

  const items = (v: Volume, where: "list" | "detail" = "list"): MenuEntry[] => {
    const ready = READY.includes(v.status) ? false : tr("Not possible while {status}", { status: v.status });
    const attached = v.attachments.length > 0;
    const canAttach = v.status === "available" || (v.multiattach && v.status === "in-use");
    return [
      where === "list" && { label: tr("View details"), icon: "eye", onSelect: () => navigate(`/storage/volumes/${v.id}`) },
      where === "list" && "-",
      { label: tr("Edit volume"), icon: "edit", onSelect: dlg(v, "edit") },
      { label: tr("Extend volume"), icon: "hard-drive-upload", disabled: ready, onSelect: dlg(v, "extend") },
      { heading: tr("Attachments") },
      { label: tr("Attach to instance"), icon: "plug", disabled: canAttach ? false : attached ? tr("Already attached (not multi-attach)") : ready, onSelect: dlg(v, "attach") },
      attached && {
        label: v.attachments.length > 1 ? tr("Detach from an instance") : tr("Detach from {serverName}", { serverName: serverName(v.attachments[0].server_id) }),
        icon: "unplug",
        onSelect: dlg(v, "detach"),
      },
      "-",
      { label: tr("Create snapshot"), icon: "camera", disabled: ready, onSelect: dlg(v, "snapshot") },
      { label: tr("Create backup"), icon: "database-backup", disabled: ready, onSelect: dlg(v, "backup") },
      { label: tr("Copy to new volume"), icon: "copy-plus", disabled: ready, onSelect: dlg(v, "copy") },
      { label: tr("Upload to image"), icon: "upload", disabled: ready, onSelect: dlg(v, "upload") },
      { label: tr("Change volume type"), icon: "tags", disabled: ready, onSelect: dlg(v, "retype") },
      {
        label: tr("Launch instance"),
        icon: "rocket",
        disabled: v.bootable !== "true" ? tr("Mark it bootable first") : v.status !== "available" ? tr("Only available volumes can boot") : false,
        onSelect: () => navigate(`/compute/instances/launch?source=volume&id=${v.id}`),
      },
      { label: v.bootable === "true" ? tr("Clear bootable flag") : tr("Mark as bootable"), icon: "power", onSelect: dlg(v, "bootable") },
      {
        label: tr("Transfer to another project"),
        icon: "send",
        disabled: attached ? tr("Detach it first") : v.group_id ? tr("Remove it from its volume group first") : v.status !== "available" ? tr("Not possible while {status}", { status: v.status }) : false,
        onSelect: dlg(v, "transfer"),
      },
      session.is_admin && "-",
      session.is_admin && { heading: tr("Admin") },
      session.is_admin && { label: tr("Reset status"), icon: "rotate-ccw", onSelect: dlg(v, "reset") },
      session.is_admin && {
        label: tr("Migrate volume"),
        icon: "arrow-right-left",
        hint: v["os-vol-host-attr:host"]?.split("#")[0] ?? undefined,
        disabled: v.migration_status === "migrating" ? tr("Already migrating") : READY.includes(v.status) ? false : tr("Not possible while {status}", { status: v.status }),
        onSelect: dlg(v, "migrate"),
      },
      "-",
      {
        label: tr("Delete volume"),
        icon: "trash",
        danger: true,
        disabled: attached ? tr("Detach it first") : v.status.endsWith("ing") ? tr("Busy ({status})", { status: v.status }) : false,
        onSelect: dlg(v, "delete"),
      },
    ];
  };

  const o = open;
  const v = o?.volume;
  const dialogs = o && v && (
    <>
      {o.kind === "edit" && <EditVolumeDialog volume={v} onClose={close} />}
      {o.kind === "extend" && <ExtendDialog volume={v} onClose={close} />}
      {o.kind === "attach" && <AttachToServerDialog volume={v} onClose={close} />}
      {o.kind === "detach" && <DetachFromServerDialog volume={v} serverName={serverName} onClose={close} />}
      {o.kind === "snapshot" && <VolumeSnapshotDialog volume={v} onClose={close} />}
      {o.kind === "backup" && <CreateBackupDialog volume={v} onClose={close} />}
      {o.kind === "transfer" && <CreateTransferDialog volume={v} onClose={close} />}
      {o.kind === "copy" && <CreateVolumeDialog open onClose={close} initial={{ source: "volume", id: v.id, size: v.size, name: `${volName(v)}-copy` }} />}
      {o.kind === "upload" && <UploadToImageDialog volume={v} onClose={close} />}
      {o.kind === "retype" && <RetypeDialog volume={v} onClose={close} />}
      {o.kind === "bootable" && (
        <ActionDialog
          onClose={close}
          title={v.bootable === "true" ? tr("Clear the bootable flag of {volName}?", { volName: volName(v) }) : tr("Mark {volName} as bootable?", { volName: volName(v) })}
          submitLabel={v.bootable === "true" ? tr("Clear flag") : tr("Mark bootable")}
          done={tr("Bootable flag updated")}
          refresh={["volume"]}
          run={() => os.action("volume", `volumes/${v.id}`, { "os-set_bootable": { bootable: v.bootable !== "true" } })}
        >
          <p className="text-sm">{tr("Bootable volumes can be chosen as the boot source when launching an instance.")}</p>
        </ActionDialog>
      )}
      {o.kind === "reset" && <ResetVolumeDialog volume={v} onClose={close} />}
      {o.kind === "migrate" && <MigrateVolumeDialog volume={v} onClose={close} />}
      {o.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete {volName}?", { volName: volName(v) })}
          submitLabel={tr("Delete volume")}
          done={tr("Deleting {volName}", { volName: volName(v) })}
          refresh={["volume"]}
          onDone={onDeleted}
          run={() => os.del("volume", `volumes/${v.id}`)}
        >
          <p className="text-sm">{tr("The volume's data is destroyed. Cinder refuses while it has snapshots. This can't be undone.")}</p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs };
}

function EditVolumeDialog({ volume, onClose }: { volume: Volume; onClose: () => void }) {
  const [name, setName] = useState(volume.name ?? "");
  const [description, setDescription] = useState(volume.description ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit {volName}", { volName: volName(volume) })}
      submitLabel={tr("Save")}
      done={tr("Volume updated")}
      refresh={["volume"]}
      run={() => os.put("volume", `volumes/${volume.id}`, { volume: { name: name.trim(), description } })}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

export function ExtendDialog({ volume, onClose }: { volume: Volume; onClose: () => void }) {
  const [size, setSize] = useState(volume.size + 10);
  const limits = useVolumeLimits();
  const left = limits.data && limits.data.maxTotalVolumeGigabytes >= 0 ? limits.data.maxTotalVolumeGigabytes - limits.data.totalGigabytesUsed : null;
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Extend {volName}", { volName: volName(volume) })}
      description={volume.status === "in-use" ? tr("The volume is attached; grow the partition and filesystem in the guest afterwards.") : undefined}
      submitLabel={tr("Extend to {size} GiB", { size })}
      canSubmit={size > volume.size}
      done={tr("Extending {volName} to {size} GiB", { volName: volName(volume), size })}
      refresh={["volume"]}
      run={() => os.action("volume", `volumes/${volume.id}`, { "os-extend": { new_size: size } })}
    >
      <Field label={tr("New size (GiB)")} hint={tr("Currently {size} GiB. Volumes can only grow.{v}", { size: volume.size, v: left != null ? tr(" {left} GiB left in quota.", { left }) : "" })}>
        {(id) => <Input id={id} type="number" min={volume.size + 1} value={size} onChange={(e) => setSize(Number(e.target.value))} />}
      </Field>
    </ActionDialog>
  );
}

export function AttachToServerDialog({ volume, onClose }: { volume: Volume; onClose: () => void }) {
  const servers = useServers();
  const [server, setServer] = useState("");
  const already = new Set(volume.attachments.map((a) => a.server_id));
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Attach {volName}", { volName: volName(volume) })}
      submitLabel={tr("Attach")}
      canSubmit={!!server}
      done={tr("Attaching volume")}
      refresh={["volume", "compute"]}
      run={() => os.post("compute", `servers/${server}/os-volume_attachments`, { volumeAttachment: { volumeId: volume.id } })}
    >
      <Field label={tr("Instance")}>
        {(id) => (
          <Picker
            inlineDescription
            id={id}
            value={server}
            onChange={setServer}
            searchable
            loading={servers.isPending}
            placeholder={tr("Choose an instance")}
            searchPlaceholder={tr("Search instances")}
            options={(servers.data ?? []).map((s) => ({
              value: s.id,
              label: s.name,
              icon: "server",
              description: `${s.status.toLowerCase()} · ${s.flavor.original_name ?? ""}`,
              disabled: already.has(s.id) ? tr("Already attached") : !["ACTIVE", "SHUTOFF", "PAUSED", "SUSPENDED", "SHELVED_OFFLOADED"].includes(s.status) ? tr("Can't attach while {toLowerCase}", { toLowerCase: s.status.toLowerCase() }) : false,
            }))}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

function DetachFromServerDialog({ volume, serverName, onClose }: { volume: Volume; serverName: (id: string) => string; onClose: () => void }) {
  const [server, setServer] = useState(volume.attachments.length === 1 ? volume.attachments[0].server_id : "");
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Detach {volName}?", { volName: volName(volume) })}
      description={tr("Unmount it in the guest first to avoid data loss. Root volumes can't be detached.")}
      submitLabel={tr("Detach")}
      canSubmit={!!server}
      done={tr("Detaching volume")}
      refresh={["volume", "compute"]}
      run={() => os.del("compute", `servers/${server}/os-volume_attachments/${volume.id}`)}
    >
      <Field label={tr("From instance")}>
        {(id) => (
          <Picker
            inlineDescription
            id={id}
            value={server}
            onChange={setServer}
            options={volume.attachments.map((a) => ({ value: a.server_id, label: serverName(a.server_id), description: a.device, icon: "server" }))}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

export function VolumeSnapshotDialog({ volume, onClose }: { volume: Volume; onClose: () => void }) {
  const [name, setName] = useState(datedName(volume.name || `volume-${volume.id.slice(0, 8)}`));
  const [description, setDescription] = useState("");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Create volume snapshot")}
      description={volume.status === "in-use" ? tr("The volume is attached. For a consistent snapshot, stop writes in the guest first.") : undefined}
      submitLabel={tr("Create snapshot")}
      canSubmit={!!name.trim()}
      done={tr("Creating snapshot {name}", { name })}
      refresh={["volume"]}
      run={() => os.post("volume", "snapshots", { snapshot: { volume_id: volume.id, name: name.trim(), description: description || undefined, force: volume.status === "in-use" } })}
    >
      <Field label={tr("Snapshot name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

function UploadToImageDialog({ volume, onClose }: { volume: Volume; onClose: () => void }) {
  const [name, setName] = useState(volume.name || `volume-${volume.id.slice(0, 8)}`);
  const [format, setFormat] = useState("raw");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Upload {volName} to an image", { volName: volName(volume) })}
      description={tr("Cinder copies the volume's data into a new Glance image. Large volumes take a while.")}
      submitLabel={tr("Upload")}
      canSubmit={!!name.trim()}
      done={tr("Uploading to image {name}", { name })}
      refresh={["volume", "compute"]}
      run={() =>
        os.action("volume", `volumes/${volume.id}`, {
          "os-volume_upload_image": { image_name: name.trim(), disk_format: format, container_format: "bare", force: volume.status === "in-use" },
        })
      }
    >
      <Field label={tr("Image name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Disk format")}>
        {(id) => (
          <Picker
            id={id}
            value={format}
            onChange={setFormat}
            options={DISK_FORMATS.filter((f) => ["raw", "qcow2", "vmdk", "vdi", "vhd", "vhdx"].includes(f)).map((f) => ({ value: f, label: f }))}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

function RetypeDialog({ volume, onClose }: { volume: Volume; onClose: () => void }) {
  const types = useVolumeTypes();
  const [type, setType] = useState("");
  const [migrate, setMigrate] = useState(true);
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Change type of {volName}", { volName: volName(volume) })}
      description={tr("Now {v}. Moving to a type on another backend copies the data.", { v: volume.volume_type ?? tr("default") })}
      submitLabel={tr("Change type")}
      canSubmit={!!type}
      done={tr("Changing volume type")}
      refresh={["volume"]}
      run={() => os.action("volume", `volumes/${volume.id}`, { "os-retype": { new_type: type, migration_policy: migrate ? "on-demand" : "never" } })}
    >
      <Field label={tr("New type")}>
        {(id) => (
          <Picker
            id={id}
            value={type}
            onChange={setType}
            loading={types.isPending}
            placeholder={tr("Choose a type")}
            options={(types.data ?? []).map((t) => ({
              value: t.name,
              label: t.name,
              description: t.description ?? undefined,
              disabled: t.name === volume.volume_type ? tr("Current type") : false,
            }))}
          />
        )}
      </Field>
      <Switch checked={migrate} onChange={setMigrate} label={tr("Allow migration")} hint={tr("Needed when the new type lives on a different backend.")} />
    </ActionDialog>
  );
}

const STATUSES = ["available", "in-use", "error", "creating", "deleting", "error_deleting", "attaching", "detaching", "maintenance"];

interface Pool {
  name: string;
  capabilities?: { volume_backend_name?: string; free_capacity_gb?: number | string; total_capacity_gb?: number | string };
}

/** Admin: move a volume to another backend/pool (`os-migrate_volume`); in-use volumes are migrated by Nova live. */
function MigrateVolumeDialog({ volume, onClose }: { volume: Volume; onClose: () => void }) {
  const pools = useOsGet<Pool[]>("volume", "scheduler-stats/get_pools", (r: { pools: Pool[] }) => r.pools, { q: { detail: "True" } });
  const current = volume["os-vol-host-attr:host"] ?? "";
  const [host, setHost] = useState("");
  const [force, setForce] = useState(false);
  const [lock, setLock] = useState(false);
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Migrate {volName}", { volName: volName(volume) })}
      description={tr("Cinder copies the data to the chosen pool and switches the volume over; its ID stays the same. To change the volume type at the same time, use “Change volume type” with migration instead.")}
      submitLabel={tr("Migrate")}
      canSubmit={!!host}
      done={tr("Migration of {volName} started", { volName: volName(volume) })}
      refresh={["volume"]}
      run={() => os.action("volume", `volumes/${volume.id}`, { "os-migrate_volume": { host, force_host_copy: force, lock_volume: lock } })}
    >
      <Field label={tr("Current host")}>{() => <Mono>{current || tr("unknown")}</Mono>}</Field>
      <Field label={tr("Destination pool")} hint={tr("Format host@backend#pool, as the scheduler reports it.")}>
        {(id) => (
          <Picker
            id={id}
            value={host}
            onChange={setHost}
            searchable
            loading={pools.isPending}
            placeholder={tr("Choose a pool")}
            options={(pools.data ?? []).map((p) => ({
              value: p.name,
              label: p.name,
              description: p.capabilities?.volume_backend_name,
              meta: typeof p.capabilities?.free_capacity_gb === "number" ? tr("{free} GB free", { free: String(p.capabilities.free_capacity_gb) }) : undefined,
              disabled: p.name === current ? tr("The volume is already here") : false,
            }))}
          />
        )}
      </Field>
      <Switch checked={force} onChange={setForce} label={tr("Force host-assisted copy")} hint={tr("Copy through the cinder-volume host even when the driver could migrate on the storage itself.")} />
      <Switch checked={lock} onChange={setLock} label={tr("Lock the volume")} hint={tr("Refuse other operations (attach, delete…) on an available volume until the migration ends.")} />
      <ErrorNotice error={pools.error} />
    </ActionDialog>
  );
}

function ResetVolumeDialog({ volume, onClose }: { volume: Volume; onClose: () => void }) {
  const [status, setStatus] = useState(volume.attachments.length ? "in-use" : "available");
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Reset status of {volName}?", { volName: volName(volume) })}
      description={tr("Now {status}. Only changes what Cinder records; the backend isn't touched.", { status: volume.status })}
      submitLabel={tr("Reset status")}
      done={tr("Status set to {status}", { status })}
      refresh={["volume"]}
      run={() => os.action("volume", `volumes/${volume.id}`, { "os-reset_status": { status } })}
    >
      <Field label={tr("Status")}>{(id) => <Picker id={id} value={status} onChange={setStatus} options={STATUSES.map((s) => ({ value: s, label: s }))} />}</Field>
    </ActionDialog>
  );
}

// =========================================================================== snapshots

export function useSnapshotActions() {
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ kind: "volume" | "edit" | "delete"; snap: Snapshot } | null>(null);
  const close = () => setOpen(null);
  const items = (s: Snapshot): MenuEntry[] => {
    const ok = s.status === "available" ? false : tr("Not possible while {status}", { status: s.status });
    return [
      { label: tr("Create volume"), icon: "hard-drive", disabled: ok, onSelect: () => setOpen({ kind: "volume", snap: s }) },
      { label: tr("Launch instance"), icon: "rocket", disabled: ok, onSelect: () => navigate(`/compute/instances/launch?source=volume_snapshot&id=${s.id}`) },
      { label: tr("Edit snapshot"), icon: "edit", onSelect: () => setOpen({ kind: "edit", snap: s }) },
      { label: tr("Open volume"), icon: "eye", onSelect: () => navigate(`/storage/volumes/${s.volume_id}`) },
      s.group_snapshot_id && { label: tr("Open group snapshot"), icon: "camera", onSelect: () => navigate(`/storage/group-snapshots/${s.group_snapshot_id}`) },
      "-",
      { label: tr("Delete snapshot"), icon: "trash", danger: true, disabled: s.group_snapshot_id ? tr("Part of a group snapshot; delete the group snapshot instead") : s.status.endsWith("ing") ? tr("Busy ({status})", { status: s.status }) : false, onSelect: () => setOpen({ kind: "delete", snap: s }) },
    ];
  };
  const o = open;
  const dialogs = o && (
    <>
      {o.kind === "volume" && (
        <CreateVolumeDialog open onClose={close} initial={{ source: "snapshot", id: o.snap.id, size: o.snap.size, name: `${o.snap.name || "snapshot"}-restore` }} />
      )}
      {o.kind === "edit" && <EditSnapshotDialog snap={o.snap} onClose={close} />}
      {o.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete {v}?", { v: o.snap.name || tr("snapshot") })}
          submitLabel={tr("Delete snapshot")}
          done={tr("Deleting snapshot")}
          refresh={["volume"]}
          run={() => os.del("volume", `snapshots/${o.snap.id}`)}
        >
          <p className="text-sm">{tr("Volumes already created from it are not affected. This can't be undone.")}</p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs };
}

function EditSnapshotDialog({ snap, onClose }: { snap: Snapshot; onClose: () => void }) {
  const [name, setName] = useState(snap.name ?? "");
  const [description, setDescription] = useState(snap.description ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit snapshot")}
      submitLabel={tr("Save")}
      done={tr("Snapshot updated")}
      refresh={["volume"]}
      run={() => os.put("volume", `snapshots/${snap.id}`, { snapshot: { name: name.trim(), description } })}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

// =========================================================================== create

type Source = "blank" | "image" | "snapshot" | "volume";

/** Create a volume, blank or from an image, snapshot or another volume. */
export function CreateVolumeDialog({
  open,
  onClose,
  initial,
  group,
}: {
  open: boolean;
  onClose: () => void;
  initial?: { source: Source; id: string; size: number; name?: string };
  /** Create the volume inside this volume group: only the group's types (by name) are offered. */
  group?: { id: string; name: string; types: string[]; az?: string };
}) {
  const types = useVolumeTypes();
  const azs = useVolumeAZs();
  const limits = useVolumeLimits();
  const images = useImages("all", { status: "active" }, open);
  const snapshots = useSnapshots();
  const volumes = useVolumes();
  const invalidate = useInvalidate();
  const toast = useToast();
  const navigate = useNavigate();
  const [source, setSource] = useState<Source>(initial?.source ?? "blank");
  const [sourceId, setSourceId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState("");
  const [size, setSize] = useState<number | "">(initial?.size ?? "");
  const [type, setType] = useState("");
  const [az, setAz] = useState(group?.az ?? "");
  const typeList = group ? (types.data ?? []).filter((t) => group.types.includes(t.name)) : types.data;

  const img = images.data?.images.find((i) => i.id === sourceId);
  const minSize =
    source === "image" && img
      ? Math.max(img.min_disk ?? 0, Math.ceil((img.virtual_size ?? img.size ?? 0) / 1024 ** 3), 1)
      : source === "snapshot"
        ? (snapshots.data?.find((s) => s.id === sourceId)?.size ?? 1)
        : source === "volume"
          ? (volumes.data?.find((v) => v.id === sourceId)?.size ?? 1)
          : 1;
  const effSize = size === "" ? minSize : size;
  const left = limits.data && limits.data.maxTotalVolumeGigabytes >= 0 ? limits.data.maxTotalVolumeGigabytes - limits.data.totalGigabytesUsed : null;

  const m = useMutation({
    mutationFn: async () => {
      const r = await os.post<{ volume: Volume }>("volume", "volumes", {
        volume: {
          name: name.trim() || undefined,
          description: description || undefined,
          size: effSize,
          volume_type: source === "snapshot" || source === "volume" ? undefined : type || defaultVolumeType(typeList) || undefined,
          group_id: group?.id,
          availability_zone: az || undefined,
          imageRef: source === "image" ? sourceId : undefined,
          snapshot_id: source === "snapshot" ? sourceId : undefined,
          source_volid: source === "volume" ? sourceId : undefined,
        },
      });
      return r;
    },
    onSuccess: (r) => {
      toast(tr("Creating volume {v}", { v: r.volume.name || r.volume.id }));
      invalidate("volume");
      close();
      navigate(`/storage/volumes/${r.volume.id}`);
    },
  });
  function close() {
    m.reset();
    if (!initial) {
      setSource("blank");
      setSourceId("");
      setName("");
      setSize("");
    }
    onClose();
  }

  const options =
    source === "image"
      ? (images.data?.images ?? []).map((i) => ({ value: i.id, label: i.name || i.id, icon: "disc-3", description: [i.os_distro, i.disk_format, i.visibility].filter(Boolean).join(" · ") }))
      : source === "snapshot"
        ? (snapshots.data ?? []).filter((s) => s.status === "available").map((s) => ({ value: s.id, label: s.name || s.id, icon: "camera", meta: tr("{size} GiB", { size: s.size }) }))
        : (volumes.data ?? [])
            .filter((v) => READY.includes(v.status))
            .map((v) => ({ value: v.id, label: v.name || v.id, icon: "hard-drive", meta: tr("{size} GiB", { size: v.size }), description: v.volume_type ?? undefined }));

  return (
    <Dialog
      open={open}
      onClose={close}
      title={group ? tr("New volume in {name}", { name: group.name }) : tr("Create volume")}
      onSubmit={() => m.mutate()}
      footer={
        <>
          <Button type="button" onClick={close}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={(source !== "blank" && !sourceId) || effSize < minSize}>
            {tr("Create volume")}
          </Button>
        </>
      }
    >
      <Tabs
        value={source}
        onChange={(s) => {
          setSource(s);
          setSourceId("");
          setSize("");
        }}
        tabs={[
          { id: "blank" as const, label: tr("Empty") },
          { id: "image" as const, label: tr("From image") },
          ...(group
            ? []
            : [
                { id: "snapshot" as const, label: tr("From snapshot") },
                { id: "volume" as const, label: tr("Copy a volume") },
              ]),
        ]}
      />
      {source !== "blank" && (
        <Field label={source === "image" ? tr("Image") : source === "snapshot" ? tr("Snapshot") : tr("Volume")}>
          {(id) => <Picker id={id} value={sourceId} onChange={setSourceId} searchable placeholder={tr("Choose…")} options={options} />}
        </Field>
      )}
      <Field label={tr("Name")}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={tr("Size (GiB)")} hint={`${minSize > 1 ? tr("At least {minSize}. ", { minSize }) : ""}${left != null ? tr("{left} GiB left.", { left }) : ""}`}>
          {(id) => <Input id={id} type="number" min={minSize} value={effSize} onChange={(e) => setSize(e.target.value === "" ? "" : Number(e.target.value))} />}
        </Field>
        <Field label={tr("Type")}>
          {(id) => (
            <Picker
              id={id}
              value={source === "snapshot" || source === "volume" ? "" : type || defaultVolumeType(typeList)}
              onChange={setType}
              disabled={source === "snapshot" || source === "volume"}
              loading={types.isPending}
              placeholder={source === "snapshot" || source === "volume" ? tr("Same as the source") : tr("No volume types")}
              options={(typeList ?? []).map((t) => ({ value: t.name, label: t.name, description: t.description ?? undefined }))}
            />
          )}
        </Field>
        <Field label={tr("Zone")}>
          {(id) => <Picker id={id} value={az} onChange={setAz} disabled={!!group} options={[{ value: "", label: tr("Any") }, ...(azs.data ?? []).map((z) => ({ value: z, label: z }))]} />}
        </Field>
      </div>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}
