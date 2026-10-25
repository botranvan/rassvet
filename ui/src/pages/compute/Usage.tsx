/**
 * Compute usage over a period (Nova os-simple-tenant-usage), like Horizon's Overview:
 * summary of vCPU / disk / RAM hours and the instances that ran. Project mode shows the
 * current project; admin mode lists every project and drills into one (`?project=`).
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Link } from "@/components/Link";
import { downloadText } from "@/components/CodeBlock";
import { type Column, DataTable } from "@/components/DataTable";
import { Button, Card, ErrorNotice, Field, Icon, Input, PageHeader, StatusDot } from "@/components/ui";
import { localDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import { age, gib, os } from "@/lib/os";
import { useSession } from "@/lib/session";
import { locale, tr } from "@/lib/i18n";

interface ServerUsage {
  instance_id: string;
  name: string;
  hours: number;
  vcpus: number;
  memory_mb: number;
  local_gb: number;
  flavor: string;
  started_at: string;
  ended_at: string | null;
  state: string;
  uptime: number;
  tenant_id: string;
}

interface TenantUsage {
  tenant_id: string;
  start: string;
  stop: string;
  total_hours: number;
  total_vcpus_usage: number;
  total_memory_mb_usage: number;
  total_local_gb_usage: number;
  server_usages?: ServerUsage[];
}

const n2 = (v: number) => v.toLocaleString(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const firstOfMonth = () => {
  const d = new Date();
  return localDate(new Date(d.getFullYear(), d.getMonth(), 1));
};

/** Nova wants ISO datetimes; the end date is inclusive (until 24:00), never in the future. */
function range(start: string, end: string) {
  const s = `${start}T00:00:00`;
  const e = new Date(`${end}T00:00:00`);
  e.setDate(e.getDate() + 1);
  const stop = e > new Date() ? new Date() : e;
  const pad = (x: number) => String(x).padStart(2, "0");
  const iso = `${stop.getFullYear()}-${pad(stop.getMonth() + 1)}-${pad(stop.getDate())}T${pad(stop.getHours())}:${pad(stop.getMinutes())}:${pad(stop.getSeconds())}`;
  return { start: s, end: iso };
}

function Summary({ u }: { u?: TenantUsage }) {
  const servers = u?.server_usages ?? [];
  const active = servers.filter((s) => !s.ended_at && s.state !== "terminated");
  const items = [
    [tr("Active instances"), String(active.length)],
    [tr("Active RAM"), gib(active.reduce((a, s) => a + s.memory_mb, 0))],
    [tr("vCPU-hours"), n2(u?.total_vcpus_usage ?? 0)],
    [tr("Disk GB-hours"), n2(u?.total_local_gb_usage ?? 0)],
    [tr("RAM GiB-hours"), n2((u?.total_memory_mb_usage ?? 0) / 1024)],
  ];
  return (
    <div className="mb-6 grid gap-4 rounded-lg border border-line bg-panel px-5 py-4 sm:grid-cols-3 xl:grid-cols-5">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <p className="truncate text-xs text-muted">{k}</p>
          <p className="truncate text-xl font-semibold tabular-nums" title={v}>
            {v}
          </p>
        </div>
      ))}
    </div>
  );
}

function csvSummary(name: string, from: string, to: string, u?: TenantUsage) {
  const rows = [
    ["Usage report for", name],
    ["Period", `${from} to ${to}`],
    [tr("vCPU-hours"), n2(u?.total_vcpus_usage ?? 0)],
    [tr("Disk GB-hours"), n2(u?.total_local_gb_usage ?? 0)],
    ["RAM MB-hours", n2(u?.total_memory_mb_usage ?? 0)],
    [],
    ["Instance", "Flavor", "vCPUs", "RAM (MB)", "Disk (GB)", "Hours", "Started", "Ended", "State"],
    ...(u?.server_usages ?? []).map((s) => [s.name, s.flavor, s.vcpus, s.memory_mb, s.local_gb, s.hours.toFixed(2), s.started_at, s.ended_at ?? "", s.state]),
  ];
  return `${rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",")).join("\n")}\n`;
}

export default function Usage({ admin = false }: { admin?: boolean }) {
  const session = useSession().data!;
  const [params, setParams] = useSearchParams();
  const projectParam = params.get("project");
  const [from, setFrom] = useState(params.get("from") ?? firstOfMonth());
  const [to, setTo] = useState(params.get("to") ?? localDate());
  const [period, setPeriod] = useState({ from, to });
  const r = range(period.from, period.to);
  const pid = admin ? projectParam : session.project?.id;
  const projects = useProjects(admin);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? session.projects.find((p) => p.id === id)?.name ?? id;
  const valid = from && to && from <= to;
  const apply = () => {
    setPeriod({ from, to });
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set("from", from);
        n.set("to", to);
        return n;
      },
      { replace: true },
    );
  };

  const one = useQuery({
    queryKey: ["os", "compute", "usage", pid, r.start, r.end],
    queryFn: () => os.get<{ tenant_usage: TenantUsage }>("compute", `os-simple-tenant-usage/${pid}`, { start: r.start, end: r.end }).then((x) => x.tenant_usage),
    enabled: !!pid,
  });
  const all = useQuery({
    queryKey: ["os", "compute", "usage", "all", r.start, r.end],
    queryFn: () => os.get<{ tenant_usages: TenantUsage[] }>("compute", "os-simple-tenant-usage", { start: r.start, end: r.end, detailed: 1 }).then((x) => x.tenant_usages),
    enabled: admin && !pid,
  });

  const picker = (
    <form
      className="mb-5 flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) apply();
      }}
    >
      <Field label={tr("From")}>{(id) => <Input id={id} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-44" />}</Field>
      <Field label={tr("To")}>{(id) => <Input id={id} type="date" value={to} min={from} max={localDate()} onChange={(e) => setTo(e.target.value)} className="w-44" />}</Field>
      <Button type="submit" variant="primary" disabled={!valid}>
        <Icon name="refresh" />
        {tr("Show usage")}
      </Button>
      <div className="flex gap-1 pb-0.5">
        {[
          [tr("This month"), firstOfMonth(), localDate()],
          [tr("Last 7 days"), localDate(new Date(Date.now() - 6 * 864e5)), localDate()],
          [tr("Last 30 days"), localDate(new Date(Date.now() - 29 * 864e5)), localDate()],
        ].map(([label, f, t]) => (
          <Button
            key={label}
            type="button"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => {
              setFrom(f);
              setTo(t);
              setPeriod({ from: f, to: t });
            }}
          >
            {label}
          </Button>
        ))}
      </div>
    </form>
  );

  if (admin && !pid) return <AllProjects picker={picker} q={all} projectName={projectName} period={period} />;

  const u = one.data;
  const name = pid ? projectName(pid) : "";
  const cols: Column<ServerUsage>[] = [
    {
      key: "name",
      header: tr("Instance"),
      cell: (s) =>
        s.ended_at ? (
          <span className="font-medium">{s.name}</span>
        ) : (
          <Link to={`${admin ? "/admin" : ""}/compute/instances/${s.instance_id}`} className="font-medium text-cable hover:underline">
            {s.name}
          </Link>
        ),
      value: (s) => s.name,
    },
    { key: "flavor", header: tr("Flavor"), width: "9rem", hideBelow: "md", cell: (s) => s.flavor, value: (s) => s.flavor },
    { key: "vcpus", header: tr("vCPUs"), width: "5rem", className: "text-right", cell: (s) => s.vcpus, value: (s) => s.vcpus },
    { key: "disk", header: tr("Disk"), width: "6rem", className: "text-right", hideBelow: "sm", cell: (s) => `${s.local_gb} GB`, value: (s) => s.local_gb },
    { key: "ram", header: "RAM", width: "6.5rem", className: "text-right", cell: (s) => gib(s.memory_mb), value: (s) => s.memory_mb },
    { key: "hours", header: tr("Hours"), width: "7rem", className: "text-right", hideBelow: "lg", cell: (s) => n2(s.hours), value: (s) => s.hours },
    {
      key: "state",
      header: tr("State"),
      width: "7.5rem",
      hideBelow: "lg",
      cell: (s) => <StatusDot status={s.ended_at ? "off" : s.state === "active" ? "ok" : s.state === "error" ? "error" : "warn"} label={s.ended_at ? tr("deleted") : s.state} />,
      value: (s) => s.state,
    },
    { key: "age", header: tr("Age"), width: "8rem", hideBelow: "md", cell: (s) => age(`${s.started_at}${s.started_at.endsWith("Z") ? "" : "Z"}`), value: (s) => s.started_at },
  ];

  return (
    <>
      {admin && (
        <Link to="/admin/compute/usage" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
          <Icon name="arrow-left" className="size-3.5" />
          {tr("All projects")}
        </Link>
      )}
      <PageHeader
        title={admin ? tr("Usage of {name}", { name }) : tr("Usage")}
        description={tr("Compute usage over the period: instance hours weighted by vCPUs, local disk and RAM, as Nova reports it for billing and capacity planning. Instances that were shut off still count.")}
        actions={
          <Button onClick={() => downloadText(`usage-${name || "project"}-${period.from}-${period.to}.csv`, csvSummary(name, period.from, period.to, u), "text/csv")} disabled={!u}>
            <Icon name="download" />
            {tr("Download CSV summary")}
          </Button>
        }
      />
      {picker}
      <ErrorNotice error={one.error} className="mb-4" />
      <Summary u={u} />
      <DataTable
        rows={one.isPending ? undefined : (u?.server_usages ?? [])}
        columns={cols}
        rowKey={(s) => s.instance_id}
        loading={one.isPending}
        tableId={admin ? "admin-usage-project" : "usage"}
        noun={tr("instances")}
        empty={tr("No instances ran in this period.")}
        onRefresh={() => one.refetch()}
        refreshing={one.isFetching}
      />
    </>
  );
}

function AllProjects({
  picker,
  q,
  projectName,
  period,
}: {
  picker: React.ReactNode;
  q: ReturnType<typeof useQuery<TenantUsage[]>>;
  projectName: (id: string) => string;
  period: { from: string; to: string };
}) {
  const rows = q.data ?? [];
  const total = useMemo<TenantUsage>(
    () => ({
      tenant_id: "",
      start: "",
      stop: "",
      total_hours: 0,
      total_vcpus_usage: rows.reduce((a, x) => a + x.total_vcpus_usage, 0),
      total_memory_mb_usage: rows.reduce((a, x) => a + x.total_memory_mb_usage, 0),
      total_local_gb_usage: rows.reduce((a, x) => a + x.total_local_gb_usage, 0),
      server_usages: rows.flatMap((x) => x.server_usages ?? []),
    }),
    [rows],
  );
  const cols: Column<TenantUsage>[] = [
    {
      key: "project",
      header: tr("Project"),
      cell: (u) => (
        <Link to={`/admin/compute/usage?project=${encodeURIComponent(u.tenant_id)}&from=${period.from}&to=${period.to}`} className="font-medium text-cable hover:underline">
          {projectName(u.tenant_id)}
        </Link>
      ),
      value: (u) => projectName(u.tenant_id),
    },
    { key: "instances", header: tr("Instances"), width: "6.5rem", className: "text-right", cell: (u) => u.server_usages?.length ?? "—", value: (u) => u.server_usages?.length ?? 0 },
    { key: "vcpu", header: tr("vCPU-hours"), width: "9rem", className: "text-right", cell: (u) => n2(u.total_vcpus_usage), value: (u) => u.total_vcpus_usage },
    { key: "disk", header: tr("Disk GB-hours"), width: "9rem", className: "text-right", hideBelow: "md", cell: (u) => n2(u.total_local_gb_usage), value: (u) => u.total_local_gb_usage },
    { key: "ram", header: tr("RAM GiB-hours"), width: "9rem", className: "text-right", hideBelow: "sm", cell: (u) => n2(u.total_memory_mb_usage / 1024), value: (u) => u.total_memory_mb_usage },
  ];
  return (
    <>
      <PageHeader
        title={tr("Usage")}
        description={tr("Compute usage of every project over the period, from Nova. Open a project for its instances, or download a CSV for billing.")}
        actions={
          <Button
            disabled={!q.data}
            onClick={() =>
              downloadText(
                `usage-all-projects-${period.from}-${period.to}.csv`,
                `Project,Project ID,Instances,vCPU-hours,Disk GB-hours,RAM MB-hours\n${rows
                  .map((u) => [projectName(u.tenant_id), u.tenant_id, u.server_usages?.length ?? 0, u.total_vcpus_usage.toFixed(2), u.total_local_gb_usage.toFixed(2), u.total_memory_mb_usage.toFixed(2)].join(","))
                  .join("\n")}\n`,
                "text/csv",
              )
            }
          >
            <Icon name="download" />
            {tr("Download CSV")}
          </Button>
        }
      />
      {picker}
      <ErrorNotice error={q.error} className="mb-4" />
      <Summary u={q.data ? total : undefined} />
      <Card title={undefined} flush className="border-0 bg-transparent">
        <DataTable
          rows={q.data}
          columns={cols}
          rowKey={(u) => u.tenant_id}
          loading={q.isPending}
          tableId="admin-usage"
          noun={tr("projects")}
          empty={tr("No project ran instances in this period.")}
          onRefresh={() => q.refetch()}
          refreshing={q.isFetching}
        />
      </Card>
    </>
  );
}
