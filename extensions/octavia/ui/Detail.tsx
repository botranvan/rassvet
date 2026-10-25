/** Detail pages: load balancer (overview, listeners, pools, status tree, amphorae), listener (L7 policies) and pool (members, health monitor). */
import { type ReactNode, useState } from "react";
import {
  ActionDialog,
  ActionMenu,
  Badge,
  Button,
  Card,
  type Column,
  CopyButton,
  DataTable,
  Detail,
  ErrorNotice,
  Icon,
  Link,
  type MenuEntry,
  Mono,
  PageHeader,
  StatusDot,
  Tabs,
  fmtBytes,
  fmtDate,
  os,
  tr,
  trx,
  useInAdmin,
  useInvalidate,
  useNavigate,
  useNetworks,
  useOsGet,
  useProjects,
  useSubnets,
  useParams,
  useTab,
} from "@rassvet/sdk";
import {
  BASE,
  type HealthMonitor,
  type L7Policy,
  type L7Rule,
  LB,
  type Listener,
  type Member,
  type Pool,
  PERSISTENCE_LABELS,
  type StatusNode,
  actionLabel,
  algorithmLabel,
  fmtCount,
  lbName,
  opStatus,
  pending,
  policyTarget,
  provStatus,
  ruleText,
  statusText,
  useFlavorsLb,
  useHealthMonitors,
  useL7Policies,
  useL7Rules,
  useLbStats,
  useListener,
  useListeners,
  useLoadBalancer,
  useMembers,
  usePool,
  usePools,
} from "./api";
import { AddMembersDialog, EditMemberDialog, HealthMonitorDialog, L7PolicyDialog, L7RuleDialog, ListenerDialog, PoolDialog, retry409 } from "./dialogs";
import { AmphoraTable } from "./Amphorae";
import { useLbActions, useVipFloatingIps } from "./LoadBalancers";

const Statuses = ({ o }: { o: { provisioning_status: string; operating_status: string } }) => (
  <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
    <StatusDot status={opStatus(o.operating_status)} label={statusText(o.operating_status)} />
    <StatusDot status={provStatus(o.provisioning_status)} label={statusText(o.provisioning_status)} />
  </span>
);

const opCol = <T extends { operating_status: string }>(): Column<T> => ({
  key: "operating",
  header: tr("Operating"),
  width: "8.5rem",
  cell: (o) => <StatusDot status={opStatus(o.operating_status)} label={statusText(o.operating_status)} />,
  value: (o) => o.operating_status,
});
const provCol = <T extends { provisioning_status: string }>(): Column<T> => ({
  key: "provisioning",
  header: tr("Provisioning"),
  width: "9.5rem",
  hideBelow: "md",
  cell: (o) => <StatusDot status={provStatus(o.provisioning_status)} label={statusText(o.provisioning_status)} />,
  value: (o) => o.provisioning_status,
});

function Back({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
      <Icon name="arrow-left" className="size-3.5" />
      {children}
    </Link>
  );
}

/** A delete that waits out the load balancer's PENDING_UPDATE from the previous change. */
function DeleteDialog({ title, body, path, done, onClose, onDone }: { title: string; body: ReactNode; path: string; done: string; onClose: () => void; onDone?: () => void }) {
  return (
    <ActionDialog onClose={onClose} danger title={title} submitLabel={tr("Delete")} done={done} refresh={[LB]} onDone={onDone} run={() => retry409(() => os.del(LB, path))}>
      <div className="text-sm">{body}</div>
    </ActionDialog>
  );
}

function StatsCard({ path }: { path: string }) {
  const stats = useLbStats(path);
  const s = stats.data;
  return (
    <Card
      title={tr("Statistics")}
      actions={
        <Button className="h-8" onClick={() => stats.refetch()} busy={stats.isFetching}>
          <Icon name="refresh" />
          {tr("Refresh")}
        </Button>
      }
    >
      <ErrorNotice error={stats.error} />
      <dl>
        <Detail label={tr("Active connections")}>{fmtCount(s?.active_connections)}</Detail>
        <Detail label={tr("Total connections")}>{fmtCount(s?.total_connections)}</Detail>
        <Detail label={tr("Bytes in")}>{s ? fmtBytes(s.bytes_in) : "—"}</Detail>
        <Detail label={tr("Bytes out")}>{s ? fmtBytes(s.bytes_out) : "—"}</Detail>
        <Detail label={tr("Request errors")}>{fmtCount(s?.request_errors)}</Detail>
      </dl>
    </Card>
  );
}

// =========================================================================== load balancer

const LB_TABS = ["overview", "listeners", "pools", "status", "amphorae"] as const;

export function LoadBalancerDetail() {
  const { id = "" } = useParams();
  const admin = useInAdmin();
  const navigate = useNavigate();
  const lbq = useLoadBalancer(id);
  const lb = lbq.data;
  const listeners = useListeners({ loadbalancer_id: id });
  const pools = usePools({ loadbalancer_id: id });
  const monitors = useHealthMonitors(admin ? undefined : { project_id: lb?.project_id }, !!lb);
  const flavors = useFlavorsLb();
  const nets = useNetworks();
  const subnets = useSubnets();
  const projects = useProjects(admin);
  const fips = useVipFloatingIps();
  const invalidate = useInvalidate();
  const actions = useLbActions({ onDeleted: () => navigate(`${BASE}/load-balancers`) });
  const [tab, setTab] = useTab(LB_TABS, "overview");
  const [open, setOpen] = useState<
    | { kind: "listener"; l?: Listener }
    | { kind: "pool"; p?: Pool }
    | { kind: "del-listener"; l: Listener }
    | { kind: "del-pool"; p: Pool }
    | null
  >(null);
  const close = () => setOpen(null);
  const ls = (listeners.data ?? []).filter((l) => l.loadbalancers.some((x) => x.id === id));
  const ps = (pools.data ?? []).filter((p) => p.loadbalancers.some((x) => x.id === id));
  const poolName = (pid?: string | null) => (pid ? lbName(ps.find((p) => p.id === pid) ?? { id: pid }) : "");
  const monitor = (p: Pool) => monitors.data?.find((m) => m.id === p.healthmonitor_id);
  const busy = lb && pending(lb) ? tr("Busy ({status})", { status: statusText(lb.provisioning_status) }) : false;

  const listenerCols: Column<Listener>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (l) => (
        <Link to={`${BASE}/load-balancers/${id}/listeners/${l.id}`} className="font-medium text-cable hover:underline">
          {lbName(l)}
        </Link>
      ),
      value: (l) => l.name,
    },
    { key: "port", header: tr("Protocol / port"), width: "11rem", cell: (l) => <span className="font-mono text-[12.5px]">{`${l.protocol}:${l.protocol_port}`}</span>, value: (l) => `${l.protocol}:${l.protocol_port}` },
    {
      key: "pool",
      header: tr("Default pool"),
      hideBelow: "md",
      cell: (l) =>
        l.default_pool_id ? (
          <Link to={`${BASE}/load-balancers/${id}/pools/${l.default_pool_id}`} className="text-cable hover:underline">
            {poolName(l.default_pool_id)}
          </Link>
        ) : (
          <span className="text-muted">{tr("None")}</span>
        ),
      value: (l) => poolName(l.default_pool_id),
    },
    { key: "l7", header: tr("L7 policies"), width: "7rem", hideBelow: "lg", className: "text-right", cell: (l) => l.l7policies.length || "—", value: (l) => l.l7policies.length },
    opCol<Listener>(),
    provCol<Listener>(),
  ];
  const poolCols: Column<Pool>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (p) => (
        <Link to={`${BASE}/load-balancers/${id}/pools/${p.id}`} className="font-medium text-cable hover:underline">
          {lbName(p)}
        </Link>
      ),
      value: (p) => p.name,
    },
    { key: "protocol", header: tr("Protocol"), width: "7rem", cell: (p) => p.protocol, value: (p) => p.protocol },
    { key: "algorithm", header: tr("Algorithm"), width: "10rem", hideBelow: "md", cell: (p) => algorithmLabel(p.lb_algorithm), value: (p) => p.lb_algorithm },
    { key: "members", header: tr("Members"), width: "6.5rem", className: "text-right", cell: (p) => p.members.length, value: (p) => p.members.length },
    { key: "monitor", header: tr("Health monitor"), width: "9rem", hideBelow: "lg", cell: (p) => monitor(p)?.type ?? <span className="text-muted">{tr("None")}</span>, value: (p) => monitor(p)?.type ?? "" },
    opCol<Pool>(),
    provCol<Pool>(),
  ];
  const fip = lb && fips.get(lb.vip_port_id);
  const subnet = lb && subnets.data?.find((s) => s.id === lb.vip_subnet_id);
  return (
    <>
      <Back to={`${BASE}/load-balancers`}>{admin ? tr("All load balancers") : tr("Load balancers")}</Back>
      <PageHeader title={lb ? lbName(lb) : tr("Load balancer")} description={lb && <Statuses o={lb} />} actions={lb && <ActionMenu variant="button" items={() => actions.items(lb, "detail")} />} />
      <ErrorNotice error={lbq.error} className="mb-4" />
      {lb && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "listeners", label: tr("Listeners ({n})", { n: ls.length }) },
              { id: "pools", label: tr("Pools ({n})", { n: ps.length }) },
              { id: "status", label: tr("Status tree") },
              ...(admin ? [{ id: "amphorae" as const, label: tr("Amphorae") }] : []),
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 xl:grid-cols-2">
              <div className="space-y-6">
                <Card title={tr("Details")}>
                  <dl>
                    <Detail label={tr("Name")}>{lb.name || "—"}</Detail>
                    <Detail label="ID">
                      <Mono>{lb.id}</Mono>
                    </Detail>
                    <Detail label={tr("Description")} wrap>
                      {lb.description || "—"}
                    </Detail>
                    {admin && (
                      <Detail label={tr("Project")}>
                        {projects.data?.find((p) => p.id === lb.project_id)?.name ?? ""} <Mono className="text-muted">{lb.project_id}</Mono>
                      </Detail>
                    )}
                    <Detail label={tr("Operating status")}>
                      <StatusDot status={opStatus(lb.operating_status)} label={statusText(lb.operating_status)} />
                    </Detail>
                    <Detail label={tr("Provisioning status")}>
                      <StatusDot status={provStatus(lb.provisioning_status)} label={statusText(lb.provisioning_status)} />
                    </Detail>
                    <Detail label={tr("Admin state")}>{lb.admin_state_up ? tr("Up") : tr("Down")}</Detail>
                    <Detail label={tr("Provider")}>{lb.provider}</Detail>
                    <Detail label={tr("Flavor")}>{lb.flavor_id ? (flavors.data?.find((f) => f.id === lb.flavor_id)?.name ?? <Mono>{lb.flavor_id}</Mono>) : tr("Default")}</Detail>
                    <Detail label={tr("Availability zone")}>{lb.availability_zone || "—"}</Detail>
                    {lb.created_at && <Detail label={tr("Created")}>{fmtDate(lb.created_at)}</Detail>}
                    {lb.updated_at && <Detail label={tr("Updated")}>{fmtDate(lb.updated_at)}</Detail>}
                    {!!lb.tags?.length && (
                      <Detail label={tr("Tags")} wrap>
                        <span className="flex flex-wrap gap-1">
                          {lb.tags.map((t) => (
                            <Badge key={t}>{t}</Badge>
                          ))}
                        </span>
                      </Detail>
                    )}
                  </dl>
                </Card>
              </div>
              <div className="space-y-6">
                <Card title={tr("Virtual IP")} actions={<CopyButton className="h-8" text={fip?.floating_ip_address ?? lb.vip_address} />}>
                  <dl>
                    <Detail label={tr("Address")}>
                      <Mono>{lb.vip_address}</Mono>
                    </Detail>
                    <Detail label={tr("Floating IP")}>
                      {fip ? (
                        <Mono>{fip.floating_ip_address}</Mono>
                      ) : (
                        <button type="button" className="text-cable hover:underline" onClick={() => actions.openDialog(lb, "fip")}>
                          {tr("Associate one")}
                        </button>
                      )}
                    </Detail>
                    <Detail label={tr("Network")}>
                      <Link to={`/network/networks/${lb.vip_network_id}`} className="text-cable hover:underline">
                        {nets.data?.find((n) => n.id === lb.vip_network_id)?.name ?? lb.vip_network_id}
                      </Link>
                    </Detail>
                    <Detail label={tr("Subnet")}>{subnet ? `${subnet.name || subnet.id} (${subnet.cidr})` : <Mono>{lb.vip_subnet_id}</Mono>}</Detail>
                    <Detail label={tr("Port")}>
                      <Mono>{lb.vip_port_id}</Mono>
                    </Detail>
                    {lb.vip_qos_policy_id && (
                      <Detail label={tr("QoS policy")}>
                        <Link to={`/network/qos/${lb.vip_qos_policy_id}`} className="text-cable hover:underline">
                          <Mono>{lb.vip_qos_policy_id}</Mono>
                        </Link>
                      </Detail>
                    )}
                    {lb.additional_vips?.map((v, i) => (
                      <Detail key={i} label={tr("Additional VIP")}>
                        <Mono>{v.ip_address ?? v.subnet_id}</Mono>
                      </Detail>
                    ))}
                  </dl>
                </Card>
                <StatsCard path={`lbaas/loadbalancers/${lb.id}`} />
              </div>
            </div>
          )}
          {tab === "listeners" && (
            <>
              <div className="mb-3">
                <Button onClick={() => setOpen({ kind: "listener" })} disabled={!!busy}>
                  <Icon name="plus" />
                  {tr("Add listener")}
                </Button>
              </div>
              <DataTable
                rows={ls}
                columns={listenerCols}
                rowKey={(l) => l.id}
                loading={listeners.isPending}
                tableId="octavia-lb-listeners"
                noun={tr("listeners")}
                rowLabel={lbName}
                empty={tr("No listeners: the load balancer accepts no traffic yet.")}
                onRefresh={() => listeners.refetch()}
                refreshing={listeners.isFetching}
                rowActions={(l) => [
                  { label: tr("View details"), icon: "eye", onSelect: () => navigate(`${BASE}/load-balancers/${id}/listeners/${l.id}`) },
                  "-",
                  { label: tr("Edit listener"), icon: "edit", disabled: busy, onSelect: () => setOpen({ kind: "listener", l }) },
                  { label: tr("Delete listener"), icon: "trash", danger: true, disabled: busy, onSelect: () => setOpen({ kind: "del-listener", l }) },
                ]}
              />
            </>
          )}
          {tab === "pools" && (
            <>
              <div className="mb-3">
                <Button onClick={() => setOpen({ kind: "pool" })} disabled={!!busy}>
                  <Icon name="plus" />
                  {tr("Add pool")}
                </Button>
              </div>
              <DataTable
                rows={ps}
                columns={poolCols}
                rowKey={(p) => p.id}
                loading={pools.isPending}
                tableId="octavia-lb-pools"
                noun={tr("pools")}
                rowLabel={lbName}
                empty={tr("No pools yet.")}
                onRefresh={() => pools.refetch()}
                refreshing={pools.isFetching}
                rowActions={(p) => [
                  { label: tr("View details"), icon: "eye", onSelect: () => navigate(`${BASE}/load-balancers/${id}/pools/${p.id}`) },
                  "-",
                  { label: tr("Edit pool"), icon: "edit", disabled: busy, onSelect: () => setOpen({ kind: "pool", p }) },
                  { label: tr("Delete pool"), icon: "trash", danger: true, disabled: busy, onSelect: () => setOpen({ kind: "del-pool", p }) },
                ]}
              />
            </>
          )}
          {tab === "status" && <StatusTree id={id} />}
          {tab === "amphorae" && admin && <AmphoraTable loadbalancerId={id} />}
        </>
      )}
      {actions.dialogs}
      {lb && open?.kind === "listener" && <ListenerDialog lb={lb} listener={open.l} pools={ps} onClose={close} />}
      {lb && open?.kind === "pool" && <PoolDialog lb={lb} pool={open.p} listeners={ls} onClose={close} />}
      {open?.kind === "del-listener" && (
        <DeleteDialog
          onClose={close}
          title={tr("Delete listener {name}?", { name: lbName(open.l) })}
          body={tr("Clients can no longer connect on {protocol}:{port}. Its L7 policies are deleted too; pools are kept.", { protocol: open.l.protocol, port: open.l.protocol_port })}
          path={`lbaas/listeners/${open.l.id}`}
          done={tr("Listener deleted")}
          onDone={() => invalidate(LB)}
        />
      )}
      {open?.kind === "del-pool" && (
        <DeleteDialog
          onClose={close}
          title={tr("Delete pool {name}?", { name: lbName(open.p) })}
          body={tr("Its {n} member(s) and its health monitor are deleted too. Listeners using it as default pool are left without one.", { n: open.p.members.length })}
          path={`lbaas/pools/${open.p.id}`}
          done={tr("Pool deleted")}
        />
      )}
    </>
  );
}

function StatusTree({ id }: { id: string }) {
  const q = useOsGet<StatusNode>(LB, `lbaas/loadbalancers/${id}/status`, (r: { statuses: { loadbalancer: StatusNode } }) => r.statuses.loadbalancer, {
    poll: (n) => /^PENDING_/.test(n.provisioning_status),
  });
  const node = (n: StatusNode, kind: string, depth: number): ReactNode => (
    <li key={`${kind}:${n.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 py-2" style={{ paddingLeft: depth * 22 }}>
        <span className="w-24 shrink-0 text-xs text-muted">{kind}</span>
        <span className="min-w-0 font-medium">
          {n.name || (n.address ? `${n.address}:${n.protocol_port}` : n.type || n.action || n.id.slice(0, 13))}
        </span>
        {n.type && n.name && <Badge>{n.type}</Badge>}
        <span className="ml-auto flex gap-4">
          <StatusDot status={opStatus(n.operating_status)} label={statusText(n.operating_status)} />
          <span className="w-36">
            <StatusDot status={provStatus(n.provisioning_status)} label={statusText(n.provisioning_status)} />
          </span>
        </span>
      </div>
      <ul>
        {n.l7policies?.map((p) => node(p, tr("L7 policy"), depth + 1))}
        {n.rules?.map((r) => node(r, tr("L7 rule"), depth + 1))}
        {n.listeners?.map((l) => node(l, tr("Listener"), depth + 1))}
        {n.pools?.map((p) => node(p, tr("Pool"), depth + 1))}
        {n.health_monitor && node(n.health_monitor, tr("Health monitor"), depth + 1)}
        {n.members?.map((m) => node(m, tr("Member"), depth + 1))}
      </ul>
    </li>
  );
  return (
    <Card title={tr("Status tree")} actions={<span className="text-xs text-muted">{tr("Operating · provisioning status of every object, as Octavia reports them")}</span>}>
      <ErrorNotice error={q.error} />
      {q.data ? <ul className="text-sm">{node(q.data, tr("Load balancer"), 0)}</ul> : <p className="text-sm text-muted">{tr("Loading…")}</p>}
    </Card>
  );
}

// =========================================================================== listener

const LI_TABS = ["overview", "policies"] as const;

export function ListenerDetail() {
  const { id = "", lid = "" } = useParams();
  const navigate = useNavigate();
  const lb = useLoadBalancer(id);
  const lq = useListener(lid);
  const l = lq.data;
  const pools = usePools({ loadbalancer_id: id });
  const policies = useL7Policies({ listener_id: lid });
  const [tab, setTab] = useTab(LI_TABS, "overview");
  const [open, setOpen] = useState<
    | { kind: "edit" }
    | { kind: "delete" }
    | { kind: "policy"; p?: L7Policy }
    | { kind: "del-policy"; p: L7Policy }
    | { kind: "rule"; p: L7Policy; r?: L7Rule }
    | { kind: "del-rule"; p: L7Policy; r: L7Rule }
    | null
  >(null);
  const close = () => setOpen(null);
  const ps = (pools.data ?? []).filter((p) => p.loadbalancers.some((x) => x.id === id));
  const poolName = (pid: string) => lbName(ps.find((p) => p.id === pid) ?? { id: pid });
  const pols = (policies.data ?? []).filter((p) => p.listener_id === lid).sort((a, b) => a.position - b.position);
  const headers = Object.entries(l?.insert_headers ?? {}).filter(([, v]) => /^true$/i.test(v)).map(([k]) => k);
  const move = (p: L7Policy, d: -1 | 1) => retry409(() => os.put(LB, `lbaas/l7policies/${p.id}`, { l7policy: { position: p.position + d } })).then(() => policies.refetch());
  return (
    <>
      <Back to={`${BASE}/load-balancers/${id}?tab=listeners`}>{lb.data ? lbName(lb.data) : tr("Load balancer")}</Back>
      <PageHeader
        title={l ? `${lbName(l)} · ${l.protocol}:${l.protocol_port}` : tr("Listener")}
        description={l && <Statuses o={l} />}
        actions={
          l && (
            <ActionMenu
              variant="button"
              items={() => [
                { label: tr("Edit listener"), icon: "edit", onSelect: () => setOpen({ kind: "edit" }) },
                { label: tr("Add L7 policy"), icon: "plus", onSelect: () => setOpen({ kind: "policy" }) },
                "-",
                { label: tr("Delete listener"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete" }) },
              ]}
            />
          )
        }
      />
      <ErrorNotice error={lq.error} className="mb-4" />
      {l && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "policies", label: tr("L7 policies ({n})", { n: pols.length }) },
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 xl:grid-cols-2">
              <div className="space-y-6">
                <Card title={tr("Details")}>
                  <dl>
                    <Detail label={tr("Name")}>{l.name || "—"}</Detail>
                    <Detail label="ID">
                      <Mono>{l.id}</Mono>
                    </Detail>
                    <Detail label={tr("Description")} wrap>
                      {l.description || "—"}
                    </Detail>
                    <Detail label={tr("Protocol")}>{l.protocol}</Detail>
                    <Detail label={tr("Port")}>{l.protocol_port}</Detail>
                    <Detail label={tr("Default pool")}>
                      {l.default_pool_id ? (
                        <Link to={`${BASE}/load-balancers/${id}/pools/${l.default_pool_id}`} className="text-cable hover:underline">
                          {poolName(l.default_pool_id)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Detail>
                    <Detail label={tr("Connection limit")}>{l.connection_limit < 0 ? tr("Unlimited") : l.connection_limit}</Detail>
                    <Detail label={tr("Allowed CIDRs")} wrap>
                      {l.allowed_cidrs?.length ? <Mono>{l.allowed_cidrs.join(", ")}</Mono> : tr("Everyone")}
                    </Detail>
                    <Detail label={tr("Admin state")}>{l.admin_state_up ? tr("Up") : tr("Down")}</Detail>
                    {l.created_at && <Detail label={tr("Created")}>{fmtDate(l.created_at)}</Detail>}
                  </dl>
                </Card>
                <Card title={tr("Timeouts and headers")}>
                  <dl>
                    <Detail label={tr("Client data")}>{l.timeout_client_data ?? "—"} ms</Detail>
                    <Detail label={tr("Member connect")}>{l.timeout_member_connect ?? "—"} ms</Detail>
                    <Detail label={tr("Member data")}>{l.timeout_member_data ?? "—"} ms</Detail>
                    <Detail label={tr("TCP inspect")}>{l.timeout_tcp_inspect ?? "—"} ms</Detail>
                    <Detail label={tr("Insert headers")} wrap>
                      {headers.length ? <Mono>{headers.join(", ")}</Mono> : tr("None")}
                    </Detail>
                  </dl>
                </Card>
              </div>
              <div className="space-y-6">
                {l.protocol === "TERMINATED_HTTPS" && (
                  <Card title={tr("TLS")}>
                    <dl>
                      <Detail label={tr("Certificate")} wrap>
                        <Mono>{l.default_tls_container_ref ?? "—"}</Mono>
                      </Detail>
                      <Detail label={tr("SNI certificates")} wrap>
                        {l.sni_container_refs?.length ? <Mono>{l.sni_container_refs.join("\n")}</Mono> : tr("None")}
                      </Detail>
                      <Detail label={tr("TLS versions")}>{l.tls_versions?.join(", ") || tr("Default")}</Detail>
                      <Detail label={tr("ALPN protocols")}>{l.alpn_protocols?.join(", ") || tr("Default")}</Detail>
                      <Detail label={tr("Ciphers")} wrap>
                        {l.tls_ciphers ? <Mono>{l.tls_ciphers}</Mono> : tr("Default")}
                      </Detail>
                      <Detail label={tr("Client authentication")}>{statusText(l.client_authentication ?? "NONE")}</Detail>
                      <Detail label="HSTS">{l.hsts_max_age ? trx("max-age {age}{sub}{pre}", { age: l.hsts_max_age, sub: l.hsts_include_subdomains ? "; includeSubDomains" : "", pre: l.hsts_preload ? "; preload" : "" }) : tr("Off")}</Detail>
                    </dl>
                  </Card>
                )}
                <StatsCard path={`lbaas/listeners/${l.id}`} />
              </div>
            </div>
          )}
          {tab === "policies" && (
            <>
              <div className="mb-3 flex items-center gap-3">
                <Button onClick={() => setOpen({ kind: "policy" })}>
                  <Icon name="plus" />
                  {tr("Add L7 policy")}
                </Button>
                {!["HTTP", "TERMINATED_HTTPS"].includes(l.protocol) && <span className="text-sm text-muted">{tr("L7 policies only work on HTTP and TERMINATED_HTTPS listeners.")}</span>}
              </div>
              {pols.length === 0 && !policies.isPending && <p className="rounded-lg border border-dashed border-line px-5 py-8 text-center text-sm text-muted">{tr("No L7 policies: every request goes to the default pool.")}</p>}
              <div className="space-y-4">
                {pols.map((p, i) => (
                  <PolicyCard
                    key={p.id}
                    p={p}
                    poolName={poolName}
                    first={i === 0}
                    last={i === pols.length - 1}
                    onMove={(d) => move(p, d)}
                    items={() => [
                      { label: tr("Edit policy"), icon: "edit", onSelect: () => setOpen({ kind: "policy", p }) },
                      { label: tr("Add rule"), icon: "plus", onSelect: () => setOpen({ kind: "rule", p }) },
                      "-",
                      { label: tr("Delete policy"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "del-policy", p }) },
                    ]}
                    onRule={(r) => setOpen({ kind: "rule", p, r })}
                    onDeleteRule={(r) => setOpen({ kind: "del-rule", p, r })}
                    onAddRule={() => setOpen({ kind: "rule", p })}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
      {l && lb.data && open?.kind === "edit" && <ListenerDialog lb={lb.data} listener={l} pools={ps} onClose={close} />}
      {l && open?.kind === "delete" && (
        <DeleteDialog
          onClose={close}
          title={tr("Delete listener {name}?", { name: lbName(l) })}
          body={tr("Clients can no longer connect on {protocol}:{port}. Its L7 policies are deleted too; pools are kept.", { protocol: l.protocol, port: l.protocol_port })}
          path={`lbaas/listeners/${l.id}`}
          done={tr("Listener deleted")}
          onDone={() => navigate(`${BASE}/load-balancers/${id}?tab=listeners`)}
        />
      )}
      {l && open?.kind === "policy" && <L7PolicyDialog listener={l} policy={open.p} pools={ps} onClose={close} />}
      {open?.kind === "del-policy" && (
        <DeleteDialog onClose={close} title={tr("Delete L7 policy {name}?", { name: lbName(open.p) })} body={tr("Its rules are deleted too.")} path={`lbaas/l7policies/${open.p.id}`} done={tr("L7 policy deleted")} />
      )}
      {open?.kind === "rule" && <L7RuleDialog policy={open.p} rule={open.r} onClose={close} />}
      {open?.kind === "del-rule" && (
        <DeleteDialog onClose={close} title={tr("Delete rule?")} body={ruleText(open.r)} path={`lbaas/l7policies/${open.p.id}/rules/${open.r.id}`} done={tr("Rule deleted")} />
      )}
    </>
  );
}

function PolicyCard({
  p,
  poolName,
  first,
  last,
  onMove,
  items,
  onRule,
  onDeleteRule,
  onAddRule,
}: {
  p: L7Policy;
  poolName: (id: string) => string;
  first: boolean;
  last: boolean;
  onMove: (d: -1 | 1) => void;
  items: () => MenuEntry[];
  onRule: (r: L7Rule) => void;
  onDeleteRule: (r: L7Rule) => void;
  onAddRule: () => void;
}) {
  const rules = useL7Rules(p.id);
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Badge tone="accent">#{p.position}</Badge>
          <span className="truncate">{lbName(p)}</span>
          <span className="truncate font-normal text-muted">
            {actionLabel(p.action)} {policyTarget(p, poolName)}
          </span>
        </span>
      }
      actions={
        <>
          <StatusDot status={provStatus(p.provisioning_status)} label={statusText(p.provisioning_status)} />
          <Button className="h-8 px-2" disabled={first} onClick={() => onMove(-1)} aria-label={tr("Move up")}>
            <Icon name="arrow-up" />
          </Button>
          <Button className="h-8 px-2" disabled={last} onClick={() => onMove(1)} aria-label={tr("Move down")}>
            <Icon name="arrow-down" />
          </Button>
          <ActionMenu items={items} />
        </>
      }
      flush
    >
      {p.description && <p className="border-b border-line px-5 py-2 text-sm text-muted">{p.description}</p>}
      <ul className="text-sm">
        {(rules.data ?? []).map((r, i) => (
          <li key={r.id} className="flex items-center gap-3 border-b border-line px-5 py-2 last:border-0">
            <span className="w-10 shrink-0 text-xs text-muted">{i === 0 ? tr("IF") : tr("AND")}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={ruleText(r)}>
              {ruleText(r)}
            </span>
            {!r.admin_state_up && <Badge tone="warn">{tr("disabled")}</Badge>}
            <StatusDot status={provStatus(r.provisioning_status)} label={statusText(r.provisioning_status)} />
            <ActionMenu
              items={() => [
                { label: tr("Edit rule"), icon: "edit", onSelect: () => onRule(r) },
                { label: tr("Delete rule"), icon: "trash", danger: true, onSelect: () => onDeleteRule(r) },
              ]}
            />
          </li>
        ))}
        {rules.data?.length === 0 && <li className="px-5 py-3 text-muted">{tr("No rules: this policy never matches.")}</li>}
        <li className="px-5 py-2">
          <button type="button" className="text-sm text-cable hover:underline" onClick={onAddRule}>
            + {tr("Add rule")}
          </button>
        </li>
      </ul>
    </Card>
  );
}

// =========================================================================== pool

const POOL_TABS = ["overview", "members"] as const;

export function PoolDetail() {
  const { id = "", pid = "" } = useParams();
  const navigate = useNavigate();
  const lb = useLoadBalancer(id);
  const pq = usePool(pid);
  const p = pq.data;
  const listeners = useListeners({ loadbalancer_id: id });
  const members = useMembers(pid);
  const monitor = useOsGet<HealthMonitor>(LB, `lbaas/healthmonitors/${p?.healthmonitor_id ?? ""}`, (r: { healthmonitor: HealthMonitor }) => r.healthmonitor, {
    enabled: !!p?.healthmonitor_id,
    poll: pending,
  });
  const subnets = useSubnets();
  const invalidate = useInvalidate();
  const [tab, setTab] = useTab(POOL_TABS, "overview");
  const [open, setOpen] = useState<
    | { kind: "edit" }
    | { kind: "delete" }
    | { kind: "add" }
    | { kind: "member"; m: Member }
    | { kind: "del-member"; m: Member }
    | { kind: "monitor"; hm?: HealthMonitor }
    | { kind: "del-monitor"; hm: HealthMonitor }
    | null
  >(null);
  const close = () => setOpen(null);
  const ls = (listeners.data ?? []).filter((l) => l.loadbalancers.some((x) => x.id === id));
  const hm = p?.healthmonitor_id ? monitor.data : undefined;
  const ms = members.data ?? [];
  const setMember = (m: Member, body: Partial<Member>) => retry409(() => os.put(LB, `lbaas/pools/${pid}/members/${m.id}`, { member: body }));
  const cols: Column<Member>[] = [
    { key: "name", header: tr("Name"), cell: (m) => m.name || <span className="text-muted">—</span>, value: (m) => m.name },
    { key: "address", header: tr("Address"), width: "12rem", mono: true, cell: (m) => `${m.address}:${m.protocol_port}`, value: (m) => `${m.address}:${m.protocol_port}` },
    { key: "weight", header: tr("Weight"), width: "6rem", className: "text-right", cell: (m) => (m.weight === 0 ? <Badge tone="warn">{tr("drain")}</Badge> : m.weight), value: (m) => m.weight },
    { key: "backup", header: tr("Backup"), width: "6rem", hideBelow: "lg", cell: (m) => (m.backup ? tr("Yes") : ""), value: (m) => (m.backup ? 1 : 0) },
    { key: "subnet", header: tr("Subnet"), width: "11rem", hideBelow: "xl", cell: (m) => subnets.data?.find((s) => s.id === m.subnet_id)?.cidr ?? "", value: (m) => m.subnet_id ?? "" },
    { key: "admin", header: tr("Admin state"), width: "7rem", hideBelow: "md", cell: (m) => (m.admin_state_up ? tr("Up") : <Badge tone="warn">{tr("Down")}</Badge>), value: (m) => (m.admin_state_up ? 1 : 0) },
    opCol<Member>(),
    provCol<Member>(),
  ];
  return (
    <>
      <Back to={`${BASE}/load-balancers/${id}?tab=pools`}>{lb.data ? lbName(lb.data) : tr("Load balancer")}</Back>
      <PageHeader
        title={p ? lbName(p) : tr("Pool")}
        description={p && <Statuses o={p} />}
        actions={
          p && (
            <ActionMenu
              variant="button"
              items={() => [
                { label: tr("Edit pool"), icon: "edit", onSelect: () => setOpen({ kind: "edit" }) },
                { label: tr("Add members"), icon: "plus", onSelect: () => setOpen({ kind: "add" }) },
                hm ? { label: tr("Edit health monitor"), icon: "activity", onSelect: () => setOpen({ kind: "monitor", hm }) } : { label: tr("Add health monitor"), icon: "activity", onSelect: () => setOpen({ kind: "monitor" }) },
                "-",
                { label: tr("Delete pool"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete" }) },
              ]}
            />
          )
        }
      />
      <ErrorNotice error={pq.error} className="mb-4" />
      {p && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "members", label: tr("Members ({n})", { n: ms.length }) },
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 xl:grid-cols-2">
              <Card title={tr("Details")}>
                <dl>
                  <Detail label={tr("Name")}>{p.name || "—"}</Detail>
                  <Detail label="ID">
                    <Mono>{p.id}</Mono>
                  </Detail>
                  <Detail label={tr("Description")} wrap>
                    {p.description || "—"}
                  </Detail>
                  <Detail label={tr("Protocol")}>{p.protocol}</Detail>
                  <Detail label={tr("Algorithm")}>{algorithmLabel(p.lb_algorithm)}</Detail>
                  <Detail label={tr("Session persistence")}>
                    {p.session_persistence ? `${PERSISTENCE_LABELS[p.session_persistence.type] ?? p.session_persistence.type}${p.session_persistence.cookie_name ? ` (${p.session_persistence.cookie_name})` : ""}` : tr("None")}
                  </Detail>
                  <Detail label={tr("Listeners")} wrap>
                    {p.listeners.length
                      ? p.listeners.map((x, i) => {
                          const l = ls.find((y) => y.id === x.id);
                          return (
                            <span key={x.id}>
                              {i > 0 && ", "}
                              <Link to={`${BASE}/load-balancers/${id}/listeners/${x.id}`} className="text-cable hover:underline">
                                {l ? `${lbName(l)} (${l.protocol}:${l.protocol_port})` : x.id.slice(0, 8)}
                              </Link>
                            </span>
                          );
                        })
                      : tr("None (used by L7 policies only)")}
                  </Detail>
                  <Detail label={tr("TLS to members")}>{p.tls_enabled ? tr("On") : tr("Off")}</Detail>
                  <Detail label={tr("Admin state")}>{p.admin_state_up ? tr("Up") : tr("Down")}</Detail>
                  {p.created_at && <Detail label={tr("Created")}>{fmtDate(p.created_at)}</Detail>}
                </dl>
              </Card>
              <Card
                title={tr("Health monitor")}
                actions={
                  hm ? (
                    <ActionMenu
                      items={() => [
                        { label: tr("Edit health monitor"), icon: "edit", onSelect: () => setOpen({ kind: "monitor", hm }) },
                        { label: tr("Delete health monitor"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "del-monitor", hm }) },
                      ]}
                    />
                  ) : (
                    <Button className="h-8" onClick={() => setOpen({ kind: "monitor" })}>
                      <Icon name="plus" />
                      {tr("Add")}
                    </Button>
                  )
                }
              >
                {hm ? (
                  <dl>
                    <Detail label={tr("Type")}>{hm.type}</Detail>
                    <Detail label={tr("Status")}>
                      <Statuses o={hm} />
                    </Detail>
                    <Detail label={tr("Interval / timeout")}>{tr("every {delay} s, {timeout} s timeout", { delay: hm.delay, timeout: hm.timeout })}</Detail>
                    <Detail label={tr("Retries")}>{tr("{up} to mark up, {down} to mark down", { up: hm.max_retries, down: hm.max_retries_down })}</Detail>
                    {hm.url_path && (
                      <Detail label={tr("Request")}>
                        <Mono>{`${hm.http_method ?? "GET"} ${hm.url_path}${hm.http_version ? ` HTTP/${hm.http_version}` : ""}${hm.domain_name ? ` (Host: ${hm.domain_name})` : ""}`}</Mono>
                      </Detail>
                    )}
                    {hm.expected_codes && (
                      <Detail label={tr("Expected codes")}>
                        <Mono>{hm.expected_codes}</Mono>
                      </Detail>
                    )}
                    <Detail label={tr("Admin state")}>{hm.admin_state_up ? tr("Up") : tr("Down")}</Detail>
                  </dl>
                ) : (
                  <p className="text-sm text-muted">{tr("No health monitor: members are always considered healthy (status NO_MONITOR).")}</p>
                )}
              </Card>
            </div>
          )}
          {tab === "members" && (
            <>
              <div className="mb-3">
                <Button onClick={() => setOpen({ kind: "add" })}>
                  <Icon name="plus" />
                  {tr("Add members")}
                </Button>
              </div>
              <DataTable
                rows={ms}
                columns={cols}
                rowKey={(m) => m.id}
                loading={members.isPending}
                tableId="octavia-pool-members"
                noun={tr("members")}
                rowLabel={(m) => m.name || `${m.address}:${m.protocol_port}`}
                empty={tr("No members: requests to this pool fail with 503.")}
                onRefresh={() => members.refetch()}
                refreshing={members.isFetching}
                onBulkDone={() => invalidate(LB)}
                rowActions={(m) => [
                  { label: tr("Edit member"), icon: "edit", onSelect: () => setOpen({ kind: "member", m }) },
                  m.admin_state_up
                    ? { label: tr("Disable"), icon: "ban", onSelect: () => setMember(m, { admin_state_up: false }).then(() => invalidate(LB)) }
                    : { label: tr("Enable"), icon: "play", onSelect: () => setMember(m, { admin_state_up: true }).then(() => invalidate(LB)) },
                  "-",
                  { label: tr("Remove member"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "del-member", m }) },
                ]}
                bulkActions={[
                  { id: "drain", label: tr("Drain"), icon: "pause", title: tr("Drain members?"), past: tr("drained"), body: tr("Weight 0: no new connections, current ones finish."), run: (m) => setMember(m, { weight: 0 }) },
                  { id: "disable", label: tr("Disable"), icon: "ban", title: tr("Disable members?"), past: tr("disabled"), run: (m) => setMember(m, { admin_state_up: false }) },
                  { id: "enable", label: tr("Enable"), icon: "play", title: tr("Enable members?"), past: tr("enabled"), run: (m) => setMember(m, { admin_state_up: true }) },
                  {
                    id: "remove",
                    label: tr("Remove"),
                    icon: "trash",
                    danger: true,
                    title: tr("Remove members?"),
                    past: tr("removed"),
                    body: tr("The servers stop getting traffic from this pool; they are not deleted."),
                    run: (m) => retry409(() => os.del(LB, `lbaas/pools/${pid}/members/${m.id}`)),
                  },
                ]}
              />
            </>
          )}
        </>
      )}
      {p && lb.data && open?.kind === "edit" && <PoolDialog lb={lb.data} pool={p} listeners={ls} onClose={close} />}
      {p && open?.kind === "delete" && (
        <DeleteDialog
          onClose={close}
          title={tr("Delete pool {name}?", { name: lbName(p) })}
          body={tr("Its {n} member(s) and its health monitor are deleted too. Listeners using it as default pool are left without one.", { n: ms.length })}
          path={`lbaas/pools/${p.id}`}
          done={tr("Pool deleted")}
          onDone={() => navigate(`${BASE}/load-balancers/${id}?tab=pools`)}
        />
      )}
      {p && open?.kind === "add" && <AddMembersDialog pool={p} members={ms} onClose={close} />}
      {p && open?.kind === "member" && <EditMemberDialog pool={p} member={open.m} onClose={close} />}
      {open?.kind === "del-member" && (
        <DeleteDialog
          onClose={close}
          title={tr("Remove member {name}?", { name: open.m.name || `${open.m.address}:${open.m.protocol_port}` })}
          body={tr("The server stops getting traffic from this pool; it is not deleted.")}
          path={`lbaas/pools/${pid}/members/${open.m.id}`}
          done={tr("Member removed")}
        />
      )}
      {p && open?.kind === "monitor" && <HealthMonitorDialog pool={p} monitor={open.hm} onClose={close} />}
      {open?.kind === "del-monitor" && (
        <DeleteDialog onClose={close} title={tr("Delete health monitor?")} body={tr("Members are no longer checked and show NO_MONITOR.")} path={`lbaas/healthmonitors/${open.hm.id}`} done={tr("Health monitor deleted")} />
      )}
    </>
  );
}

