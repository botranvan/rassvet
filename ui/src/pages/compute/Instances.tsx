import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useNavigate } from "@/components/Link";
import { type BulkAction, type Column, DataTable } from "@/components/DataTable";
import { copyText } from "@/components/CodeBlock";
import { useToast } from "@/components/Toast";
import { Button, ErrorNotice, Icon, PageHeader, StatusDot } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import { NOVA_STATUSES, choice, filters, statusLabel, text, useFlavorFilter, useHostFilter, useProjectFilter, useZoneFilter, idFilter } from "@/lib/filters";
import { type Server, age, serverAction, serverIps, serverLabel, serverStatus, useFlavors, useInvalidate, deleteServer, serverBusy, useListOrPages, useVolumesById } from "@/lib/os";
import { useSession } from "@/lib/session";
import { useServerActions } from "./serverActions";
import { tr } from "@/lib/i18n";

/**
 * What each instance on the page boots from, with the image name: Glance for image-booted
 * ones, the root volume's image metadata for volume-booted ones. Only the rows shown are
 * looked up (one cached request per image / attached volume).
 */
function useBootSources(rows: Server[] | undefined) {
  const imageIds = [...new Set((rows ?? []).flatMap((s) => (s.image ? [s.image.id] : [])))];
  const images = useQueries({
    queries: imageIds.map((id) => ({
      queryKey: ["image", "one", id],
      queryFn: () => api.get<{ id: string; name: string }>(`/image/images/${encodeURIComponent(id)}`),
      retry: false,
      staleTime: 5 * 60_000,
    })),
  });
  const volumeIds = [...new Set((rows ?? []).flatMap((s) => (s.image === "" ? (s["os-extended-volumes:volumes_attached"] ?? []).map((a) => a.id) : [])))];
  const volumes = useVolumesById(volumeIds);
  const imageName = new Map(images.flatMap((q) => (q.data ? [[q.data.id, q.data.name] as const] : [])));
  return (s: Server): { kind: "image" | "volume"; image?: string } => {
    if (s.image) return { kind: "image", image: imageName.get(s.image.id) };
    const mine = (volumes.data ?? []).filter((v) => v.attachments.some((a) => a.server_id === s.id));
    const root = mine.find((v) => v.attachments.some((a) => a.server_id === s.id && /[sv]da$/.test(a.device ?? ""))) ?? mine.find((v) => v.bootable === "true");
    return { kind: "volume", image: root?.volume_image_metadata?.image_name };
  };
}

/** Copy an IP address with one click; a toast confirms it. */
function CopyIp({ addr, floating }: { addr: string; floating: boolean }) {
  const toast = useToast();
  return (
    <button
      type="button"
      title={tr("{v} — click to copy", { v: floating ? tr("Floating IP") : tr("Fixed IP") })}
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(addr)) toast(tr("Copied {addr}", { addr }));
      }}
      className="rounded font-mono text-[13px] hover:bg-cable-soft hover:text-cable focus-visible:outline-2 focus-visible:outline-cable"
    >
      {addr}
    </button>
  );
}

/** Bulk power actions shared by the project and admin lists. */
export function serverBulkActions(): BulkAction<Server>[] {
  const notLocked = (s: Server) => (s.locked ? "Locked" : true);
  return [
    {
      id: "start",
      label: tr("Start"),
      icon: "play",
      title: tr("Start instances?"),
      past: tr("started"),
      check: (s) => (s.status === "SHUTOFF" ? true : tr("Status is {toLowerCase}", { toLowerCase: serverLabel(s).toLowerCase() })),
      run: (s) => serverAction(s.id, { "os-start": null }),
    },
    {
      id: "stop",
      label: tr("Stop"),
      icon: "power",
      title: tr("Stop instances?"),
      past: tr("stopped"),
      body: tr("The guest OS is asked to shut down; Nova powers the instance off if it doesn't within the timeout. Disks are kept."),
      check: (s) => (s.status !== "ACTIVE" ? tr("Status is {toLowerCase}", { toLowerCase: serverLabel(s).toLowerCase() }) : notLocked(s)),
      run: (s) => serverAction(s.id, { "os-stop": null }),
    },
    {
      id: "reboot",
      label: tr("Reboot"),
      icon: "refresh",
      title: tr("Reboot instances?"),
      past: tr("rebooted"),
      body: tr("A soft reboot asks the guest OS to restart."),
      check: (s) => (s.status !== "ACTIVE" ? tr("Status is {toLowerCase}", { toLowerCase: serverLabel(s).toLowerCase() }) : notLocked(s)),
      run: (s) => serverAction(s.id, { reboot: { type: "SOFT" } }),
    },
    {
      id: "delete",
      label: tr("Delete"),
      icon: "trash",
      danger: true,
      title: tr("Delete instances?"),
      past: tr("deleted"),
      body: tr("Instances are destroyed. Root volumes created with “delete on termination” are deleted with them; other attached volumes are detached and kept. This can't be undone."),
      check: notLocked,
      run: (s) => deleteServer(s.id),
    },
  ];
}

export default function Instances({ admin = false }: { admin?: boolean }) {
  const session = useSession().data!;
  // One page at a time from Nova (limit = rows per page, marker = last row), filtered and
  // sorted on the server; admins see every project.
  const filterProject = useProjectFilter(admin);
  const filterHost = useHostFilter(admin);
  const filterFlavor = useFlavorFilter();
  const filterZone = useZoneFilter("compute");
  const servers = useListOrPages<Server>(true, "compute", "servers/detail", "servers", admin ? { all_tenants: 1 } : undefined, {
    filters: filters(
      text("name", tr("Name"), "name", tr("Name (regular expression)")),
      idFilter("servers", "server"),
      filterProject,
      filterHost,
      choice("status", tr("Status"), "status", NOVA_STATUSES, statusLabel),
      text("ip", tr("IP address"), "ip", tr("IP address (regular expression)")),
      text("tags", tr("Tag"), "tags", tr("Tags, comma separated (all must match)")),
      filterFlavor,
      filterZone,
    ),
    sort: { name: "display_name", status: "vm_state", created: "created_at", ...(admin ? { project: "project_id", host: "host" } : { az: "availability_zone" }) },
    tableId: admin ? "admin-instances" : "instances",
    poll: (rows) => rows.some(serverBusy),
  });
  const flavors = useFlavors();
  const boot = useBootSources(servers.rows);
  const projects = useProjects(admin);
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const base = admin ? "/admin/compute/instances" : "/compute/instances";
  const actions = useServerActions({ admin, base });

  const flavorName = useMemo(() => {
    const m = new Map(flavors.data?.map((f) => [f.id, f.name]));
    return (s: Server) => s.flavor.original_name ?? (s.flavor.id ? m.get(s.flavor.id) : undefined) ?? "";
  }, [flavors.data]);
  const projectName = useMemo(() => {
    const m = new Map(projects.data?.map((p) => [p.id, p.name]));
    return (id: string) => m.get(id) ?? id;
  }, [projects.data]);

  const columns: Column<Server>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (s) => {
        const b = boot(s);
        return (
          <span className="flex min-w-0 flex-col">
            <span className="inline-flex max-w-full items-center gap-1.5">
              <Link to={`${base}/${s.id}`} className="truncate font-medium text-cable hover:underline">
                {s.name}
              </Link>
              {s.locked && <Icon name="lock" className="size-3.5 shrink-0 text-muted" />}
            </span>
            <span className="truncate text-xs text-muted" title={tr("Boots from {v}{v2}", { v: b.kind === "image" ? tr("an image") : tr("a volume"), v2: b.image ? `: ${b.image}` : "" })}>
              <Icon name={b.kind === "image" ? "image" : "hard-drive"} className="mr-1 inline size-3 align-[-2px]" />
              {b.kind === "image" ? tr("Image") : tr("Volume")} · {b.image ?? "-"}
            </span>
          </span>
        );
      },
      value: (s) => s.name,
      csv: (s) => `${s.name} (${boot(s).kind}: ${boot(s).image ?? "-"})`,
    },
    {
      key: "status",
      header: tr("Status"),
      width: "11rem",
      // Failed instances show Nova's fault message under the status (full text on hover).
      cell: (s) => (
        <span className="flex min-w-0 flex-col">
          <StatusDot status={serverStatus(s)} label={serverLabel(s)} />
          {s.fault?.message && (
            <span className="truncate pl-4 text-xs text-led-red" title={`${s.fault.code}: ${s.fault.message}`}>
              {s.fault.message}
            </span>
          )}
        </span>
      ),
      value: (s) => `${s.status} ${s.fault?.message ?? ""}`,
      csv: (s) => (s.fault?.message ? `${serverLabel(s)}: ${s.fault.message}` : serverLabel(s)),
    },
    {
      key: "ips",
      header: tr("IP addresses"),
      width: admin ? "14rem" : "16rem",
      hideBelow: "md",
      cell: (s) => {
        const ips = serverIps(s);
        if (!ips.length) return <span className="text-muted">{tr("none")}</span>;
        const nets = [...new Set(ips.map((ip) => ip.net))];
        return (
          <span className="flex min-w-0 flex-col gap-0.5">
            {nets.map((net) => (
              <span key={net} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                <span className="max-w-full truncate font-medium" title={net}>
                  {net}
                </span>
                {ips
                  .filter((ip) => ip.net === net)
                  .sort((a, b) => Number(b.floating) - Number(a.floating))
                  .map((ip) => (
                    <CopyIp key={ip.addr} addr={ip.addr} floating={ip.floating} />
                  ))}
              </span>
            ))}
          </span>
        );
      },
      value: (s) => serverIps(s).map((ip) => `${ip.net} ${ip.addr}`).join(" "),
      csv: (s) => serverIps(s).map((ip) => `${ip.net}=${ip.addr}`).join("; "),
    },
    { key: "flavor", header: tr("Flavor"), width: "8.5rem", hideBelow: "lg", cell: flavorName, value: flavorName },
    ...(admin
      ? [
          {
            key: "project",
            header: tr("Project"),
            width: "9rem",
            hideBelow: "lg",
            cell: (s: Server) => projectName(s.tenant_id),
            value: (s: Server) => projectName(s.tenant_id),
          } satisfies Column<Server>,
          {
            key: "host",
            header: tr("Host"),
            width: "9rem",
            hideBelow: "xl",
            cell: (s: Server) => s["OS-EXT-SRV-ATTR:host"] ?? "",
            value: (s: Server) => s["OS-EXT-SRV-ATTR:host"] ?? "",
          } satisfies Column<Server>,
        ]
      : [
          {
            key: "az",
            header: tr("Zone"),
            width: "7rem",
            hideBelow: "xl",
            cell: (s: Server) => s["OS-EXT-AZ:availability_zone"] ?? "",
            value: (s: Server) => s["OS-EXT-AZ:availability_zone"] ?? "",
          } satisfies Column<Server>,
        ]),
    {
      key: "created",
      header: tr("Age"),
      width: "9rem",
      hideBelow: "lg",
      cell: (s) => (
        <span className="block truncate" title={tr("Created {created}", { created: fmtDate(s.created) })}>
          {age(s.created)}
        </span>
      ),
      value: (s) => s.created,
      csv: (s) => s.created,
    },
  ];

  return (
    <>
      <PageHeader
        title={admin ? tr("All instances") : tr("Instances")}
        description={
          admin
            ? tr("Every instance in the cloud, across all projects.")
            : tr("Virtual machines in this project. New instances boot from a Cinder volume by default.")
        }
        actions={
          !admin && (
            <Button variant="primary" onClick={() => navigate("/compute/instances/launch")} disabled={!session.project}>
              <Icon name="plus" />
              {tr("Launch instance")}
            </Button>
          )
        }
      />
      <ErrorNotice error={servers.error} className="mb-4" />
      <DataTable
        rows={servers.rows}
        columns={columns}
        rowKey={(s) => s.id}
        loading={servers.isPending}
        remote={servers.remote}
        loadingMore={servers.partial}
        tableId={admin ? "admin-instances" : "instances"}
        noun={tr("instances")}
        rowLabel={(s) => s.name}
        pendingCell={(s) => (
          <Link to={`${base}/${s.id}`} className="text-cable hover:underline">
            {s.name}
          </Link>
        )}
        empty={admin ? tr("There are no instances in the cloud.") : tr("No instances yet. Launch one to get started.")}
        bulkActions={serverBulkActions()}
        onRefresh={() => servers.refetch()}
        refreshing={servers.isFetching}
        onBulkDone={() => invalidate("compute", "volume")}
        rowActions={(s) => actions.items(s)}
      />
      {actions.dialogs}
    </>
  );
}
