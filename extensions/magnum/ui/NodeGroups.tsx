/** Node groups of a cluster (list, create, resize, autoscaler bounds, delete) and the OpenStack resources a cluster uses. */
import { useState } from "react";
import {
  ActionDialog,
  Badge,
  Button,
  Card,
  type Column,
  DataTable,
  Detail,
  ErrorNotice,
  Field,
  Icon,
  Input,
  Link,
  type MenuEntry,
  Mono,
  Picker,
  type Server,
  StatusDot,
  age,
  fmtDate,
  os,
  serverIps,
  serverLabel,
  serverStatus,
  tr,
  useFlavors,
  useFloatingIps,
  useInAdmin,
  useQuery,
  useServers,
  useSession,
} from "@rassvet/sdk";
import { type Cluster, MG, type NodeGroup, busy, clusterStatus, flavorTooSmall, mgName, statusText, useNodeGroups } from "./api";

/** The list only has a summary of each group: fetch every group's details (min / max, labels…) in one query. */
function useNodeGroupDetails(clusterId: string, groups?: NodeGroup[]) {
  const ids = (groups ?? []).map((g) => g.uuid);
  return useQuery({
    queryKey: ["os", MG, `clusters/${clusterId}/nodegroups`, "details", ids, groups?.map((g) => `${g.status}${g.node_count}`)],
    queryFn: () => Promise.all(ids.map((id) => os.get<NodeGroup>(MG, `clusters/${clusterId}/nodegroups/${id}`))),
    enabled: ids.length > 0,
  });
}

/** Name of the cluster's Helm release and Cluster API `Cluster` on the management cluster. */
export const clusterRelease = (c?: Cluster) => c?.cluster_id || c?.stack_id || "";

/** Like the driver's `sanitized_name`: lower case, runs of other characters become "-". */
const sanitized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Prefix of the servers of a node group. capi-helm-charts names the control plane
 * `<release>-control-plane` and a worker group's MachineDeployment `<release>-<group>` (cut to
 * 63 characters, like the chart's `componentName`); the machines, and so the Nova servers, are
 * named after them with a random suffix.
 */
function groupPrefix(release: string, g: NodeGroup) {
  const name = `${release}-${g.role === "master" ? "control-plane" : sanitized(g.name)}`;
  return `${name.slice(0, 63).replace(/-+$/, "")}-`;
}

/** Nova servers of the cluster (named after its release), each assigned to its node group (longest prefix wins). */
export function useClusterServers(c?: Cluster, groups?: NodeGroup[]) {
  const admin = useInAdmin();
  const servers = useServers(admin ? { all_tenants: true } : undefined);
  const release = clusterRelease(c);
  const data = (servers.data ?? []).filter((s) => release && s.name.startsWith(`${release}-`) && (!c?.project_id || !s.tenant_id || s.tenant_id === c.project_id));
  const byGroup = new Map<string, Server[]>();
  const prefixes = (groups ?? []).map((g) => ({ g: g.uuid, p: groupPrefix(release, g) })).sort((x, y) => y.p.length - x.p.length);
  for (const s of data) {
    const hit = prefixes.find((x) => s.name.startsWith(x.p));
    if (hit) byGroup.set(hit.g, [...(byGroup.get(hit.g) ?? []), s]);
  }
  return { ...servers, data, byGroup };
}

/** The servers of one node group, shown when its row is expanded. */
function GroupServers({ servers, loading, error }: { servers: Server[]; loading: boolean; error: unknown }) {
  const admin = useInAdmin();
  const base = admin ? "/admin" : "";
  if (loading) return <p className="py-2 text-sm text-muted">{tr("Loading…")}</p>;
  if (error) return <ErrorNotice error={error} />;
  if (!servers.length) return <p className="py-2 text-sm text-muted">{tr("No servers yet: Cluster API creates them while the group is being built or resized.")}</p>;
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-panel">
      <table className="w-full min-w-[44rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="px-3 py-2 font-medium">{tr("Server")}</th>
            <th className="px-3 py-2 font-medium">{tr("Status")}</th>
            <th className="px-3 py-2 font-medium">{tr("IP addresses")}</th>
            <th className="px-3 py-2 font-medium">{tr("Flavor")}</th>
            <th className="px-3 py-2 font-medium">{tr("Availability zone")}</th>
            <th className="px-3 py-2 font-medium">{tr("Created")}</th>
          </tr>
        </thead>
        <tbody>
          {[...servers]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((s) => (
              <tr key={s.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2">
                  <Link to={`${base}/compute/instances/${s.id}`} className="font-medium text-cable hover:underline">
                    {s.name}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <StatusDot status={serverStatus(s)} label={serverLabel(s)} />
                  {s.fault?.message && <p className="mt-0.5 max-w-[22rem] text-xs break-words text-led-red">{s.fault.message}</p>}
                </td>
                <td className="px-3 py-2">
                  <Mono>{serverIps(s).map((i) => i.addr).join(", ") || "—"}</Mono>
                </td>
                <td className="px-3 py-2">
                  {s.flavor.original_name ?? s.flavor.id ?? "—"}
                  {s.flavor.vcpus !== undefined && <span className="text-xs text-muted">{` · ${s.flavor.vcpus} vCPU · ${Math.round((s.flavor.ram ?? 0) / 1024)} GiB`}</span>}
                </td>
                <td className="px-3 py-2">{s["OS-EXT-AZ:availability_zone"] || "—"}</td>
                <td className="px-3 py-2" title={fmtDate(s.created) ?? undefined}>
                  {age(s.created)}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

export function NodeGroupsTab({ cluster }: { cluster: Cluster }) {
  const groups = useNodeGroups(cluster.uuid);
  const details = useNodeGroupDetails(cluster.uuid, groups.data);
  const servers = useClusterServers(cluster, groups.data);
  const flavors = useFlavors();
  const [open, setOpen] = useState<{ kind: "create" | "resize" | "bounds" | "delete"; g?: NodeGroup } | null>(null);
  const close = () => setOpen(null);
  const full = (g: NodeGroup) => details.data?.find((d) => d.uuid === g.uuid) ?? g;
  const flavorName = (id?: string | null) => (id ? (flavors.data?.find((f) => f.id === id || f.name === id)?.name ?? id) : "—");
  /** Stored as an id (Rassvet before this fix, or the CLI): the driver can't build its servers. */
  const flavorById = (id?: string | null) => !!id && !!flavors.data?.some((f) => f.id === id && f.name !== id);
  const clusterBusy = busy(cluster) ? tr("Busy ({status})", { status: statusText(cluster.status) }) : false;

  const columns: Column<NodeGroup>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (g) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{g.name}</span>
          {g.is_default && <Badge>{tr("Default")}</Badge>}
        </span>
      ),
      value: (g) => g.name,
    },
    { key: "role", header: tr("Role"), width: "7rem", cell: (g) => g.role, value: (g) => g.role },
    { key: "count", header: tr("Nodes"), width: "6rem", className: "text-right", cell: (g) => g.node_count, value: (g) => g.node_count },
    {
      key: "servers",
      header: tr("Servers"),
      width: "7rem",
      className: "text-right",
      hideBelow: "sm",
      cell: (g) => {
        if (servers.isPending) return "…";
        const list = servers.byGroup.get(g.uuid) ?? [];
        const active = list.filter((s) => s.status === "ACTIVE").length;
        return list.length === active ? String(list.length) : tr("{a} of {n} active", { a: active, n: list.length });
      },
      value: (g) => servers.byGroup.get(g.uuid)?.length ?? 0,
    },
    {
      key: "bounds",
      header: tr("Min / max"),
      width: "7rem",
      hideBelow: "md",
      cell: (g) => {
        const d = full(g);
        return d.min_node_count === undefined ? "…" : `${d.min_node_count} / ${d.max_node_count ?? "∞"}`;
      },
      value: (g) => full(g).max_node_count ?? "",
    },
    {
      key: "flavor",
      header: tr("Flavor"),
      width: "10rem",
      hideBelow: "lg",
      cell: (g) =>
        flavorById(g.flavor_id) ? (
          <span className="text-led-red" title={tr("Saved as a flavor id: Cluster API looks flavors up by name and builds no server. Delete the group and add it again.")}>
            {flavorName(g.flavor_id)} ⚠
          </span>
        ) : (
          flavorName(g.flavor_id)
        ),
      value: (g) => flavorName(g.flavor_id),
    },
    { key: "status", header: tr("Status"), width: "11rem", cell: (g) => <StatusDot status={clusterStatus(g.status)} label={statusText(g.status)} />, value: (g) => g.status ?? "" },
  ];

  const items = (g: NodeGroup): MenuEntry[] => {
    const wait = busy(g) ? tr("Busy ({status})", { status: statusText(g.status) }) : clusterBusy;
    const master = g.role === "master" ? tr("Masters can't be resized") : false;
    return [
      { label: tr("Change node count"), icon: "scaling", disabled: master || wait, onSelect: () => setOpen({ kind: "resize", g }) },
      { label: tr("Autoscaler bounds"), icon: "sliders-horizontal", disabled: wait, onSelect: () => setOpen({ kind: "bounds", g: full(g) }) },
      "-",
      { label: tr("Delete node group"), icon: "trash", danger: true, disabled: (g.is_default && tr("The default groups can't be deleted")) || wait, onSelect: () => setOpen({ kind: "delete", g }) },
    ];
  };

  return (
    <>
      <ErrorNotice error={groups.error ?? details.error} className="mb-4" />
      <DataTable
        rows={groups.data}
        columns={columns}
        rowKey={(g) => g.uuid}
        loading={groups.isPending}
        tableId="magnum-nodegroups"
        noun={tr("node groups")}
        rowLabel={(g) => g.name}
        onRefresh={() => groups.refetch()}
        refreshing={groups.isFetching}
        empty={tr("No node groups.")}
        filterPlaceholder={tr("Filter node groups")}
        rowActions={items}
        expand={(g) => <GroupServers servers={servers.byGroup.get(g.uuid) ?? []} loading={servers.isPending} error={servers.error} />}
        toolbar={
          <Button onClick={() => setOpen({ kind: "create" })} disabled={!!clusterBusy}>
            <Icon name="plus" />
            {tr("Add node group")}
          </Button>
        }
      />
      {open?.kind === "create" && <CreateNodeGroupDialog cluster={cluster} onClose={close} />}
      {open?.kind === "resize" && open.g && <ResizeDialog cluster={cluster} group={open.g} onClose={close} />}
      {open?.kind === "bounds" && open.g && <BoundsDialog cluster={cluster} group={open.g} onClose={close} />}
      {open?.kind === "delete" && open.g && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete node group {name}?", { name: open.g.name })}
          submitLabel={tr("Delete node group")}
          done={tr("Deleting node group {name}", { name: open.g.name })}
          refresh={[MG, "compute"]}
          run={() => os.del(MG, `clusters/${cluster.uuid}/nodegroups/${open.g!.uuid}`)}
        >
          <p className="text-sm">{tr("Its {n} node(s) are deleted; Kubernetes moves their pods to the other nodes where it can.", { n: open.g.node_count })}</p>
        </ActionDialog>
      )}
    </>
  );
}

// =========================================================================== dialogs

/** Resize a worker group (or, without `group`, the cluster's default worker group). */
export function ResizeDialog({ cluster, group, onClose }: { cluster: Cluster; group?: NodeGroup; onClose: () => void }) {
  const current = group?.node_count ?? cluster.node_count;
  const [count, setCount] = useState(String(current));
  const n = Number(count);
  const min = group?.min_node_count ?? 0;
  const tooSmall = Number.isInteger(n) && n < min;
  const ok = Number.isInteger(n) && n >= 0 && n !== current && !tooSmall;
  return (
    <ActionDialog
      onClose={onClose}
      title={group ? tr("Resize node group {name}", { name: group.name }) : tr("Resize {name}", { name: mgName(cluster) })}
      description={group ? undefined : tr("Changes the number of workers in the default worker group.")}
      submitLabel={tr("Change node count")}
      canSubmit={ok}
      done={tr("Resizing to {n} node(s)", { n })}
      refresh={[MG, "compute"]}
      run={() =>
        os.post(MG, `clusters/${cluster.uuid}/actions/resize`, {
          node_count: n,
          ...(group ? { nodegroup: group.uuid } : {}),
        })
      }
    >
      <Field label={tr("Nodes")} hint={tr("Now {n}.", { n: current })}>
        {(id) => <Input id={id} autoFocus type="number" min={0} value={count} onChange={(e) => setCount(e.target.value)} />}
      </Field>
      {n < current && <p className="text-sm">{tr("Cluster API picks the machines to remove and drains them first.")}</p>}
      {tooSmall && <p className="text-sm text-led-red">{tr("The group's autoscaler minimum is {n}: lower it first.", { n: min })}</p>}
    </ActionDialog>
  );
}

function BoundsDialog({ cluster, group, onClose }: { cluster: Cluster; group: NodeGroup; onClose: () => void }) {
  const [min, setMin] = useState(String(group.min_node_count ?? 0));
  const [max, setMax] = useState(group.max_node_count == null ? "" : String(group.max_node_count));
  const lo = Number(min);
  const hi = max.trim() === "" ? null : Number(max);
  const aboveCount = lo > group.node_count;
  const ok = Number.isInteger(lo) && lo >= 0 && !aboveCount && (hi === null || (Number.isInteger(hi) && hi >= Math.max(lo, group.node_count)));
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Autoscaler bounds of {name}", { name: group.name })}
      description={tr("The cluster autoscaler (label auto_scaling_enabled=true) keeps the group's size within these bounds.")}
      submitLabel={tr("Save")}
      canSubmit={ok}
      done={tr("Node group updated")}
      refresh={[MG]}
      run={() =>
        os.patch(MG, `clusters/${cluster.uuid}/nodegroups/${group.uuid}`, [
          { op: "replace", path: "/min_node_count", value: lo },
          hi === null ? { op: "remove", path: "/max_node_count" } : { op: "replace", path: "/max_node_count", value: hi },
        ])
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Minimum")}>{(id) => <Input id={id} autoFocus type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} />}</Field>
        <Field label={tr("Maximum")} hint={tr("Empty: no upper bound.")}>
          {(id) => <Input id={id} type="number" min={0} value={max} onChange={(e) => setMax(e.target.value)} />}
        </Field>
      </div>
      <p className="text-sm text-muted">{tr("The group has {n} node(s) now: the minimum can't be higher, the maximum can't be lower. A minimum of 0 needs version 0.26 or later of the cluster's Helm chart.", { n: group.node_count })}</p>
    </ActionDialog>
  );
}

function CreateNodeGroupDialog({ cluster, onClose }: { cluster: Cluster; onClose: () => void }) {
  const flavors = useFlavors();
  const [name, setName] = useState("");
  const [count, setCount] = useState("1");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [flavor, setFlavor] = useState("");
  const n = Number(count);
  const boundsOk = (!min || Number(min) <= n) && (!max || Number(max) >= Math.max(n, Number(min || 0)));
  const ok = /^[A-Za-z][A-Za-z0-9_.-]*$/.test(name.trim()) && Number.isInteger(n) && n >= 0 && boundsOk;
  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={tr("Add a node group to {name}", { name: mgName(cluster) })}
      description={tr("A group of workers with its own size and flavor, e.g. GPU nodes or a separate pool for batch jobs. It uses the cluster template's image.")}
      submitLabel={tr("Add node group")}
      canSubmit={ok}
      done={tr("Creating node group {name}", { name: name.trim() })}
      refresh={[MG, "compute"]}
      run={() =>
        os.post(MG, `clusters/${cluster.uuid}/nodegroups`, {
          name: name.trim(),
          node_count: n,
          role: "worker",
          ...(min ? { min_node_count: Number(min) } : {}),
          ...(max ? { max_node_count: Number(max) } : {}),
          ...(flavor ? { flavor_id: flavor } : {}),
        })
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="gpu-workers" />}</Field>
        <Field label={tr("Nodes")}>{(id) => <Input id={id} type="number" min={0} value={count} onChange={(e) => setCount(e.target.value)} />}</Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Autoscaler minimum")}>{(id) => <Input id={id} type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} placeholder="0" />}</Field>
        <Field label={tr("Autoscaler maximum")}>{(id) => <Input id={id} type="number" min={0} value={max} onChange={(e) => setMax(e.target.value)} placeholder="∞" />}</Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Flavor")}>
          {(id) => (
            <Picker
              id={id}
              value={flavor}
              onChange={setFlavor}
              loading={flavors.isPending}
              options={[
                { value: "", label: tr("Cluster's worker flavor") },
                // By name: Cluster API looks the flavor up by name (an id builds no server).
                ...(flavors.data ?? []).map((f) => ({ value: f.name, label: f.name, description: `${f.vcpus} vCPU · ${Math.round(f.ram / 1024)} GiB RAM`, disabled: flavorTooSmall(f) })),
              ]}
            />
          )}
        </Field>
      </div>
      {!boundsOk && <p className="text-sm text-led-red">{tr("The minimum must not exceed the node count, and the maximum must be at least both.")}</p>}
      <p className="text-sm text-muted">{tr("The Cluster API driver uses the group's name, flavor and node count (and the autoscaler bounds when the cluster has auto_scaling_enabled=true); node group labels are ignored.")}</p>
    </ActionDialog>
  );
}

// =========================================================================== resources

interface Lb {
  id: string;
  name: string;
  vip_address: string;
  vip_port_id: string;
  provisioning_status: string;
}

/** Network and API load balancer of the cluster, linked to their own pages (servers are in the node groups tab). */
export function ResourcesCard({ cluster }: { cluster: Cluster }) {
  const admin = useInAdmin();
  const services = useSession().data?.services ?? [];
  const fips = useFloatingIps();
  const hasLb = services.includes("load-balancer");
  const host = (() => {
    try {
      return cluster.api_address ? new URL(cluster.api_address).hostname : "";
    } catch {
      return "";
    }
  })();
  const lbs = useQuery({
    queryKey: ["os", "ext:octavia", "lbaas/loadbalancers", { magnum: cluster.uuid }],
    queryFn: () => os.list<Lb>("ext:octavia", "lbaas/loadbalancers", "loadbalancers", admin ? {} : { project_id: cluster.project_id }),
    enabled: hasLb && !!host,
  });
  const fip = fips.data?.find((f) => f.floating_ip_address === host);
  const apiLb = lbs.data?.find((l) => l.vip_address === host || (fip?.port_id && l.vip_port_id === fip.port_id));
  const base = admin ? "/admin" : "";
  return (
    <Card title={tr("OpenStack resources")}>
      <dl>
        {cluster.fixed_network && (
          <Detail label={tr("Network")}>
            <Link to={`/network/networks/${cluster.fixed_network}`} className="text-cable hover:underline">
              <Mono>{cluster.fixed_network}</Mono>
            </Link>
          </Detail>
        )}
        {hasLb && (
          <Detail label={tr("API load balancer")}>
            {apiLb ? (
              <Link to={`${base}/ext/octavia/load-balancers/${apiLb.id}`} className="text-cable hover:underline">
                {apiLb.name || apiLb.id}
              </Link>
            ) : (
              "—"
            )}
          </Detail>
        )}
        {clusterRelease(cluster) && (
          <Detail label={tr("Cluster API name")} wrap>
            <Mono>{clusterRelease(cluster)}</Mono>
            <p className="text-xs text-muted">{tr("Helm release and Cluster object on the management cluster; the servers' names start with it.")}</p>
          </Detail>
        )}
      </dl>
    </Card>
  );
}
