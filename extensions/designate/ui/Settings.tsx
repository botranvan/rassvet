/** Admin: TLDs, TSIG keys, blacklists, quotas, pools and the state of the Designate services. */
import { useState } from "react";
import {
  ActionDialog,
  Button,
  Card,
  type Column,
  CopyButton,
  DataTable,
  Detail,
  ErrorNotice,
  Field,
  Icon,
  Input,
  type MenuEntry,
  Mono,
  PageHeader,
  Picker,
  StatusDot,
  Tabs,
  age,
  fmtDate,
  tr,
  useInvalidate,
  useProjects,
  useTab,
} from "@rassvet/sdk";
import {
  type Blacklist,
  DNS,
  type DnsQuota,
  type Pool,
  QUOTA_KEYS,
  type ServiceStatus,
  type Tld,
  type TsigKey,
  dns,
  dnsStatus,
  undot,
  usePools,
  useQuota,
  useServiceStatuses,
  useTlds,
  useTsigKeys,
  useBlacklists,
} from "./api";

const TABS = ["tlds", "tsigkeys", "blacklists", "quotas", "pools", "services"] as const;

export default function Settings() {
  const [tab, setTab] = useTab(TABS, "tlds");
  return (
    <>
      <PageHeader title={tr("DNS service")} description={tr("Which domains projects may create zones in, TSIG keys for zone transfers, per-project quotas, and the state of Designate in this region.")} />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { id: "tlds", label: tr("TLDs") },
          { id: "tsigkeys", label: tr("TSIG keys") },
          { id: "blacklists", label: tr("Blacklists") },
          { id: "quotas", label: tr("Quotas") },
          { id: "pools", label: tr("Pools") },
          { id: "services", label: tr("Services") },
        ]}
      />
      {tab === "tlds" && <Tlds />}
      {tab === "tsigkeys" && <TsigKeys />}
      {tab === "blacklists" && <Blacklists />}
      {tab === "quotas" && <Quotas />}
      {tab === "pools" && <Pools />}
      {tab === "services" && <Services />}
    </>
  );
}

const ageCol = <T extends { created_at?: string; updated_at?: string | null }>(): Column<T> => ({
  key: "updated",
  header: tr("Updated"),
  width: "8rem",
  hideBelow: "md",
  cell: (r) => <span title={fmtDate(r.updated_at ?? r.created_at) ?? ""}>{age(r.updated_at ?? r.created_at)}</span>,
  value: (r) => r.updated_at ?? r.created_at ?? "",
});

// =========================================================================== TLDs

function Tlds() {
  const tlds = useTlds();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "set" | "delete"; t?: Tld } | null>(null);
  const close = () => setOpen(null);
  const columns: Column<Tld>[] = [
    { key: "name", header: tr("Name"), width: "14rem", mono: true, cell: (t) => t.name, value: (t) => t.name },
    { key: "description", header: tr("Description"), cell: (t) => t.description || "—", value: (t) => t.description ?? "" },
    ageCol<Tld>(),
  ];
  const items = (t: Tld): MenuEntry[] => [
    { label: tr("Edit TLD"), icon: "edit", onSelect: () => setOpen({ kind: "set", t }) },
    { label: tr("Delete TLD"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", t }) },
  ];
  return (
    <>
      <p className="mb-4 text-sm text-muted">{tr("With no TLDs, zones can be created under any domain. Once one exists, only zones under a listed TLD are allowed.")}</p>
      <ErrorNotice error={tlds.error} className="mb-4" />
      <DataTable
        rows={tlds.data}
        columns={columns}
        rowKey={(t) => t.id}
        loading={tlds.isPending}
        tableId="designate-tlds"
        noun={tr("TLDs")}
        rowLabel={(t) => t.name}
        onRefresh={() => tlds.refetch()}
        refreshing={tlds.isFetching}
        onBulkDone={() => invalidate(DNS)}
        empty={tr("No TLDs: every domain is allowed.")}
        rowActions={items}
        toolbar={
          <Button onClick={() => setOpen({ kind: "set" })}>
            <Icon name="plus" />
            {tr("Add TLD")}
          </Button>
        }
        bulkActions={[{ id: "delete", label: tr("Delete"), icon: "trash", danger: true, title: tr("Delete TLDs?"), past: tr("deleted"), run: (t) => dns.del(`tlds/${t.id}`) }]}
      />
      {open?.kind === "set" && <TldDialog tld={open.t} onClose={close} />}
      {open?.kind === "delete" && open.t && (
        <ActionDialog onClose={close} danger title={tr("Delete {name}?", { name: open.t.name })} submitLabel={tr("Delete TLD")} done={tr("TLD deleted")} refresh={[DNS]} run={() => dns.del(`tlds/${open.t!.id}`)}>
          <p className="text-sm">{tr("Existing zones under it are kept; new ones can't be created unless another TLD allows them.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function TldDialog({ tld, onClose }: { tld?: Tld; onClose: () => void }) {
  const [name, setName] = useState(tld?.name ?? "");
  const [description, setDescription] = useState(tld?.description ?? "");
  const body = { name: name.trim().replace(/\.$/, ""), description: description.trim() || null };
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tld ? tr("Edit {name}", { name: tld.name }) : tr("Add TLD")}
      submitLabel={tld ? tr("Save") : tr("Add TLD")}
      canSubmit={/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*$/.test(body.name)}
      done={tld ? tr("TLD updated") : tr("TLD added")}
      refresh={[DNS]}
      run={() => (tld ? dns.patch(`tlds/${tld.id}`, body) : dns.post("tlds", body))}
    >
      <Field label={tr("Name")} hint={tr("e.g. com, org or co.uk, without the leading dot.")}>
        {(id) => <Input id={id} autoFocus className="font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="org" />}
      </Field>
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

// =========================================================================== TSIG keys

const ALGORITHMS = ["hmac-sha256", "hmac-sha512", "hmac-sha384", "hmac-sha224", "hmac-sha1", "hmac-md5"];

/** 32 random bytes, base64. */
const randomSecret = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

function TsigKeys() {
  const keys = useTsigKeys();
  const pools = usePools();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "create" | "delete"; k?: TsigKey } | null>(null);
  const close = () => setOpen(null);
  const poolName = (id: string) => pools.data?.find((p) => p.id === id)?.name ?? id;
  const columns: Column<TsigKey>[] = [
    { key: "name", header: tr("Name"), mono: true, cell: (k) => k.name, value: (k) => k.name },
    { key: "algorithm", header: tr("Algorithm"), width: "9rem", mono: true, cell: (k) => k.algorithm, value: (k) => k.algorithm },
    { key: "scope", header: tr("Scope"), width: "14rem", hideBelow: "md", cell: (k) => (k.scope === "POOL" ? tr("Pool {name}", { name: poolName(k.resource_id) }) : tr("Zone {id}", { id: k.resource_id.slice(0, 13) })), value: (k) => `${k.scope} ${k.resource_id}` },
    { key: "secret", header: tr("Secret"), width: "6rem", wrap: true, cell: (k) => <CopyButton className="h-8" text={k.secret} />, value: () => "" },
    ageCol<TsigKey>(),
  ];
  return (
    <>
      <p className="mb-4 text-sm text-muted">{tr("Shared secrets that sign zone transfers between Designate and the DNS servers of a pool, or with the primaries of one secondary zone.")}</p>
      <ErrorNotice error={keys.error} className="mb-4" />
      <DataTable
        rows={keys.data}
        columns={columns}
        rowKey={(k) => k.id}
        loading={keys.isPending}
        tableId="designate-tsigkeys"
        noun={tr("TSIG keys")}
        rowLabel={(k) => k.name}
        onRefresh={() => keys.refetch()}
        refreshing={keys.isFetching}
        onBulkDone={() => invalidate(DNS)}
        empty={tr("No TSIG keys.")}
        rowActions={(k) => [{ label: tr("Delete TSIG key"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", k }) }]}
        toolbar={
          <Button onClick={() => setOpen({ kind: "create" })}>
            <Icon name="plus" />
            {tr("Create TSIG key")}
          </Button>
        }
        bulkActions={[{ id: "delete", label: tr("Delete"), icon: "trash", danger: true, title: tr("Delete TSIG keys?"), past: tr("deleted"), run: (k) => dns.del(`tsigkeys/${k.id}`) }]}
      />
      {open?.kind === "create" && <TsigDialog pools={pools.data ?? []} onClose={close} />}
      {open?.kind === "delete" && open.k && (
        <ActionDialog onClose={close} danger title={tr("Delete {name}?", { name: open.k.name })} submitLabel={tr("Delete TSIG key")} done={tr("TSIG key deleted")} refresh={[DNS]} run={() => dns.del(`tsigkeys/${open.k!.id}`)}>
          <p className="text-sm">{tr("Zone transfers signed with this key fail until the servers use another one.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function TsigDialog({ pools, onClose }: { pools: Pool[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [algorithm, setAlgorithm] = useState("hmac-sha256");
  const [secret, setSecret] = useState(randomSecret);
  const [scope, setScope] = useState<"POOL" | "ZONE">("POOL");
  const [resource, setResource] = useState(pools[0]?.id ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Create TSIG key")}
      submitLabel={tr("Create TSIG key")}
      canSubmit={!!name.trim() && !!secret.trim() && /^[a-zA-Z0-9-]+$/.test(resource.trim())}
      done={tr("TSIG key created")}
      refresh={[DNS]}
      run={() => dns.post("tsigkeys", { name: name.trim(), algorithm, secret: secret.trim(), scope, resource_id: resource.trim() })}
    >
      <Field label={tr("Name")} hint={tr("The key name the DNS servers know it by.")}>
        {(id) => <Input id={id} autoFocus className="font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="designate-pool" />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Algorithm")}>{(id) => <Picker id={id} value={algorithm} onChange={setAlgorithm} options={ALGORITHMS.map((a) => ({ value: a, label: a }))} />}</Field>
        <Field label={tr("Scope")}>
          {(id) => (
            <Picker
              id={id}
              value={scope}
              onChange={(v) => {
                setScope(v as "POOL" | "ZONE");
                setResource(v === "POOL" ? (pools[0]?.id ?? "") : "");
              }}
              options={[
                { value: "POOL", label: tr("Pool") },
                { value: "ZONE", label: tr("Zone") },
              ]}
            />
          )}
        </Field>
      </div>
      <Field label={scope === "POOL" ? tr("Pool") : tr("Zone ID")}>
        {(id) =>
          scope === "POOL" ? (
            <Picker id={id} value={resource} onChange={setResource} options={pools.map((p) => ({ value: p.id, label: p.name, description: p.id }))} />
          ) : (
            <Input id={id} className="font-mono" value={resource} onChange={(e) => setResource(e.target.value)} />
          )
        }
      </Field>
      <Field label={tr("Secret")} hint={tr("Base64. A random one is filled in; configure the same value on the DNS servers.")}>
        {(id) => (
          <div className="flex gap-2">
            <Input id={id} className="font-mono" value={secret} onChange={(e) => setSecret(e.target.value)} />
            <Button type="button" onClick={() => setSecret(randomSecret())} title={tr("New random secret")}>
              <Icon name="refresh" />
            </Button>
            <CopyButton text={secret} />
          </div>
        )}
      </Field>
    </ActionDialog>
  );
}

// =========================================================================== blacklists

function Blacklists() {
  const lists = useBlacklists();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "set" | "delete"; b?: Blacklist } | null>(null);
  const close = () => setOpen(null);
  const columns: Column<Blacklist>[] = [
    { key: "pattern", header: tr("Pattern"), mono: true, cell: (b) => b.pattern, value: (b) => b.pattern },
    { key: "description", header: tr("Description"), cell: (b) => b.description || "—", value: (b) => b.description ?? "" },
    ageCol<Blacklist>(),
  ];
  return (
    <>
      <p className="mb-4 text-sm text-muted">{tr("Regular expressions of zone names projects may not create (admins still can), e.g. to protect the cloud's own domains.")}</p>
      <ErrorNotice error={lists.error} className="mb-4" />
      <DataTable
        rows={lists.data}
        columns={columns}
        rowKey={(b) => b.id}
        loading={lists.isPending}
        tableId="designate-blacklists"
        noun={tr("blacklists")}
        rowLabel={(b) => b.pattern}
        onRefresh={() => lists.refetch()}
        refreshing={lists.isFetching}
        onBulkDone={() => invalidate(DNS)}
        empty={tr("No blacklisted names.")}
        rowActions={(b) => [
          { label: tr("Edit blacklist"), icon: "edit", onSelect: () => setOpen({ kind: "set", b }) },
          { label: tr("Delete blacklist"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", b }) },
        ]}
        toolbar={
          <Button onClick={() => setOpen({ kind: "set" })}>
            <Icon name="plus" />
            {tr("Add blacklist")}
          </Button>
        }
        bulkActions={[{ id: "delete", label: tr("Delete"), icon: "trash", danger: true, title: tr("Delete blacklists?"), past: tr("deleted"), run: (b) => dns.del(`blacklists/${b.id}`) }]}
      />
      {open?.kind === "set" && <BlacklistDialog blacklist={open.b} onClose={close} />}
      {open?.kind === "delete" && open.b && (
        <ActionDialog onClose={close} danger title={tr("Delete {name}?", { name: open.b.pattern })} submitLabel={tr("Delete blacklist")} done={tr("Blacklist deleted")} refresh={[DNS]} run={() => dns.del(`blacklists/${open.b!.id}`)} />
      )}
    </>
  );
}

function BlacklistDialog({ blacklist, onClose }: { blacklist?: Blacklist; onClose: () => void }) {
  const [pattern, setPattern] = useState(blacklist?.pattern ?? "");
  const [description, setDescription] = useState(blacklist?.description ?? "");
  const [sample, setSample] = useState("");
  let regex: RegExp | null = null;
  try {
    regex = pattern ? new RegExp(pattern) : null;
  } catch {
    regex = null;
  }
  const body = { pattern, description: description.trim() || null };
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={blacklist ? tr("Edit blacklist") : tr("Add blacklist")}
      submitLabel={blacklist ? tr("Save") : tr("Add blacklist")}
      canSubmit={!!regex}
      done={blacklist ? tr("Blacklist updated") : tr("Blacklist added")}
      refresh={[DNS]}
      run={() => (blacklist ? dns.patch(`blacklists/${blacklist.id}`, body) : dns.post("blacklists", body))}
    >
      <Field label={tr("Pattern")} hint={tr("Matched against full zone names with their trailing dot, e.g. ^([A-Za-z0-9_\\-]+\\.)*example\\.com\\.$")}>
        {(id) => <Input id={id} autoFocus className="font-mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />}
      </Field>
      {pattern && !regex && <p className="text-sm text-led-red">{tr("Not a valid regular expression")}</p>}
      <Field label={tr("Try a zone name")}>{(id) => <Input id={id} className="font-mono" value={sample} onChange={(e) => setSample(e.target.value)} placeholder="sub.example.com." />}</Field>
      {regex && sample && <p className="text-sm">{regex.test(sample) ? tr("Blocked") : tr("Allowed")}</p>}
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

// =========================================================================== quotas

function Quotas() {
  const projects = useProjects();
  const [project, setProject] = useState("");
  const quota = useQuota(project);
  const [open, setOpen] = useState<"edit" | "reset" | null>(null);
  const close = () => setOpen(null);
  const name = projects.data?.find((p) => p.id === project)?.name ?? project;
  return (
    <>
      <p className="mb-4 text-sm text-muted">{tr("Designate has no list of quotas: choose a project to see and change its limits. Projects keep the defaults from designate.conf ([DEFAULT] quota_*) until changed.")}</p>
      <div className="mb-5 max-w-md">
        <Field label={tr("Project")}>
          {(id) => (
            <Picker id={id} value={project} onChange={setProject} loading={projects.isPending} options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name, description: p.id }))} />
          )}
        </Field>
      </div>
      <ErrorNotice error={quota.error} className="mb-4" />
      {project && quota.data && (
        <Card
          title={tr("Limits of {project}", { project: name })}
          actions={
            <span className="flex gap-2">
              <Button className="h-8" onClick={() => setOpen("edit")}>
                <Icon name="edit" />
                {tr("Change")}
              </Button>
              <Button className="h-8" onClick={() => setOpen("reset")}>
                <Icon name="rotate-ccw" />
                {tr("Reset to defaults")}
              </Button>
            </span>
          }
        >
          <dl>
            {QUOTA_KEYS.map((k) => (
              <Detail key={k.key} label={k.label}>
                {quota.data[k.key] ?? "—"} <span className="text-xs text-muted">{k.hint}</span>
              </Detail>
            ))}
          </dl>
        </Card>
      )}
      {open === "edit" && quota.data && <QuotaDialog project={project} name={name} quota={quota.data} onClose={close} />}
      {open === "reset" && (
        <ActionDialog onClose={close} danger title={tr("Reset the DNS quotas of {project}?", { project: name })} submitLabel={tr("Reset")} done={tr("Quotas reset")} refresh={[DNS]} run={() => dns.del(`quotas/${project}`)}>
          <p className="text-sm">{tr("The project gets the defaults again. Existing zones and records are kept.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function QuotaDialog({ project, name, quota, onClose }: { project: string; name: string; quota: DnsQuota; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(QUOTA_KEYS.map((k) => [k.key, String(quota[k.key] ?? "")])));
  const valid = QUOTA_KEYS.every((k) => /^-?\d+$/.test(values[k.key].trim()));
  const changed = Object.fromEntries(QUOTA_KEYS.filter((k) => Number(values[k.key]) !== quota[k.key]).map((k) => [k.key, Number(values[k.key])]));
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("DNS quotas of {project}", { project: name })}
      submitLabel={tr("Save")}
      canSubmit={valid && Object.keys(changed).length > 0}
      done={tr("Quotas updated")}
      refresh={[DNS]}
      run={() => dns.patch(`quotas/${project}`, changed)}
    >
      <p className="text-sm text-muted">{tr("-1: unlimited.")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {QUOTA_KEYS.map((k) => (
          <Field key={k.key} label={k.label} hint={k.hint}>
            {(id) => <Input id={id} inputMode="numeric" value={values[k.key]} onChange={(e) => setValues({ ...values, [k.key]: e.target.value })} />}
          </Field>
        ))}
      </div>
    </ActionDialog>
  );
}

// =========================================================================== pools and services

function Pools() {
  const pools = usePools();
  const columns: Column<Pool>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (p) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{p.name}</p>
          {p.description && <p className="truncate text-xs text-muted">{p.description}</p>}
        </div>
      ),
      value: (p) => `${p.name} ${p.id} ${p.description ?? ""}`,
    },
    { key: "id", header: "ID", width: "18rem", hideBelow: "lg", mono: true, cell: (p) => p.id, value: (p) => p.id },
    {
      key: "ns",
      header: tr("Name servers"),
      wrap: true,
      cell: (p) => (
        <ul className="space-y-0.5">
          {[...p.ns_records]
            .sort((a, b) => a.priority - b.priority)
            .map((n) => (
              <li key={n.hostname} className="font-mono text-xs">
                {undot(n.hostname)}
              </li>
            ))}
        </ul>
      ),
      value: (p) => p.ns_records.map((n) => n.hostname).join(" "),
    },
    {
      key: "attributes",
      header: tr("Attributes"),
      width: "12rem",
      hideBelow: "md",
      wrap: true,
      cell: (p) =>
        Object.keys(p.attributes ?? {}).length ? (
          <Mono className="text-xs">
            {Object.entries(p.attributes ?? {})
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")}
          </Mono>
        ) : (
          "—"
        ),
      value: (p) => JSON.stringify(p.attributes ?? {}),
    },
  ];
  return (
    <>
      <p className="mb-4 text-sm text-muted">{tr("Groups of DNS servers zones are published to; defined in pools.yaml and loaded with designate-manage pool update.")}</p>
      <ErrorNotice error={pools.error} className="mb-4" />
      <DataTable
        rows={pools.data}
        columns={columns}
        rowKey={(p) => p.id}
        loading={pools.isPending}
        tableId="designate-pools"
        noun={tr("pools")}
        onRefresh={() => pools.refetch()}
        refreshing={pools.isFetching}
        empty={tr("No pools.")}
      />
    </>
  );
}

/** Services report every few seconds; Designate keeps the last status of a host that stopped (e.g. a replaced pod). */
const STALE_MS = 2 * 60_000;
const stale = (s: ServiceStatus) => {
  if (!s.heartbeated_at) return false;
  const iso = s.heartbeated_at;
  const t = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
  return Date.now() - t > STALE_MS;
};

function Services() {
  const services = useServiceStatuses();
  const columns: Column<ServiceStatus>[] = [
    { key: "service", header: tr("Service"), width: "12rem", mono: true, cell: (s) => s.service_name, value: (s) => s.service_name },
    { key: "host", header: tr("Host"), cell: (s) => s.hostname, value: (s) => s.hostname },
    {
      key: "status",
      header: tr("Status"),
      width: "10rem",
      cell: (s) => (stale(s) ? <StatusDot status="warn" label={tr("No heartbeat")} /> : <StatusDot status={dnsStatus(s.status)} label={s.status} />),
      value: (s) => (stale(s) ? "stale" : s.status),
    },
    { key: "heartbeat", header: tr("Last heartbeat"), width: "10rem", cell: (s) => <span title={fmtDate(s.heartbeated_at) ?? ""}>{age(s.heartbeated_at)}</span>, value: (s) => s.heartbeated_at ?? "" },
  ];
  return (
    <>
      <p className="mb-4 text-sm text-muted">
        {tr("Designate keeps a host's last status after it stops reporting (e.g. a replaced pod); hosts without a heartbeat for 2 minutes are shown as such.")}
      </p>
      <ErrorNotice error={services.error} className="mb-4" />
      <DataTable
        rows={services.data}
        columns={columns}
        rowKey={(s) => s.id}
        loading={services.isPending}
        tableId="designate-services"
        noun={tr("services")}
        rowLabel={(s) => `${s.service_name} ${s.hostname}`}
        onRefresh={() => services.refetch()}
        refreshing={services.isFetching}
        empty={tr("No services reported.")}
      />
    </>
  );
}
