/**
 * Subnet pools (Neutron subnet_allocation): address space that subnets are carved from by
 * prefix length instead of a hand-typed CIDR, with per-project quotas, an optional address
 * scope (routing domain) and a default pool per IP version. Address scopes are managed on
 * the second tab. Prefix add/remove needs subnetpool-prefix-ops (adding falls back to an
 * update of the prefix list); onboarding a network's subnets needs subnet_onboard.
 */
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { ActionMenu, type MenuEntry } from "@/components/Menu";
import { Picker } from "@/components/Picker";
import { Badge, Button, Card, Checkbox, Detail, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Switch, Tabs, Textarea } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import { type Cidr, cidrContains, cidrOverlaps, cidrSize, cidrText, fmtCount, parseCidr, pctOf } from "@/lib/ipmath";
import { type AddressScope, type SubnetPool, useAddressScopes, useNeutronExtensions, useSubnetPools } from "@/lib/neutron";
import { type Subnet, os, useInvalidate, useNetworks, useOsGet, useSubnets } from "@/lib/os";
import { useSession } from "@/lib/session";
import { useTab } from "@/lib/useTab";
import { cn } from "@/lib/utils";
import { SubnetDialog } from "./networkActions";
import { ObjectSharing, ShareDialog } from "./Rbac";
import { plen } from "./subnetSource";
import { tr, trx } from "@/lib/i18n";

// =========================================================================== helpers

function useProjectName() {
  const session = useSession().data!;
  const projects = useProjects(session.is_admin);
  return (id: string) => projects.data?.find((p) => p.id === id)?.name ?? session.projects.find((p) => p.id === id)?.name ?? id;
}

const lens = (p: SubnetPool) => tr("/{def} (/{min}–/{max})", { def: plen(p.default_prefixlen), min: plen(p.min_prefixlen), max: plen(p.max_prefixlen) });

export interface PrefixUse {
  prefix: string;
  cidr: Cidr | null;
  used: bigint;
  total: bigint;
  subnets: Subnet[];
}

/** Addresses allocated per pool prefix, from the subnets carved out of the pool. */
export function poolUsage(pool: SubnetPool, subnets: Subnet[] | undefined) {
  const mine = (subnets ?? []).filter((s) => s.subnetpool_id === pool.id).map((s) => ({ s, c: parseCidr(s.cidr) }));
  const prefixes: PrefixUse[] = pool.prefixes.map((prefix) => {
    const cidr = parseCidr(prefix);
    const inside = cidr ? mine.filter((x) => x.c && cidrContains(cidr, x.c)) : [];
    return { prefix, cidr, used: inside.reduce((n, x) => n + cidrSize(x.c!), 0n), total: cidr ? cidrSize(cidr) : 0n, subnets: inside.map((x) => x.s) };
  });
  const used = prefixes.reduce((n, p) => n + p.used, 0n);
  const total = prefixes.reduce((n, p) => n + p.total, 0n);
  return { prefixes, used, total, pct: pctOf(used, total), count: mine.length };
}

function UsageBar({ pct, className }: { pct: number; className?: string }) {
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-ink/8", className)}>
      <div className={cn("h-full rounded-full", pct >= 90 ? "bg-led-red" : pct >= 75 ? "bg-led-amber" : "bg-cable")} style={{ width: `${Math.min(100, Math.max(pct > 0 ? 1 : 0, pct))}%` }} />
    </div>
  );
}

/** "65,536 addresses" for IPv4; IPv6 counted in /64 blocks (how Neutron counts its quota). */
function sizeText(n: bigint, version: 4 | 6) {
  return version === 4 ? tr("{n} addresses", { n: fmtCount(n) }) : tr("{n} × /64", { n: fmtCount(n >> 64n) });
}
/** "64 of 65,536 addresses". */
const ofText = (used: bigint, total: bigint, version: 4 | 6) => tr("{n} of {total}", { n: fmtCount(version === 4 ? used : used >> 64n), total: sizeText(total, version) });

/** Parse a prefix list (one per line or comma separated): the CIDRs, or the first problem. */
function parsePrefixes(text: string, version?: 4 | 6): { list: Cidr[]; error: string | null } {
  const parts = text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const list: Cidr[] = [];
  for (const p of parts) {
    const c = parseCidr(p);
    if (!c) return { list, error: tr("{p} isn't a valid CIDR", { p }) };
    if (!c.aligned) return { list, error: tr("{p} has host bits set (use {fixed})", { p, fixed: cidrText(c) }) };
    if ((version ?? list[0]?.version ?? c.version) !== c.version) return { list, error: tr("Mixing IPv4 and IPv6 prefixes isn't allowed") };
    if (list.some((x) => cidrOverlaps(x, c))) return { list, error: tr("{p} overlaps another prefix", { p }) };
    list.push(c);
  }
  return { list, error: null };
}

const mineOrAdmin = (session: { is_admin: boolean; project?: { id: string } | null }, ownerId: string) => session.is_admin || ownerId === session.project?.id;

// =========================================================================== list page

const PAGE_TABS = ["pools", "scopes"] as const;

export default function SubnetPools({ admin = false }: { admin?: boolean }) {
  const [tab, setTab] = useTab(PAGE_TABS, "pools");
  const [creating, setCreating] = useState<"pool" | "scope" | null>(null);
  return (
    <>
      <PageHeader
        title={admin ? tr("All subnet pools") : tr("Subnet pools")}
        description={tr("Address space that subnets are allocated from: ask for a prefix length and Neutron picks a free block, so subnets never overlap. A pool can belong to an address scope (a routing domain without NAT) and be the default pool for its IP version.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(tab === "pools" ? "pool" : "scope")}>
            <Icon name="plus" />
            {tab === "pools" ? tr("Create subnet pool") : tr("Create address scope")}
          </Button>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { id: "pools", label: tr("Subnet pools") },
          { id: "scopes", label: tr("Address scopes") },
        ]}
      />
      {tab === "pools" ? <PoolList admin={admin} /> : <AddressScopeList admin={admin} />}
      {creating === "pool" && <SubnetPoolDialog onClose={() => setCreating(null)} />}
      {creating === "scope" && <AddressScopeDialog onClose={() => setCreating(null)} />}
    </>
  );
}

function PoolList({ admin }: { admin: boolean }) {
  const session = useSession().data!;
  const pools = useSubnetPools();
  const subnets = useSubnets();
  const scopes = useAddressScopes();
  const projectName = useProjectName();
  const invalidate = useInvalidate();
  const actions = useSubnetPoolActions();
  const usage = useMemo(() => {
    const m = new Map(pools.data?.map((p) => [p.id, poolUsage(p, subnets.data)]));
    return (p: SubnetPool) => m.get(p.id) ?? poolUsage(p, []);
  }, [pools.data, subnets.data]);
  const scopeName = (id?: string | null) => (id ? (scopes.data?.find((a) => a.id === id)?.name ?? id.slice(0, 8)) : "");
  const rows = admin ? pools.data : pools.data?.filter((p) => p.project_id === session.project?.id || p.shared || !session.is_admin);

  const columns: Column<SubnetPool>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="inline-flex max-w-full items-center gap-2">
            <Link to={`/network/subnet-pools/${p.id}`} className="truncate font-medium text-cable hover:underline">
              {p.name || p.id}
            </Link>
            {p.is_default && <Badge tone="accent">{tr("default")}</Badge>}
            {p.shared && <Badge>{tr("shared")}</Badge>}
          </span>
          <span className="truncate text-xs text-muted">
            {tr("IPv{ip_version}", { ip_version: p.ip_version })}
            {p.address_scope_id ? ` · ${tr("scope {name}", { name: scopeName(p.address_scope_id) })}` : ""}
          </span>
        </span>
      ),
      value: (p) => p.name,
    },
    ...(admin ? [{ key: "project", header: tr("Project"), width: "9rem", hideBelow: "md" as const, cell: (p: SubnetPool) => projectName(p.project_id), value: (p: SubnetPool) => projectName(p.project_id) }] : []),
    { key: "prefixes", header: tr("Prefixes"), mono: true, cell: (p) => p.prefixes.join(", "), value: (p) => p.prefixes.join(" ") },
    { key: "lens", header: tr("Prefix length"), width: "9.5rem", hideBelow: "lg", cell: lens, value: (p) => plen(p.default_prefixlen) },
    {
      key: "used",
      header: tr("Allocated"),
      width: "11rem",
      hideBelow: "sm",
      wrap: true,
      cell: (p) => {
        const u = usage(p);
        return (
          <div className="min-w-0" title={ofText(u.used, u.total, p.ip_version)}>
            <div className="flex justify-between gap-2 text-xs text-muted">
              <span className="truncate">{tr("{n} subnet(s)", { n: u.count })}</span>
              <span className="tabular-nums">{u.pct}%</span>
            </div>
            <UsageBar pct={u.pct} className="mt-1" />
          </div>
        );
      },
      value: (p) => usage(p).pct,
      csv: (p) => `${usage(p).count} subnets, ${usage(p).pct}%`,
    },
    { key: "quota", header: tr("Quota"), width: "7rem", hideBelow: "xl", cell: (p) => (p.default_quota == null ? <span className="text-muted">{tr("No limit")}</span> : p.default_quota.toLocaleString()), value: (p) => p.default_quota ?? -1 },
  ];

  return (
    <>
      <ErrorNotice error={pools.error} className="mb-4" />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(p) => p.id}
        loading={pools.isPending}
        tableId={admin ? "admin-subnet-pools" : "subnet-pools"}
        noun={tr("subnet pools")}
        rowLabel={(p) => p.name || p.id}
        filterPlaceholder={tr("Filter by name or prefix")}
        empty={tr("No subnet pools yet. Create one to hand out subnets by prefix length.")}
        onRefresh={() => {
          pools.refetch();
          subnets.refetch();
        }}
        refreshing={pools.isFetching || subnets.isFetching}
        onBulkDone={() => invalidate("network")}
        rowActions={(p) => actions.items(p)}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete subnet pools?"),
            past: tr("deleted"),
            body: tr("Neutron refuses while subnets are still allocated from a pool."),
            check: (p) => (!mineOrAdmin(session, p.project_id) ? tr("Owned by another project") : usage(p).count ? tr("{n} subnet(s) allocated", { n: usage(p).count }) : true),
            run: (p) => os.del("network", `subnetpools/${p.id}`),
          },
        ]}
      />
      {actions.dialogs}
    </>
  );
}

// =========================================================================== actions

type Kind = "edit" | "add" | "remove" | "onboard" | "share" | "delete";

export function useSubnetPoolActions({ onDeleted }: { onDeleted?: () => void } = {}) {
  const session = useSession().data!;
  const navigate = useNavigate();
  const ext = useNeutronExtensions();
  const [open, setOpen] = useState<{ kind: Kind; p: SubnetPool } | null>(null);
  const close = () => setOpen(null);
  const has = (alias: string) => !ext.data || ext.data.has(alias);
  const items = (p: SubnetPool, where: "list" | "detail" = "list"): MenuEntry[] => {
    const owner = mineOrAdmin(session, p.project_id) ? false : tr("Owned by another project");
    return [
      where === "list" && { label: tr("View details"), icon: "eye", onSelect: () => navigate(`/network/subnet-pools/${p.id}`) },
      where === "list" && "-",
      { label: tr("Edit subnet pool"), icon: "edit", disabled: owner, onSelect: () => setOpen({ kind: "edit", p }) },
      { label: tr("Add prefixes"), icon: "list-plus", disabled: owner, onSelect: () => setOpen({ kind: "add", p }) },
      {
        label: tr("Remove prefixes"),
        icon: "list-minus",
        disabled: owner || (has("subnetpool-prefix-ops") ? false : tr("Needs Neutron's subnetpool-prefix-ops extension")),
        onSelect: () => setOpen({ kind: "remove", p }),
      },
      {
        label: tr("Onboard a network's subnets"),
        icon: "arrow-right-left",
        disabled: owner || (has("subnet_onboard") ? false : tr("Needs Neutron's subnet_onboard extension")),
        onSelect: () => setOpen({ kind: "onboard", p }),
      },
      { label: tr("Share with a project"), icon: "share", disabled: owner, onSelect: () => setOpen({ kind: "share", p }) },
      "-",
      { label: tr("Delete subnet pool"), icon: "trash", danger: true, disabled: owner, onSelect: () => setOpen({ kind: "delete", p }) },
    ];
  };
  const o = open;
  const dialogs = o && (
    <>
      {o.kind === "edit" && <SubnetPoolDialog pool={o.p} onClose={close} />}
      {(o.kind === "add" || o.kind === "remove") && <PrefixesDialog pool={o.p} mode={o.kind} prefixOps={has("subnetpool-prefix-ops")} onClose={close} />}
      {o.kind === "onboard" && <OnboardDialog pool={o.p} onClose={close} />}
      {o.kind === "share" && <ShareDialog onClose={close} object={{ type: "subnetpool", id: o.p.id, name: o.p.name || o.p.id }} />}
      {o.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete subnet pool {name}?", { name: o.p.name || o.p.id })}
          submitLabel={tr("Delete subnet pool")}
          done={tr("Subnet pool deleted")}
          refresh={["network"]}
          onDone={onDeleted}
          run={() => os.del("network", `subnetpools/${o.p.id}`)}
        >
          <p className="text-sm">{tr("Neutron refuses while subnets are still allocated from it. Subnets created with a CIDR of their own are not affected.")}</p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs, open: (p: SubnetPool, kind: Kind) => setOpen({ kind, p }) };
}

// =========================================================================== dialogs

function SubnetPoolDialog({ pool, onClose }: { pool?: SubnetPool; onClose: () => void }) {
  const session = useSession().data!;
  const navigate = useNavigate();
  const scopes = useAddressScopes();
  const projects = useProjects(session.is_admin && !pool);
  const [name, setName] = useState(pool?.name ?? "");
  const [description, setDescription] = useState(pool?.description ?? "");
  const [prefixes, setPrefixes] = useState("");
  const [def, setDef] = useState(pool ? String(plen(pool.default_prefixlen)) : "");
  const [min, setMin] = useState(pool ? String(plen(pool.min_prefixlen)) : "");
  const [max, setMax] = useState(pool ? String(plen(pool.max_prefixlen)) : "");
  const [quota, setQuota] = useState(pool?.default_quota != null ? String(pool.default_quota) : "");
  const [scope, setScope] = useState(pool?.address_scope_id ?? "");
  const [shared, setShared] = useState(false);
  const [isDefault, setDefault] = useState(pool?.is_default ?? false);
  const [project, setProject] = useState("");

  const parsed = parsePrefixes(prefixes);
  const version: 4 | 6 = pool?.ip_version ?? parsed.list[0]?.version ?? 4;
  const width = version === 4 ? 32 : 128;
  // Suggested lengths: the widest prefix as minimum, /24 (IPv4) or /64 (IPv6) by default.
  const widest = pool ? plen(pool.min_prefixlen) : parsed.list.length ? Math.min(...parsed.list.map((c) => c.len)) : version === 4 ? 8 : 48;
  const eff = {
    min: min.trim() ? Number(min) : widest,
    max: max.trim() ? Number(max) : width,
    def: def.trim() ? Number(def) : Math.max(widest, version === 4 ? Math.min(24, width) : 64),
  };
  const lenError =
    [eff.min, eff.max, eff.def].some((n) => !Number.isInteger(n) || n < 0 || n > width)
      ? tr("Prefix lengths must be 0 to {width}", { width })
      : !(eff.min <= eff.def && eff.def <= eff.max)
        ? tr("Needs minimum ≤ default ≤ maximum")
        : null;
  const prefixError = pool ? null : parsed.error ?? (parsed.list.length ? null : tr("Add at least one prefix"));
  const quotaOk = !quota.trim() || (Number.isInteger(Number(quota)) && Number(quota) >= 0);
  const scopeOptions = (scopes.data ?? []).filter((a) => a.ip_version === version);

  return (
    <ActionDialog<{ subnetpool: SubnetPool }>
      onClose={onClose}
      size="md"
      title={pool ? tr("Edit {name}", { name: pool.name || pool.id }) : tr("Create subnet pool")}
      submitLabel={pool ? tr("Save") : tr("Create subnet pool")}
      canSubmit={!!name.trim() && !prefixError && !lenError && quotaOk}
      done={pool ? tr("Subnet pool updated") : tr("Subnet pool {name} created", { name })}
      refresh={["network"]}
      onDone={(r) => !pool && navigate(`/network/subnet-pools/${r.subnetpool.id}`)}
      run={() => {
        const body: Record<string, unknown> = {
          name: name.trim(),
          description,
          default_prefixlen: eff.def,
          min_prefixlen: eff.min,
          max_prefixlen: eff.max,
          default_quota: quota.trim() ? Number(quota) : null,
          address_scope_id: scope || null,
          ...(session.is_admin ? { is_default: isDefault } : {}),
        };
        if (!pool) {
          body.prefixes = parsed.list.map(cidrText);
          if (session.is_admin) {
            body.shared = shared;
            if (project) body.project_id = project;
          }
          if (!scope) delete body.address_scope_id;
          if (body.default_quota === null) delete body.default_quota;
        }
        return pool ? os.put("network", `subnetpools/${pool.id}`, { subnetpool: body }) : os.post("network", "subnetpools", { subnetpool: body });
      }}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("tenant-v4")} />}</Field>
      {pool ? (
        <Field label={tr("Prefixes")} hint={tr("Use “Add prefixes” / “Remove prefixes” to change them.")}>
          {() => <p className="font-mono text-[13px]">{pool.prefixes.join(", ")}</p>}
        </Field>
      ) : (
        <Field label={tr("Prefixes")} hint={parsed.error ?? tr("One per line (or comma separated), all IPv4 or all IPv6. Neutron merges adjacent prefixes.")}>
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={prefixes}
              onChange={(e) => setPrefixes(e.target.value)}
              placeholder={"10.10.0.0/16\n10.20.0.0/16"}
              className={cn("font-mono text-[13px]", parsed.error && "border-led-red")}
            />
          )}
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={tr("Default prefix length")} hint={tr("Subnets that ask for no size get this.")}>
          {(id) => <Input id={id} type="number" min={0} max={width} value={def} onChange={(e) => setDef(e.target.value)} placeholder={String(eff.def)} />}
        </Field>
        <Field label={tr("Minimum")} hint={tr("Largest subnet allowed.")}>
          {(id) => <Input id={id} type="number" min={0} max={width} value={min} onChange={(e) => setMin(e.target.value)} placeholder={String(eff.min)} />}
        </Field>
        <Field label={tr("Maximum")} hint={tr("Smallest subnet allowed.")}>
          {(id) => <Input id={id} type="number" min={0} max={width} value={max} onChange={(e) => setMax(e.target.value)} placeholder={String(eff.max)} />}
        </Field>
      </div>
      {lenError && <p className="-mt-2 text-xs text-led-red">{lenError}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Per-project quota")} hint={version === 4 ? tr("IPv4 addresses each project may allocate. Empty = no limit.") : tr("/64 blocks each project may allocate. Empty = no limit.")}>
          {(id) => <Input id={id} type="number" min={0} value={quota} onChange={(e) => setQuota(e.target.value)} placeholder={tr("No limit")} />}
        </Field>
        <Field label={tr("Address scope")} hint={tr("Subnets in one scope are routed without NAT between them.")}>
          {(id) => (
            <Picker
              id={id}
              value={scope}
              onChange={setScope}
              loading={scopes.isPending}
              options={[
                { value: "", label: tr("No address scope") },
                ...scopeOptions.map((a) => ({ value: a.id, label: a.name || a.id, icon: "map-pin", description: a.shared ? tr("shared") : undefined })),
              ]}
            />
          )}
        </Field>
      </div>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      {session.is_admin && (
        <>
          {!pool && (
            <Field label={tr("Project")}>
              {(id) => (
                <Picker
                  id={id}
                  value={project}
                  onChange={setProject}
                  searchable
                  loading={projects.isPending}
                  options={[
                    { value: "", label: tr("{v} (current)", { v: session.project?.name ?? tr("Current project") }) },
                    ...(projects.data ?? []).filter((p) => p.id !== session.project?.id).map((p) => ({ value: p.id, label: p.name, icon: "folder" })),
                  ]}
                />
              )}
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {pool ? (
              <p className="text-sm text-muted">{pool.shared ? tr("Shared with every project (can't be changed).") : tr("Not shared. Share with chosen projects from the pool's Sharing tab.")}</p>
            ) : (
              <Switch checked={shared} onChange={setShared} label={tr("Shared")} hint={tr("Every project can allocate from it. Can't be undone later.")} />
            )}
            <Switch checked={isDefault} onChange={setDefault} label={tr("Default pool")} hint={tr("Used when a subnet asks for the default pool of its IP version. One per IP version.")} />
          </div>
        </>
      )}
    </ActionDialog>
  );
}

function PrefixesDialog({ pool, mode, prefixOps, onClose }: { pool: SubnetPool; mode: "add" | "remove"; prefixOps: boolean; onClose: () => void }) {
  const subnets = useSubnets({ subnetpool_id: pool.id });
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const parsed = parsePrefixes(text, pool.ip_version);
  const existing = pool.prefixes.map(parseCidr).filter((c): c is Cidr => !!c);
  const dup = parsed.list.find((c) => existing.some((e) => cidrOverlaps(e, c)));
  const usage = poolUsage(pool, subnets.data);
  const addError = parsed.error ?? (dup ? tr("{p} overlaps the pool's prefixes", { p: cidrText(dup) }) : parsed.list.length ? null : tr("Add at least one prefix"));
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={mode === "add" ? tr("Add prefixes to {name}", { name: pool.name || pool.id }) : tr("Remove prefixes from {name}", { name: pool.name || pool.id })}
      description={
        mode === "add"
          ? tr("New address space for the pool. Adjacent prefixes are merged by Neutron.")
          : tr("Only prefixes without allocated subnets can be removed.")
      }
      submitLabel={mode === "add" ? tr("Add prefixes") : tr("Remove prefixes")}
      danger={mode === "remove"}
      canSubmit={mode === "add" ? !addError : picked.length > 0}
      done={mode === "add" ? tr("Prefixes added") : tr("Prefixes removed")}
      refresh={["network"]}
      run={() => {
        if (mode === "remove") return os.put("network", `subnetpools/${pool.id}/remove_prefixes`, { prefixes: picked });
        const add = parsed.list.map(cidrText);
        return prefixOps
          ? os.put("network", `subnetpools/${pool.id}/add_prefixes`, { prefixes: add })
          : os.put("network", `subnetpools/${pool.id}`, { subnetpool: { prefixes: [...pool.prefixes, ...add] } });
      }}
    >
      {mode === "add" ? (
        <Field label={tr("Prefixes")} hint={parsed.error ?? (dup ? tr("{p} overlaps the pool's prefixes", { p: cidrText(dup) }) : tr("IPv{ip_version}, one per line.", { ip_version: pool.ip_version }))}>
          {(id) => (
            <Textarea
              id={id}
              autoFocus
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={pool.ip_version === 4 ? "10.30.0.0/16" : "2001:db8:200::/48"}
              className={cn("font-mono text-[13px]", (parsed.error || dup) && "border-led-red")}
            />
          )}
        </Field>
      ) : (
        <div className="space-y-2">
          {usage.prefixes.map((u) => (
            <Checkbox
              key={u.prefix}
              checked={picked.includes(u.prefix)}
              disabled={u.subnets.length > 0}
              onChange={(on) => setPicked((x) => (on ? [...x, u.prefix] : x.filter((y) => y !== u.prefix)))}
            >
              <span className="font-mono text-[13px]">{u.prefix}</span>
              <span className="ml-2 text-xs text-muted">{u.subnets.length ? tr("{n} subnet(s) allocated", { n: u.subnets.length }) : tr("free")}</span>
            </Checkbox>
          ))}
          {picked.length === pool.prefixes.length && <p className="text-xs text-led-red">{tr("A pool needs at least one prefix; Neutron will refuse to remove them all.")}</p>}
        </div>
      )}
    </ActionDialog>
  );
}

function OnboardDialog({ pool, onClose }: { pool: SubnetPool; onClose: () => void }) {
  const session = useSession().data!;
  const networks = useNetworks();
  const subnets = useSubnets();
  const [net, setNet] = useState("");
  const options = (networks.data ?? [])
    .filter((n) => !n["router:external"] && (session.is_admin || n.project_id === pool.project_id))
    .map((n) => {
      const own = (subnets.data ?? []).filter((s) => s.network_id === n.id && s.ip_version === pool.ip_version && s.subnetpool_id !== pool.id);
      return {
        value: n.id,
        label: n.name || n.id,
        icon: "network",
        description: own.length ? own.map((s) => s.cidr).join(", ") : tr("No IPv{ip_version} subnets to move", { ip_version: pool.ip_version }),
        disabled: own.length ? false : true,
      };
    });
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Onboard subnets into {name}", { name: pool.name || pool.id })}
      description={tr("Moves a network's existing IPv{ip_version} subnets into this pool without changing their addresses. Their CIDRs must fit in the pool's prefixes and not overlap subnets already allocated.", { ip_version: pool.ip_version })}
      submitLabel={tr("Onboard subnets")}
      canSubmit={!!net}
      done={tr("Subnets onboarded")}
      refresh={["network"]}
      run={() => os.put("network", `subnetpools/${pool.id}/onboard_network_subnets`, { network_id: net })}
    >
      <Field label={tr("Network")}>
        {(id) => <Picker id={id} value={net} onChange={setNet} searchable loading={networks.isPending} placeholder={tr("Choose a network")} options={options} />}
      </Field>
    </ActionDialog>
  );
}

// =========================================================================== address scopes

function AddressScopeList({ admin }: { admin: boolean }) {
  const session = useSession().data!;
  const scopes = useAddressScopes();
  const pools = useSubnetPools();
  const projectName = useProjectName();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "edit" | "share" | "delete"; a: AddressScope } | null>(null);
  const poolsIn = (a: AddressScope) => (pools.data ?? []).filter((p) => p.address_scope_id === a.id);
  const rows = admin ? scopes.data : scopes.data?.filter((a) => a.project_id === session.project?.id || a.shared || !session.is_admin);
  const columns: Column<AddressScope>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (a) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <span className="truncate font-medium">{a.name || a.id}</span>
          {a.shared && <Badge>{tr("shared")}</Badge>}
        </span>
      ),
      value: (a) => a.name,
    },
    ...(admin ? [{ key: "project", header: tr("Project"), width: "9rem", hideBelow: "md" as const, cell: (a: AddressScope) => projectName(a.project_id), value: (a: AddressScope) => projectName(a.project_id) }] : []),
    { key: "ver", header: tr("IP version"), width: "7rem", cell: (a) => tr("IPv{ip_version}", { ip_version: a.ip_version }), value: (a) => a.ip_version },
    {
      key: "pools",
      header: tr("Subnet pools"),
      hideBelow: "sm",
      cell: (a) => {
        const list = poolsIn(a);
        return list.length ? (
          <span className="truncate">
            {list.map((p, i) => (
              <span key={p.id}>
                {i > 0 && ", "}
                <Link to={`/network/subnet-pools/${p.id}`} className="text-cable hover:underline">
                  {p.name || p.id}
                </Link>
              </span>
            ))}
          </span>
        ) : (
          <span className="text-muted">{tr("none")}</span>
        );
      },
      value: (a) => poolsIn(a).map((p) => p.name).join(", "),
    },
    { key: "id", header: "ID", width: "18rem", hideBelow: "2xl", mono: true, cell: (a) => a.id, value: (a) => a.id },
  ];
  const owner = (a: AddressScope) => (mineOrAdmin(session, a.project_id) ? false : tr("Owned by another project"));
  return (
    <>
      <ErrorNotice error={scopes.error} className="mb-4" />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(a) => a.id}
        loading={scopes.isPending}
        tableId={admin ? "admin-address-scopes" : "address-scopes"}
        noun={tr("address scopes")}
        rowLabel={(a) => a.name || a.id}
        empty={tr("No address scopes. Subnets of pools in the same scope are routed without NAT; without a scope, routers NAT to external networks as usual.")}
        onRefresh={() => scopes.refetch()}
        refreshing={scopes.isFetching}
        onBulkDone={() => invalidate("network")}
        rowActions={(a) => [
          { label: tr("Edit address scope"), icon: "edit", disabled: owner(a), onSelect: () => setOpen({ kind: "edit", a }) },
          { label: tr("Share with a project"), icon: "share", disabled: owner(a), onSelect: () => setOpen({ kind: "share", a }) },
          "-",
          { label: tr("Delete address scope"), icon: "trash", danger: true, disabled: owner(a) || (poolsIn(a).length ? tr("Used by {n} subnet pool(s)", { n: poolsIn(a).length }) : false), onSelect: () => setOpen({ kind: "delete", a }) },
        ]}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete address scopes?"),
            past: tr("deleted"),
            body: tr("Neutron refuses while subnet pools still belong to a scope."),
            check: (a) => (owner(a) || (poolsIn(a).length ? tr("Used by {n} subnet pool(s)", { n: poolsIn(a).length }) : true)),
            run: (a) => os.del("network", `address-scopes/${a.id}`),
          },
        ]}
      />
      {open?.kind === "edit" && <AddressScopeDialog scope={open.a} onClose={() => setOpen(null)} />}
      {open?.kind === "share" && <ShareDialog onClose={() => setOpen(null)} object={{ type: "address_scope", id: open.a.id, name: open.a.name || open.a.id }} />}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={() => setOpen(null)}
          danger
          title={tr("Delete address scope {name}?", { name: open.a.name || open.a.id })}
          submitLabel={tr("Delete address scope")}
          done={tr("Address scope deleted")}
          refresh={["network"]}
          run={() => os.del("network", `address-scopes/${open.a.id}`)}
        >
          <p className="text-sm">{tr("Routers stop treating its subnets as one routing domain.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function AddressScopeDialog({ scope, onClose }: { scope?: AddressScope; onClose: () => void }) {
  const session = useSession().data!;
  const [name, setName] = useState(scope?.name ?? "");
  const [version, setVersion] = useState<"4" | "6">(scope ? (String(scope.ip_version) as "4" | "6") : "4");
  const [shared, setShared] = useState(scope?.shared ?? false);
  return (
    <ActionDialog
      onClose={onClose}
      title={scope ? tr("Edit {name}", { name: scope.name || scope.id }) : tr("Create address scope")}
      description={tr("A routing domain: Neutron routers forward between subnets of pools in the same scope without NAT, and never route between different scopes.")}
      submitLabel={scope ? tr("Save") : tr("Create address scope")}
      canSubmit={!!name.trim()}
      done={scope ? tr("Address scope updated") : tr("Address scope {name} created", { name })}
      refresh={["network"]}
      run={() => {
        const body: Record<string, unknown> = { name: name.trim(), ...(session.is_admin && (!scope || (!scope.shared && shared)) ? { shared } : {}) };
        if (!scope) body.ip_version = Number(version);
        return scope ? os.put("network", `address-scopes/${scope.id}`, { address_scope: body }) : os.post("network", "address-scopes", { address_scope: body });
      }}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("corp-v4")} />}</Field>
      {!scope && (
        <Field label={tr("IP version")}>
          {(id) => (
            <Picker
              id={id}
              value={version}
              onChange={(v) => setVersion(v as "4" | "6")}
              options={[
                { value: "4", label: "IPv4" },
                { value: "6", label: "IPv6" },
              ]}
            />
          )}
        </Field>
      )}
      {session.is_admin && (
        <Switch
          checked={shared}
          onChange={setShared}
          disabled={scope?.shared}
          label={tr("Shared")}
          hint={scope?.shared ? tr("Already shared with every project (can't be undone).") : tr("Every project can put its subnet pools in this scope.")}
        />
      )}
    </ActionDialog>
  );
}

// =========================================================================== detail

const TABS = ["overview", "subnets", "sharing"] as const;

export function SubnetPoolDetail({ admin = false }: { admin?: boolean }) {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const session = useSession().data!;
  const pool = useOsGet<SubnetPool>("network", `subnetpools/${id}`, (r: { subnetpool: SubnetPool }) => r.subnetpool);
  const subnets = useSubnets({ subnetpool_id: id });
  const networks = useNetworks();
  const scopes = useAddressScopes();
  const projectName = useProjectName();
  const back = `${admin ? "/admin" : ""}/network/subnet-pools`;
  const actions = useSubnetPoolActions({ onDeleted: () => navigate(back) });
  const [tab, setTab] = useTab(TABS, "overview");
  const [creating, setCreating] = useState(false);
  const p = pool.data;
  const list = (subnets.data ?? []).filter((s) => s.subnetpool_id === id);
  const usage = p ? poolUsage(p, list) : null;
  const netName = (nid: string) => networks.data?.find((n) => n.id === nid)?.name || nid.slice(0, 8);
  const scope = p?.address_scope_id ? scopes.data?.find((a) => a.id === p.address_scope_id) : undefined;

  const subnetCols: Column<Subnet>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (s) => (
        <Link to={`/network/networks/${s.network_id}?tab=subnets`} className="font-medium text-cable hover:underline">
          {s.name || s.id.slice(0, 13)}
        </Link>
      ),
      value: (s) => s.name,
    },
    { key: "cidr", header: tr("Network address"), width: "13rem", mono: true, cell: (s) => s.cidr, value: (s) => s.cidr },
    {
      key: "size",
      header: tr("Size"),
      width: "10rem",
      hideBelow: "md",
      cell: (s) => {
        const c = parseCidr(s.cidr);
        return c ? sizeText(cidrSize(c), c.version) : "";
      },
      value: (s) => parseCidr(s.cidr)?.len ?? 0,
    },
    { key: "network", header: tr("Network"), hideBelow: "sm", cell: (s) => netName(s.network_id), value: (s) => netName(s.network_id) },
    ...(session.is_admin ? [{ key: "project", header: tr("Project"), width: "9rem", hideBelow: "lg" as const, cell: (s: Subnet) => projectName(s.project_id ?? ""), value: (s: Subnet) => projectName(s.project_id ?? "") }] : []),
  ];

  return (
    <>
      <Link to={back} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Subnet pools")}
      </Link>
      <PageHeader
        title={p?.name || tr("Subnet pool")}
        description={p ? p.description || p.prefixes.join(", ") : undefined}
        actions={p && <ActionMenu variant="button" items={() => actions.items(p, "detail")} />}
      />
      <ErrorNotice error={pool.error} className="mb-4" />
      {p && usage && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "subnets", label: tr("Subnets ({length})", { length: list.length }) },
              { id: "sharing", label: tr("Sharing") },
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <Card title={tr("Details")}>
                <dl>
                  <Detail label={tr("Name")}>{p.name}</Detail>
                  <Detail label="ID">
                    <Mono>{p.id}</Mono>
                  </Detail>
                  <Detail label={tr("Project")}>{projectName(p.project_id)}</Detail>
                  <Detail label={tr("IP version")}>{tr("IPv{ip_version}", { ip_version: p.ip_version })}</Detail>
                  <Detail label={tr("Prefix length")}>{trx("default /{def}, from /{min} to /{max}", { def: plen(p.default_prefixlen), min: plen(p.min_prefixlen), max: plen(p.max_prefixlen) })}</Detail>
                  <Detail label={tr("Per-project quota")}>
                    {p.default_quota == null ? tr("No limit") : p.ip_version === 4 ? tr("{n} addresses", { n: p.default_quota.toLocaleString() }) : tr("{n} × /64", { n: p.default_quota.toLocaleString() })}
                  </Detail>
                  <Detail label={tr("Address scope")}>{p.address_scope_id ? (scope?.name ?? <Mono>{p.address_scope_id}</Mono>) : tr("None")}</Detail>
                  <Detail label={tr("Shared")}>{p.shared ? tr("Yes, with every project") : tr("No")}</Detail>
                  <Detail label={tr("Default pool")}>{p.is_default ? tr("Yes, for IPv{ip_version}", { ip_version: p.ip_version }) : tr("No")}</Detail>
                  {p.created_at && <Detail label={tr("Created")}>{fmtDate(p.created_at)}</Detail>}
                  {p.updated_at && <Detail label={tr("Updated")}>{fmtDate(p.updated_at)}</Detail>}
                </dl>
              </Card>
              <Card
                title={tr("Allocation")}
                actions={
                  <span className="text-xs text-muted">
                    {tr("{pct}% of {total}", { pct: usage.pct, total: sizeText(usage.total, p.ip_version) })}
                  </span>
                }
              >
                <ul className="space-y-4">
                  {usage.prefixes.map((u) => {
                    const pct = pctOf(u.used, u.total);
                    return (
                      <li key={u.prefix}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="font-mono text-[13px]">{u.prefix}</span>
                          <span className="text-xs text-muted tabular-nums">
                            {tr("{n} subnet(s)", { n: u.subnets.length })} · {pct}%
                          </span>
                        </div>
                        <UsageBar pct={pct} className="mt-1.5" />
                        <p className="mt-1 text-xs text-muted">{ofText(u.used, u.total, p.ip_version)}</p>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-4 text-xs text-muted">{tr("Counted from the subnets you can see; other projects' allocations count only for admins.")}</p>
              </Card>
            </div>
          )}
          {tab === "subnets" && (
            <DataTable
              rows={subnets.isPending ? undefined : list}
              columns={subnetCols}
              rowKey={(s) => s.id}
              loading={subnets.isPending}
              tableId="subnet-pool-subnets"
              noun={tr("subnets")}
              rowLabel={(s) => s.name || s.cidr}
              empty={tr("No subnets allocated from this pool yet.")}
              onRefresh={() => subnets.refetch()}
              refreshing={subnets.isFetching}
              toolbar={
                <Button className="h-9" onClick={() => setCreating(true)}>
                  <Icon name="plus" />
                  {tr("Create subnet from pool")}
                </Button>
              }
            />
          )}
          {tab === "sharing" && (
            <ObjectSharing
              type="subnetpool"
              object={p}
              notShared={p.shared ? tr("Shared with every project (the pool's shared flag).") : tr("Not shared. Only this project can allocate from the pool.")}
              notYours={tr("Not your subnet pool")}
              idLabel={tr("Subnet pool ID")}
            />
          )}
        </>
      )}
      {creating && p && <SubnetDialog poolId={p.id} onClose={() => setCreating(false)} />}
      {actions.dialogs}
    </>
  );
}
