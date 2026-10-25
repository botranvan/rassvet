import { useParams } from "react-router";
import { Link, useInAdmin, useNavigate } from "@/components/Link";
import { type Column, DataTable } from "@/components/DataTable";
import { ActionMenu } from "@/components/Menu";
import { Badge, Card, Detail, ErrorNotice, Icon, Mono, PageHeader, StatusDot, Tabs } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import { type Snapshot, type Volume, age, os, useOsGet, useSnapshots, volumeBusy, volumeStatus } from "@/lib/os";
import { useSession } from "@/lib/session";
import { useTab } from "@/lib/useTab";
import { type Backup, backupBusy, useBackups, useVolumeGroups } from "@/lib/cinder";
import { useBackupActions } from "./Backups";
import { useServerNames, useSnapshotActions, useVolumeActions } from "./volumeActions";
import { tr, trx } from "@/lib/i18n";

const TABS = ["overview", "snapshots", "backups"] as const;

export default function VolumeDetail() {
  const { id = "" } = useParams();
  const session = useSession().data!;
  const vol = useOsGet<Volume>("volume", `volumes/${id}`, (r: { volume: Volume }) => r.volume, { poll: volumeBusy });
  // Admin screens: the volume can be another project's, so look across projects.
  const scope = useInAdmin() ? { all_tenants: 1 } : {};
  const snapshots = useSnapshots({ volume_id: id, ...scope });
  const serverName = useServerNames();
  const projects = useProjects(session.is_admin);
  const navigate = useNavigate();
  const actions = useVolumeActions({ onDeleted: () => navigate("/storage/volumes") });
  const snapActions = useSnapshotActions();
  const backups = useBackups({ volume_id: id, ...scope });
  const backupActions = useBackupActions();
  const groups = useVolumeGroups(scope);
  const [tab, setTab] = useTab(TABS, "overview");
  const v = vol.data;
  const pid = v?.["os-vol-tenant-attr:tenant_id"];
  const projectName = (p: string) => projects.data?.find((x) => x.id === p)?.name ?? session.projects.find((x) => x.id === p)?.name ?? p;

  const volBackups = backups.data?.filter((b) => b.volume_id === id);
  const group = v?.group_id ? groups.data?.find((g) => g.id === v.group_id) : undefined;
  const backupCols: Column<Backup>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (b) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <span className="truncate font-medium">{b.name || b.id}</span>
          {b.is_incremental && <Badge tone="accent">{tr("incremental")}</Badge>}
        </span>
      ),
      value: (b) => b.name || b.id,
    },
    { key: "status", header: tr("Status"), width: "8rem", cell: (b) => <StatusDot status={backupBusy(b) ? "warn" : volumeStatus(b)} label={b.status} />, value: (b) => b.status },
    { key: "size", header: tr("Size"), width: "5.5rem", className: "text-right", cell: (b) => tr("{size} GiB", { size: b.size }), value: (b) => b.size },
    { key: "created", header: tr("Created"), width: "10rem", hideBelow: "sm", cell: (b) => fmtDate(b.created_at), value: (b) => b.created_at },
  ];
  const snapCols: Column<Snapshot>[] = [
    { key: "name", header: tr("Name"), cell: (s) => <span className="font-medium">{s.name || s.id}</span>, value: (s) => s.name || s.id },
    { key: "status", header: tr("Status"), width: "8.5rem", cell: (s) => <StatusDot status={volumeStatus(s)} label={s.status} />, value: (s) => s.status },
    { key: "size", header: tr("Size"), width: "5.5rem", className: "text-right", cell: (s) => tr("{size} GiB", { size: s.size }), value: (s) => s.size },
    { key: "created", header: tr("Created"), width: "10rem", hideBelow: "sm", cell: (s) => fmtDate(s.created_at), value: (s) => s.created_at },
  ];

  return (
    <>
      <Link to="/storage/volumes" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Volumes")}
      </Link>
      <PageHeader
        title={v?.name || v?.id || tr("Volume")}
        description={
          v
            ? v.description ||
              tr("{size} GiB {v} volume, {v2}", { size: v.size, v: v.volume_type ?? "", v2: v.attachments.length ? tr("attached to {map}", { map: v.attachments.map((a) => serverName(a.server_id)).join(", ") }) : tr("not attached") })
            : undefined
        }
        actions={v && <ActionMenu variant="button" items={() => actions.items(v, "detail")} />}
      />
      <ErrorNotice error={vol.error} className="mb-4" />
      {v && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "snapshots", label: tr("Snapshots ({v})", { v: snapshots.data?.length ?? "…" }) },
              { id: "backups", label: tr("Backups ({v})", { v: volBackups?.length ?? "…" }) },
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <Card title={tr("Details")}>
                <dl>
                  <Detail label={tr("Name")}>{v.name || "—"}</Detail>
                  <Detail label="ID">
                    <Mono>{v.id}</Mono>
                  </Detail>
                  <Detail label={tr("Description")} wrap>
                    {v.description || <span className="text-muted">{tr("No description")}</span>}
                  </Detail>
                  {pid && <Detail label={tr("Project")}>{projectName(pid)}</Detail>}
                  <Detail label={tr("Status")}>
                    <StatusDot status={volumeStatus(v)} label={v.status} />
                  </Detail>
                  <Detail label={tr("Zone")}>{v.availability_zone ?? "—"}</Detail>
                  {v.group_id && (
                    <Detail label={tr("Volume group")}>
                      <Link to={`/storage/groups/${v.group_id}`} className="text-cable hover:underline">
                        {group?.name || v.group_id}
                      </Link>
                    </Detail>
                  )}
                  <Detail label={tr("Created")}>{fmtDate(v.created_at)}</Detail>
                  <Detail label={tr("Age")}>{age(v.created_at)}</Detail>
                </dl>
              </Card>
              <div className="space-y-6">
                <Card title={tr("Specs")}>
                  <dl>
                    <Detail label={tr("Size")}>{trx("{size} GiB", { size: v.size })}</Detail>
                    <Detail label={tr("Type")}>{v.volume_type ?? "—"}</Detail>
                    <Detail label={tr("Bootable")}>{v.bootable === "true" ? tr("Yes") : tr("No")}</Detail>
                    {v["os-vol-host-attr:host"] && (
                      <Detail label={tr("Host")}>
                        <Mono>{v["os-vol-host-attr:host"]}</Mono>
                      </Detail>
                    )}
                    {v.migration_status && <Detail label={tr("Migration")}>{v.migration_status}</Detail>}
                    <Detail label={tr("Encrypted")}>{v.encrypted ? tr("Yes") : tr("No")}</Detail>
                    <Detail label={tr("Multi-attach")}>{v.multiattach ? tr("Yes") : tr("No")}</Detail>
                    {v.snapshot_id && <Detail label={tr("From snapshot")}><Mono>{v.snapshot_id}</Mono></Detail>}
                    {v.source_volid && (
                      <Detail label={tr("Copied from")}>
                        <Link to={`/storage/volumes/${v.source_volid}`} className="text-cable hover:underline">
                          <Mono>{v.source_volid}</Mono>
                        </Link>
                      </Detail>
                    )}
                  </dl>
                </Card>
                <Card title={tr("Attachments")} flush>
                  <ul>
                    {v.attachments.map((a) => (
                      <li key={a.server_id} className="flex items-center gap-3 border-b border-line px-5 py-2.5 text-sm last:border-0">
                        <Icon name="server" className="text-muted" />
                        <div className="min-w-0 flex-1">
                          <Link to={`/compute/instances/${a.server_id}`} className="block truncate font-medium text-cable hover:underline">
                            {serverName(a.server_id)}
                          </Link>
                        </div>
                        {a.device && <Mono className="text-muted">{a.device}</Mono>}
                      </li>
                    ))}
                    {v.attachments.length === 0 && <li className="px-5 py-6 text-center text-sm text-muted">{tr("Not attached to any instance.")}</li>}
                  </ul>
                </Card>
                {v.volume_image_metadata && Object.keys(v.volume_image_metadata).length > 0 && (
                  <Card title={tr("Image metadata")}>
                    <dl>
                      {Object.entries(v.volume_image_metadata)
                        .sort(([a], [b]) => (a === "image_name" ? -1 : b === "image_name" ? 1 : a.localeCompare(b)))
                        .map(([k, val]) => (
                          <Detail key={k} label={k}>
                            {k === "image_id" ? <Mono>{val}</Mono> : val}
                          </Detail>
                        ))}
                    </dl>
                  </Card>
                )}
              </div>
            </div>
          )}
          {tab === "snapshots" && (
            <DataTable
              rows={snapshots.data}
              columns={snapCols}
              rowKey={(s) => s.id}
              loading={snapshots.isPending}
              tableId="volume-snapshots"
              noun={tr("snapshots")}
              rowLabel={(s) => s.name || s.id}
              empty={tr("No snapshots of this volume.")}
              onRefresh={() => snapshots.refetch()}
              refreshing={snapshots.isFetching}
              rowActions={snapActions.items}
              bulkActions={[
                {
                  id: "delete",
                  label: tr("Delete"),
                  icon: "trash",
                  danger: true,
                  title: tr("Delete snapshots?"),
                  past: tr("deleted"),
                  check: (s) => (s.group_snapshot_id ? tr("Part of a group snapshot; delete the group snapshot instead") : true),
                  run: (s) => os.del("volume", `snapshots/${s.id}`),
                },
              ]}
            />
          )}
          {tab === "backups" && (
            <DataTable
              rows={volBackups}
              columns={backupCols}
              rowKey={(b) => b.id}
              loading={backups.isPending}
              tableId="volume-backups"
              noun={tr("backups")}
              rowLabel={(b) => b.name || b.id}
              empty={tr("No backups of this volume. Create one from the Actions menu.")}
              onRefresh={() => backups.refetch()}
              refreshing={backups.isFetching}
              rowActions={backupActions.items}
            />
          )}
          {v.bootable === "true" && tab === "overview" && (
            <p className="mt-4 text-sm text-muted">
              <Badge tone="accent">{tr("bootable")}</Badge>{" "}{tr("This volume can be the boot disk of a new instance.")}
            </p>
          )}
        </>
      )}
      {actions.dialogs}
      {snapActions.dialogs}
      {backupActions.dialogs}
    </>
  );
}
