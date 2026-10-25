import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { type Column, DataTable } from "@/components/DataTable";
import { Link, useNavigate } from "@/components/Link";
import { Badge, ErrorNotice, Icon, PageHeader, StatusDot } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { runActive, useRuns } from "@/lib/drain";
import { limiter } from "@/lib/limiter";
import { gib, os } from "@/lib/os";
import { cn } from "@/lib/utils";
import { tr } from "@/lib/i18n";
import { type ComputeService, useComputeServices } from "./ComputeAdmin";
import { EndDialog, StartDialog, hostPath, hostServers, hostState, isDown } from "./hostMaintenance";
import { RunBadge } from "./runBadge";

export interface Inventory {
  total: number;
  reserved: number;
  allocation_ratio: number;
  min_unit?: number;
  max_unit?: number;
}
export interface Provider {
  uuid: string;
  name: string;
  parent_provider_uuid?: string | null;
  root_provider_uuid?: string;
  inventories: Record<string, Inventory> | null;
  usages: Record<string, number> | null;
}

export const useCapacity = (enabled = true) =>
  useQuery({
    queryKey: ["os", "placement", "capacity"],
    queryFn: () => api.get<{ resource_providers: Provider[] }>("/placement/capacity").then((r) => r.resource_providers),
    enabled,
  });

/** Schedulable capacity of a resource class: (total − reserved) × allocation ratio. */
export function cap(inv?: Inventory) {
  return inv ? Math.floor((inv.total - inv.reserved) * inv.allocation_ratio) : 0;
}

export function totals(list: Provider[] | undefined) {
  const t: Record<string, { used: number; cap: number }> = {};
  for (const p of list ?? []) {
    for (const [rc, inv] of Object.entries(p.inventories ?? {})) {
      t[rc] ??= { used: 0, cap: 0 };
      t[rc].cap += cap(inv);
      t[rc].used += p.usages?.[rc] ?? 0;
    }
  }
  return t;
}

const fmt = (rc: string, n: number) => (rc === "MEMORY_MB" ? gib(n) : rc === "DISK_GB" ? `${n} GB` : String(n));

/** Compact usage bar for one resource class. */
export function Meter({ rc, used, capacity, className }: { rc: string; used: number; capacity: number; className?: string }) {
  const pct = capacity ? Math.min(100, Math.round((used / capacity) * 100)) : 0;
  return (
    <div className={cn("min-w-0", className)} title={tr("{rc}: {fmt} of {fmt2} ({pct}%)", { rc, fmt: fmt(rc, used), fmt2: fmt(rc, capacity), pct })}>
      <div className="flex justify-between gap-2 text-xs">
        <span className="truncate text-muted">{fmt(rc, used)}</span>
        <span className="shrink-0 text-muted tabular-nums">{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink/8">
        <div className={cn("h-full rounded-full", pct >= 90 ? "bg-led-red" : pct >= 75 ? "bg-led-amber" : "bg-cable")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

interface HypervisorSummary {
  id: string | number;
  hypervisor_hostname: string;
  state: "up" | "down";
  status: "enabled" | "disabled";
}
interface Hypervisor extends HypervisorSummary {
  hypervisor_type?: string;
  host_ip?: string;
  service?: { host: string; disabled_reason?: string | null };
}
type Usage = Pick<Provider, "inventories" | "usages">;
type Part<T> = { data?: T; error?: unknown; pending: boolean };
type Row = HypervisorSummary & { detail: Part<Hypervisor>; usage: Part<Usage | null> };

/**
 * Shared by every per-hypervisor call so a big cloud doesn't open hundreds of requests at
 * once. Priority = row position, so a row's detail and usage run together, top rows first.
 */
const slot = limiter(6);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const byHost = (a: HypervisorSummary, b: HypervisorSummary) => a.hypervisor_hostname.localeCompare(b.hypervisor_hostname, undefined, { numeric: true });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The hypervisor of a compute host (service host name, which may differ from the hypervisor
 * hostname, e.g. "cmp-01" vs "cmp-01.example.com") and its Placement usage. Asks Nova for
 * hostnames containing the host (2.53+ `hypervisor_hostname_pattern`), then picks the one
 * whose service host matches.
 */
export function useHostHypervisor(host: string) {
  return useQuery({
    queryKey: ["os", "compute", "os-hypervisors", "of-host", host],
    enabled: !!host,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const cands = await os
        .get<{ hypervisors: HypervisorSummary[] }>("compute", "os-hypervisors", { hypervisor_hostname_pattern: host }, { signal })
        .then((r) => r.hypervisors)
        .catch((e) => {
          if (e instanceof ApiError && e.status === 404) return [] as HypervisorSummary[]; // no match
          throw e;
        });
      let hv: Hypervisor | null = null;
      for (const c of cands.slice(0, 5)) {
        const d = await os.get<{ hypervisor: Hypervisor }>("compute", `os-hypervisors/${c.id}`, undefined, { signal }).then((r) => r.hypervisor);
        if ((d.service?.host ?? d.hypervisor_hostname) === host) {
          hv = d;
          break;
        }
      }
      if (!hv) return null;
      let usage: Usage | null = null;
      if (UUID.test(String(hv.id))) {
        const path = `resource_providers/${hv.id}`;
        try {
          const [i, u] = await Promise.all([
            os.get<{ inventories: Usage["inventories"] }>("placement", `${path}/inventories`, undefined, { signal }),
            os.get<{ usages: Usage["usages"] }>("placement", `${path}/usages`, undefined, { signal }),
          ]);
          usage = { inventories: i.inventories, usages: u.usages };
        } catch {
          /* not in Placement (yet): no meters */
        }
      }
      return { hypervisor: hv, usage };
    },
  });
}

/** One host's capacity meters and hypervisor (host page under Hypervisors). */
export function HostCapacity({ host, className }: { host: string; className?: string }) {
  const q = useHostHypervisor(host);
  if (q.isError) return null;
  const u = q.data?.usage;
  const meter = (rc: string, label: string) => {
    const inv = u?.inventories?.[rc];
    return (
      <div className="w-40 min-w-0">
        <p className="mb-0.5 text-xs font-medium text-muted">{label}</p>
        {q.isPending ? <Pending /> : inv ? <Meter rc={rc} used={u?.usages?.[rc] ?? 0} capacity={cap(inv)} /> : <span className="text-xs text-muted">—</span>}
      </div>
    );
  };
  if (!q.isPending && !q.data) return null;
  return (
    <div className={cn("flex flex-wrap items-end gap-x-6 gap-y-3 rounded-lg border border-line bg-panel px-4 py-3", className)}>
      {meter("VCPU", tr("vCPUs"))}
      {meter("MEMORY_MB", "RAM")}
      {meter("DISK_GB", tr("Disk"))}
      {q.data && (
        <p className="ml-auto inline-flex min-w-0 items-center gap-1.5 text-sm text-muted">
          <Icon name="cpu" className="size-4 shrink-0" />
          <span className="truncate">{[q.data.hypervisor.hypervisor_hostname, q.data.hypervisor.hypervisor_type, q.data.hypervisor.host_ip].filter(Boolean).join(" · ")}</span>
        </p>
      )}
    </div>
  );
}

function Pending() {
  return <span className="block h-3 w-16 max-w-full animate-pulse rounded bg-ink/8" aria-label={tr("Loading…")} />;
}

/**
 * Hypervisors of the cloud. The light `os-hypervisors` list is shown at once; then each
 * hypervisor's detail (and its Placement usage) is fetched on its own, a few at a time,
 * and every row fills in as soon as its own calls return.
 */
export function Hypervisors() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const runs = useRuns();
  // nova-compute services: maintenance state, reason and the id to enable / disable.
  const services = useComputeServices({ binary: "nova-compute" });
  const svcOf = useMemo(() => {
    const m = new Map(services.data?.map((s) => [s.host, s]));
    return (host?: string) => (host ? m.get(host) : undefined);
  }, [services.data]);
  const counts = useQueries({
    queries: (services.data ?? []).map((s) => ({
      queryKey: ["os", "compute", "servers", "on-host", s.host],
      queryFn: ({ signal }: { signal: AbortSignal }) => hostServers(s.host, signal).then((l) => l.length),
      staleTime: 15_000,
      retry: false,
    })),
  });
  const countOf = new Map((services.data ?? []).map((s, i) => [s.host, counts[i]]));
  const [open, setOpen] = useState<{ kind: "start" | "end"; s: ComputeService } | null>(null);
  // ?host=<compute host>: only that host's hypervisor(s).
  const [params, setParams] = useSearchParams();
  const only = params.get("host") ?? "";
  const list = useQuery({
    queryKey: ["os", "compute", "os-hypervisors", "list"],
    queryFn: () => os.list<HypervisorSummary>("compute", "os-hypervisors", "hypervisors").then((l) => l.sort(byHost)),
  });
  const hosts = list.data ?? [];
  // Nova ≥ 2.53 uses the compute node UUID as hypervisor id, and that is also the node's
  // Placement resource provider: each row can fetch its own usage. Older clouds (integer
  // ids) fall back to matching the full provider list by name.
  const perRow = hosts.length > 0 && hosts.every((h) => UUID.test(String(h.id)));
  const details = useQueries({
    queries: hosts.map((h, i) => ({
      queryKey: ["os", "compute", "os-hypervisors", "item", String(h.id)],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        slot(() => os.get<{ hypervisor: Hypervisor }>("compute", `os-hypervisors/${h.id}`, undefined, { signal }).then((r) => r.hypervisor), { signal, priority: i }),
      retry: false,
      staleTime: 30_000,
    })),
  });
  const usages = useQueries({
    queries: (perRow ? hosts : []).map((h, i) => ({
      queryKey: ["os", "placement", "provider-usage", String(h.id)],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        slot(async (): Promise<Usage | null> => {
          const path = `resource_providers/${h.id}`;
          try {
            const [i, u] = await Promise.all([
              os.get<{ inventories: Usage["inventories"] }>("placement", `${path}/inventories`, undefined, { signal }),
              os.get<{ usages: Usage["usages"] }>("placement", `${path}/usages`, undefined, { signal }),
            ]);
            return { inventories: i.inventories, usages: u.usages };
          } catch (e) {
            if (e instanceof ApiError && e.status === 404) return null; // not (yet) in Placement
            throw e;
          }
        }, { signal, priority: i }),
      retry: false,
      staleTime: 30_000,
    })),
  });
  const capacity = useCapacity(list.isSuccess && hosts.length > 0 && !perRow);
  const byName = useMemo(() => new Map(capacity.data?.map((p) => [p.name, p])), [capacity.data]);

  const rows: Row[] = hosts.map((h, i) => {
    const d = details[i];
    const u = perRow ? usages[i] : undefined;
    return {
      ...h,
      ...(d?.data ? { state: d.data.state, status: d.data.status } : {}),
      detail: { data: d?.data, error: d?.error ?? undefined, pending: !d || d.isPending },
      usage: perRow
        ? { data: u?.data, error: u?.error ?? undefined, pending: !u || u.isPending }
        : { data: byName.get(h.hypervisor_hostname) ?? null, error: capacity.error ?? undefined, pending: capacity.isPending },
    };
  });
  /** The nova-compute host of a row (known once its detail has loaded). */
  const hostOf = (r: Row) => r.detail.data?.service?.host;
  const shown = only ? rows.filter((r) => hostOf(r) === only || r.hypervisor_hostname === only || r.hypervisor_hostname.startsWith(`${only}.`)) : rows;
  const loaded = rows.filter((r) => !r.detail.pending && !r.usage.pending).length;
  const inMaint = (services.data ?? []).filter((s) => s.status === "disabled").length;
  const failed = rows.filter((r) => r.detail.error || r.usage.error).length;
  const busy = list.isFetching || details.some((d) => d.isFetching) || usages.some((u) => u.isFetching) || capacity.isFetching;

  const meter = (rc: string) => (r: Row) => {
    if (r.usage.pending) return <Pending />;
    if (r.usage.error) return <span className="text-xs text-muted" title={errText(r.usage.error)}>—</span>;
    const inv = r.usage.data?.inventories?.[rc];
    return inv ? <Meter rc={rc} used={r.usage.data?.usages?.[rc] ?? 0} capacity={cap(inv)} /> : <span className="text-xs text-muted">—</span>;
  };
  const usedPct = (rc: string) => (r: Row) => {
    const c = cap(r.usage.data?.inventories?.[rc]);
    return c ? (r.usage.data?.usages?.[rc] ?? 0) / c : -1;
  };
  const fromDetail = (get: (h: Hypervisor) => string | undefined, mono?: boolean) => (r: Row) =>
    r.detail.pending ? <Pending /> : r.detail.error ? <span className="text-xs text-muted" title={errText(r.detail.error)}>—</span> : <span className={mono ? "font-mono" : undefined}>{get(r.detail.data!) ?? ""}</span>;

  const columns: Column<Row>[] = [
    {
      key: "host",
      header: tr("Host"),
      cell: (r) => {
        const host = hostOf(r);
        const svc = svcOf(host);
        return (
          <div className="min-w-0">
            {host ? (
              <Link to={hostPath(host)} className="block truncate font-medium text-cable hover:underline" title={String(r.id)}>
                {r.hypervisor_hostname}
              </Link>
            ) : (
              <p className="truncate font-medium" title={String(r.id)}>
                {r.hypervisor_hostname}
              </p>
            )}
            {(host && host !== r.hypervisor_hostname) || svc?.zone ? (
              <p className="truncate text-xs text-muted">{[host !== r.hypervisor_hostname ? host : "", svc?.zone].filter(Boolean).join(" · ")}</p>
            ) : null}
          </div>
        );
      },
      value: (r) => r.hypervisor_hostname,
    },
    {
      key: "state",
      header: tr("State"),
      width: "11rem",
      wrap: true,
      cell: (r) => {
        const host = hostOf(r);
        const svc = svcOf(host);
        // The compute service knows more (forced down, maintenance); the hypervisor alone until it loads.
        const st = svc ? hostState(svc) : { status: r.state === "up" ? (r.status === "enabled" ? "ok" : "warn") : "error", label: r.status === "disabled" ? `${r.state}, ${tr("disabled")}` : r.state };
        const reason = svc?.disabled_reason ?? r.detail.data?.service?.disabled_reason;
        return (
          <span className="flex min-w-0 flex-col gap-1">
            <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
              <StatusDot status={st.status as "ok" | "warn" | "error"} label={st.label} />
              {host && runs.get(host) && (
                <Link to={hostPath(host)}>
                  <RunBadge run={runs.get(host)} />
                </Link>
              )}
            </span>
            {r.status === "disabled" && reason && (
              <span className="truncate text-xs text-muted" title={reason}>
                {reason}
              </span>
            )}
          </span>
        );
      },
      value: (r) => `${svcOf(hostOf(r)) ? hostState(svcOf(hostOf(r))!).label : r.state} ${r.status}`,
    },
    {
      key: "instances",
      header: tr("Instances"),
      width: "6.5rem",
      cell: (r) => {
        const q = countOf.get(hostOf(r) ?? "");
        if (!q) return r.detail.pending ? <Pending /> : <span className="text-xs text-muted">—</span>;
        if (q.isPending) return <Pending />;
        if (q.isError) return <span className="text-xs text-led-red" title={errText(q.error)}>!</span>;
        return <span className="tabular-nums">{q.data}</span>;
      },
      value: (r) => countOf.get(hostOf(r) ?? "")?.data ?? -1,
    },
    { key: "type", header: tr("Type"), width: "6.5rem", hideBelow: "xl", cell: fromDetail((h) => h.hypervisor_type), value: (r) => r.detail.data?.hypervisor_type ?? "" },
    { key: "ip", header: "IP", width: "8.5rem", hideBelow: "lg", cell: fromDetail((h) => h.host_ip, true), value: (r) => r.detail.data?.host_ip ?? "" },
    { key: "vcpu", header: tr("vCPUs"), width: "9rem", wrap: true, cell: meter("VCPU"), value: usedPct("VCPU") },
    { key: "ram", header: "RAM", width: "9rem", wrap: true, hideBelow: "sm", cell: meter("MEMORY_MB"), value: usedPct("MEMORY_MB") },
    { key: "disk", header: tr("Disk"), width: "9rem", wrap: true, hideBelow: "md", cell: meter("DISK_GB"), value: usedPct("DISK_GB") },
  ];

  const retryFailed = () =>
    qc.refetchQueries({
      predicate: (q) => q.state.status === "error" && ((q.queryKey[2] === "os-hypervisors" && q.queryKey[3] === "item") || q.queryKey[2] === "provider-usage"),
    });

  return (
    <>
      <PageHeader
        title={tr("Hypervisors")}
        description={
          inMaint
            ? tr("Compute hosts with their allocated capacity from Placement. {n} host(s) in maintenance; open a host to drain it or see what still runs there.", { n: inMaint })
            : tr("Compute hosts with their allocated capacity from Placement (after allocation ratios). Start maintenance on a host to stop new instances landing on it, drain or evacuate it, then end maintenance when it's back.")
        }
      />
      {only && (
        <div className="mb-3 flex items-center gap-2 text-sm text-muted">
          {tr("Showing one host:")}
          <Badge tone="accent" onRemove={() => setParams({}, { replace: true })} removeLabel={tr("Show all hosts")}>
            {only}
          </Badge>
        </div>
      )}
      <ErrorNotice error={list.error ?? services.error} className="mb-4" />
      {hosts.length > 0 && (loaded < rows.length || failed > 0) && (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          {loaded < rows.length && (
            <span className="inline-flex items-center gap-2">
              <span className="relative h-1.5 w-28 overflow-hidden rounded-full bg-ink/8">
                <span className="absolute inset-y-0 left-0 rounded-full bg-cable transition-[width]" style={{ width: `${Math.round((loaded / rows.length) * 100)}%` }} />
              </span>
              {tr("Loading details: {n} of {total}", { n: loaded, total: rows.length })}
            </span>
          )}
          {failed > 0 && (
            <span className="inline-flex items-center gap-2 text-led-red">
              {tr("{n} host(s) failed to load (hover “—” for the error)", { n: failed })}
              <button type="button" onClick={retryFailed} className="text-cable hover:underline">
                {tr("Retry")}
              </button>
            </span>
          )}
        </div>
      )}
      <DataTable
        rows={list.data ? shown : undefined}
        columns={columns}
        rowKey={(r) => String(r.id)}
        loading={list.isPending}
        tableId="admin-hypervisors"
        filterPlaceholder={tr("Filter by host or IP")}
        onRefresh={() => {
          qc.invalidateQueries({ queryKey: ["os", "compute", "os-hypervisors"] });
          qc.invalidateQueries({ queryKey: ["os", "placement"] });
          services.refetch();
          for (const c of counts) c.refetch();
        }}
        refreshing={busy}
        rowActions={(r) => {
          const host = hostOf(r);
          const svc = svcOf(host);
          const wait = host && svc ? false : r.detail.pending || services.isPending ? tr("Loading…") : tr("No compute service on this hypervisor");
          const down = svc ? isDown(svc) : r.state === "down";
          return [
            { label: tr("Open host"), icon: "external-link", disabled: wait, onSelect: () => host && navigate(hostPath(host)) },
            { heading: tr("Maintenance") },
            svc?.status === "disabled" || svc?.forced_down
              ? { label: tr("End maintenance"), icon: "play", disabled: wait, onSelect: () => svc && setOpen({ kind: "end", s: svc }) }
              : { label: tr("Start maintenance"), icon: "wrench", disabled: wait, onSelect: () => svc && setOpen({ kind: "start", s: svc }) },
            !down && { label: tr("Drain host"), icon: "arrow-right-left", disabled: wait, onSelect: () => host && navigate(hostPath(host, "drain")) },
            down && { label: tr("Evacuate host"), icon: "life-buoy", disabled: wait, onSelect: () => host && navigate(hostPath(host, "evacuate")) },
          ];
        }}
      />
      {open?.kind === "start" && <StartDialog s={open.s} onClose={() => setOpen(null)} />}
      {open?.kind === "end" && <EndDialog s={open.s} busy={runActive(runs.get(open.s.host))} onClose={() => setOpen(null)} />}
    </>
  );
}
