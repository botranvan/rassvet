/** Admin: Neutron agents (state, scheduling of routers and DHCP) and IP availability. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Button, ErrorNotice, Field, Icon, PageHeader, StatusDot, Textarea } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import { type Agent, type IpAvailability, useAgents, useIpAvailability } from "@/lib/neutron";
import { type Network, type Router, os, useInvalidate, useNetworks, useRouters } from "@/lib/os";
import { cn } from "@/lib/utils";
import { tr } from "@/lib/i18n";

const agentState = (a: Agent) => (!a.alive ? "down" : a.admin_state_up ? "alive" : "disabled");
const hosts = (a: Agent) => (a.agent_type === "L3 agent" ? "routers" : a.agent_type === "DHCP agent" ? "networks" : null);

export function NetworkAgents() {
  const agents = useAgents();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "toggle" | "edit" | "hosted" | "delete"; a: Agent } | null>(null);
  const close = () => setOpen(null);
  const columns: Column<Agent>[] = [
    { key: "type", header: tr("Agent"), cell: (a) => <span className="font-medium">{a.agent_type}</span>, value: (a) => a.agent_type },
    { key: "host", header: tr("Host"), cell: (a) => a.host, value: (a) => a.host },
    {
      key: "alive",
      header: tr("State"),
      width: "8.5rem",
      cell: (a) => <StatusDot status={a.alive ? (a.admin_state_up ? "ok" : "warn") : "error"} label={agentState(a)} />,
      value: (a) => (a.alive ? (a.admin_state_up ? 2 : 1) : 0),
      csv: agentState,
    },
    { key: "binary", header: tr("Binary"), hideBelow: "lg", mono: true, cell: (a) => a.binary, value: (a) => a.binary },
    { key: "az", header: tr("Zone"), width: "7rem", hideBelow: "xl", cell: (a) => a.availability_zone ?? "", value: (a) => a.availability_zone ?? "" },
    { key: "beat", header: tr("Last heartbeat"), width: "10.5rem", hideBelow: "md", cell: (a) => fmtDate(a.heartbeat_timestamp), value: (a) => a.heartbeat_timestamp },
  ];
  const down = agents.data?.filter((a) => !a.alive).length ?? 0;
  return (
    <>
      <PageHeader
        title={tr("Network agents")}
        description={
          down
            ? tr("{down} agent{v} not reporting. Move their routers and networks to a live agent, then delete the dead entries if the host is gone.", { down, v: down === 1 ? tr(" is") : tr("s are") })
            : tr("Neutron agents and the hosts they run on. Disable an agent to stop scheduling new routers or networks to it; move existing ones from its ⋮ menu.")
        }
      />
      <ErrorNotice error={agents.error} className="mb-4" />
      <DataTable
        rows={agents.data}
        columns={columns}
        rowKey={(a) => a.id}
        loading={agents.isPending}
        tableId="admin-network-agents"
        noun={tr("agents")}
        rowLabel={(a) => `${a.agent_type} on ${a.host}`}
        filterPlaceholder={tr("Filter by type, host or state")}
        onRefresh={() => agents.refetch()}
        refreshing={agents.isFetching}
        onBulkDone={() => invalidate("network")}
        rowActions={(a) => [
          hosts(a) && { label: a.agent_type === "L3 agent" ? tr("Hosted routers") : tr("Hosted networks"), icon: a.agent_type === "L3 agent" ? "router" : "network", onSelect: () => setOpen({ kind: "hosted", a }) },
          { label: a.admin_state_up ? tr("Disable agent") : tr("Enable agent"), icon: a.admin_state_up ? "ban" : "play", onSelect: () => setOpen({ kind: "toggle", a }) },
          { label: tr("Edit description"), icon: "edit", onSelect: () => setOpen({ kind: "edit", a }) },
          "-",
          { label: tr("Delete agent"), icon: "trash", danger: true, hint: a.alive ? tr("alive") : undefined, onSelect: () => setOpen({ kind: "delete", a }) },
        ]}
        bulkActions={[
          { id: "enable", label: tr("Enable"), icon: "play", title: tr("Enable agents?"), past: tr("enabled"), check: (a) => (a.admin_state_up ? tr("Already enabled") : true), run: (a) => os.put("network", `agents/${a.id}`, { agent: { admin_state_up: true } }) },
          { id: "disable", label: tr("Disable"), icon: "ban", title: tr("Disable agents?"), past: tr("disabled"), body: tr("New routers and networks are no longer scheduled to them; existing ones keep working."), check: (a) => (a.admin_state_up ? true : tr("Already disabled")), run: (a) => os.put("network", `agents/${a.id}`, { agent: { admin_state_up: false } }) },
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete agents?"),
            past: tr("deleted"),
            body: tr("Only the database entries are removed. A live agent registers itself again on its next report."),
            run: (a) => os.del("network", `agents/${a.id}`),
          },
        ]}
      />
      {open?.kind === "toggle" && (
        <ActionDialog
          onClose={close}
          danger={open.a.admin_state_up}
          title={tr("{v} {agent_type} on {host}?", { v: open.a.admin_state_up ? tr("Disable") : tr("Enable"), agent_type: open.a.agent_type, host: open.a.host })}
          submitLabel={open.a.admin_state_up ? tr("Disable") : tr("Enable")}
          done={tr("Agent {v}", { v: open.a.admin_state_up ? tr("disabled") : tr("enabled") })}
          refresh={["network"]}
          run={() => os.put("network", `agents/${open.a.id}`, { agent: { admin_state_up: !open.a.admin_state_up } })}
        >
          <p className="text-sm">
            {open.a.admin_state_up
              ? tr("The scheduler stops placing new routers or networks here. What it already hosts keeps running; move it under Hosted routers / networks.")
              : tr("The scheduler may place new routers or networks on this agent again.")}
          </p>
        </ActionDialog>
      )}
      {open?.kind === "edit" && <AgentDescriptionDialog agent={open.a} onClose={close} />}
      {open?.kind === "hosted" && <HostedDialog agent={open.a} agents={agents.data ?? []} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete {agent_type} on {host}?", { agent_type: open.a.agent_type, host: open.a.host })}
          submitLabel={tr("Delete agent")}
          done={tr("Agent deleted")}
          refresh={["network"]}
          run={() => os.del("network", `agents/${open.a.id}`)}
        >
          <p className="text-sm">
            {open.a.alive
              ? tr("This agent is alive and will register again on its next report. Stop the service on the host first if it's being retired.")
              : tr("The agent isn't reporting. Removing it cleans up the database; move its routers or networks to another agent first.")}
          </p>
        </ActionDialog>
      )}
    </>
  );
}

function AgentDescriptionDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [description, setDescription] = useState(agent.description ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("{agent_type} on {host}", { agent_type: agent.agent_type, host: agent.host })}
      submitLabel={tr("Save")}
      done={tr("Agent updated")}
      refresh={["network"]}
      run={() => os.put("network", `agents/${agent.id}`, { agent: { description } })}
    >
      <Field label={tr("Description")}>{(id) => <Textarea id={id} autoFocus rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tr("e.g. Draining for kernel upgrade")} />}</Field>
    </ActionDialog>
  );
}

/** Routers hosted by an L3 agent or networks by a DHCP agent: add, remove, move. */
function HostedDialog({ agent, agents, onClose }: { agent: Agent; agents: Agent[]; onClose: () => void }) {
  const l3 = agent.agent_type === "L3 agent";
  const sub = l3 ? "l3-routers" : "dhcp-networks";
  const hosted = useQuery({
    queryKey: ["os", "network", "agents", agent.id, sub],
    queryFn: () => os.get<{ routers?: Router[]; networks?: Network[] }>("network", `agents/${agent.id}/${sub}`).then((r) => (l3 ? r.routers : r.networks) ?? []),
  });
  const routers = useRouters();
  const networks = useNetworks();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [add, setAdd] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const peers = agents.filter((a) => a.agent_type === agent.agent_type && a.id !== agent.id);
  const has = new Set(hosted.data?.map((x) => x.id));
  const body = (id: string) => (l3 ? { router_id: id } : { network_id: id });
  const m = useMutation({
    mutationFn: async (op: { kind: "add" | "remove" | "move"; id: string }) => {
      if (op.kind === "add") return os.post("network", `agents/${agent.id}/${sub}`, body(op.id));
      if (op.kind === "move") await os.post("network", `agents/${moveTo}/${sub}`, body(op.id));
      return os.del("network", `agents/${agent.id}/${sub}/${op.id}`);
    },
    onSuccess: (_, op) => {
      toast(op.kind === "add" ? tr("Scheduled to this agent") : op.kind === "move" ? tr("Moved to the other agent") : tr("Removed from this agent"));
      setAdd("");
      invalidate("network");
    },
  });
  const options = l3
    ? (routers.data ?? []).map((r) => ({ value: r.id, label: r.name || r.id, icon: "router", disabled: has.has(r.id) ? tr("Already here") : false }))
    : (networks.data ?? []).filter((n) => !n["router:external"]).map((n) => ({ value: n.id, label: n.name || n.id, icon: "network", disabled: has.has(n.id) ? tr("Already here") : false }));
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={tr("{v} on {host}", { v: l3 ? tr("Routers") : tr("Networks"), host: agent.host })}
      description={`${agent.agent_type}${agent.alive ? "" : tr(" — not reporting")}. ${l3 ? tr("A router normally lives on one L3 agent (two or more for HA).") : tr("A network can be served by several DHCP agents.")}`}
      footer={
        <Button variant="primary" onClick={onClose}>
          {tr("Done")}
        </Button>
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <Field label={tr("Move to another {agent_type}", { agent_type: agent.agent_type })}>
            {(id) => (
              <Picker
                id={id}
                value={moveTo}
                onChange={setMoveTo}
                clearable
                placeholder={tr("Choose a target agent (for Move)")}
                options={peers.map((a) => ({ value: a.id, label: a.host, description: agentState(a), disabled: !a.alive ? tr("Not reporting") : !a.admin_state_up ? tr("Disabled") : false }))}
              />
            )}
          </Field>
        </div>
      </div>
      <ul className="divide-y divide-line rounded-md border border-line">
        {(hosted.data ?? []).map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <Icon name={l3 ? "router" : "network"} className="text-muted" />
            <Link to={`/network/${l3 ? "routers" : "networks"}/${x.id}`} className="min-w-0 flex-1 truncate text-cable hover:underline">
              {x.name || x.id}
            </Link>
            <Button className="h-8" disabled={!moveTo || m.isPending} onClick={() => m.mutate({ kind: "move", id: x.id })}>
              <Icon name="move-right" />
              {tr("Move")}
            </Button>
            <Button variant="ghost" className="h-8" disabled={m.isPending} onClick={() => m.mutate({ kind: "remove", id: x.id })}>
              {tr("Remove")}
            </Button>
          </li>
        ))}
        {hosted.data?.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">{tr("Nothing hosted here.")}</li>}
        {hosted.isPending && <li className="px-3 py-4 text-center text-sm text-muted">{tr("Loading…")}</li>}
      </ul>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <Picker aria-label={l3 ? tr("Router") : tr("Network")} value={add} onChange={setAdd} searchable placeholder={tr("Add a {v} to this agent", { v: l3 ? tr("router") : tr("network") })} options={options} />
        </div>
        <Button disabled={!add || m.isPending} busy={m.isPending && m.variables?.kind === "add"} onClick={() => m.mutate({ kind: "add", id: add })}>
          <Icon name="plus" />
          {tr("Add")}
        </Button>
      </div>
      <ErrorNotice error={m.error ?? hosted.error} />
    </Dialog>
  );
}

// =========================================================================== IP availability

export function IpAvailabilityPage() {
  const avail = useIpAvailability();
  const projects = useProjects(true);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;
  const pct = (a: IpAvailability) => (a.total_ips ? Math.round((a.used_ips / a.total_ips) * 100) : 0);
  const cidrs = (a: IpAvailability) => a.subnet_ip_availability.map((s) => s.cidr).join(", ");
  const columns: Column<IpAvailability>[] = [
    {
      key: "name",
      header: tr("Network"),
      cell: (a) => (
        <Link to={`/network/networks/${a.network_id}`} className="font-medium text-cable hover:underline">
          {a.network_name || a.network_id}
        </Link>
      ),
      value: (a) => a.network_name,
    },
    { key: "project", header: tr("Project"), width: "9rem", hideBelow: "md", cell: (a) => projectName(a.project_id), value: (a) => projectName(a.project_id) },
    { key: "subnets", header: tr("Subnets"), hideBelow: "lg", mono: true, cell: cidrs, value: cidrs },
    {
      key: "usage",
      header: tr("Used"),
      width: "14rem",
      wrap: true,
      cell: (a) => (
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink/8" role="meter" aria-valuenow={pct(a)} aria-valuemin={0} aria-valuemax={100} aria-label={tr("IP usage")}>
            <div className={cn("h-full rounded-full", pct(a) >= 90 ? "bg-led-red" : pct(a) >= 75 ? "bg-led-amber" : "bg-cable")} style={{ width: `${pct(a)}%` }} />
          </div>
          <span className="w-24 shrink-0 text-right text-sm tabular-nums">
            {a.used_ips}/{a.total_ips > 99999 ? "∞" : a.total_ips}
          </span>
        </div>
      ),
      value: pct,
      csv: (a) => `${a.used_ips}/${a.total_ips}`,
    },
  ];
  const full = avail.data?.filter((a) => a.total_ips && a.total_ips < 100000 && pct(a) >= 90).length ?? 0;
  return (
    <>
      <PageHeader
        title={tr("IP availability")}
        description={full ? tr("{full} network{v} at least 90% full. Add a subnet or a larger allocation pool before ports fail to get addresses.", { full, v: full === 1 ? tr(" is") : tr("s are") }) : tr("Allocated addresses per network and subnet, across all projects (IPv6 subnets count as unlimited).")}
      />
      <ErrorNotice error={avail.error} className="mb-4" />
      <DataTable
        rows={avail.data}
        columns={columns}
        rowKey={(a) => a.network_id}
        loading={avail.isPending}
        tableId="admin-ip-availability"
        noun={tr("networks")}
        onRefresh={() => avail.refetch()}
        refreshing={avail.isFetching}
      />
    </>
  );
}
