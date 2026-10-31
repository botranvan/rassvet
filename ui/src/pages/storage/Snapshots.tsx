import { useMemo } from "react";
import { Link } from "@/components/Link";
import { type Column, DataTable } from "@/components/DataTable";
import { ErrorNotice, PageHeader, StatusDot } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { SNAPSHOT_STATUSES, choice, filters, idFilter, cinderName } from "@/lib/filters";
import { type Snapshot, os, useInvalidate, useOsPaged, useVolumes, volumeStatus } from "@/lib/os";
import { useSnapshotActions } from "./volumeActions";
import { tr, trx } from "@/lib/i18n";

export default function Snapshots() {
  const volumes = useVolumes();
  const snapshots = useOsPaged<Snapshot>("volume", "snapshots/detail", "snapshots", {}, {
    filters: filters(
      cinderName(),
      idFilter("snapshots", "snapshot"),
      choice("status", tr("Status"), "status", SNAPSHOT_STATUSES),
      { key: "volume", label: tr("Volume"), param: "volume_id", options: (volumes.data ?? []).map((v) => ({ value: v.id, label: v.name || v.id, description: tr("{size} GiB", { size: v.size }) })) },
    ),
    sort: { name: "name", status: "status", size: "size", created: "created_at" },
    tableId: "snapshots",
    poll: (rows) => rows.some((s) => /ing$/.test(s.status)),
  });
  const invalidate = useInvalidate();
  const actions = useSnapshotActions();
  const volName = useMemo(() => {
    const m = new Map(volumes.data?.map((v) => [v.id, v.name || v.id]));
    return (id: string) => m.get(id) ?? id;
  }, [volumes.data]);

  const columns: Column<Snapshot>[] = [
    {
      key: "name",
      header: tr("Name"),
      // The source volume as a subline; the description on hover.
      cell: (s) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium" title={s.description || undefined}>
            {s.name || s.id}
          </span>
          <span className="truncate text-xs text-muted">
            {tr("of")}
            <Link to={`/storage/volumes/${s.volume_id}`} className="text-ink/80 hover:text-cable hover:underline">
              {volName(s.volume_id)}
            </Link>
            {s.group_snapshot_id && (
              <>
                {tr("· in")}
                <Link to={`/storage/group-snapshots/${s.group_snapshot_id}`} className="text-ink/80 hover:text-cable hover:underline">
                  {tr("group snapshot")}
                </Link>
              </>
            )}
          </span>
        </span>
      ),
      value: (s) => s.name || s.id,
      csv: (s) => s.name || s.id,
    },
    { key: "status", header: tr("Status"), width: "8.5rem", cell: (s) => <StatusDot status={volumeStatus(s)} label={s.status} />, value: (s) => s.status },
    { key: "size", header: tr("Size"), width: "5.5rem", className: "text-right", cell: (s) => <span className="tabular-nums">{trx("{size} GiB", { size: s.size })}</span>, value: (s) => s.size },
    { key: "created", header: tr("Created"), width: "8.5rem", hideBelow: "lg", cell: (s) => fmtDate(s.created_at, false), value: (s) => s.created_at },
  ];

  return (
    <>
      <PageHeader title={tr("Volume snapshots")} description={tr("Point-in-time copies of volumes. Create a volume from a snapshot, or boot an instance from one.")} />
      <ErrorNotice error={snapshots.query.error} className="mb-4" />
      <DataTable
        rows={snapshots.rows}
        remote={snapshots.remote}
        columns={columns}
        rowKey={(s) => s.id}
        loading={snapshots.query.isPending}
        tableId="snapshots"
        noun={tr("snapshots")}
        rowLabel={(s) => s.name || s.id}
        empty={tr("No snapshots. Create one from a volume's page.")}
        onRefresh={() => snapshots.refetch()}
        refreshing={snapshots.fetching}
        onBulkDone={() => invalidate("volume")}
        rowActions={actions.items}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete snapshots?"),
            past: tr("deleted"),
            body: tr("Volumes already created from these snapshots are not affected. This can't be undone."),
            check: (s) => (s.group_snapshot_id ? tr("Part of a group snapshot; delete the group snapshot instead") : volumeStatus(s) === "warn" ? tr("Busy ({status})", { status: s.status }) : true),
            run: (s) => os.del("volume", `snapshots/${s.id}`),
          },
        ]}
      />
      {actions.dialogs}
    </>
  );
}
