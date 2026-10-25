import { useState } from "react";
import { useNewParam } from "@/lib/useTab";
import { Link } from "@/components/Link";
import { type Column, DataTable } from "@/components/DataTable";
import { Button, ErrorNotice, Icon, PageHeader, StatusDot } from "@/components/ui";
import { useProjects } from "@/lib/identity";
import { VOLUME_STATUSES, choice, filters, text, useProjectFilter, useZoneFilter, idFilter } from "@/lib/filters";
import { type Volume, os, useInvalidate, useListOrPages, volumeBusy, volumeStatus } from "@/lib/os";
import { AcceptTransferDialog } from "./Transfers";
import { CreateVolumeDialog, useServerNames, useVolumeActions } from "./volumeActions";
import { tr, trx } from "@/lib/i18n";

export { CreateVolumeDialog, useServerNames } from "./volumeActions";

export default function Volumes({ admin = false }: { admin?: boolean }) {
  const filterProject = useProjectFilter(admin);
  const filterZone = useZoneFilter("volume");
  const volumes = useListOrPages<Volume>(true, "volume", "volumes/detail", "volumes", admin ? { all_tenants: 1 } : undefined, {
    filters: filters(
      text("name", tr("Name"), "name~", tr("Name contains…")),
      idFilter("volumes", "volume"),
      filterProject,
      choice("status", tr("Status"), "status", VOLUME_STATUSES),
      filterZone,
      { key: "bootable", label: tr("Bootable"), param: "bootable", options: [{ value: "true", label: tr("Bootable") }, { value: "false", label: tr("Not bootable") }] },
    ),
    sort: { name: "name", size: "size", status: "status", az: "availability_zone", bootable: "bootable", ...(admin ? { project: "project_id" } : {}) },
    tableId: admin ? "admin-volumes" : "volumes",
    poll: (rows) => rows.some(volumeBusy),
  });
  const projects = useProjects(admin);
  const serverName = useServerNames();
  const invalidate = useInvalidate();
  const actions = useVolumeActions();
  const [creating, setCreating] = useState(false);
  useNewParam(setCreating);
  const [accepting, setAccepting] = useState(false);
  const projectName = (v: Volume) => {
    const p = v["os-vol-tenant-attr:tenant_id"] ?? "";
    return projects.data?.find((x) => x.id === p)?.name ?? p;
  };
  const projectCol: Column<Volume> = { key: "project", header: tr("Project"), width: "9rem", hideBelow: "md", cell: projectName, value: projectName };

  const attachedTo = (v: Volume) => v.attachments.map((a) => `${a.device ?? ""} on ${serverName(a.server_id)}`.trim()).join(", ");
  const yesNo = (b: boolean | undefined) => (b ? "Yes" : "No");
  const columns: Column<Volume>[] = [
    {
      key: "name",
      header: tr("Name"),
      // Attachments as a subline; the description is on the volume's page (and on hover).
      cell: (v) => (
        <span className="flex min-w-0 flex-col">
          <Link to={`/storage/volumes/${v.id}`} className="truncate font-medium text-cable hover:underline" title={v.description || undefined}>
            {v.name || <span className="font-mono text-[12.5px] font-normal">{v.id}</span>}
          </Link>
          <span className="truncate text-xs text-muted" title={attachedTo(v) || tr("Not attached")}>
            {v.attachments.length ? (
              v.attachments.map((a, i) => (
                <span key={a.server_id}>
                  {i > 0 && ", "}
                  <Link to={`/compute/instances/${a.server_id}`} className="text-ink/80 hover:text-cable hover:underline" onClick={(e) => e.stopPropagation()}>
                    {serverName(a.server_id)}
                  </Link>
                  {a.device && <span className="font-mono text-[11.5px]"> {a.device}</span>}
                </span>
              ))
            ) : (
              tr("Not attached")
            )}
          </span>
        </span>
      ),
      value: (v) => v.name || v.id,
      csv: (v) => v.name || v.id,
    },
    ...(admin ? [projectCol] : []),
    { key: "size", header: tr("Size"), width: "5.5rem", className: "text-right", cell: (v) => <span className="tabular-nums">{trx("{size} GiB", { size: v.size })}</span>, value: (v) => v.size },
    { key: "status", header: tr("Status"), width: "9rem", cell: (v) => <StatusDot status={volumeStatus(v)} label={v.status} />, value: (v) => v.status },
    { key: "type", header: tr("Type"), width: "7rem", hideBelow: "lg", cell: (v) => v.volume_type ?? "—", value: (v) => v.volume_type ?? "" },
    { key: "az", header: tr("Zone"), width: "6.5rem", hideBelow: "xl", cell: (v) => v.availability_zone ?? "", value: (v) => v.availability_zone ?? "" },
    { key: "bootable", header: tr("Bootable"), width: "6rem", hideBelow: "lg", cell: (v) => yesNo(v.bootable === "true"), value: (v) => yesNo(v.bootable === "true") },
    { key: "encrypted", header: tr("Encrypted"), width: "6.5rem", hideBelow: "2xl", cell: (v) => yesNo(v.encrypted), value: (v) => yesNo(v.encrypted) },
  ];

  return (
    <>
      <PageHeader
        title={admin ? tr("All volumes") : tr("Volumes")}
        description={
          admin
            ? tr("Volumes of every project. Actions run with admin rights, so they work on other projects' volumes too.")
            : tr("Block storage from Cinder. Instances boot from volumes by default; extra volumes can be attached as data disks.")
        }
        actions={
          !admin && (
            <>
              <Button onClick={() => setAccepting(true)}>
                <Icon name="inbox" />
                {tr("Accept transfer")}
              </Button>
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Icon name="plus" />
                {tr("Create volume")}
              </Button>
            </>
          )
        }
      />
      <ErrorNotice error={volumes.error} className="mb-4" />
      <DataTable
        rows={volumes.rows}
        remote={volumes.remote}
        loadingMore={volumes.partial}
        columns={columns}
        rowKey={(v) => v.id}
        loading={volumes.isPending}
        tableId={admin ? "admin-volumes" : "volumes"}
        noun={tr("volumes")}
        rowLabel={(v) => v.name || v.id}
        pendingCell={(v) => (
          <Link to={`/storage/volumes/${v.id}`} className="text-cable hover:underline">
            {v.name || <span className="font-mono text-[12.5px] font-normal">{v.id}</span>}
          </Link>
        )}
        empty={tr("No volumes yet.")}
        onRefresh={() => volumes.refetch()}
        refreshing={volumes.isFetching}
        onBulkDone={() => invalidate("volume", "compute")}
        rowActions={(v) => actions.items(v)}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete volumes?"),
            past: tr("deleted"),
            body: tr("Volume data is destroyed. Volumes with snapshots must have their snapshots deleted first. This can't be undone."),
            check: (v) => (v.attachments.length ? tr("Attached to {attachedTo}; detach it first", { attachedTo: attachedTo(v) }) : volumeStatus(v) === "warn" ? tr("Busy ({status})", { status: v.status }) : true),
            run: (v) => os.del("volume", `volumes/${v.id}`),
          },
        ]}
      />
      <CreateVolumeDialog open={creating} onClose={() => setCreating(false)} />
      {accepting && <AcceptTransferDialog onClose={() => setAccepting(false)} />}
      {actions.dialogs}
    </>
  );
}
