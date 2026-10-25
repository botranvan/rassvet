/**
 * Network QoS policies: bandwidth limits, minimum bandwidth, DSCP marking and packet
 * rate rules, applied to networks (every port on it) or to single ports.
 * Neutron's policy decides who may create policies and rules (admins by default);
 * everyone can apply policies they can see to their own networks and ports.
 */
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { ActionMenu, type MenuEntry } from "@/components/Menu";
import { Picker } from "@/components/Picker";
import { Badge, Button, Card, Detail, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Switch, Tabs, Textarea } from "@/components/ui";
import { useProjects } from "@/lib/identity";
import { DSCP_NAMES, type QosPolicy, type QosRule, type QosRuleType, RULE_INFO, ruleSummary, useQosPolicies, useQosRuleTypes } from "@/lib/neutron";
import { type Network, type Port, os, portLabel, useInvalidate, useNetworks, useOsGet, usePorts } from "@/lib/os";
import { useSession } from "@/lib/session";
import { useTab } from "@/lib/useTab";
import { tr, trx } from "@/lib/i18n";

const rulesText = (q: QosPolicy) => q.rules.map(ruleSummary).join("; ");

function useProjectName(admin: boolean) {
  const session = useSession().data!;
  const projects = useProjects(admin);
  return (id: string) => projects.data?.find((p) => p.id === id)?.name ?? session.projects.find((p) => p.id === id)?.name ?? id;
}

export default function QosPolicies({ admin = false }: { admin?: boolean }) {
  const session = useSession().data!;
  const policies = useQosPolicies();
  const networks = useNetworks();
  const ports = usePorts();
  const projectName = useProjectName(session.is_admin);
  const invalidate = useInvalidate();
  const actions = useQosActions();
  const [creating, setCreating] = useState(false);
  const usage = useMemo(() => {
    const m = new Map<string, { nets: number; ports: number }>();
    for (const n of networks.data ?? []) if (n.qos_policy_id) m.set(n.qos_policy_id, { ...(m.get(n.qos_policy_id) ?? { nets: 0, ports: 0 }), nets: (m.get(n.qos_policy_id)?.nets ?? 0) + 1 });
    for (const p of ports.data ?? []) if (p.qos_policy_id) m.set(p.qos_policy_id, { ...(m.get(p.qos_policy_id) ?? { nets: 0, ports: 0 }), ports: (m.get(p.qos_policy_id)?.ports ?? 0) + 1 });
    return (q: QosPolicy) => m.get(q.id) ?? { nets: 0, ports: 0 };
  }, [networks.data, ports.data]);
  const usageText = (q: QosPolicy) => {
    const u = usage(q);
    return [u.nets && `${u.nets} network${u.nets === 1 ? "" : "s"}`, u.ports && `${u.ports} port${u.ports === 1 ? "" : "s"}`].filter(Boolean).join(", ") || "Unused";
  };
  const rows = admin ? policies.data : policies.data?.filter((q) => q.project_id === session.project?.id || q.shared || !session.is_admin);

  const projectCol: Column<QosPolicy> = { key: "project", header: tr("Project"), width: "9rem", hideBelow: "md", cell: (q) => projectName(q.project_id), value: (q) => projectName(q.project_id) };
  const columns: Column<QosPolicy>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (q) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <Link to={`${admin ? "/admin" : ""}/network/qos/${q.id}`} className="truncate font-medium text-cable hover:underline">
            {q.name || q.id}
          </Link>
          {q.shared && <Badge>{tr("shared")}</Badge>}
          {q.is_default && <Badge tone="accent">{tr("default")}</Badge>}
        </span>
      ),
      value: (q) => q.name,
    },
    ...(admin ? [projectCol] : []),
    { key: "rules", header: tr("Rules"), cell: (q) => (q.rules.length ? rulesText(q) : <span className="text-muted">{tr("No rules")}</span>), value: rulesText },
    { key: "used", header: tr("Applied to"), width: "11rem", hideBelow: "lg", cell: usageText, value: usageText },
    { key: "description", header: tr("Description"), hideBelow: "xl", cell: (q) => <span className="text-muted">{q.description || "—"}</span>, value: (q) => q.description ?? "" },
  ];

  return (
    <>
      <PageHeader
        title={admin ? tr("All QoS policies") : tr("QoS policies")}
        description={tr("Limit or guarantee bandwidth and packet rate, or mark traffic with DSCP. Apply a policy to a network (all its ports) or to a single port; a port's own policy wins over its network's.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Create policy")}
          </Button>
        }
      />
      {!session.is_admin && (
        <p className="mb-4 rounded-md border border-line bg-panel px-4 py-3 text-sm text-muted">
          {tr("Most clouds let only admins create policies and rules. You can apply the shared policies listed here to your networks and ports.")}
        </p>
      )}
      <ErrorNotice error={policies.error} className="mb-4" />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(q) => q.id}
        loading={policies.isPending}
        tableId={admin ? "admin-qos-policies" : "qos-policies"}
        noun={tr("policies")}
        rowLabel={(q) => q.name || q.id}
        empty={tr("No QoS policies. They need Neutron's qos extension.")}
        onRefresh={() => policies.refetch()}
        refreshing={policies.isFetching}
        onBulkDone={() => invalidate("network")}
        rowActions={(q) => actions.items(q, admin)}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete QoS policies?"),
            past: tr("deleted"),
            body: tr("Neutron refuses while a network or port still uses a policy."),
            check: (q) => (usage(q).nets + usage(q).ports ? tr("In use ({usageText})", { usageText: usageText(q) }) : true),
            run: (q) => os.del("network", `qos/policies/${q.id}`),
          },
        ]}
      />
      {creating && <PolicyDialog onClose={() => setCreating(false)} />}
      {actions.dialogs}
    </>
  );
}

// =========================================================================== actions

type Kind = "edit" | "rule" | "apply" | "delete";

export function useQosActions({ onDeleted }: { onDeleted?: () => void } = {}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ kind: Kind; q: QosPolicy; rule?: QosRule } | null>(null);
  const close = () => setOpen(null);
  const items = (q: QosPolicy, admin = false, where: "list" | "detail" = "list"): MenuEntry[] => [
    where === "list" && { label: tr("View details"), icon: "eye", onSelect: () => navigate(`${admin ? "/admin" : ""}/network/qos/${q.id}`) },
    where === "list" && "-",
    { label: tr("Edit policy"), icon: "edit", onSelect: () => setOpen({ kind: "edit", q }) },
    { label: tr("Add rule"), icon: "plus", onSelect: () => setOpen({ kind: "rule", q }) },
    { label: tr("Apply to network or port"), icon: "network", onSelect: () => setOpen({ kind: "apply", q }) },
    "-",
    { label: tr("Delete policy"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", q }) },
  ];
  const o = open;
  const dialogs = o && (
    <>
      {o.kind === "edit" && <PolicyDialog policy={o.q} onClose={close} />}
      {o.kind === "rule" && <RuleDialog policy={o.q} rule={o.rule} onClose={close} />}
      {o.kind === "apply" && <ApplyPolicyDialog policy={o.q} onClose={close} />}
      {o.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete QoS policy {name}?", { name: o.q.name })}
          submitLabel={tr("Delete policy")}
          done={tr("QoS policy deleted")}
          refresh={["network"]}
          onDone={onDeleted}
          run={() => os.del("network", `qos/policies/${o.q.id}`)}
        >
          <p className="text-sm">{tr("Neutron refuses while a network or port still uses it. Its rules are deleted with it.")}</p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs, open: (q: QosPolicy, kind: Kind, rule?: QosRule) => setOpen({ kind, q, rule }) };
}

function PolicyDialog({ policy, onClose }: { policy?: QosPolicy; onClose: () => void }) {
  const session = useSession().data!;
  const navigate = useNavigate();
  const [name, setName] = useState(policy?.name ?? "");
  const [description, setDescription] = useState(policy?.description ?? "");
  const [shared, setShared] = useState(policy?.shared ?? false);
  const [isDefault, setDefault] = useState(policy?.is_default ?? false);
  return (
    <ActionDialog<{ policy: QosPolicy }>
      onClose={onClose}
      title={policy ? tr("Edit {name}", { name: policy.name }) : tr("Create QoS policy")}
      submitLabel={policy ? tr("Save") : tr("Create policy")}
      canSubmit={!!name.trim()}
      done={policy ? tr("QoS policy updated") : tr("QoS policy {name} created", { name })}
      refresh={["network"]}
      onDone={(r) => !policy && navigate(`/network/qos/${r.policy.id}?tab=rules`)}
      run={() => {
        const body = { policy: { name: name.trim(), description, is_default: isDefault, ...(session.is_admin ? { shared } : {}) } };
        return policy ? os.put("network", `qos/policies/${policy.id}`, body) : os.post("network", "qos/policies", body);
      }}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("bw-100m")} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      {session.is_admin && <Switch checked={shared} onChange={setShared} label={tr("Shared")} hint={tr("Every project can apply it. To share with chosen projects only, use Sharing (RBAC).")} />}
      <Switch checked={isDefault} onChange={setDefault} label={tr("Default for the project")} hint={tr("New networks of the project get this policy automatically (qos-default extension).")} />
    </ActionDialog>
  );
}

const DIRECTIONAL: QosRuleType[] = ["bandwidth_limit", "minimum_bandwidth", "minimum_packet_rate", "packet_rate_limit"];

export function RuleDialog({ policy, rule, onClose }: { policy: QosPolicy; rule?: QosRule; onClose: () => void }) {
  const ruleTypes = useQosRuleTypes();
  const supported = ruleTypes.data ?? (Object.keys(RULE_INFO) as QosRuleType[]);
  const [type, setType] = useState<QosRuleType>(rule?.type ?? "bandwidth_limit");
  const [direction, setDirection] = useState<string>(rule?.direction ?? "egress");
  const [a, setA] = useState(String(rule?.max_kbps ?? rule?.min_kbps ?? rule?.min_kpps ?? rule?.max_kpps ?? ""));
  const [burst, setBurst] = useState(String(rule?.max_burst_kbps ?? rule?.max_burst_kpps ?? ""));
  const [dscp, setDscp] = useState(String(rule?.dscp_mark ?? "46"));
  const info = RULE_INFO[type];
  const taken = (t: QosRuleType, d?: string) => policy.rules.some((r) => r.id !== rule?.id && r.type === t && (t === "dscp_marking" || (r.direction ?? "egress") === d));
  const unit = type.includes("packet") ? "kpps" : "kbps";
  const body = (): Record<string, unknown> => {
    const n = (s: string) => (s.trim() === "" ? undefined : Number(s));
    switch (type) {
      case "bandwidth_limit":
        return { max_kbps: n(a), max_burst_kbps: n(burst) ?? 0, direction };
      case "minimum_bandwidth":
        return { min_kbps: n(a), direction };
      case "minimum_packet_rate":
        return { min_kpps: n(a), direction };
      case "packet_rate_limit":
        return { max_kpps: n(a), max_burst_kpps: n(burst) ?? 0, direction };
      case "dscp_marking":
        return { dscp_mark: Number(dscp) };
    }
  };
  const valid = type === "dscp_marking" || Number(a) > 0;
  const clash = taken(type, direction);
  const directions = type === "minimum_packet_rate" ? ["egress", "ingress", "any"] : ["egress", "ingress"];
  return (
    <ActionDialog
      onClose={onClose}
      title={rule ? tr("Edit {toLowerCase} rule", { toLowerCase: info.label.toLowerCase() }) : tr("Add a rule to {name}", { name: policy.name })}
      description={info.help}
      submitLabel={rule ? tr("Save rule") : tr("Add rule")}
      canSubmit={valid && !clash}
      done={rule ? tr("Rule updated") : tr("Rule added")}
      refresh={["network"]}
      run={() =>
        rule
          ? os.put("network", `qos/policies/${policy.id}/${info.path}/${rule.id}`, { [info.key]: body() })
          : os.post("network", `qos/policies/${policy.id}/${info.path}`, { [info.key]: body() })
      }
    >
      {!rule && (
        <Field label={tr("Rule type")}>
          {(id) => (
            <Picker
              id={id}
              value={type}
              onChange={(t) => setType(t as QosRuleType)}
              options={(Object.keys(RULE_INFO) as QosRuleType[]).map((t) => ({
                value: t,
                label: RULE_INFO[t].label,
                description: RULE_INFO[t].help,
                disabled: !supported.includes(t) ? tr("Not supported by this cloud's QoS drivers") : false,
              }))}
            />
          )}
        </Field>
      )}
      {type === "dscp_marking" ? (
        <Field label={tr("DSCP mark")}>
          {(id) => (
            <Picker
              id={id}
              value={dscp}
              onChange={setDscp}
              options={Object.entries(DSCP_NAMES).map(([v, n]) => ({ value: v, label: `${v} — ${n}` }))}
            />
          )}
        </Field>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={type === "minimum_bandwidth" || type === "minimum_packet_rate" ? tr("Minimum ({unit})", { unit }) : tr("Maximum ({unit})", { unit })} hint={unit === "kbps" && Number(a) > 0 ? tr("= {v} Mbps", { v: +(Number(a) / 1000).toFixed(2) }) : undefined}>
              {(id) => <Input id={id} type="number" min={1} autoFocus value={a} onChange={(e) => setA(e.target.value)} placeholder={unit === "kbps" ? "100000" : "1000"} />}
            </Field>
            {DIRECTIONAL.includes(type) && (
              <Field label={tr("Direction")} hint={tr("Egress = from the instance; ingress = to it.")}>
                {(id) => <Picker id={id} value={direction} onChange={setDirection} options={directions.map((d) => ({ value: d, label: d }))} />}
              </Field>
            )}
          </div>
          {(type === "bandwidth_limit" || type === "packet_rate_limit") && (
            <Field label={tr("Burst ({unit})", { unit })} hint={tr("Optional. Around 80% of the maximum suits TCP well.")}>
              {(id) => <Input id={id} type="number" min={0} value={burst} onChange={(e) => setBurst(e.target.value)} />}
            </Field>
          )}
        </>
      )}
      {clash && <p className="text-sm text-led-red">{trx("The policy already has a {toLowerCase} rule{v}.", { toLowerCase: info.label.toLowerCase(), v: type === "dscp_marking" ? "" : tr(" for {direction}", { direction }) })}</p>}
    </ActionDialog>
  );
}

/** Set the policy on networks or ports of the current project (PUT qos_policy_id). */
function ApplyPolicyDialog({ policy, onClose }: { policy: QosPolicy; onClose: () => void }) {
  const session = useSession().data!;
  const networks = useNetworks();
  const ports = usePorts();
  const [kind, setKind] = useState<"network" | "port">("network");
  const [target, setTarget] = useState("");
  const mine = (o: { project_id?: string }) => session.is_admin || o.project_id === session.project?.id;
  const netName = (id: string) => networks.data?.find((n) => n.id === id)?.name ?? id;
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Apply {name}", { name: policy.name })}
      description={tr("A network's policy covers all its ports except those with a policy of their own.")}
      submitLabel={tr("Apply policy")}
      canSubmit={!!target}
      done={tr("QoS policy applied")}
      refresh={["network"]}
      run={() => (kind === "network" ? os.put("network", `networks/${target}`, { network: { qos_policy_id: policy.id } }) : os.put("network", `ports/${target}`, { port: { qos_policy_id: policy.id } }))}
    >
      <Tabs
        value={kind}
        onChange={(k) => {
          setKind(k);
          setTarget("");
        }}
        tabs={[
          { id: "network", label: tr("Network") },
          { id: "port", label: tr("Port") },
        ]}
      />
      {kind === "network" ? (
        <Field label={tr("Network")}>
          {(id) => (
            <Picker
              id={id}
              value={target}
              onChange={setTarget}
              searchable
              loading={networks.isPending}
              placeholder={tr("Choose a network")}
              options={(networks.data ?? []).map((n) => ({
                value: n.id,
                label: n.name || n.id,
                icon: "network",
                disabled: !mine(n) ? tr("Owned by another project") : n.qos_policy_id === policy.id ? tr("Already uses it") : false,
                description: n.qos_policy_id && n.qos_policy_id !== policy.id ? tr("Has another policy (replaced)") : undefined,
              }))}
            />
          )}
        </Field>
      ) : (
        <Field label={tr("Port")}>
          {(id) => (
            <Picker
              id={id}
              inlineDescription
              value={target}
              onChange={setTarget}
              searchable
              loading={ports.isPending}
              placeholder={tr("Choose a port")}
              options={(ports.data ?? [])
                .filter((p) => !p.device_owner?.startsWith("network:"))
                .map((p) => ({
                  value: p.id,
                  label: portLabel(p),
                  description: `${netName(p.network_id)} · ${p.fixed_ips.map((f) => f.ip_address).join(", ")}`,
                  disabled: !mine(p) ? tr("Owned by another project") : p.qos_policy_id === policy.id ? tr("Already uses it") : false,
                }))}
            />
          )}
        </Field>
      )}
    </ActionDialog>
  );
}

/** QoS policy picker for network and port edit dialogs ("" = none). */
export function QosPolicyPicker({ id, value, onChange, inheritLabel }: { id?: string; value: string; onChange: (v: string) => void; inheritLabel?: string }) {
  const policies = useQosPolicies();
  return (
    <Picker
      id={id}
      value={value}
      onChange={onChange}
      loading={policies.isPending}
      options={[
        { value: "", label: inheritLabel ?? tr("No QoS policy") },
        ...(policies.data ?? []).map((q) => ({ value: q.id, label: q.name || q.id, icon: "gauge", description: rulesText(q) || tr("No rules") })),
      ]}
    />
  );
}

// =========================================================================== detail

const TABS = ["overview", "rules", "applied"] as const;

export function QosPolicyDetail({ admin = false }: { admin?: boolean }) {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const session = useSession().data!;
  const policy = useOsGet<QosPolicy>("network", `qos/policies/${id}`, (r: { policy: QosPolicy }) => r.policy);
  const networks = useNetworks({ qos_policy_id: id });
  const ports = usePorts({ qos_policy_id: id });
  const projectName = useProjectName(session.is_admin);
  const invalidate = useInvalidate();
  const back = `${admin ? "/admin" : ""}/network/qos`;
  const actions = useQosActions({ onDeleted: () => navigate(back) });
  const [tab, setTab] = useTab(TABS, "overview");
  const [delRule, setDelRule] = useState<QosRule | null>(null);
  const q = policy.data;
  const netList = (networks.data ?? []).filter((n) => n.qos_policy_id === id);
  const portList = (ports.data ?? []).filter((p) => p.qos_policy_id === id);
  type Target = { kind: "network"; n: Network } | { kind: "port"; p: Port };
  const targets: Target[] = [...netList.map((n) => ({ kind: "network" as const, n })), ...portList.map((p) => ({ kind: "port" as const, p }))];
  const tLabel = (t: Target) => (t.kind === "network" ? t.n.name || t.n.id : portLabel(t.p));
  const ruleCols: Column<QosRule>[] = [
    { key: "type", header: tr("Type"), width: "11rem", cell: (r) => RULE_INFO[r.type]?.label ?? r.type, value: (r) => r.type },
    { key: "summary", header: tr("Rule"), cell: ruleSummary, value: ruleSummary },
    { key: "direction", header: tr("Direction"), width: "7rem", hideBelow: "md", cell: (r) => r.direction ?? "—", value: (r) => r.direction ?? "" },
  ];
  const tCols: Column<Target>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (t) =>
        t.kind === "network" ? (
          <Link to={`/network/networks/${t.n.id}`} className="font-medium text-cable hover:underline">
            {tLabel(t)}
          </Link>
        ) : (
          <span className="font-medium">{tLabel(t)}</span>
        ),
      value: tLabel,
    },
    { key: "kind", header: tr("Kind"), width: "7rem", cell: (t) => (t.kind === "network" ? tr("Network") : tr("Port")), value: (t) => t.kind },
    { key: "detail", header: tr("Addresses"), hideBelow: "md", mono: true, cell: (t) => (t.kind === "port" ? t.p.fixed_ips.map((f) => f.ip_address).join(", ") : ""), value: (t) => (t.kind === "port" ? t.p.fixed_ips.map((f) => f.ip_address).join(", ") : "") },
  ];
  return (
    <>
      <Link to={back} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("QoS policies")}
      </Link>
      <PageHeader
        title={q?.name || tr("QoS policy")}
        description={q ? q.description || (q.rules.length ? q.rules.map(ruleSummary).join("; ") : tr("No rules yet")) : undefined}
        actions={q && <ActionMenu variant="button" items={() => actions.items(q, admin, "detail")} />}
      />
      <ErrorNotice error={policy.error} className="mb-4" />
      {q && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "rules", label: tr("Rules ({length})", { length: q.rules.length }) },
              { id: "applied", label: tr("Applied to ({length})", { length: targets.length }) },
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <Card title={tr("Details")}>
                <dl>
                  <Detail label={tr("Name")}>{q.name}</Detail>
                  <Detail label="ID">
                    <Mono>{q.id}</Mono>
                  </Detail>
                  <Detail label={tr("Project")}>{projectName(q.project_id)}</Detail>
                  <Detail label={tr("Shared")}>{q.shared ? tr("Yes") : tr("No")}</Detail>
                  <Detail label={tr("Project default")}>{q.is_default ? tr("Yes") : tr("No")}</Detail>
                </dl>
              </Card>
              <Card title={tr("Rules")}>
                <dl>
                  {q.rules.map((r) => (
                    <Detail key={r.id} label={RULE_INFO[r.type]?.label ?? r.type}>
                      {ruleSummary(r)}
                    </Detail>
                  ))}
                  {q.rules.length === 0 && <p className="text-sm text-muted">{tr("No rules; the policy has no effect yet.")}</p>}
                </dl>
              </Card>
            </div>
          )}
          {tab === "rules" && (
            <>
              <div className="mb-3">
                <Button onClick={() => actions.open(q, "rule")}>
                  <Icon name="plus" />
                  {tr("Add rule")}
                </Button>
              </div>
              <DataTable
                rows={q.rules}
                columns={ruleCols}
                rowKey={(r) => r.id}
                noun={tr("rules")}
                empty={tr("No rules.")}
                onRefresh={() => policy.refetch()}
                refreshing={policy.isFetching}
                rowActions={(r) => [
                  { label: tr("Edit rule"), icon: "edit", onSelect: () => actions.open(q, "rule", r) },
                  "-",
                  { label: tr("Delete rule"), icon: "trash", danger: true, onSelect: () => setDelRule(r) },
                ]}
              />
            </>
          )}
          {tab === "applied" && (
            <>
              <div className="mb-3">
                <Button onClick={() => actions.open(q, "apply")}>
                  <Icon name="network" />
                  {tr("Apply to network or port")}
                </Button>
              </div>
              <DataTable
                rows={networks.isPending || ports.isPending ? undefined : targets}
                columns={tCols}
                rowKey={(t) => (t.kind === "network" ? t.n.id : t.p.id)}
                loading={networks.isPending || ports.isPending}
                tableId="qos-applied"
                noun={tr("networks and ports")}
                rowLabel={tLabel}
                empty={tr("Not applied to any network or port you can see.")}
                onBulkDone={() => invalidate("network")}
                bulkActions={[
                  {
                    id: "remove",
                    label: tr("Remove policy"),
                    icon: "x",
                    danger: true,
                    title: tr("Remove the policy?"),
                    past: tr("updated"),
                    body: tr("Their traffic is no longer shaped by this policy (a port falls back to its network's policy)."),
                    run: (t) => (t.kind === "network" ? os.put("network", `networks/${t.n.id}`, { network: { qos_policy_id: null } }) : os.put("network", `ports/${t.p.id}`, { port: { qos_policy_id: null } })),
                  },
                ]}
              />
            </>
          )}
        </>
      )}
      {q && delRule && (
        <ActionDialog
          onClose={() => setDelRule(null)}
          danger
          title={tr("Delete rule?")}
          submitLabel={tr("Delete rule")}
          done={tr("Rule deleted")}
          refresh={["network"]}
          run={() => os.del("network", `qos/policies/${q.id}/${RULE_INFO[delRule.type].path}/${delRule.id}`)}
        >
          <p className="text-sm">{trx("{ruleSummary} stops applying to every network and port using {name}.", { ruleSummary: ruleSummary(delRule), name: q.name })}</p>
        </ActionDialog>
      )}
      {actions.dialogs}
    </>
  );
}
