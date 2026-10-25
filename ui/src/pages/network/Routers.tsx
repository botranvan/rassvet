import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { ActionMenu, type MenuEntry } from "@/components/Menu";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Button, Card, Detail, ErrorNotice, Field, Icon, Input, Mono, PageHeader, StatusDot, Switch, Tabs, Textarea } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import type { Agent } from "@/lib/neutron";
import { NEUTRON_STATUSES, choice, filters, statusLabel, useProjectFilter, idFilter, nameRegex } from "@/lib/filters";
import { type Port, type Router, type Subnet, networkStatus, os, useInvalidate, useNetworks, useListOrPages, useOsGet, usePorts, useSubnets } from "@/lib/os";
import { useSession } from "@/lib/session";
import { useTab, useNewParam } from "@/lib/useTab";
import { useNetName } from "./networkActions";
import { tr, trx } from "@/lib/i18n";

const gwText = (r: Router, netName: (id: string) => string) =>
  r.external_gateway_info
    ? `${netName(r.external_gateway_info.network_id)} ${r.external_gateway_info.external_fixed_ips?.map((f) => f.ip_address).join(", ") ?? ""}`.trim()
    : "";

/** Subnets as picker options grouped by network: "network / subnet (CIDR)". */
function useSubnetOptions(exclude: Set<string>, skipNetwork?: string) {
  const session = useSession().data!;
  const subnets = useSubnets();
  const networks = useNetworks();
  const netName = useNetName();
  const ext = new Set(networks.data?.filter((n) => n["router:external"]).map((n) => n.id));
  const list = (subnets.data ?? [])
    .filter((s) => !exclude.has(s.id) && s.network_id !== skipNetwork && !ext.has(s.network_id))
    .sort((a, b) => netName(a.network_id).localeCompare(netName(b.network_id)) || (a.name || "").localeCompare(b.name || ""));
  return {
    loading: subnets.isPending,
    options: list.map((s) => ({
      value: s.id,
      label: s.name || s.cidr,
      group: netName(s.network_id),
      meta: s.cidr,
      keywords: netName(s.network_id),
      description: s.gateway_ip ? tr("gateway {gateway_ip}", { gateway_ip: s.gateway_ip }) : tr("no gateway"),
      disabled: !s.gateway_ip ? tr("No gateway IP; the router needs one") : s.project_id && s.project_id !== session.project?.id && !session.is_admin ? tr("Owned by another project") : false,
    })),
  };
}

type Kind = "edit" | "gateway" | "clearGw" | "connect" | "disconnect" | "delete";

export function useRouterActions({ onDeleted }: { onDeleted?: () => void } = {}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ kind: Kind; router: Router } | null>(null);
  const close = () => setOpen(null);
  const dlg = (r: Router, kind: Kind) => () => setOpen({ kind, router: r });
  const items = (r: Router, where: "list" | "detail" = "list"): MenuEntry[] => [
    where === "list" && { label: tr("View details"), icon: "eye", onSelect: () => navigate(`/network/routers/${r.id}`) },
    where === "list" && "-",
    { label: tr("Edit router"), icon: "edit", onSelect: dlg(r, "edit") },
    { label: tr("Connect subnet"), icon: "plus", onSelect: dlg(r, "connect") },
    { label: tr("Disconnect subnet"), icon: "unplug", onSelect: dlg(r, "disconnect") },
    r.external_gateway_info
      ? { label: tr("Clear gateway"), icon: "unlink", onSelect: dlg(r, "clearGw") }
      : { label: tr("Set gateway"), icon: "globe", onSelect: dlg(r, "gateway") },
    r.external_gateway_info && { label: tr("Change gateway"), icon: "globe", onSelect: dlg(r, "gateway") },
    "-",
    { label: tr("Delete router"), icon: "trash", danger: true, onSelect: dlg(r, "delete") },
  ];
  const o = open;
  const r = o?.router;
  const dialogs = o && r && (
    <>
      {o.kind === "edit" && <EditRouterDialog router={r} onClose={close} />}
      {o.kind === "gateway" && <GatewayDialog router={r} onClose={close} />}
      {o.kind === "clearGw" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Clear the gateway of {v}?", { v: r.name || tr("router") })}
          submitLabel={tr("Clear gateway")}
          done={tr("Gateway cleared")}
          refresh={["network"]}
          run={() => os.put("network", `routers/${r.id}`, { router: { external_gateway_info: {} } })}
        >
          <p className="text-sm">{tr("Instances behind it lose outbound access, and floating IPs through it stop working.")}</p>
        </ActionDialog>
      )}
      {o.kind === "connect" && <ConnectSubnetDialog router={r} onClose={close} />}
      {o.kind === "disconnect" && <DisconnectSubnetDialog router={r} onClose={close} />}
      {o.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete {v}?", { v: r.name || tr("router") })}
          submitLabel={tr("Delete router")}
          done={tr("Router deleted")}
          refresh={["network"]}
          onDone={onDeleted}
          run={() => os.del("network", `routers/${r.id}`)}
        >
          <p className="text-sm">{tr("Disconnect its subnets first; Neutron refuses to delete a router that still has interfaces.")}</p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs };
}

function EditRouterDialog({ router, onClose }: { router: Router; onClose: () => void }) {
  const [name, setName] = useState(router.name);
  const [description, setDescription] = useState(router.description ?? "");
  const [up, setUp] = useState(router.admin_state_up);
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit {v}", { v: router.name || tr("router") })}
      submitLabel={tr("Save")}
      done={tr("Router updated")}
      refresh={["network"]}
      run={() => os.put("network", `routers/${router.id}`, { router: { name: name.trim(), description, admin_state_up: up } })}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Switch checked={up} onChange={setUp} label={tr("Admin state up")} hint={tr("A router that is down forwards no traffic.")} />
    </ActionDialog>
  );
}

function GatewayDialog({ router, onClose }: { router: Router; onClose: () => void }) {
  const ext = useNetworks({ "router:external": true });
  const [net, setNet] = useState(router.external_gateway_info?.network_id ?? "");
  const [snat, setSnat] = useState(router.external_gateway_info?.enable_snat ?? true);
  const session = useSession().data!;
  const chosen = net || ext.data?.[0]?.id || "";
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("External gateway of {v}", { v: router.name || tr("router") })}
      description={tr("Gives instances behind the router outbound access and allows floating IPs.")}
      submitLabel={tr("Set gateway")}
      canSubmit={!!chosen}
      done={tr("Gateway set")}
      refresh={["network"]}
      run={() =>
        os.put("network", `routers/${router.id}`, {
          router: { external_gateway_info: { network_id: chosen, ...(session.is_admin ? { enable_snat: snat } : {}) } },
        })
      }
    >
      <Field label={tr("External network")}>
        {(id) => (
          <Picker
            id={id}
            value={chosen}
            onChange={setNet}
            loading={ext.isPending}
            emptyText={tr("No external network is available.")}
            options={(ext.data ?? []).map((n) => ({ value: n.id, label: n.name, icon: "globe" }))}
          />
        )}
      </Field>
      {session.is_admin && <Switch checked={snat} onChange={setSnat} label="SNAT" hint={tr("Translate instance addresses for outbound traffic.")} />}
    </ActionDialog>
  );
}

function ConnectSubnetDialog({ router, onClose }: { router: Router; onClose: () => void }) {
  const ports = usePorts({ device_id: router.id });
  const connected = new Set((ports.data ?? []).flatMap((p) => p.fixed_ips.map((f) => f.subnet_id)));
  const { options, loading } = useSubnetOptions(connected, router.external_gateway_info?.network_id);
  const [subnet, setSubnet] = useState("");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Connect subnet")}
      description={tr("{v} takes the subnet's gateway address and routes between its subnets.", { v: router.name || tr("The router") })}
      submitLabel={tr("Connect")}
      canSubmit={!!subnet}
      done={tr("Subnet connected")}
      refresh={["network"]}
      run={() => os.put("network", `routers/${router.id}/add_router_interface`, { subnet_id: subnet })}
    >
      <Field label={tr("Subnet")}>
        {(id) => (
          <Picker
            id={id}
            value={subnet}
            onChange={setSubnet}
            searchable
            loading={loading}
            placeholder={tr("Choose a subnet")}
            searchPlaceholder={tr("Search networks, subnets or CIDRs")}
            emptyText={tr("Every subnet is already connected.")}
            options={options}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

function DisconnectSubnetDialog({ router, onClose }: { router: Router; onClose: () => void }) {
  const ports = usePorts({ device_id: router.id });
  const subnets = useSubnets();
  const netName = useNetName();
  const ifaces = (ports.data ?? []).filter((p) => p.device_owner.startsWith("network:router_interface") || p.device_owner === "network:ha_router_replicated_interface");
  const [subnet, setSubnet] = useState("");
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Disconnect subnet")}
      submitLabel={tr("Disconnect")}
      canSubmit={!!subnet}
      done={tr("Subnet disconnected")}
      refresh={["network"]}
      run={() => os.put("network", `routers/${router.id}/remove_router_interface`, { subnet_id: subnet })}
    >
      <Field label={tr("Subnet")}>
        {(id) => (
          <Picker
            id={id}
            value={subnet}
            onChange={setSubnet}
            loading={ports.isPending}
            placeholder={tr("Choose a subnet")}
            emptyText={tr("No subnets connected.")}
            options={ifaces.flatMap((p) =>
              p.fixed_ips.map((f) => {
                const s = subnets.data?.find((x) => x.id === f.subnet_id);
                return { value: f.subnet_id, label: s?.name || s?.cidr || f.subnet_id, group: netName(p.network_id), meta: f.ip_address, description: s?.cidr };
              }),
            )}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

// =========================================================================== list

export default function Routers({ admin = false }: { admin?: boolean }) {
  const session = useSession().data!;
  const filterProject = useProjectFilter(admin);
  // Neutron gives admins every project's routers, so the project view asks for the current project's.
  const routers = useListOrPages<Router>(true, "network", "routers", "routers", admin ? undefined : { project_id: session.project?.id }, {
    filters: filters(nameRegex(), idFilter("routers", "router"), filterProject, choice("status", tr("Status"), "status", NEUTRON_STATUSES, statusLabel)),
    sort: { name: "name", status: "status", ...(admin ? { project: "project_id" } : {}) },
    tableId: admin ? "admin-routers" : "routers",
  });
  const projects = useProjects(admin);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;
  const rows = routers.rows;
  const netName = useNetName();
  const invalidate = useInvalidate();
  const actions = useRouterActions();
  const [creating, setCreating] = useState(false);
  useNewParam(setCreating);
  const gw = (r: Router) => gwText(r, netName);

  const columns: Column<Router>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (r) => (
        <Link to={`/network/routers/${r.id}`} className="font-medium text-cable hover:underline">
          {r.name || r.id}
        </Link>
      ),
      value: (r) => r.name,
    },
    ...(admin ? [{ key: "project", header: tr("Project"), width: "9rem", hideBelow: "md", cell: (r: Router) => projectName(r.project_id), value: (r: Router) => projectName(r.project_id) } as Column<Router>] : []),
    { key: "status", header: tr("Status"), width: "7.5rem", cell: (r) => <StatusDot status={networkStatus(r.status)} label={r.status.toLowerCase()} />, value: (r) => r.status },
    { key: "gateway", header: tr("External gateway"), hideBelow: "md", cell: (r) => gw(r) || <span className="text-muted">{tr("none")}</span>, value: gw },
    { key: "admin", header: tr("Admin state"), width: "7rem", hideBelow: "lg", cell: (r) => (r.admin_state_up ? tr("Up") : tr("Down")), value: (r) => (r.admin_state_up ? "Up" : "Down") },
    { key: "description", header: tr("Description"), hideBelow: "xl", cell: (r) => <span className="text-muted">{r.description || "—"}</span>, value: (r) => r.description ?? "" },
  ];

  return (
    <>
      <PageHeader
        title={admin ? tr("All routers") : tr("Routers")}
        description={
          admin
            ? tr("Routers of every project. Open one to see which L3 agents host it.")
            : tr("Routers connect your networks to each other and, through an external gateway, to the outside world.")
        }
        actions={
          !admin && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              {tr("Create router")}
            </Button>
          )
        }
      />
      <ErrorNotice error={routers.error} className="mb-4" />
      <DataTable
        rows={rows}
        remote={routers.remote}
        loadingMore={routers.partial}
        columns={columns}
        rowKey={(r) => r.id}
        loading={routers.isPending}
        tableId={admin ? "admin-routers" : "routers"}
        noun={tr("routers")}
        rowLabel={(r) => r.name || r.id}
        empty={tr("No routers yet. Create one to give instances internet access.")}
        onRefresh={() => routers.refetch()}
        refreshing={routers.isFetching}
        onBulkDone={() => invalidate("network")}
        rowActions={(r) => actions.items(r)}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete routers?"),
            past: tr("deleted"),
            body: tr("Remove each router's subnet interfaces first; Neutron refuses to delete a router that still has them."),
            run: (r) => os.del("network", `routers/${r.id}`),
          },
        ]}
      />
      <CreateRouterDialog open={creating} onClose={() => setCreating(false)} />
      {actions.dialogs}
    </>
  );
}

function CreateRouterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ext = useNetworks({ "router:external": true });
  const { options } = useSubnetOptions(new Set());
  const invalidate = useInvalidate();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [gwNet, setGwNet] = useState<string | null>(null);
  const [subnet, setSubnet] = useState("");
  const gateway = gwNet ?? ext.data?.[0]?.id ?? "";
  const m = useMutation({
    mutationFn: async () => {
      const r = await os.post<{ router: Router }>("network", "routers", {
        router: { name: name.trim(), admin_state_up: true, external_gateway_info: gateway ? { network_id: gateway } : undefined },
      });
      if (subnet) await os.put("network", `routers/${r.router.id}/add_router_interface`, { subnet_id: subnet });
      return r.router;
    },
    onSuccess: (r) => {
      toast(tr("Router {name} created", { name: r.name }));
      invalidate("network");
      onClose();
      navigate(`/network/routers/${r.id}`);
    },
    onError: () => invalidate("network"),
  });
  return (
    <Dialog
      open={open}
      onClose={() => {
        m.reset();
        onClose();
      }}
      title={tr("Create router")}
      onSubmit={() => m.mutate()}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!name.trim()}>
            {tr("Create router")}
          </Button>
        </>
      }
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("edge-router")} />}</Field>
      <Field label={tr("External network")} hint={tr("Gives instances behind the router outbound access and allows floating IPs.")}>
        {(id) => (
          <Picker
            id={id}
            value={gateway}
            onChange={setGwNet}
            options={[{ value: "", label: tr("No external gateway") }, ...(ext.data ?? []).map((n) => ({ value: n.id, label: n.name, icon: "globe" }))]}
          />
        )}
      </Field>
      <Field label={tr("Connect subnet")} hint={tr("Optional. More subnets can be added later.")}>
        {(id) => (
          <Picker
            id={id}
            value={subnet}
            onChange={setSubnet}
            clearable
            searchable
            placeholder={tr("None")}
            searchPlaceholder={tr("Search networks, subnets or CIDRs")}
            options={options}
          />
        )}
      </Field>
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}

// =========================================================================== detail

const TABS = ["overview", "interfaces", "agents"] as const;

export function RouterDetail() {
  const { id = "" } = useParams();
  const session = useSession().data!;
  const navigate = useNavigate();
  const router = useOsGet<Router>("network", `routers/${id}`, (r: { router: Router }) => r.router);
  const ports = usePorts({ device_id: id });
  const subnets = useSubnets();
  const netName = useNetName();
  const actions = useRouterActions({ onDeleted: () => navigate("/network/routers") });
  const [tab, setTab] = useTab(TABS, "overview");
  const [disconnecting, setDisconnecting] = useState<{ port: Port; subnet: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const r = router.data;
  const interfaces = (ports.data ?? []).filter((p) => p.device_owner.startsWith("network:router_interface") || p.device_owner === "network:ha_router_replicated_interface");
  const subnetOf = (sid: string): Subnet | undefined => subnets.data?.find((s) => s.id === sid);

  const columns: Column<Port>[] = [
    {
      key: "subnet",
      header: tr("Subnet"),
      cell: (p) => {
        const s = subnetOf(p.fixed_ips[0]?.subnet_id);
        return <span className="font-medium">{s ? s.name || s.cidr : p.fixed_ips[0]?.subnet_id}</span>;
      },
      value: (p) => subnetOf(p.fixed_ips[0]?.subnet_id)?.name ?? "",
    },
    {
      key: "network",
      header: tr("Network"),
      hideBelow: "sm",
      cell: (p) => (
        <Link to={`/network/networks/${p.network_id}`} className="text-cable hover:underline">
          {netName(p.network_id)}
        </Link>
      ),
      value: (p) => netName(p.network_id),
    },
    { key: "cidr", header: "CIDR", width: "10rem", mono: true, hideBelow: "md", cell: (p) => subnetOf(p.fixed_ips[0]?.subnet_id)?.cidr ?? "", value: (p) => subnetOf(p.fixed_ips[0]?.subnet_id)?.cidr ?? "" },
    { key: "ip", header: tr("Router IP"), width: "9rem", mono: true, cell: (p) => p.fixed_ips.map((f) => f.ip_address).join(", "), value: (p) => p.fixed_ips.map((f) => f.ip_address).join(", ") },
    { key: "status", header: tr("Status"), width: "6.5rem", hideBelow: "lg", cell: (p) => <StatusDot status={networkStatus(p.status)} label={p.status.toLowerCase()} />, value: (p) => p.status },
  ];

  return (
    <>
      <Link to="/network/routers" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Routers")}
      </Link>
      <PageHeader title={r?.name || tr("Router")} description={r?.description || undefined} actions={r && <ActionMenu variant="button" items={() => actions.items(r, "detail")} />} />
      <ErrorNotice error={router.error} className="mb-4" />
      {r && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "interfaces", label: tr("Interfaces ({length})", { length: interfaces.length }) },
              ...(session.is_admin ? [{ id: "agents" as const, label: tr("L3 agents") }] : []),
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <Card title={tr("Details")}>
                <dl>
                  <Detail label={tr("Name")}>{r.name || "—"}</Detail>
                  <Detail label="ID">
                    <Mono>{r.id}</Mono>
                  </Detail>
                  <Detail label={tr("Status")}>
                    <StatusDot status={networkStatus(r.status)} label={r.status.toLowerCase()} />
                  </Detail>
                  <Detail label={tr("Admin state")}>{r.admin_state_up ? tr("Up") : tr("Down")}</Detail>
                  {r.project_id !== session.project?.id && <Detail label={tr("Project")}>{r.project_id}</Detail>}
                  {r.created_at && <Detail label={tr("Created")}>{fmtDate(r.created_at)}</Detail>}
                </dl>
              </Card>
              <Card title={tr("External gateway")}>
                <dl>
                  <Detail label={tr("Network")}>{r.external_gateway_info ? netName(r.external_gateway_info.network_id) : tr("None")}</Detail>
                  {r.external_gateway_info?.external_fixed_ips?.length ? (
                    <Detail label={tr("Gateway IP")}>
                      <Mono>{r.external_gateway_info.external_fixed_ips.map((f) => f.ip_address).join(", ")}</Mono>
                    </Detail>
                  ) : null}
                  {r.external_gateway_info && <Detail label="SNAT">{r.external_gateway_info.enable_snat === false ? tr("Off") : tr("On")}</Detail>}
                </dl>
              </Card>
            </div>
          )}
          {tab === "agents" && session.is_admin && <RouterAgents routerId={r.id} />}
          {tab === "interfaces" && (
            <DataTable
              rows={ports.data ? interfaces : undefined}
              columns={columns}
              rowKey={(p) => p.id}
              loading={ports.isPending}
              tableId="router-interfaces"
              noun={tr("interfaces")}
              empty={tr("No subnets connected.")}
              onRefresh={() => ports.refetch()}
              refreshing={ports.isFetching}
              rowActions={(p) => [
                { label: tr("Open network"), icon: "eye", onSelect: () => navigate(`/network/networks/${p.network_id}`) },
                "-",
                { label: tr("Disconnect"), icon: "unplug", danger: true, onSelect: () => setDisconnecting({ port: p, subnet: p.fixed_ips[0]?.subnet_id }) },
              ]}
              toolbar={
                <Button className="h-9" onClick={() => setConnecting(true)}>
                  <Icon name="plus" />
                  {tr("Connect subnet")}
                </Button>
              }
            />
          )}
        </>
      )}
      {disconnecting && r && (
        <ActionDialog
          onClose={() => setDisconnecting(null)}
          danger
          title={tr("Disconnect subnet?")}
          submitLabel={tr("Disconnect")}
          done={tr("Subnet disconnected")}
          refresh={["network"]}
          run={() => os.put("network", `routers/${r.id}/remove_router_interface`, { subnet_id: disconnecting.subnet })}
        >
          <p className="text-sm">{trx("Instances on {v} lose their route through {v2}.", { v: subnetOf(disconnecting.subnet)?.cidr ?? tr("the subnet"), v2: r.name || tr("this router") })}</p>
        </ActionDialog>
      )}
      {connecting && r && <ConnectSubnetDialog router={r} onClose={() => setConnecting(false)} />}
      {actions.dialogs}
    </>
  );
}

/** Admin: the L3 agents hosting a router (HA routers show their state per agent). */
function RouterAgents({ routerId }: { routerId: string }) {
  const navigate = useNavigate();
  const agents = useQuery({
    queryKey: ["os", "network", "routers", routerId, "l3-agents"],
    queryFn: () => os.get<{ agents: (Agent & { ha_state?: string | null })[] }>("network", `routers/${routerId}/l3-agents`).then((r) => r.agents),
  });
  const columns: Column<Agent & { ha_state?: string | null }>[] = [
    { key: "host", header: tr("Host"), cell: (a) => <span className="font-medium">{a.host}</span>, value: (a) => a.host },
    { key: "state", header: tr("Agent"), width: "8.5rem", cell: (a) => <StatusDot status={a.alive ? (a.admin_state_up ? "ok" : "warn") : "error"} label={!a.alive ? tr("down") : a.admin_state_up ? tr("alive") : tr("disabled")} />, value: (a) => (a.alive ? 1 : 0) },
    { key: "ha", header: tr("HA state"), width: "7rem", cell: (a) => a.ha_state ?? "—", value: (a) => a.ha_state ?? "" },
    { key: "az", header: tr("Zone"), width: "7rem", hideBelow: "md", cell: (a) => a.availability_zone ?? "", value: (a) => a.availability_zone ?? "" },
  ];
  return (
    <>
      <ErrorNotice error={agents.error} className="mb-4" />
      <DataTable
        rows={agents.data}
        columns={columns}
        rowKey={(a) => a.id}
        loading={agents.isPending}
        noun={tr("agents")}
        empty={tr("No L3 agent hosts this router (it is unscheduled, or the cloud uses OVN, which has no L3 agents).")}
        onRefresh={() => agents.refetch()}
        refreshing={agents.isFetching}
        rowActions={() => [{ label: tr("Manage in Network agents"), icon: "activity", onSelect: () => navigate("/admin/network/agents") }]}
      />
    </>
  );
}
