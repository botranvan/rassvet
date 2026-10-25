/**
 * Admin: object storage cluster information (Swift/RGW `/info`) and every project's
 * account usage and quota. Accounts are read one project at a time (a few in parallel),
 * so rows fill in as they arrive; reading and setting other projects' accounts needs the
 * ResellerAdmin role in Swift (RGW: an admin with the right caps).
 */
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { CodeBlock } from "@/components/CodeBlock";
import { type Column, DataTable } from "@/components/DataTable";
import { Badge, Card, Detail, ErrorNotice, Field, Input, Mono, PageHeader, Tabs } from "@/components/ui";
import { useProjects } from "@/lib/identity";
import { fmtBytes } from "@/lib/format";
import { limiter } from "@/lib/limiter";
import { type AccountStats, swift, useSwiftInfo } from "@/lib/swift";
import { useTab } from "@/lib/useTab";
import { cn } from "@/lib/utils";
import { tr } from "@/lib/i18n";
import { UsageStats, useRefreshSwift } from "@/pages/objectstore/Containers";

const TABS = ["cluster", "accounts"] as const;
const slot = limiter(6);
const GiB = 1024 ** 3;

export default function ObjectStorageAdmin() {
  const [tab, setTab] = useTab(TABS, "cluster");
  const info = useSwiftInfo();
  return (
    <>
      <PageHeader
        title={tr("Object storage")}
        description={tr("The object storage cluster behind the Swift API (OpenStack Swift or Ceph RGW): its features and limits, and how much each project stores.")}
      />
      <ErrorNotice error={info.error} className="mb-4" />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { id: "cluster", label: tr("Cluster") },
          { id: "accounts", label: tr("Project accounts") },
        ]}
      />
      {tab === "cluster" ? <Cluster /> : <Accounts />}
    </>
  );
}

function Cluster() {
  const info = useSwiftInfo();
  const caps = info.data?.capabilities;
  const sw = caps?.swift;
  const middleware = Object.keys(caps ?? {})
    .filter((k) => k !== "swift" && !k.startsWith("admin"))
    .sort();
  const limits: [string, unknown][] = sw
    ? (
        [
          [tr("Max object size"), typeof sw.max_file_size === "number" ? fmtBytes(sw.max_file_size) : undefined],
          [tr("Max name length"), sw.max_object_name_length],
          [tr("Listing limit"), sw.container_listing_limit],
          [tr("Max metadata items"), (sw as Record<string, unknown>).max_meta_count],
          [tr("Max header size"), (sw as Record<string, unknown>).max_header_size],
        ] as [string, unknown][]
      ).filter(([, v]) => v != null)
    : [];
  return (
    <>
      <UsageStats info={info.data} />
      {info.isPending && <p className="text-sm text-muted">{tr("Loading…")}</p>}
      {info.data && !caps && <p className="mb-4 rounded-md border border-line bg-panel px-4 py-3 text-sm text-muted">{tr("The cluster doesn't publish /info, so its features and limits are unknown.")}</p>}
      {caps && (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Card title={tr("Cluster")}>
            <dl>
              <Detail label={tr("Endpoint")}>
                <Mono className="break-all">{info.data?.endpoint}</Mono>
              </Detail>
              {sw?.version && <Detail label={tr("Version")}>{sw.version}</Detail>}
              {limits.map(([k, v]) => (
                <Detail key={k} label={k}>
                  {typeof v === "number" ? v.toLocaleString() : String(v)}
                </Detail>
              ))}
            </dl>
          </Card>
          <Card title={tr("Storage policies")}>
            {sw?.policies?.length ? (
              <ul className="space-y-2 text-sm">
                {sw.policies.map((p) => (
                  <li key={p.name} className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    {p.default && <Badge tone="accent">{tr("default")}</Badge>}
                    {p.aliases && p.aliases !== p.name && <span className="text-xs text-muted">{p.aliases}</span>}
                    {info.data?.account.bytes_by_policy[p.name.toLowerCase()] != null && (
                      <span className="ml-auto text-xs text-muted">{tr("{size} used by this project", { size: fmtBytes(info.data.account.bytes_by_policy[p.name.toLowerCase()]) ?? "" })}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">{tr("One policy (not listed by the cluster).")}</p>
            )}
          </Card>
          <Card title={tr("Middleware and features")} className="lg:col-span-2">
            <div className="flex flex-wrap gap-1.5">
              {middleware.map((m) => (
                <Badge key={m}>{m}</Badge>
              ))}
            </div>
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-muted hover:text-ink">{tr("Raw /info")}</summary>
              <div className="mt-2">
                <CodeBlock code={JSON.stringify(caps, null, 2)} filename="info.json" />
              </div>
            </details>
          </Card>
        </div>
      )}
    </>
  );
}

interface Row {
  id: string;
  name: string;
  state: "pending" | "ok" | "none" | "error";
  account?: AccountStats | null;
  error?: string;
}

function Pending() {
  return <span className="block h-3 w-16 max-w-full animate-pulse rounded bg-ink/8" />;
}

function Accounts() {
  const projects = useProjects();
  const refresh = useRefreshSwift();
  const [editing, setEditing] = useState<Row | null>(null);
  const list = projects.data ?? [];
  const accounts = useQueries({
    queries: list.map((p, i) => ({
      queryKey: ["object-store", "account", p.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => slot(() => swift.account(p.id), { signal, priority: i }),
      retry: false,
      staleTime: 60_000,
    })),
  });
  const rows: Row[] = list.map((p, i) => {
    const q = accounts[i];
    if (!q || q.isPending) return { id: p.id, name: p.name, state: "pending" };
    if (q.error) return { id: p.id, name: p.name, state: "error", error: q.error instanceof Error ? q.error.message : String(q.error) };
    return { id: p.id, name: p.name, state: q.data?.account ? "ok" : "none", account: q.data?.account };
  });
  const errors = rows.filter((r) => r.state === "error");
  const loaded = rows.filter((r) => r.state !== "pending").length;
  const stat = (get: (a: AccountStats) => number | null, fmt: (n: number) => string) => (r: Row) =>
    r.state === "pending" ? <Pending /> : r.state === "error" ? <span className="text-muted" title={r.error}>—</span> : r.account ? fmt(get(r.account) ?? 0) : <span className="text-muted">0</span>;
  const columns: Column<Row>[] = [
    { key: "name", header: tr("Project"), cell: (r) => <span className="font-medium">{r.name}</span>, value: (r) => r.name },
    { key: "containers", header: tr("Containers"), width: "8rem", cell: stat((a) => a.containers, (n) => n.toLocaleString()), value: (r) => r.account?.containers ?? -1 },
    { key: "objects", header: tr("Objects"), width: "8rem", cell: stat((a) => a.objects, (n) => n.toLocaleString()), value: (r) => r.account?.objects ?? -1 },
    { key: "bytes", header: tr("Used"), width: "8rem", cell: stat((a) => a.bytes, (n) => fmtBytes(n) ?? ""), value: (r) => r.account?.bytes ?? -1 },
    {
      key: "quota",
      header: tr("Quota"),
      width: "12rem",
      wrap: true,
      cell: (r) => {
        if (r.state === "pending") return <Pending />;
        const q = r.account?.quota_bytes;
        if (!q) return <span className="text-muted">{r.state === "error" ? "—" : tr("No limit")}</span>;
        const pct = Math.min(100, Math.round(((r.account?.bytes ?? 0) / q) * 100));
        return (
          <div className="min-w-0">
            <div className="flex justify-between text-xs text-muted">
              <span>{fmtBytes(q)}</span>
              <span className="tabular-nums">{pct}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink/8">
              <div className={cn("h-full rounded-full", pct >= 90 ? "bg-led-red" : pct >= 75 ? "bg-led-amber" : "bg-cable")} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      },
      value: (r) => r.account?.quota_bytes ?? -1,
    },
  ];
  return (
    <>
      <ErrorNotice error={projects.error} className="mb-4" />
      {list.length > 0 && loaded < list.length && <p className="mb-3 text-xs text-muted">{tr("Loading details: {n} of {total}", { n: loaded, total: list.length })}</p>}
      {errors.length > 0 && (
        <p className="mb-3 rounded-md border border-line bg-panel px-4 py-3 text-sm text-led-red" title={errors[0].error}>
          {tr("{n} account(s) couldn't be read: {msg}", { n: errors.length, msg: errors[0].error ?? "" })}
        </p>
      )}
      <DataTable
        rows={projects.data ? rows : undefined}
        columns={columns}
        rowKey={(r) => r.id}
        loading={projects.isPending}
        tableId="admin-object-accounts"
        noun={tr("projects")}
        rowLabel={(r) => r.name}
        filterPlaceholder={tr("Filter by project")}
        onRefresh={refresh}
        rowActions={(r) => [{ label: tr("Set quota"), icon: "edit", disabled: r.state === "error" ? r.error : false, onSelect: () => setEditing(r) }]}
      />
      <p className="mt-3 text-xs text-muted">{tr("Projects that never used object storage have no account yet and show 0.")}</p>
      {editing && <QuotaDialog row={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function QuotaDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const refresh = useRefreshSwift();
  const q = row.account?.quota_bytes;
  const [gib, setGib] = useState(q ? String(+(q / GiB).toFixed(3)) : "");
  const bad = gib.trim() !== "" && !(Number(gib) > 0);
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Object storage quota of {name}", { name: row.name })}
      description={tr("Uploads that would exceed it are refused (account_quotas middleware).")}
      submitLabel={tr("Save")}
      canSubmit={!bad}
      done={tr("Quota saved")}
      onDone={refresh}
      run={() => swift.setQuota(row.id, gib.trim() ? Math.round(Number(gib) * GiB) : null)}
    >
      <Field label={tr("Quota (GiB)")} hint={tr("Empty removes the quota.")}>
        {(id) => <Input id={id} type="number" min={0} step="any" autoFocus value={gib} onChange={(e) => setGib(e.target.value)} placeholder={tr("No limit")} />}
      </Field>
      {row.account?.bytes != null && <p className="text-sm text-muted">{tr("Currently using {size}.", { size: fmtBytes(row.account.bytes) ?? "" })}</p>}
    </ActionDialog>
  );
}
