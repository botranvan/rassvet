/** Load balancers: list (project and admin view), create wizard and the per-LB actions. */
import { useMemo, useState } from "react";
import {
  ActionDialog,
  Button,
  Checkbox,
  type Column,
  DataTable,
  ErrorNotice,
  Field,
  Icon,
  Input,
  Link,
  type MenuEntry,
  MultiPicker,
  PageHeader,
  Picker,
  StatusDot,
  Switch,
  Tabs,
  Textarea,
  age,
  fmtDate,
  os,
  tr,
  useFloatingIps,
  useInAdmin,
  useInvalidate,
  useNavigate,
  useNewParam,
  useNetworks,
  useOsGet,
  usePorts,
  useProjects,
  useSession,
  useSubnets,
} from "@rassvet/sdk";
import {
  ALGORITHMS,
  type Algorithm,
  BASE,
  LB,
  LISTENER_PROTOCOLS,
  type LbQuota,
  type ListenerProtocol,
  type LoadBalancer,
  MONITOR_TYPES,
  type MonitorType,
  POOL_FOR_LISTENER,
  type PoolProtocol,
  deleteLb,
  lbName,
  opStatus,
  pending,
  provStatus,
  statusText,
  useFlavorsLb,
  useListeners,
  useLoadBalancers,
  useProviders,
  useScope,
  useZonesLb,
} from "./api";
import { CertificatePicker, ListenerDialog, PoolDialog, retry409, useMemberTargets } from "./dialogs";

/** Floating IPs by port (the VIP port of each load balancer). */
export function useVipFloatingIps() {
  const fips = useFloatingIps();
  return useMemo(() => {
    const m = new Map<string, { id: string; floating_ip_address: string }>();
    for (const f of fips.data ?? []) if (f.port_id) m.set(f.port_id, f);
    return m;
  }, [fips.data]);
}

export default function LoadBalancers() {
  const admin = useInAdmin();
  const scope = useScope();
  const session = useSession();
  const lbs = useLoadBalancers(scope);
  const listeners = useListeners(scope);
  const flavors = useFlavorsLb();
  const projects = useProjects(admin);
  const fips = useVipFloatingIps();
  const invalidate = useInvalidate();
  const actions = useLbActions();
  const [creating, setCreating] = useState(false);
  useNewParam(setCreating);
  const quota = useOsGet<LbQuota>(LB, `lbaas/quotas/${session.data?.project?.id ?? ""}`, (r: { quota: LbQuota }) => r.quota, { enabled: !admin && !!session.data?.project?.id });

  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;
  const flavorName = (id?: string | null) => (id ? (flavors.data?.find((f) => f.id === id)?.name ?? id.slice(0, 8)) : "");
  const ports = (lb: LoadBalancer) =>
    (listeners.data ?? [])
      .filter((l) => l.loadbalancers.some((x) => x.id === lb.id))
      .sort((a, b) => a.protocol_port - b.protocol_port)
      .map((l) => `${l.protocol === "TERMINATED_HTTPS" ? "HTTPS*" : l.protocol}:${l.protocol_port}`);

  const columns: Column<LoadBalancer>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (lb) => (
        <div className="min-w-0">
          <Link to={`${BASE}/load-balancers/${lb.id}`} className="block truncate font-medium text-cable hover:underline">
            {lbName(lb)}
          </Link>
          {lb.description && <p className="truncate text-xs text-muted">{lb.description}</p>}
        </div>
      ),
      value: (lb) => `${lb.name} ${lb.description ?? ""} ${lb.id}`,
      csv: (lb) => lb.name,
    },
    ...(admin ? [{ key: "project", header: tr("Project"), width: "9rem", hideBelow: "md" as const, cell: (lb: LoadBalancer) => projectName(lb.project_id), value: (lb: LoadBalancer) => projectName(lb.project_id) }] : []),
    {
      key: "vip",
      header: tr("VIP"),
      width: "11rem",
      cell: (lb) => (
        <div className="min-w-0 font-mono text-[12.5px]">
          <p className="truncate">{lb.vip_address}</p>
          {fips.get(lb.vip_port_id) && <p className="truncate text-xs text-muted">{fips.get(lb.vip_port_id)!.floating_ip_address}</p>}
        </div>
      ),
      value: (lb) => `${lb.vip_address} ${fips.get(lb.vip_port_id)?.floating_ip_address ?? ""}`,
    },
    {
      key: "listeners",
      header: tr("Listeners"),
      width: "11rem",
      hideBelow: "lg",
      wrap: true,
      cell: (lb) => (ports(lb).length ? <span className="font-mono text-[12px]">{ports(lb).join(", ")}</span> : <span className="text-muted">{tr("None")}</span>),
      value: (lb) => ports(lb).join(" "),
    },
    {
      key: "operating",
      header: tr("Operating"),
      width: "8.5rem",
      cell: (lb) => <StatusDot status={opStatus(lb.operating_status)} label={statusText(lb.operating_status)} />,
      value: (lb) => lb.operating_status,
    },
    {
      key: "provisioning",
      header: tr("Provisioning"),
      width: "9.5rem",
      hideBelow: "sm",
      cell: (lb) => <StatusDot status={provStatus(lb.provisioning_status)} label={statusText(lb.provisioning_status)} />,
      value: (lb) => lb.provisioning_status,
    },
    {
      key: "provider",
      header: tr("Provider"),
      width: "8rem",
      hideBelow: "xl",
      cell: (lb) => (
        <div className="min-w-0">
          <p className="truncate">{lb.provider}</p>
          {lb.flavor_id && <p className="truncate text-xs text-muted">{flavorName(lb.flavor_id)}</p>}
        </div>
      ),
      value: (lb) => `${lb.provider} ${flavorName(lb.flavor_id)}`,
    },
    { key: "age", header: tr("Age"), width: "7rem", hideBelow: "2xl", cell: (lb) => <span title={fmtDate(lb.created_at) ?? ""}>{age(lb.created_at)}</span>, value: (lb) => lb.created_at ?? "" },
  ];

  const used = lbs.data?.length ?? 0;
  const limit = quota.data?.load_balancer;
  return (
    <>
      <PageHeader
        title={admin ? tr("All load balancers") : tr("Load balancers")}
        description={
          admin
            ? tr("Octavia load balancers of every project in this region.")
            : `${tr("Spread traffic to a VIP over a pool of instances, with health checks, TLS termination and L7 routing.")}${limit != null && limit >= 0 ? " " + tr("{used} of {limit} load balancers used.", { used, limit }) : ""}`
        }
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Create load balancer")}
          </Button>
        }
      />
      <ErrorNotice error={lbs.error} className="mb-4" />
      <DataTable
        rows={lbs.data}
        columns={columns}
        rowKey={(lb) => lb.id}
        loading={lbs.isPending}
        tableId={admin ? "octavia-admin-load-balancers" : "octavia-load-balancers"}
        noun={tr("load balancers")}
        rowLabel={lbName}
        onRefresh={() => lbs.refetch()}
        refreshing={lbs.isFetching}
        onBulkDone={() => invalidate(LB, "network")}
        empty={admin ? tr("No load balancers in this region.") : tr("This project has no load balancers yet.")}
        filterPlaceholder={tr("Filter by name, VIP, port or status")}
        rowActions={(lb) => actions.items(lb)}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete load balancers?"),
            past: tr("deleted"),
            body: tr("Each load balancer is deleted with its listeners, pools, members, health monitors and L7 policies (cascade). The VIP port is released; floating IPs stay allocated."),
            check: (lb) => (pending(lb) ? tr("Busy ({status})", { status: statusText(lb.provisioning_status) }) : true),
            run: (lb) => deleteLb(lb.id, true),
          },
        ]}
      />
      {creating && <CreateLoadBalancerDialog onClose={() => setCreating(false)} />}
      {actions.dialogs}
    </>
  );
}

// =========================================================================== actions

type Kind = "edit" | "delete" | "fip" | "unfip" | "failover" | "listener" | "pool";

export function useLbActions({ onDeleted }: { onDeleted?: () => void } = {}) {
  const navigate = useNavigate();
  const admin = useSession().data?.is_admin;
  const fips = useVipFloatingIps();
  const [open, setOpen] = useState<{ kind: Kind; lb: LoadBalancer } | null>(null);
  const close = () => setOpen(null);
  const items = (lb: LoadBalancer, where: "list" | "detail" = "list"): MenuEntry[] => {
    const busy = pending(lb) ? tr("Busy ({status})", { status: statusText(lb.provisioning_status) }) : false;
    const fip = fips.get(lb.vip_port_id);
    return [
      where === "list" && { label: tr("View details"), icon: "eye", onSelect: () => navigate(`${BASE}/load-balancers/${lb.id}`) },
      where === "list" && "-",
      { label: tr("Edit load balancer"), icon: "edit", disabled: busy, onSelect: () => setOpen({ kind: "edit", lb }) },
      { label: tr("Add listener"), icon: "radio-tower", disabled: busy, onSelect: () => setOpen({ kind: "listener", lb }) },
      { label: tr("Add pool"), icon: "layers", disabled: busy, onSelect: () => setOpen({ kind: "pool", lb }) },
      "-",
      fip
        ? { label: tr("Disassociate floating IP"), icon: "unlink", hint: fip.floating_ip_address, onSelect: () => setOpen({ kind: "unfip", lb }) }
        : { label: tr("Associate floating IP"), icon: "globe", onSelect: () => setOpen({ kind: "fip", lb }) },
      admin && { label: tr("Failover"), icon: "refresh", disabled: busy, onSelect: () => setOpen({ kind: "failover", lb }) },
      "-",
      { label: tr("Delete load balancer"), icon: "trash", danger: true, disabled: busy, onSelect: () => setOpen({ kind: "delete", lb }) },
    ];
  };
  const o = open;
  const dialogs = o && (
    <>
      {o.kind === "edit" && <EditLbDialog lb={o.lb} onClose={close} />}
      {o.kind === "delete" && <DeleteLbDialog lb={o.lb} onClose={close} onDone={onDeleted} />}
      {o.kind === "fip" && <AssociateFipDialog lb={o.lb} onClose={close} />}
      {o.kind === "unfip" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Disassociate {ip}?", { ip: fips.get(o.lb.vip_port_id)?.floating_ip_address ?? "" })}
          submitLabel={tr("Disassociate")}
          done={tr("Floating IP disassociated")}
          refresh={["network"]}
          run={() => os.put("network", `floatingips/${fips.get(o.lb.vip_port_id)!.id}`, { floatingip: { port_id: null } })}
        >
          <p className="text-sm">{tr("The load balancer stays reachable on its VIP; the floating IP stays allocated to the project.")}</p>
        </ActionDialog>
      )}
      {o.kind === "failover" && (
        <ActionDialog
          onClose={close}
          title={tr("Fail over {name}?", { name: lbName(o.lb) })}
          submitLabel={tr("Failover")}
          done={tr("Failover started")}
          refresh={[LB]}
          run={() => os.put(LB, `lbaas/loadbalancers/${o.lb.id}/failover`)}
        >
          <p className="text-sm">
            {tr("Octavia replaces the load balancer's amphorae (or re-creates it on the provider) one by one. Active connections may drop; use it to recover from errors or to roll out a new amphora image.")}
          </p>
        </ActionDialog>
      )}
      {o.kind === "listener" && <ListenerDialogFor lb={o.lb} onClose={close} />}
      {o.kind === "pool" && <PoolDialogFor lb={o.lb} onClose={close} />}
    </>
  );
  return { items, dialogs, openDialog: (lb: LoadBalancer, kind: Kind) => setOpen({ kind, lb }) };
}

function ListenerDialogFor({ lb, onClose }: { lb: LoadBalancer; onClose: () => void }) {
  const pools = useOsGet(LB, "lbaas/pools", (r: { pools: import("./api").Pool[] }) => r.pools.filter((p) => p.loadbalancers.some((x) => x.id === lb.id)), { q: { loadbalancer_id: lb.id } });
  if (!pools.data) return null;
  return <ListenerDialog lb={lb} pools={pools.data} onClose={onClose} />;
}

function PoolDialogFor({ lb, onClose }: { lb: LoadBalancer; onClose: () => void }) {
  const listeners = useOsGet(LB, "lbaas/listeners", (r: { listeners: import("./api").Listener[] }) => r.listeners.filter((l) => l.loadbalancers.some((x) => x.id === lb.id)), { q: { loadbalancer_id: lb.id } });
  if (!listeners.data) return null;
  return <PoolDialog lb={lb} listeners={listeners.data} onClose={onClose} />;
}

function EditLbDialog({ lb, onClose }: { lb: LoadBalancer; onClose: () => void }) {
  const [name, setName] = useState(lb.name);
  const [description, setDescription] = useState(lb.description ?? "");
  const [up, setUp] = useState(lb.admin_state_up);
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit {name}", { name: lbName(lb) })}
      submitLabel={tr("Save")}
      done={tr("Load balancer updated")}
      refresh={[LB]}
      run={() => os.put(LB, `lbaas/loadbalancers/${lb.id}`, { loadbalancer: { name: name.trim(), description, admin_state_up: up } })}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Switch checked={up} onChange={setUp} label={tr("Admin state up")} hint={tr("A load balancer that is down stops serving every listener.")} />
    </ActionDialog>
  );
}

function DeleteLbDialog({ lb, onClose, onDone }: { lb: LoadBalancer; onClose: () => void; onDone?: () => void }) {
  const [cascade, setCascade] = useState(true);
  const children = lb.listeners.length + lb.pools.length;
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Delete {name}?", { name: lbName(lb) })}
      submitLabel={tr("Delete load balancer")}
      canSubmit={cascade || children === 0}
      done={tr("Deleting load balancer {name}", { name: lbName(lb) })}
      refresh={[LB, "network"]}
      onDone={onDone}
      run={() => deleteLb(lb.id, cascade)}
    >
      <p className="text-sm">
        {tr("The VIP {vip} is released. Floating IPs stay allocated to the project.", { vip: lb.vip_address })}
      </p>
      <Checkbox checked={cascade} onChange={setCascade}>
        {tr("Also delete its {listeners} listener(s), {pools} pool(s) and everything in them", { listeners: lb.listeners.length, pools: lb.pools.length })}
      </Checkbox>
      {!cascade && children > 0 && <p className="text-sm text-led-red">{tr("Octavia refuses to delete a load balancer that still has listeners or pools.")}</p>}
    </ActionDialog>
  );
}

function AssociateFipDialog({ lb, onClose }: { lb: LoadBalancer; onClose: () => void }) {
  const fips = useFloatingIps();
  const nets = useNetworks();
  const free = (fips.data ?? []).filter((f) => !f.port_id);
  const external = (nets.data ?? []).filter((n) => n["router:external"]);
  const [choice, setChoice] = useState("");
  const value = choice || (free[0] ? free[0].id : external[0] ? `new:${external[0].id}` : "");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Associate a floating IP with {name}", { name: lbName(lb) })}
      description={tr("The floating IP is mapped to the VIP {vip}. The VIP network needs a router to the external network.", { vip: lb.vip_address })}
      submitLabel={tr("Associate")}
      canSubmit={!!value}
      done={tr("Floating IP associated")}
      refresh={["network"]}
      run={() =>
        value.startsWith("new:")
          ? os.post("network", "floatingips", { floatingip: { floating_network_id: value.slice(4), port_id: lb.vip_port_id } })
          : os.put("network", `floatingips/${value}`, { floatingip: { port_id: lb.vip_port_id } })
      }
    >
      <Field label={tr("Floating IP")}>
        {(id) => (
          <Picker
            id={id}
            value={value}
            onChange={setChoice}
            loading={fips.isPending || nets.isPending}
            options={[
              ...free.map((f) => ({ value: f.id, label: f.floating_ip_address, icon: "globe", group: tr("Allocated, not in use") })),
              ...external.map((n) => ({ value: `new:${n.id}`, label: tr("New address from {net}", { net: n.name || n.id }), icon: "plus", group: tr("Allocate") })),
            ]}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

// =========================================================================== create

const STEPS = ["details", "vip", "listener", "pool", "monitor"] as const;
type Step = (typeof STEPS)[number];

export function CreateLoadBalancerDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const admin = useInAdmin();
  const providers = useProviders();
  const flavors = useFlavorsLb();
  const zones = useZonesLb();
  const nets = useNetworks();
  const subnets = useSubnets();
  const ports = usePorts();
  const T = useMemberTargets();
  const [step, setStep] = useState<Step>("details");
  // details
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState("");
  const [flavor, setFlavor] = useState("");
  const [zone, setZone] = useState("");
  // vip
  const [vipMode, setVipMode] = useState<"subnet" | "port">("subnet");
  const [vipSubnet, setVipSubnet] = useState("");
  const [vipAddress, setVipAddress] = useState("");
  const [vipPort, setVipPort] = useState("");
  const [fipNet, setFipNet] = useState("");
  // listener
  const [withListener, setWithListener] = useState(true);
  const [protocol, setProtocol] = useState<ListenerProtocol>("HTTP");
  const [port, setPort] = useState("80");
  const [tlsRef, setTlsRef] = useState("");
  // pool
  const [withPool, setWithPool] = useState(true);
  const [poolProtocol, setPoolProtocol] = useState<PoolProtocol>("HTTP");
  const [algorithm, setAlgorithm] = useState<Algorithm>("ROUND_ROBIN");
  const [members, setMembers] = useState<string[]>([]);
  const [memberPort, setMemberPort] = useState("80");
  // monitor
  const [withMonitor, setWithMonitor] = useState(true);
  const [monType, setMonType] = useState<MonitorType>("HTTP");
  const [monPath, setMonPath] = useState("/");
  const [monCodes, setMonCodes] = useState("200");
  const [monDelay, setMonDelay] = useState("5");
  const [monTimeout, setMonTimeout] = useState("3");
  const [monRetries, setMonRetries] = useState("3");

  const netName = (id: string) => nets.data?.find((n) => n.id === id)?.name ?? id;
  const external = (nets.data ?? []).filter((n) => n["router:external"]);
  const httpMon = monType === "HTTP" || monType === "HTTPS";
  const problems: Partial<Record<Step, string>> = {};
  if (vipMode === "subnet" ? !vipSubnet : !vipPort) problems.vip = tr("Choose where the VIP lives");
  if (withListener && !(Number(port) > 0 && Number(port) < 65536)) problems.listener = tr("Enter a port");
  if (withListener && protocol === "TERMINATED_HTTPS" && !tlsRef.trim()) problems.listener = tr("A TERMINATED_HTTPS listener needs a certificate");
  if (withListener && withPool && members.length && !(Number(memberPort) > 0)) problems.pool = tr("Enter the members' port");
  if (withListener && withPool && withMonitor && !(Number(monTimeout) <= Number(monDelay))) problems.monitor = tr("The timeout can't be longer than the interval");

  const changeProtocol = (p: ListenerProtocol) => {
    setProtocol(p);
    setPort(p === "HTTP" ? "80" : p === "HTTPS" || p === "TERMINATED_HTTPS" ? "443" : p === "PROMETHEUS" ? "9100" : port);
    const pp = POOL_FOR_LISTENER[p][0];
    if (pp) setPoolProtocol(pp);
    setMonType(p === "UDP" ? "UDP-CONNECT" : p === "SCTP" ? "SCTP" : p === "HTTPS" ? "TLS-HELLO" : p === "TCP" ? "TCP" : "HTTP");
    if (p === "PROMETHEUS") setWithPool(false);
  };

  const create = async () => {
    const membersBody = members
      .map((k) => T.targets.find((t) => t.key === k))
      .filter(Boolean)
      .map((t) => ({ address: t!.address, protocol_port: Number(memberPort), subnet_id: t!.subnet, name: t!.label }));
    const pool =
      withPool && protocol !== "PROMETHEUS"
        ? {
            protocol: poolProtocol,
            lb_algorithm: algorithm,
            name: name.trim() ? `${name.trim()}-pool` : undefined,
            members: membersBody.length ? membersBody : undefined,
            healthmonitor: withMonitor
              ? {
                  type: monType,
                  delay: Number(monDelay),
                  timeout: Number(monTimeout),
                  max_retries: Number(monRetries),
                  ...(httpMon ? { url_path: monPath || "/", expected_codes: monCodes || "200" } : {}),
                }
              : undefined,
          }
        : undefined;
    const loadbalancer: Record<string, unknown> = {
      name: name.trim() || undefined,
      description: description || undefined,
      provider: provider || undefined,
      flavor_id: flavor || undefined,
      availability_zone: zone || undefined,
      ...(vipMode === "subnet" ? { vip_subnet_id: vipSubnet, vip_address: vipAddress.trim() || undefined } : { vip_port_id: vipPort }),
      listeners: withListener
        ? [
            {
              protocol,
              protocol_port: Number(port),
              name: name.trim() ? `${name.trim()}-${protocol.toLowerCase()}-${port}` : undefined,
              ...(protocol === "TERMINATED_HTTPS" ? { default_tls_container_ref: tlsRef.trim() } : {}),
              ...(pool ? { default_pool: pool } : {}),
            },
          ]
        : undefined,
    };
    const r = await os.post<{ loadbalancer: LoadBalancer }>(LB, "lbaas/loadbalancers", { loadbalancer });
    if (fipNet) {
      await retry409(() => os.post("network", "floatingips", { floatingip: { floating_network_id: fipNet, port_id: r.loadbalancer.vip_port_id } }), 5);
    }
    return r.loadbalancer;
  };

  const idx = STEPS.indexOf(step);
  const stepLabel: Record<Step, string> = {
    details: tr("Details"),
    vip: tr("VIP"),
    listener: tr("Listener"),
    pool: tr("Pool & members"),
    monitor: tr("Health monitor"),
  };
  return (
    <ActionDialog<LoadBalancer>
      onClose={onClose}
      size="xl"
      title={tr("Create load balancer")}
      description={tr("Everything is created in one request (Octavia's fully populated load balancer); you can add more listeners and pools later.")}
      submitLabel={tr("Create load balancer")}
      canSubmit={Object.keys(problems).length === 0}
      done={(lb) => tr("Creating load balancer {name}", { name: lbName(lb) })}
      refresh={[LB, "network"]}
      onDone={(lb) => navigate(`${BASE}/load-balancers/${lb.id}`)}
      run={create}
    >
      <Tabs value={step} onChange={setStep} tabs={STEPS.map((s, i) => ({ id: s, label: `${i + 1}. ${stepLabel[s]}${problems[s] ? " •" : ""}` }))} />
      {step === "details" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="web-lb" />}</Field>
            <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={tr("Provider")} hint={tr("amphora: VMs running HAProxy (L7, TLS); ovn: distributed L4 in OVN.")}>
              {(id) => (
                <Picker
                  id={id}
                  value={provider}
                  onChange={setProvider}
                  loading={providers.isPending}
                  options={[{ value: "", label: tr("Cloud default") }, ...(providers.data ?? []).map((p) => ({ value: p.name, label: p.name, description: p.description }))]}
                />
              )}
            </Field>
            <Field label={tr("Flavor")} hint={tr("Topology and size, defined by the cloud admins.")}>
              {(id) => (
                <Picker
                  id={id}
                  value={flavor}
                  onChange={setFlavor}
                  loading={flavors.isPending}
                  options={[
                    { value: "", label: tr("Default") },
                    ...(flavors.data ?? []).map((f) => ({ value: f.id, label: f.name, description: f.description, disabled: f.enabled ? false : tr("Disabled") })),
                  ]}
                />
              )}
            </Field>
            <Field label={tr("Availability zone")}>
              {(id) => (
                <Picker
                  id={id}
                  value={zone}
                  onChange={setZone}
                  options={[{ value: "", label: tr("Any") }, ...(zones.data ?? []).filter((z) => z.enabled).map((z) => ({ value: z.name, label: z.name, description: z.description }))]}
                />
              )}
            </Field>
          </div>
        </>
      )}
      {step === "vip" && (
        <>
          <Tabs
            value={vipMode}
            onChange={setVipMode}
            tabs={[
              { id: "subnet", label: tr("Subnet") },
              { id: "port", label: tr("Existing port") },
            ]}
          />
          {vipMode === "subnet" ? (
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <Field label={tr("VIP subnet")} hint={tr("Clients reach the load balancer on an address of this subnet.")}>
                {(id) => (
                  <Picker
                    id={id}
                    value={vipSubnet}
                    onChange={setVipSubnet}
                    searchable
                    loading={subnets.isPending}
                    placeholder={tr("Choose a subnet")}
                    options={(subnets.data ?? []).map((s) => ({ value: s.id, label: s.name || s.id, description: `${s.cidr}`, group: netName(s.network_id), icon: "network" }))}
                  />
                )}
              </Field>
              <Field label={tr("Fixed address")} hint={tr("Optional.")}>
                {(id) => <Input id={id} className="font-mono text-[13px]" value={vipAddress} onChange={(e) => setVipAddress(e.target.value)} placeholder={tr("automatic")} />}
              </Field>
            </div>
          ) : (
            <Field label={tr("VIP port")} hint={tr("An unattached port; the load balancer takes its address.")}>
              {(id) => (
                <Picker
                  id={id}
                  value={vipPort}
                  onChange={setVipPort}
                  searchable
                  placeholder={tr("Choose a port")}
                  options={(ports.data ?? [])
                    .filter((p) => !p.device_owner)
                    .map((p) => ({ value: p.id, label: p.name || p.id.slice(0, 13), description: `${netName(p.network_id)} · ${p.fixed_ips.map((f) => f.ip_address).join(", ")}`, icon: "ethernet-port" }))}
                />
              )}
            </Field>
          )}
          <Field label={tr("Floating IP")} hint={tr("Allocate a public address for the VIP right away (the VIP network needs a router to it).")}>
            {(id) => (
              <Picker
                id={id}
                value={fipNet}
                onChange={setFipNet}
                options={[{ value: "", label: tr("None") }, ...external.map((n) => ({ value: n.id, label: tr("New address from {net}", { net: n.name || n.id }), icon: "globe" }))]}
              />
            )}
          </Field>
        </>
      )}
      {step === "listener" && (
        <>
          <Switch checked={withListener} onChange={setWithListener} label={tr("Create a listener")} hint={tr("Without one the load balancer accepts no traffic yet.")} />
          {withListener && (
            <>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
                <Field label={tr("Protocol")}>{(id) => <Picker id={id} value={protocol} onChange={(v) => changeProtocol(v as ListenerProtocol)} options={LISTENER_PROTOCOLS} />}</Field>
                <Field label={tr("Port")}>{(id) => <Input id={id} type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />}</Field>
              </div>
              {protocol === "TERMINATED_HTTPS" && (
                <Field label={tr("Certificate (Barbican container or secret)")} hint={tr("PKCS12 secret or certificate container with the server certificate and key.")}>
                  {(id) => <CertificatePicker id={id} value={tlsRef} onChange={setTlsRef} />}
                </Field>
              )}
              <p className="text-xs text-muted">{tr("Headers, timeouts, allowed CIDRs and TLS options can be set afterwards on the listener.")}</p>
            </>
          )}
        </>
      )}
      {step === "pool" && (
        <>
          {!withListener || protocol === "PROMETHEUS" ? (
            <p className="text-sm text-muted">{tr("A pool is created together with a listener; add pools later from the load balancer's page.")}</p>
          ) : (
            <>
              <Switch checked={withPool} onChange={setWithPool} label={tr("Create a default pool")} />
              {withPool && (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={tr("Pool protocol")}>
                      {(id) => <Picker id={id} value={poolProtocol} onChange={(v) => setPoolProtocol(v as PoolProtocol)} options={POOL_FOR_LISTENER[protocol].map((p) => ({ value: p, label: p }))} />}
                    </Field>
                    <Field label={tr("Algorithm")}>{(id) => <Picker id={id} value={algorithm} onChange={(v) => setAlgorithm(v as Algorithm)} options={ALGORITHMS} />}</Field>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
                    <Field label={tr("Members")} hint={tr("Instances receiving the traffic; more can be added later.")}>
                      {(id) => (
                        <MultiPicker
                          id={id}
                          values={members}
                          onChange={setMembers}
                          searchable
                          loading={T.loading}
                          placeholder={admin ? tr("Choose instances (any project)") : tr("Choose instances")}
                          options={T.targets.map((t) => ({ value: t.key, label: t.label, description: t.description, icon: "server", keywords: t.address }))}
                        />
                      )}
                    </Field>
                    <Field label={tr("Member port")}>{(id) => <Input id={id} type="number" min={1} max={65535} value={memberPort} onChange={(e) => setMemberPort(e.target.value)} />}</Field>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
      {step === "monitor" && (
        <>
          {!withListener || !withPool || protocol === "PROMETHEUS" ? (
            <p className="text-sm text-muted">{tr("A health monitor belongs to a pool.")}</p>
          ) : (
            <>
              <Switch checked={withMonitor} onChange={setWithMonitor} label={tr("Check member health")} hint={tr("Failing members are taken out of rotation.")} />
              {withMonitor && (
                <>
                  <div className="grid gap-4 sm:grid-cols-4">
                    <Field label={tr("Type")}>{(id) => <Picker id={id} value={monType} onChange={(v) => setMonType(v as MonitorType)} options={MONITOR_TYPES.map((t) => ({ value: t, label: t }))} />}</Field>
                    <Field label={tr("Interval (s)")}>{(id) => <Input id={id} type="number" min={1} value={monDelay} onChange={(e) => setMonDelay(e.target.value)} />}</Field>
                    <Field label={tr("Timeout (s)")}>{(id) => <Input id={id} type="number" min={1} value={monTimeout} onChange={(e) => setMonTimeout(e.target.value)} />}</Field>
                    <Field label={tr("Retries")}>{(id) => <Input id={id} type="number" min={1} max={10} value={monRetries} onChange={(e) => setMonRetries(e.target.value)} />}</Field>
                  </div>
                  {httpMon && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label={tr("URL path")}>{(id) => <Input id={id} className="font-mono text-[13px]" value={monPath} onChange={(e) => setMonPath(e.target.value)} />}</Field>
                      <Field label={tr("Expected codes")}>{(id) => <Input id={id} className="font-mono text-[13px]" value={monCodes} onChange={(e) => setMonCodes(e.target.value)} placeholder="200-299" />}</Field>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
      <div className="flex items-center gap-2 border-t border-line pt-3">
        {Object.entries(problems).map(([s, p]) => (
          <button key={s} type="button" className="text-xs text-[#9a6412] hover:underline dark:text-led-amber" onClick={() => setStep(s as Step)}>
            {p}
          </button>
        ))}
        <span className="ml-auto" />
        <Button type="button" disabled={idx === 0} onClick={() => setStep(STEPS[idx - 1])}>
          {tr("Back")}
        </Button>
        <Button type="button" disabled={idx === STEPS.length - 1} onClick={() => setStep(STEPS[idx + 1])}>
          {tr("Next")}
        </Button>
      </div>
    </ActionDialog>
  );
}
