/**
 * Volume backups (cinder-backup): full and incremental copies kept outside the volume
 * backend, restorable into a new or an existing volume.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import type { MenuEntry } from "@/components/Menu";
import { Picker } from "@/components/Picker";
import { Badge, Button, ErrorNotice, Field, Icon, Input, PageHeader, StatusDot, Switch, Tabs, Textarea } from "@/components/ui";
import { type Backup, backupBusy, useBackups } from "@/lib/cinder";
import { datedName, fmtDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import { BACKUP_STATUSES, choice, filters, useProjectFilter, idFilter, cinderName } from "@/lib/filters";
import { type Volume, os, useInvalidate, useListOrPages, useSnapshots, useVolumes, volumeStatus } from "@/lib/os";
import { useSession } from "@/lib/session";
import { tr, trx } from "@/lib/i18n";

const bkName = (b: Backup) => b.name || b.id;

export default function Backups({ admin = false }: { admin?: boolean }) {
  const filterProject = useProjectFilter(admin);
  const volumes = useVolumes(admin ? { all_tenants: 1 } : undefined);
  const backups = useListOrPages<Backup>(true, "volume", "backups/detail", "backups", admin ? { all_tenants: 1 } : undefined, {
    filters: filters(
      cinderName(),
      idFilter("backups", "backup"),
      filterProject,
      choice("status", tr("Status"), "status", BACKUP_STATUSES),
      { key: "volume", label: tr("Volume"), param: "volume_id", options: (volumes.data ?? []).map((v) => ({ value: v.id, label: v.name || v.id, description: tr("{size} GiB", { size: v.size }) })) },
    ),
    sort: { name: "name", status: "status", size: "size", created: "created_at" },
    tableId: admin ? "admin-backups" : "backups",
    poll: (rows) => rows.some(backupBusy),
  });
  const projects = useProjects(admin);
  const invalidate = useInvalidate();
  const actions = useBackupActions();
  const [creating, setCreating] = useState(false);
  const volName = useMemo(() => {
    const m = new Map(volumes.data?.map((v) => [v.id, v.name || v.id]));
    return (id: string) => m.get(id) ?? tr("{id}… (deleted)", { id: id.slice(0, 8) });
  }, [volumes.data]);
  const projectName = (b: Backup) => {
    const p = b["os-backup-project-attr:project_id"] ?? "";
    return projects.data?.find((x) => x.id === p)?.name ?? p;
  };

  const projectCol: Column<Backup> = { key: "project", header: tr("Project"), width: "9rem", cell: projectName, value: projectName };
  const columns: Column<Backup>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (b) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <span className="truncate font-medium">{bkName(b)}</span>
          {b.is_incremental && <Badge tone="accent">{tr("incremental")}</Badge>}
        </span>
      ),
      value: bkName,
    },
    ...(admin ? [projectCol] : []),
    { key: "status", header: tr("Status"), width: "8rem", cell: (b) => <StatusDot status={backupBusy(b) ? "warn" : volumeStatus(b)} label={b.status} />, value: (b) => b.status },
    { key: "size", header: tr("Size"), width: "5.5rem", className: "text-right", cell: (b) => <span className="tabular-nums">{trx("{size} GiB", { size: b.size })}</span>, value: (b) => b.size },
    {
      key: "volume",
      header: tr("Volume"),
      hideBelow: "md",
      cell: (b) => (
        <Link to={`/storage/volumes/${b.volume_id}`} className="text-cable hover:underline" onClick={(e) => e.stopPropagation()}>
          {volName(b.volume_id)}
        </Link>
      ),
      value: (b) => volName(b.volume_id),
    },
    { key: "created", header: tr("Created"), width: "11.5rem", hideBelow: "lg", cell: (b) => fmtDate(b.created_at), value: (b) => b.created_at },
    { key: "container", header: tr("Container"), width: "9rem", hideBelow: "2xl", mono: true, cell: (b) => b.container ?? "—", value: (b) => b.container ?? "" },
    { key: "description", header: tr("Description"), hideBelow: "xl", cell: (b) => <span className="text-muted">{b.description || "—"}</span>, value: (b) => b.description ?? "" },
  ];

  return (
    <>
      <PageHeader
        title={admin ? tr("All backups") : tr("Volume backups")}
        description={tr("Copies of volumes kept by cinder-backup, outside the volume backend. Incremental backups store only what changed since the previous backup of the same volume.")}
        actions={
          !admin && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              {tr("Create backup")}
            </Button>
          )
        }
      />
      <ErrorNotice error={backups.error} className="mb-4" />
      <DataTable
        rows={backups.rows}
        remote={backups.remote}
        loadingMore={backups.partial}
        columns={columns}
        rowKey={(b) => b.id}
        loading={backups.isPending}
        tableId={admin ? "admin-backups" : "backups"}
        noun={tr("backups")}
        rowLabel={bkName}
        empty={tr("No backups yet.")}
        onRefresh={() => backups.refetch()}
        refreshing={backups.isFetching}
        onBulkDone={() => invalidate("volume")}
        rowActions={(b) => actions.items(b)}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete backups?"),
            past: tr("deleted"),
            body: tr("Delete newer incremental backups first; Cinder refuses to delete a backup others depend on."),
            check: (b) => (b.has_dependent_backups ? tr("Has incremental backups that depend on it") : backupBusy(b) ? tr("Busy ({status})", { status: b.status }) : true),
            run: (b) => os.del("volume", `backups/${b.id}`),
          },
        ]}
      />
      {creating && <CreateBackupDialog onClose={() => setCreating(false)} />}
      {actions.dialogs}
    </>
  );
}

type Kind = "restore" | "edit" | "delete" | "reset" | "force";

export function useBackupActions() {
  const session = useSession().data!;
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ kind: Kind; b: Backup } | null>(null);
  const close = () => setOpen(null);
  const dlg = (b: Backup, kind: Kind) => () => setOpen({ kind, b });
  const items = (b: Backup): MenuEntry[] => {
    const ready = b.status === "available" ? false : tr("Not possible while {status}", { status: b.status });
    return [
      { label: tr("Restore"), icon: "archive-restore", disabled: ready, onSelect: dlg(b, "restore") },
      { label: tr("Edit backup"), icon: "edit", onSelect: dlg(b, "edit") },
      { label: tr("Open volume"), icon: "eye", onSelect: () => navigate(`/storage/volumes/${b.volume_id}`) },
      session.is_admin && "-",
      session.is_admin && { heading: tr("Admin") },
      session.is_admin && { label: tr("Reset status"), icon: "rotate-ccw", onSelect: dlg(b, "reset") },
      session.is_admin && { label: tr("Force delete"), icon: "trash", danger: true, onSelect: dlg(b, "force") },
      "-",
      {
        label: tr("Delete backup"),
        icon: "trash",
        danger: true,
        disabled: b.has_dependent_backups ? tr("Newer incremental backups depend on it") : backupBusy(b) ? tr("Busy ({status})", { status: b.status }) : false,
        onSelect: dlg(b, "delete"),
      },
    ];
  };
  const o = open;
  const dialogs = o && (
    <>
      {o.kind === "restore" && <RestoreBackupDialog backup={o.b} onClose={close} />}
      {o.kind === "edit" && <EditBackupDialog backup={o.b} onClose={close} />}
      {o.kind === "reset" && <ResetBackupDialog backup={o.b} onClose={close} />}
      {(o.kind === "delete" || o.kind === "force") && (
        <ActionDialog
          onClose={close}
          danger
          title={`${o.kind === "force" ? tr("Force delete") : tr("Delete")} ${bkName(o.b)}?`}
          submitLabel={o.kind === "force" ? tr("Force delete") : tr("Delete backup")}
          done={tr("Deleting {bkName}", { bkName: bkName(o.b) })}
          refresh={["volume"]}
          run={() => (o.kind === "force" ? os.action("volume", `backups/${o.b.id}`, { "os-force_delete": {} }) : os.del("volume", `backups/${o.b.id}`))}
        >
          <p className="text-sm">
            {o.kind === "force"
              ? tr("Deletes the backup whatever its status, including while it is being created or restored. Use it to clean up stuck backups.")
              : tr("The backup's data is removed from the backup store. This can't be undone.")}
          </p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs };
}

/** Back up a volume; pass `volume` to fix it (from the volume's menu). */
export function CreateBackupDialog({ volume, onClose }: { volume?: Volume; onClose: () => void }) {
  const volumes = useVolumes();
  const [volumeId, setVolumeId] = useState(volume?.id ?? "");
  const v = volume ?? volumes.data?.find((x) => x.id === volumeId);
  const existing = useBackups(volumeId ? { volume_id: volumeId } : undefined);
  const snapshots = useSnapshots(volumeId ? { volume_id: volumeId } : undefined);
  const hasFull = !!existing.data?.some((b) => b.volume_id === volumeId && b.status === "available");
  const [name, setName] = useState(volume ? datedName(volume.name || `volume-${volume.id.slice(0, 8)}`) : "");
  const [description, setDescription] = useState("");
  const [incremental, setIncremental] = useState(false);
  const [snapshot, setSnapshot] = useState("");
  const inUse = v?.status === "in-use";
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={volume ? tr("Back up {v}", { v: volume.name || volume.id }) : tr("Create backup")}
      description={inUse && !snapshot ? tr("The volume is attached, so it is backed up live (force). Quiesce writes in the guest for a consistent copy, or back up from a snapshot.") : undefined}
      submitLabel={tr("Create backup")}
      canSubmit={!!v}
      done={tr("Creating backup {v}", { v: name || "" }).trim()}
      refresh={["volume"]}
      run={() =>
        os.post("volume", "backups", {
          backup: {
            volume_id: v!.id,
            name: name.trim() || undefined,
            description: description || undefined,
            incremental,
            force: inUse,
            snapshot_id: snapshot || undefined,
          },
        })
      }
    >
      {!volume && (
        <Field label={tr("Volume")}>
          {(id) => (
            <Picker
              id={id}
              value={volumeId}
              onChange={(x) => {
                setVolumeId(x);
                setSnapshot("");
                setIncremental(false);
                const nv = volumes.data?.find((y) => y.id === x);
                if (nv && !name) setName(datedName(nv.name || `volume-${nv.id.slice(0, 8)}`));
              }}
              searchable
              loading={volumes.isPending}
              placeholder={tr("Choose a volume")}
              options={(volumes.data ?? []).map((x) => ({
                value: x.id,
                label: x.name || x.id,
                icon: "hard-drive",
                meta: tr("{size} GiB", { size: x.size }),
                description: x.status,
                disabled: ["available", "in-use"].includes(x.status) ? false : tr("Not possible while {status}", { status: x.status }),
              }))}
            />
          )}
        </Field>
      )}
      <Field label={tr("Backup name")}>{(id) => <Input id={id} autoFocus={!!volume} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Field label={tr("From snapshot")} hint={tr("Optional. Backing up a snapshot gives a consistent copy of an attached volume.")}>
        {(id) => (
          <Picker
            id={id}
            value={snapshot}
            onChange={setSnapshot}
            disabled={!volumeId}
            loading={!!volumeId && snapshots.isPending}
            options={[
              { value: "", label: tr("Current volume data") },
              ...(snapshots.data ?? [])
                .filter((s) => s.volume_id === volumeId)
                .map((s) => ({ value: s.id, label: s.name || s.id, icon: "camera", meta: fmtDate(s.created_at, false), disabled: s.status === "available" ? false : s.status })),
            ]}
          />
        )}
      </Field>
      <Switch
        checked={incremental}
        onChange={setIncremental}
        disabled={!hasFull}
        label={tr("Incremental")}
        hint={hasFull ? tr("Store only the blocks changed since the latest backup of this volume.") : tr("Needs an existing backup of this volume to build on.")}
      />
    </ActionDialog>
  );
}

function RestoreBackupDialog({ backup, onClose }: { backup: Backup; onClose: () => void }) {
  const navigate = useNavigate();
  const volumes = useVolumes();
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState(`${backup.name || "backup"}-restore`);
  const [target, setTarget] = useState("");
  return (
    <ActionDialog<{ restore: { volume_id: string } }>
      onClose={onClose}
      size="md"
      title={tr("Restore {bkName}", { bkName: bkName(backup) })}
      description={tr("{size} GiB backup taken {fmtDate}.", { size: backup.size, fmtDate: fmtDate(backup.data_timestamp ?? backup.created_at) })}
      submitLabel={tr("Restore")}
      danger={mode === "existing"}
      canSubmit={mode === "new" || !!target}
      done={tr("Restoring backup")}
      refresh={["volume"]}
      onDone={(r) => navigate(`/storage/volumes/${r.restore.volume_id}`)}
      run={() => os.post("volume", `backups/${backup.id}/restore`, { restore: mode === "new" ? { name: name.trim() || undefined } : { volume_id: target } })}
    >
      <Tabs
        value={mode}
        onChange={setMode}
        tabs={[
          { id: "new", label: tr("Into a new volume") },
          { id: "existing", label: tr("Overwrite a volume") },
        ]}
      />
      {mode === "new" ? (
        <Field label={tr("Volume name")} hint={tr("A {size} GiB volume of the default type is created.", { size: backup.size })}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
      ) : (
        <>
          <Field label={tr("Target volume")} hint={tr("Must be available (detached) and at least as large as the backup.")}>
            {(id) => (
              <Picker
                id={id}
                value={target}
                onChange={setTarget}
                searchable
                loading={volumes.isPending}
                placeholder={tr("Choose a volume")}
                options={(volumes.data ?? []).map((v) => ({
                  value: v.id,
                  label: v.name || v.id,
                  icon: "hard-drive",
                  meta: tr("{size} GiB", { size: v.size }),
                  description: v.volume_type ?? undefined,
                  disabled: v.status !== "available" ? tr("Not possible while {status}", { status: v.status }) : v.size < backup.size ? tr("Smaller than {size} GiB", { size: backup.size }) : false,
                }))}
              />
            )}
          </Field>
          <p className="rounded-md border border-led-red/30 bg-led-red/6 p-3 text-sm">{tr("Everything on the target volume is replaced by the backup's data.")}</p>
        </>
      )}
    </ActionDialog>
  );
}

function EditBackupDialog({ backup, onClose }: { backup: Backup; onClose: () => void }) {
  const [name, setName] = useState(backup.name ?? "");
  const [description, setDescription] = useState(backup.description ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit backup")}
      submitLabel={tr("Save")}
      done={tr("Backup updated")}
      refresh={["volume"]}
      run={() => os.put("volume", `backups/${backup.id}`, { backup: { name: name.trim(), description } })}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

function ResetBackupDialog({ backup, onClose }: { backup: Backup; onClose: () => void }) {
  const [status, setStatus] = useState("available");
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Reset status of {bkName}?", { bkName: bkName(backup) })}
      description={tr("Now {status}. Only changes what Cinder records.", { status: backup.status })}
      submitLabel={tr("Reset status")}
      done={tr("Status set to {status}", { status })}
      refresh={["volume"]}
      run={() => os.action("volume", `backups/${backup.id}`, { "os-reset_status": { status } })}
    >
      <Field label={tr("Status")}>{(id) => <Picker id={id} value={status} onChange={setStatus} options={["available", "error"].map((s) => ({ value: s, label: s }))} />}</Field>
    </ActionDialog>
  );
}
