/**
 * Cleanup: finds resources that cost quota or money but do nothing — unattached volumes,
 * old snapshots, idle floating IPs, detached ports, unused security groups, instances in
 * ERROR or stopped for long, routers without interfaces, networks without ports, failed
 * Kubernetes clusters and unused cluster templates (Magnum extension) — and removes them in bulk. Project view: the current project; admin view: every project.
 */
import { type ReactNode, useMemo, useState } from "react";
import { type BulkAction, type Column, DataTable } from "@/components/DataTable";
import { Link } from "@/components/Link";
import { Badge, Card, ErrorNotice, Icon, PageHeader, Select, StatusDot } from "@/components/ui";
import { useProjects } from "@/lib/identity";
import {
  type FloatingIp,
  type Network,
  type Port,
  type Router,
  type SecurityGroup,
  type Server,
  type Snapshot,
  type Volume,
  age,
  os,
  portLabel,
  serverAction,
  serverLabel,
  serverStatus,
  useInvalidate,
  useOsList,
} from "@/lib/os";
import { useNav, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { tr } from "@/lib/i18n";

const DAY = 86_400_000;
const vcpus = (n: number) => (n === 1 ? tr("1 vCPU held") : tr("{n} vCPUs held", { n }));
const DAYS = [0, 1, 7, 30, 90, 180, 365];
const KEY = "rassvet.cleanup.days";

/** Milliseconds since an OpenStack timestamp (naive ones are UTC), or null. */
function since(iso?: string | null) {
  if (!iso) return null;
  const t = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
  return Number.isNaN(t) ? null : Date.now() - t;
}

/** Idle at least `days` (unknown age counts as old: better shown than hidden). */
const idle = (days: number, ...iso: (string | null | undefined)[]) => {
  if (!days) return true;
  const ms = iso.map(since).find((x) => x != null);
  return ms == null || ms >= days * DAY;
};

/** Ports that belong to the network itself, not to something using it. */
const INFRA_OWNERS = new Set(["network:dhcp", "network:distributed"]);
const ROUTER_IF = new Set(["network:router_interface", "network:router_interface_distributed", "network:ha_router_replicated_interface"]);

/** The Magnum extension's clusters and templates (only the fields the findings need). */
interface MgCluster {
  id: string;
  uuid: string;
  name: string;
  status: string;
  status_reason?: string | null;
  cluster_template_id: string;
  master_count: number;
  node_count: number;
  project_id?: string;
  created_at?: string;
  updated_at?: string | null;
}
interface MgTemplate {
  id: string;
  uuid: string;
  name: string;
  public?: boolean;
  project_id?: string;
  created_at?: string;
}
const withId = <T extends { uuid: string }>(rows?: T[]) => rows?.map((r) => ({ ...r, id: r.uuid }));

interface Finder {
  id: string;
  icon: string;
  title: string;
  hint: string;
  count?: number;
  extra?: string;
  loading: boolean;
  error: unknown;
  table: () => ReactNode;
}

function readDays() {
  try {
    const v = Number(localStorage.getItem(KEY));
    return DAYS.includes(v) && localStorage.getItem(KEY) !== null ? v : 30;
  } catch {
    return 30;
  }
}

export default function Cleanup({ admin }: { admin?: boolean }) {
  const session = useSession();
  const pid = session.data?.project?.id ?? "";
  const [days, setDaysState] = useState(readDays);
  const setDays = (d: number) => {
    setDaysState(d);
    try {
      localStorage.setItem(KEY, String(d));
    } catch {
      /* not remembered */
    }
  };
  const [pick, setPick] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const services = session.data?.services ?? [];
  const has = (s: string) => services.includes(s);

  const all = admin ? { all_tenants: 1 } : {};
  // Neutron: admins see every project's resources anyway; members get their own plus shared
  // ones, so those lists are narrowed to the project. Ports aren't: a network owner also sees
  // other projects' ports on its networks, which keeps "unused network" honest.
  const mine = admin ? {} : { project_id: pid };
  const ready = admin || !!pid;
  const net = has("network") && ready;
  const vol = (has("block-storage") || has("volumev3") || has("volume")) && ready;
  const nav = useNav(true);
  const mg = !!nav.data?.extensions.some((e) => e.id === "magnum") && ready;

  const volumes = useOsList<Volume>("volume", "volumes/detail", "volumes", all, { enabled: vol });
  const snapshots = useOsList<Snapshot>("volume", "snapshots/detail", "snapshots", all, { enabled: vol });
  const errored = useOsList<Server>("compute", "servers/detail", "servers", { ...all, status: "ERROR" }, { enabled: ready });
  const stopped = useOsList<Server>("compute", "servers/detail", "servers", { ...all, status: "SHUTOFF" }, { enabled: ready });
  const fips = useOsList<FloatingIp>("network", "floatingips", "floatingips", mine, { enabled: net });
  const ports = useOsList<Port>("network", "ports", "ports", undefined, { enabled: net });
  const sgs = useOsList<SecurityGroup>("network", "security-groups", "security_groups", mine, { enabled: net });
  const routers = useOsList<Router>("network", "routers", "routers", mine, { enabled: net });
  const networks = useOsList<Network>("network", "networks", "networks", mine, { enabled: net });
  // Magnum shows admins every project's clusters and templates whatever the query.
  const clusters = useOsList<MgCluster>("ext:magnum", "clusters/detail", "clusters", undefined, { enabled: mg });
  const templates = useOsList<MgTemplate>("ext:magnum", "clustertemplates", "clustertemplates", undefined, { enabled: mg });
  const projects = useProjects(!!admin);

  const projectName = useMemo(() => {
    const m = new Map(projects.data?.map((p) => [p.id, p.name]));
    return (id?: string) => (id ? (m.get(id) ?? id) : "");
  }, [projects.data]);
  const full = <T,>(q: { data?: T[]; partial?: boolean }) => (q.partial ? undefined : q.data);

  // ------------------------------------------------------------------ findings
  const found = useMemo(() => {
    const vs = full(volumes);
    const ss = full(snapshots);
    const ps = full(ports);
    const snapsOf = new Map<string, number>();
    for (const s of ss ?? []) snapsOf.set(s.volume_id, (snapsOf.get(s.volume_id) ?? 0) + 1);
    const usedSg = new Set<string>();
    const busyNet = new Set<string>();
    const routerIfs = new Set<string>();
    for (const p of ps ?? []) {
      for (const g of p.security_groups ?? []) usedSg.add(g);
      if (!INFRA_OWNERS.has(p.device_owner)) busyNet.add(p.network_id);
      if (ROUTER_IF.has(p.device_owner)) routerIfs.add(p.device_id);
    }
    const sgList = full(sgs);
    // A group referenced by another group's rules (remote group) is in use too.
    for (const g of sgList ?? []) for (const r of g.security_group_rules ?? []) if (r.remote_group_id && r.remote_group_id !== g.id) usedSg.add(r.remote_group_id);
    const cs = withId(full(clusters))?.filter((c) => admin || c.project_id === pid);
    const usedTemplates = new Set((full(clusters) ?? []).map((c) => c.cluster_template_id));
    const gwNets = new Set((full(routers) ?? []).map((r) => r.external_gateway_info?.network_id).filter(Boolean) as string[]);
    return {
      snapsOf,
      unattached: vs?.filter((v) => v.status === "available" && !v.attachments?.length && idle(days, v.updated_at, v.created_at)),
      errorVolumes: vs?.filter((v) => v.status.startsWith("error")),
      oldSnapshots: ss?.filter((s) => s.status === "available" && idle(days, s.created_at)),
      idleFips: full(fips)?.filter((f) => !f.port_id && idle(days, f.updated_at, f.created_at)),
      detachedPorts: ps?.filter((p) => !p.device_owner && !p.device_id && (admin || p.project_id === pid) && idle(days, p.updated_at, p.created_at)),
      unusedSgs: ps && sgList?.filter((g) => g.name !== "default" && !usedSg.has(g.id) && idle(days, g.created_at)),
      errorServers: full(errored),
      stoppedServers: full(stopped)?.filter((s) => idle(days, s.updated)),
      emptyRouters: ps && full(routers)?.filter((r) => !routerIfs.has(r.id) && idle(days, r.created_at)),
      failedClusters: cs?.filter((c) => c.status.endsWith("_FAILED") && idle(days, c.updated_at, c.created_at)),
      unusedTemplates: cs && withId(full(templates))?.filter((t) => !usedTemplates.has(t.uuid) && (admin ? true : t.project_id === pid) && idle(days, t.created_at)),
      unusedNets: ps && full(networks)?.filter((n) => !n["router:external"] && !(n.shared && !admin) && !busyNet.has(n.id) && !gwNets.has(n.id) && (admin || n.project_id === pid) && idle(days, n.created_at)),
    };
  }, [volumes, snapshots, ports, sgs, routers, fips, errored, stopped, networks, clusters, templates, days, admin, pid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------ shared columns
  const projectCol = <T,>(id: (r: T) => string | undefined): Column<T>[] =>
    admin ? [{ key: "project", header: tr("Project"), width: "11rem", hideBelow: "md", cell: (r) => projectName(id(r)), value: (r) => projectName(id(r)) }] : [];
  const ageCol = <T,>(header: string, iso: (r: T) => string | null | undefined): Column<T> => ({
    key: "age",
    header,
    width: "9rem",
    hideBelow: "sm",
    cell: (r) => age(iso(r)) || "—",
    value: (r) => iso(r) ?? "",
  });
  const del = (svc: "volume" | "network" | "compute", path: (id: string) => string, title: string, body?: ReactNode, check?: (r: { id: string }) => true | string): BulkAction<{ id: string }> => ({
    id: "delete",
    label: tr("Delete"),
    icon: "trash",
    danger: true,
    title,
    body,
    past: tr("deleted"),
    check,
    run: (r) => os.del(svc, path(r.id)),
  });
  const gib = (list?: { size: number }[]) => (list?.length ? tr("{n} GiB", { n: list.reduce((a, v) => a + (v.size ?? 0), 0) }) : undefined);
  const volTenant = (v: Volume) => v["os-vol-tenant-attr:tenant_id"];
  const table = <T extends { id: string }>(id: string, rows: T[] | undefined, columns: Column<T>[], label: (r: T) => string, bulk: BulkAction<T>[], refresh: () => void, noun: string) => (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.id}
      loading={!rows}
      tableId={`${admin ? "admin-" : ""}cleanup-${id}`}
      noun={noun}
      rowLabel={label}
      empty={tr("Nothing to clean up here.")}
      bulkActions={bulk}
      onRefresh={refresh}
    />
  );
  const volName = (v: Volume) => v.name || v.id.slice(0, 13);
  const volumeColumns: Column<Volume>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (v) => (
        <Link to={`/storage/volumes/${v.id}`} className="truncate font-medium text-cable hover:underline">
          {volName(v)}
        </Link>
      ),
      value: volName,
    },
    { key: "size", header: tr("Size"), width: "6rem", cell: (v) => tr("{n} GiB", { n: v.size }), value: (v) => v.size },
    { key: "type", header: tr("Type"), width: "9rem", hideBelow: "lg", cell: (v) => v.volume_type ?? "—", value: (v) => v.volume_type ?? "" },
    ...projectCol<Volume>(volTenant),
  ];
  const volumeDelete = del("volume", (id) => `volumes/${id}`, tr("Delete volumes?"), tr("The data is gone for good. Volumes with snapshots are skipped: delete the snapshots first."), (r) => {
    const n = found.snapsOf.get(r.id) ?? 0;
    return n ? tr("Has {n} snapshot(s)", { n }) : true;
  }) as BulkAction<Volume>;
  const serverColumns = (extra: Column<Server>[]): Column<Server>[] => [
    {
      key: "name",
      header: tr("Name"),
      cell: (s) => (
        <Link to={`/compute/instances/${s.id}`} className="truncate font-medium text-cable hover:underline">
          {s.name}
        </Link>
      ),
      value: (s) => s.name,
    },
    { key: "status", header: tr("Status"), width: "9rem", cell: (s) => <StatusDot status={serverStatus(s)} label={serverLabel(s)} />, value: serverLabel },
    { key: "flavor", header: tr("Flavor"), width: "9rem", hideBelow: "lg", cell: (s) => s.flavor.original_name ?? "", value: (s) => s.flavor.original_name ?? "" },
    ...extra,
    ...projectCol<Server>((s) => s.tenant_id),
  ];
  const serverDelete: BulkAction<Server> = {
    id: "delete",
    label: tr("Delete"),
    icon: "trash",
    danger: true,
    title: tr("Delete instances?"),
    body: tr("Their root disks go with them (volumes set to delete on termination too); other attached volumes are detached and kept."),
    past: tr("deleted"),
    check: (s) => (s.locked ? tr("Locked") : true),
    run: (s) => os.del("compute", `servers/${s.id}`),
  };
  const refreshAll = (...qs: { refetch: () => unknown }[]) => () => {
    for (const q of qs) q.refetch();
  };

  const finders: Finder[] = [
    {
      id: "unattached-volumes",
      icon: "hard-drive",
      title: tr("Unattached volumes"),
      hint: tr("Available volumes no instance uses. They still take storage quota."),
      count: found.unattached?.length,
      extra: gib(found.unattached),
      loading: vol && !found.unattached,
      error: volumes.error,
      table: () =>
        table("unattached-volumes", found.unattached, [...volumeColumns, ageCol<Volume>(tr("Idle for"), (v) => v.updated_at ?? v.created_at)], volName, [volumeDelete], refreshAll(volumes, snapshots), tr("volumes")),
    },
    {
      id: "error-volumes",
      icon: "warning",
      title: tr("Volumes in error"),
      hint: tr("Volumes whose create, extend, restore or delete failed."),
      count: found.errorVolumes?.length,
      extra: gib(found.errorVolumes),
      loading: vol && !found.errorVolumes,
      error: volumes.error,
      table: () =>
        table(
          "error-volumes",
          found.errorVolumes,
          [...volumeColumns.slice(0, 1), { key: "status", header: tr("Status"), width: "10rem", cell: (v) => <StatusDot status="error" label={v.status} />, value: (v) => v.status }, ...volumeColumns.slice(1), ageCol<Volume>(tr("Age"), (v) => v.created_at)],
          volName,
          [
            volumeDelete,
            ...(admin
              ? [
                  {
                    id: "force-delete",
                    label: tr("Force delete"),
                    icon: "trash",
                    danger: true,
                    title: tr("Force-delete volumes?"),
                    body: tr("Deletes regardless of state, also when the backend still reports trouble. Use it when a normal delete is refused."),
                    past: tr("deleted"),
                    run: (v: Volume) => os.action("volume", `volumes/${v.id}`, { "os-force_delete": null }),
                  } satisfies BulkAction<Volume>,
                ]
              : []),
          ],
          refreshAll(volumes, snapshots),
          tr("volumes"),
        ),
    },
    {
      id: "old-snapshots",
      icon: "camera",
      title: tr("Old volume snapshots"),
      hint: tr("Snapshots older than the age you picked. Each one keeps its blocks on the backend."),
      count: found.oldSnapshots?.length,
      extra: gib(found.oldSnapshots),
      loading: vol && !found.oldSnapshots,
      error: snapshots.error,
      table: () =>
        table(
          "old-snapshots",
          found.oldSnapshots,
          [
            { key: "name", header: tr("Name"), cell: (s) => <span className="font-medium">{s.name || s.id.slice(0, 13)}</span>, value: (s) => s.name || s.id },
            {
              key: "volume",
              header: tr("Volume"),
              hideBelow: "md",
              cell: (s) => (
                <Link to={`/storage/volumes/${s.volume_id}`} className="truncate text-cable hover:underline">
                  {(full(volumes) ?? []).find((v) => v.id === s.volume_id)?.name || s.volume_id.slice(0, 13)}
                </Link>
              ),
              value: (s) => s.volume_id,
            },
            { key: "size", header: tr("Size"), width: "6rem", cell: (s) => tr("{n} GiB", { n: s.size }), value: (s) => s.size },
            ...projectCol<Snapshot>((s) => s["os-extended-snapshot-attributes:project_id"]),
            ageCol<Snapshot>(tr("Age"), (s) => s.created_at),
          ],
          (s) => s.name || s.id,
          [del("volume", (id) => `snapshots/${id}`, tr("Delete snapshots?"), undefined, (r) => ((r as Snapshot).group_snapshot_id ? tr("Part of a group snapshot") : true)) as BulkAction<Snapshot>],
          refreshAll(snapshots),
          tr("snapshots"),
        ),
    },
    {
      id: "floating-ips",
      icon: "globe",
      title: tr("Unassociated floating IPs"),
      hint: tr("Public addresses held but not attached to any port. Most clouds bill or limit them."),
      count: found.idleFips?.length,
      loading: net && !found.idleFips,
      error: fips.error,
      table: () =>
        table(
          "floating-ips",
          found.idleFips,
          [
            { key: "ip", header: tr("Address"), mono: true, cell: (f) => f.floating_ip_address, value: (f) => f.floating_ip_address },
            { key: "desc", header: tr("Description"), hideBelow: "lg", cell: (f) => <span className="text-muted">{f.description || "—"}</span>, value: (f) => f.description ?? "" },
            ...projectCol<FloatingIp>((f) => f.project_id),
            ageCol<FloatingIp>(tr("Idle for"), (f) => f.updated_at ?? f.created_at),
          ],
          (f) => f.floating_ip_address,
          [{ ...del("network", (id) => `floatingips/${id}`, tr("Release floating IPs?"), tr("The addresses go back to the pool; you may not get the same ones again.")), label: tr("Release"), icon: "unlink", past: tr("released") } as BulkAction<FloatingIp>],
          refreshAll(fips),
          tr("floating IPs"),
        ),
    },
    {
      id: "detached-ports",
      icon: "ethernet-port",
      title: tr("Detached ports"),
      hint: tr("Ports with no device: left over from deleted instances or made by hand. They hold IP addresses."),
      count: found.detachedPorts?.length,
      loading: net && !found.detachedPorts,
      error: ports.error,
      table: () =>
        table(
          "detached-ports",
          found.detachedPorts,
          [
            { key: "name", header: tr("Name"), cell: (p) => <span className="font-medium">{portLabel(p)}</span>, value: (p) => portLabel(p) },
            { key: "ips", header: tr("Fixed IPs"), mono: true, hideBelow: "md", cell: (p) => p.fixed_ips.map((x) => x.ip_address).join(", ") || "—", value: (p) => p.fixed_ips.map((x) => x.ip_address).join(", ") },
            { key: "net", header: tr("Network"), hideBelow: "lg", cell: (p) => (full(networks) ?? []).find((n) => n.id === p.network_id)?.name || p.network_id.slice(0, 13), value: (p) => p.network_id },
            ...projectCol<Port>((p) => p.project_id),
            ageCol<Port>(tr("Idle for"), (p) => p.updated_at ?? p.created_at),
          ],
          portLabel,
          [del("network", (id) => `ports/${id}`, tr("Delete ports?"), tr("Their IP addresses are released.")) as BulkAction<Port>],
          refreshAll(ports),
          tr("ports"),
        ),
    },
    {
      id: "unused-security-groups",
      icon: "shield",
      title: tr("Unused security groups"),
      hint: tr("Groups no port uses and no other group's rules refer to (“default” is never listed)."),
      count: found.unusedSgs?.length,
      loading: net && !found.unusedSgs,
      error: sgs.error ?? ports.error,
      table: () =>
        table(
          "unused-security-groups",
          found.unusedSgs,
          [
            {
              key: "name",
              header: tr("Name"),
              cell: (g) => (
                <Link to={`/network/security-groups/${g.id}`} className="truncate font-medium text-cable hover:underline">
                  {g.name || g.id.slice(0, 13)}
                </Link>
              ),
              value: (g) => g.name,
            },
            { key: "rules", header: tr("Rules"), width: "6rem", cell: (g) => g.security_group_rules?.length ?? 0, value: (g) => g.security_group_rules?.length ?? 0 },
            { key: "desc", header: tr("Description"), hideBelow: "lg", cell: (g) => <span className="text-muted">{g.description || "—"}</span>, value: (g) => g.description },
            ...projectCol<SecurityGroup>((g) => g.project_id),
            ageCol<SecurityGroup>(tr("Age"), (g) => g.created_at),
          ],
          (g) => g.name || g.id,
          [del("network", (id) => `security-groups/${id}`, tr("Delete security groups?")) as BulkAction<SecurityGroup>],
          refreshAll(sgs, ports),
          tr("security groups"),
        ),
    },
    {
      id: "error-instances",
      icon: "server",
      title: tr("Instances in error"),
      hint: tr("Instances that failed to build, move or resize. They may still hold quota and ports."),
      count: found.errorServers?.length,
      loading: ready && !found.errorServers,
      error: errored.error,
      table: () =>
        table(
          "error-instances",
          found.errorServers,
          serverColumns([
            { key: "fault", header: tr("Fault"), hideBelow: "md", cell: (s) => <span className="text-muted">{s.fault?.message || "—"}</span>, value: (s) => s.fault?.message ?? "" },
            ageCol<Server>(tr("Age"), (s) => s.created),
          ]),
          (s) => s.name,
          [serverDelete],
          refreshAll(errored),
          tr("instances"),
        ),
    },
    {
      id: "stopped-instances",
      icon: "power",
      title: tr("Long-stopped instances"),
      hint: tr("Shut-off instances still hold their vCPUs and RAM on the host. Shelve them to free the host but keep the instance, or delete them."),
      count: found.stoppedServers?.length,
      extra: found.stoppedServers?.length ? vcpus(found.stoppedServers.reduce((a, s) => a + (s.flavor.vcpus ?? 0), 0)) : undefined,
      loading: ready && !found.stoppedServers,
      error: stopped.error,
      table: () =>
        table(
          "stopped-instances",
          found.stoppedServers,
          serverColumns([ageCol<Server>(tr("Stopped for"), (s) => s.updated)]),
          (s) => s.name,
          [
            {
              id: "shelve",
              label: tr("Shelve"),
              icon: "archive",
              title: tr("Shelve instances?"),
              body: tr("Each instance is snapshotted and removed from its host; unshelve brings it back. The snapshot takes image storage."),
              past: tr("shelved"),
              check: (s) => (s.locked ? tr("Locked") : true),
              run: (s) => serverAction(s.id, { shelve: null }),
            },
            serverDelete,
          ],
          refreshAll(stopped),
          tr("instances"),
        ),
    },
    {
      id: "empty-routers",
      icon: "router",
      title: tr("Routers without interfaces"),
      hint: tr("Routers connected to no subnet. One with an external gateway still holds a public address."),
      count: found.emptyRouters?.length,
      loading: net && !found.emptyRouters,
      error: routers.error ?? ports.error,
      table: () =>
        table(
          "empty-routers",
          found.emptyRouters,
          [
            {
              key: "name",
              header: tr("Name"),
              cell: (r) => (
                <Link to={`/network/routers/${r.id}`} className="truncate font-medium text-cable hover:underline">
                  {r.name || r.id.slice(0, 13)}
                </Link>
              ),
              value: (r) => r.name,
            },
            {
              key: "gw",
              header: tr("External gateway"),
              hideBelow: "md",
              cell: (r) => r.external_gateway_info?.external_fixed_ips?.map((x) => x.ip_address).join(", ") || <span className="text-muted">{tr("None")}</span>,
              value: (r) => r.external_gateway_info?.external_fixed_ips?.map((x) => x.ip_address).join(", ") ?? "",
            },
            ...projectCol<Router>((r) => r.project_id),
            ageCol<Router>(tr("Age"), (r) => r.created_at),
          ],
          (r) => r.name || r.id,
          [del("network", (id) => `routers/${id}`, tr("Delete routers?"), tr("Their external gateways are removed with them.")) as BulkAction<Router>],
          refreshAll(routers, ports),
          tr("routers"),
        ),
    },
    {
      id: "unused-networks",
      icon: "network",
      title: tr("Networks without ports"),
      hint: tr("Networks nothing is plugged into (only their DHCP or metadata ports). External and shared networks aren't listed."),
      count: found.unusedNets?.length,
      loading: net && !found.unusedNets,
      error: networks.error ?? ports.error,
      table: () =>
        table(
          "unused-networks",
          found.unusedNets,
          [
            {
              key: "name",
              header: tr("Name"),
              cell: (n) => (
                <Link to={`/network/networks/${n.id}`} className="truncate font-medium text-cable hover:underline">
                  {n.name || n.id.slice(0, 13)}
                </Link>
              ),
              value: (n) => n.name,
            },
            { key: "subnets", header: tr("Subnets"), width: "6rem", cell: (n) => n.subnets.length, value: (n) => n.subnets.length },
            ...projectCol<Network>((n) => n.project_id),
            ageCol<Network>(tr("Age"), (n) => n.created_at),
          ],
          (n) => n.name || n.id,
          [del("network", (id) => `networks/${id}`, tr("Delete networks?"), tr("Their subnets are deleted with them. Neutron refuses networks something still uses.")) as BulkAction<Network>],
          refreshAll(networks, ports),
          tr("networks"),
        ),
    },
    {
      id: "failed-clusters",
      icon: "container",
      title: tr("Failed Kubernetes clusters"),
      hint: tr("Magnum clusters whose create, update or delete failed. Their servers, volumes and load balancers still count against quota; deleting the cluster removes them too."),
      count: found.failedClusters?.length,
      loading: mg && !found.failedClusters,
      error: clusters.error,
      table: () =>
        table(
          "failed-clusters",
          found.failedClusters,
          [
            {
              key: "name",
              header: tr("Name"),
              cell: (c) => (
                <Link to={`${admin ? "/admin" : ""}/ext/magnum/clusters/${c.uuid}`} className="truncate font-medium text-cable hover:underline">
                  {c.name || c.uuid.slice(0, 13)}
                </Link>
              ),
              value: (c) => c.name,
            },
            { key: "status", header: tr("Status"), width: "11rem", cell: (c) => <StatusDot status="error" label={c.status} />, value: (c) => `${c.status} ${c.status_reason ?? ""}` },
            { key: "nodes", header: tr("Nodes"), width: "6rem", cell: (c) => c.master_count + c.node_count, value: (c) => c.master_count + c.node_count },
            ...projectCol<MgCluster>((c) => c.project_id),
            ageCol<MgCluster>(tr("Idle for"), (c) => c.updated_at ?? c.created_at),
          ],
          (c) => c.name || c.uuid,
          [
            {
              id: "delete",
              label: tr("Delete"),
              icon: "trash",
              danger: true,
              title: tr("Delete clusters?"),
              body: tr("Magnum deletes each cluster with the servers, load balancers, networks and volumes it created."),
              past: tr("deleted"),
              check: (c) => (c.status === "DELETE_IN_PROGRESS" ? tr("Already being deleted") : true),
              run: (c) => os.del("ext:magnum", `clusters/${c.uuid}`),
            },
          ],
          refreshAll(clusters),
          tr("clusters"),
        ),
    },
    {
      id: "unused-templates",
      icon: "file-code",
      title: tr("Unused cluster templates"),
      hint: tr("Cluster templates no Kubernetes cluster was created from. Public templates of other projects aren't listed."),
      count: found.unusedTemplates?.length,
      loading: mg && !found.unusedTemplates,
      error: templates.error ?? clusters.error,
      table: () =>
        table(
          "unused-templates",
          found.unusedTemplates,
          [
            { key: "name", header: tr("Name"), cell: (t) => <span className="font-medium">{t.name || t.uuid.slice(0, 13)}</span>, value: (t) => t.name },
            { key: "public", header: tr("Visibility"), width: "8rem", cell: (t) => (t.public ? tr("Public") : tr("Private")), value: (t) => (t.public ? "public" : "private") },
            ...projectCol<MgTemplate>((t) => t.project_id),
            ageCol<MgTemplate>(tr("Age"), (t) => t.created_at),
          ],
          (t) => t.name || t.uuid,
          [
            {
              id: "delete",
              label: tr("Delete"),
              icon: "trash",
              danger: true,
              title: tr("Delete cluster templates?"),
              past: tr("deleted"),
              run: (t) => os.del("ext:magnum", `clustertemplates/${t.uuid}`),
            },
          ],
          refreshAll(templates, clusters),
          tr("cluster templates"),
        ),
    },
  ].filter((f) => {
    if (["failed-clusters", "unused-templates"].includes(f.id)) return mg;
    if (["unattached-volumes", "error-volumes", "old-snapshots"].includes(f.id)) return vol;
    if (["error-instances", "stopped-instances"].includes(f.id)) return true;
    return net;
  });

  const withHits = finders.filter((f) => (f.count ?? 0) > 0);
  const current = finders.find((f) => f.id === pick) ?? withHits[0] ?? null;
  const loading = finders.filter((f) => f.loading).length;
  const total = finders.reduce((a, f) => a + (f.count ?? 0), 0);

  return (
    <>
      <PageHeader
        title={tr("Cleanup")}
        description={
          admin
            ? tr("Leftovers across every project: resources that hold quota, addresses or storage but do nothing. Pick a finding, review the list, select and delete.")
            : tr("Leftovers in this project: resources that hold quota, addresses or storage but do nothing. Pick a finding, review the list, select and delete.")
        }
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">{tr("Idle for at least")}</span>
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-9 w-36" aria-label={tr("Idle for at least")}>
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? tr("Any age") : d === 1 ? tr("1 day") : tr("{n} days", { n: d })}
                </option>
              ))}
            </Select>
            <button
              type="button"
              className="grid size-9 place-items-center rounded-md border border-line bg-panel hover:bg-surface"
              title={tr("Refresh")}
              aria-label={tr("Refresh")}
              onClick={() => invalidate("compute", "volume", "network", "ext:magnum")}
            >
              <Icon name="refresh" className={cn("size-4", loading > 0 && "animate-spin")} />
            </button>
          </label>
        }
      />
      <p className="-mt-3 mb-4 text-sm text-muted" aria-live="polite">
        {loading ? tr("Looking… {n} check(s) still running.", { n: loading }) : total ? tr("{n} item(s) found.", { n: total }) : tr("Nothing to clean up. Nice and tidy.")}
      </p>
      <div className="mb-5 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
        {finders.map((f) => {
          const on = current?.id === f.id;
          const n = f.count ?? 0;
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={on}
              onClick={() => setPick(f.id)}
              className={cn(
                "flex min-w-0 items-start gap-3 rounded-lg border bg-panel p-3 text-left transition-colors",
                on ? "border-cable ring-2 ring-cable/15" : "border-line hover:border-cable/60",
              )}
            >
              <span className={cn("grid size-9 shrink-0 place-items-center rounded-md", n ? "bg-led-amber/15 text-[#9a6412] dark:text-led-amber" : "bg-ink/5 text-muted")}>
                <Icon name={f.icon} className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium" title={f.title}>
                    {f.title}
                  </span>
                </span>
                <span className="mt-0.5 flex items-baseline gap-2">
                  {f.error ? (
                    <span className="text-sm text-led-red">{tr("Couldn't check")}</span>
                  ) : f.loading ? (
                    <span className="mt-1 block h-4 w-10 animate-pulse rounded bg-ink/8" aria-label={tr("Loading…")} />
                  ) : (
                    <span className={cn("text-xl font-semibold tabular-nums", !n && "text-muted")}>{n}</span>
                  )}
                  {!f.loading && f.extra && <span className="truncate text-xs text-muted">{f.extra}</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {current ? (
        <Card
          title={
            <span className="flex items-center gap-2">
              <Icon name={current.icon} className="size-4 text-muted" />
              {current.title}
              {current.count != null && <Badge>{current.count}</Badge>}
            </span>
          }
          flush
        >
          <p className="px-5 pt-3 text-sm text-muted">{current.hint}</p>
          <ErrorNotice error={current.error} className="mx-5 mt-3" />
          <div className="p-3">{current.table()}</div>
        </Card>
      ) : (
        !loading && (
          <Card>
            <p className="flex items-center gap-2 text-sm text-muted">
              <Icon name="circle-check" className="size-4 text-led-green" />
              {tr("No leftovers found with these settings.")}
            </p>
          </Card>
        )
      )}
    </>
  );
}
