/**
 * Admin: quotas of one project across Nova, Neutron and Cinder (limits with current usage),
 * plus the cloud-wide defaults (Nova and Cinder quota classes; Neutron's come from its config).
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Link } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Button, Card, ErrorNotice, Icon, Input, PageHeader, Tabs } from "@/components/ui";
import { useProjects } from "@/lib/identity";
import { type Svc, gib, os, useInvalidate } from "@/lib/os";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { tr, trx } from "@/lib/i18n";

type Unit = "count" | "mib" | "gib" | "bytes";
interface Def {
  key: string;
  label: string;
  unit?: Unit;
}

const NOVA: Def[] = [
  { key: "instances", label: tr("Instances") },
  { key: "cores", label: tr("vCPUs") },
  { key: "ram", label: "RAM", unit: "mib" },
  { key: "key_pairs", label: tr("Key pairs (per user)") },
  { key: "server_groups", label: tr("Server groups") },
  { key: "server_group_members", label: tr("Members per server group") },
  { key: "metadata_items", label: tr("Metadata items per instance") },
  { key: "injected_files", label: tr("Injected files") },
  { key: "injected_file_content_bytes", label: tr("Injected file size"), unit: "bytes" },
  { key: "injected_file_path_bytes", label: tr("Injected file path length") },
];
const NEUTRON: Def[] = [
  { key: "network", label: tr("Networks") },
  { key: "subnet", label: tr("Subnets") },
  { key: "port", label: tr("Ports") },
  { key: "router", label: tr("Routers") },
  { key: "floatingip", label: tr("Floating IPs") },
  { key: "security_group", label: tr("Security groups") },
  { key: "security_group_rule", label: tr("Security group rules") },
  { key: "rbac_policy", label: tr("RBAC policies") },
  { key: "trunk", label: tr("Trunks") },
  { key: "subnetpool", label: tr("Subnet pools") },
];
const CINDER: Def[] = [
  { key: "volumes", label: tr("Volumes") },
  { key: "gigabytes", label: tr("Volume storage"), unit: "gib" },
  { key: "snapshots", label: tr("Snapshots") },
  { key: "backups", label: tr("Backups") },
  { key: "backup_gigabytes", label: tr("Backup storage"), unit: "gib" },
  { key: "groups", label: tr("Volume groups") },
  { key: "per_volume_gigabytes", label: tr("Largest volume"), unit: "gib" },
];

const fmt = (v: number, unit?: Unit) => (v < 0 ? "∞" : unit === "mib" ? gib(v) : unit === "gib" ? `${v} GiB` : unit === "bytes" ? `${v} B` : String(v));

interface Row {
  key: string;
  label: string;
  unit?: Unit;
  limit: number;
  used?: number;
}

/** Turn a quota API answer into rows: known keys in order, then extras (e.g. Cinder per-type quotas). */
function toRows(defs: Def[], raw: Record<string, unknown> | undefined): Row[] {
  if (!raw) return [];
  const val = (v: unknown) => (typeof v === "object" && v ? (v as { limit: number; in_use?: number; used?: number }) : { limit: Number(v) });
  const known = defs.filter((d) => d.key in raw).map((d) => {
    const v = val(raw[d.key]);
    return { ...d, limit: v.limit, used: v.in_use ?? v.used };
  });
  const extra = Object.keys(raw)
    .filter((k) => k !== "id" && !defs.some((d) => d.key === k))
    .sort()
    .map((k) => {
      const v = val(raw[k]);
      const unit: Unit | undefined = k.startsWith("gigabytes_") ? "gib" : undefined;
      return { key: k, label: k.replace(/_/g, " "), unit, limit: v.limit, used: v.in_use ?? v.used };
    })
    .filter((r) => Number.isFinite(r.limit));
  return [...known, ...extra];
}

interface ServiceSpec {
  svc: Svc;
  title: string;
  defs: Def[];
  get: (pid: string) => [string, Record<string, string | undefined> | undefined];
  key: "quota_set" | "quota";
  put: (pid: string) => string;
}

const SERVICES: Record<"compute" | "network" | "volume", ServiceSpec> = {
  compute: { svc: "compute", title: tr("Compute (Nova)"), defs: NOVA, get: (p) => [`os-quota-sets/${p}/detail`, undefined], key: "quota_set", put: (p) => `os-quota-sets/${p}` },
  network: { svc: "network", title: tr("Network (Neutron)"), defs: NEUTRON, get: (p) => [`quotas/${p}/details`, undefined], key: "quota", put: (p) => `quotas/${p}` },
  volume: { svc: "volume", title: tr("Block storage (Cinder)"), defs: CINDER, get: (p) => [`os-quota-sets/${p}`, { usage: "True" }], key: "quota_set", put: (p) => `os-quota-sets/${p}` },
};

const TABS = ["compute", "network", "volume", "defaults"] as const;

export default function Quotas() {
  const session = useSession().data!;
  const [params, setParams] = useSearchParams();
  const projects = useProjects();
  const pid = params.get("project") ?? "";
  const tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as (typeof TABS)[number]) : "compute";
  const set = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );
  const has = (t: string[]) => t.some((x) => session.services.includes(x));
  const project = projects.data?.find((p) => p.id === pid);

  return (
    <>
      <PageHeader
        title={tr("Quotas")}
        description={tr("How much of each resource a project may use. Usage shows what the project holds now; Nova and Cinder refuse limits below current usage. -1 means unlimited.")}
      />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="w-full max-w-md">
          <Picker
            aria-label={tr("Project")}
            value={pid}
            onChange={(v) => set("project", v)}
            searchable
            loading={projects.isPending}
            placeholder={tr("Choose a project")}
            searchPlaceholder={tr("Search projects")}
            options={(projects.data ?? []).filter((p) => !p.is_domain).map((p) => ({ value: p.id, label: p.name, icon: "folder", description: p.id }))}
          />
        </div>
        {project && (
          <Link to={`/admin/identity/projects/${project.id}`} className="pb-2 text-sm text-cable hover:underline">
            {tr("Open project")}
          </Link>
        )}
      </div>
      <Tabs
        value={tab}
        onChange={(t) => set("tab", t === "compute" ? "" : t)}
        className="mb-5"
        tabs={[
          ...(has(["compute"]) ? [{ id: "compute" as const, label: tr("Compute") }] : []),
          ...(has(["network"]) ? [{ id: "network" as const, label: tr("Network") }] : []),
          ...(has(["block-storage", "volumev3", "volume"]) ? [{ id: "volume" as const, label: tr("Block storage") }] : []),
          { id: "defaults", label: tr("Defaults") },
        ]}
      />
      {tab === "defaults" ? (
        <Defaults />
      ) : !pid ? (
        <Card>
          <p className="py-6 text-center text-sm text-muted">{tr("Choose a project to see and edit its quotas.")}</p>
        </Card>
      ) : (
        <ProjectQuota key={`${tab}:${pid}`} spec={SERVICES[tab]} pid={pid} projectName={project?.name ?? pid} />
      )}
    </>
  );
}

function useQuota(spec: ServiceSpec, pid: string) {
  const [path, q] = spec.get(pid);
  return useQuery({
    queryKey: ["os", spec.svc, path, q ?? {}],
    queryFn: () => os.get<Record<string, Record<string, unknown>>>(spec.svc, path, q).then((r) => r[spec.key]),
  });
}

function ProjectQuota({ spec, pid, projectName }: { spec: ServiceSpec; pid: string; projectName: string }) {
  const quota = useQuota(spec, pid);
  const rows = useMemo(() => toRows(spec.defs, quota.data), [quota.data, spec.defs]);
  const toast = useToast();
  const invalidate = useInvalidate();
  const [edit, setEdit] = useState<Record<string, number>>({});
  const [resetting, setResetting] = useState(false);
  useEffect(() => setEdit({}), [quota.data]);
  const changed = Object.entries(edit).filter(([k, v]) => rows.find((r) => r.key === k)?.limit !== v);
  const save = useMutation({
    mutationFn: () => os.put(spec.svc, spec.put(pid), { [spec.key]: Object.fromEntries(changed) }),
    onSuccess: () => {
      toast(tr("Quotas of {projectName} saved", { projectName }));
      invalidate(spec.svc);
    },
  });
  return (
    <Card
      title={spec.title}
      flush
      actions={
        <>
          <Button onClick={() => setResetting(true)}>
            <Icon name="rotate-ccw" />
            {tr("Reset to defaults")}
          </Button>
          <Button variant="primary" busy={save.isPending} disabled={!changed.length} onClick={() => save.mutate()}>
            {trx("Save{v}", { v: changed.length ? ` (${changed.length})` : "" })}
          </Button>
        </>
      }
    >
      <ErrorNotice error={quota.error ?? save.error} className="m-4" />
      {quota.isPending ? (
        <p className="px-5 py-8 text-center text-sm text-muted">{tr("Loading quotas…")}</p>
      ) : (
        <QuotaTable rows={rows} edit={edit} setEdit={setEdit} />
      )}
      {resetting && (
        <ActionDialog
          onClose={() => setResetting(false)}
          danger
          title={tr("Reset {title} quotas of {projectName}?", { title: spec.title, projectName })}
          submitLabel={tr("Reset to defaults")}
          done={tr("Quotas reset to the defaults")}
          refresh={[spec.svc]}
          run={() => os.del(spec.svc, spec.put(pid))}
        >
          <p className="text-sm">{tr("Every limit set for this project is removed, so the cloud's defaults apply again.")}</p>
        </ActionDialog>
      )}
    </Card>
  );
}

function QuotaTable({ rows, edit, setEdit, readOnly }: { rows: Row[]; edit: Record<string, number>; setEdit: (f: (e: Record<string, number>) => Record<string, number>) => void; readOnly?: boolean }) {
  const hasUsage = rows.some((r) => r.used !== undefined);
  return (
    <table className="w-full table-fixed text-sm">
      <thead>
        <tr className="border-b border-line text-left text-muted">
          <th className="px-5 py-2.5 font-medium">{tr("Resource")}</th>
          {hasUsage && <th className="hidden w-[38%] px-4 py-2.5 font-medium sm:table-cell">{tr("Usage")}</th>}
          <th className="w-[11.5rem] px-4 py-2.5 font-medium">{tr("Limit")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const limit = edit[r.key] ?? r.limit;
          const unlimited = limit < 0;
          const pct = r.used !== undefined && limit > 0 ? Math.min(100, Math.round((r.used / limit) * 100)) : 0;
          const over = r.used !== undefined && limit >= 0 && r.used > limit;
          return (
            <tr key={r.key} className="border-b border-line last:border-0">
              <td className="px-5 py-2.5">
                <p className="truncate font-medium" title={r.label}>
                  {r.label}
                </p>
                <p className="truncate font-mono text-[11px] text-muted">{r.key}</p>
              </td>
              {hasUsage && (
                <td className="hidden px-4 py-2.5 sm:table-cell">
                  {r.used !== undefined ? (
                    <div className="flex items-center gap-3">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink/8">
                        <div className={cn("h-full rounded-full", over || pct >= 90 ? "bg-led-red" : pct >= 75 ? "bg-led-amber" : "bg-cable")} style={{ width: `${unlimited ? 0 : over ? 100 : pct}%` }} />
                      </div>
                      <span className="w-24 shrink-0 text-right text-xs text-muted tabular-nums">
                        {fmt(r.used, r.unit)} / {fmt(limit, r.unit)}
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted">—</span>
                  )}
                </td>
              )}
              <td className="px-4 py-2">
                {readOnly ? (
                  <span className="tabular-nums">{fmt(limit, r.unit)}</span>
                ) : (
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label={tr("{label} limit", { label: r.label })}
                      type="number"
                      min={-1}
                      disabled={unlimited}
                      value={unlimited ? "" : limit}
                      placeholder="∞"
                      onChange={(e) => setEdit((x) => ({ ...x, [r.key]: e.target.value === "" ? 0 : Math.max(-1, Number(e.target.value)) }))}
                      className={cn("h-8 w-24 text-right tabular-nums", over && "border-led-red", edit[r.key] !== undefined && edit[r.key] !== r.limit && "border-cable")}
                    />
                    <label className="inline-flex items-center gap-1 text-xs text-muted" title={tr("Unlimited (-1)")}>
                      <input type="checkbox" className="size-3.5 accent-cable" checked={unlimited} onChange={(e) => setEdit((x) => ({ ...x, [r.key]: e.target.checked ? -1 : Math.max(r.used ?? 0, r.limit > 0 ? r.limit : 10) }))} />∞
                    </label>
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Cloud-wide defaults: Nova and Cinder "default" quota classes (editable), Neutron's (read-only, from neutron.conf). */
function Defaults() {
  const session = useSession().data!;
  const pid = session.project?.id ?? "";
  const has = (t: string[]) => t.some((x) => session.services.includes(x));
  return (
    <div className="grid items-start gap-6 xl:grid-cols-2">
      {has(["compute"]) && <ClassDefaults svc="compute" title={tr("Compute (Nova) defaults")} defs={NOVA} />}
      {has(["block-storage", "volumev3", "volume"]) && <ClassDefaults svc="volume" title={tr("Block storage (Cinder) defaults")} defs={CINDER} />}
      {has(["network"]) && pid && <NeutronDefaults pid={pid} />}
    </div>
  );
}

function ClassDefaults({ svc, title, defs }: { svc: Svc; title: string; defs: Def[] }) {
  const q = useQuery({
    queryKey: ["os", svc, "os-quota-class-sets/default"],
    queryFn: () => os.get<{ quota_class_set: Record<string, unknown> }>(svc, "os-quota-class-sets/default").then((r) => r.quota_class_set),
  });
  const rows = useMemo(() => toRows(defs, q.data), [q.data, defs]);
  const [edit, setEdit] = useState<Record<string, number>>({});
  useEffect(() => setEdit({}), [q.data]);
  const toast = useToast();
  const invalidate = useInvalidate();
  const changed = Object.entries(edit).filter(([k, v]) => rows.find((r) => r.key === k)?.limit !== v);
  const save = useMutation({
    mutationFn: () => os.put(svc, "os-quota-class-sets/default", { quota_class_set: Object.fromEntries(changed) }),
    onSuccess: () => {
      toast(tr("Default quotas saved"));
      invalidate(svc);
    },
  });
  return (
    <Card
      title={title}
      flush
      actions={
        <Button variant="primary" busy={save.isPending} disabled={!changed.length} onClick={() => save.mutate()}>
          {trx("Save{v}", { v: changed.length ? ` (${changed.length})` : "" })}
        </Button>
      }
    >
      <p className="px-5 pt-3 text-xs text-muted">{tr("Apply to every project without its own limit.")}</p>
      <ErrorNotice error={q.error ?? save.error} className="m-4" />
      {q.isPending ? <p className="px-5 py-8 text-center text-sm text-muted">{tr("Loading…")}</p> : <QuotaTable rows={rows} edit={edit} setEdit={setEdit} />}
    </Card>
  );
}

function NeutronDefaults({ pid }: { pid: string }) {
  const q = useQuery({
    queryKey: ["os", "network", `quotas/${pid}/default`],
    queryFn: () => os.get<{ quota: Record<string, unknown> }>("network", `quotas/${pid}/default`).then((r) => r.quota),
  });
  const rows = useMemo(() => toRows(NEUTRON, q.data), [q.data]);
  return (
    <Card title={tr("Network (Neutron) defaults")} flush>
      <p className="px-5 pt-3 text-xs text-muted">
        {tr("Set in")}{" "}<code className="font-mono">neutron.conf</code>{" "}{tr("([quotas] section); change them there.")}
      </p>
      <ErrorNotice error={q.error} className="m-4" />
      {q.isPending ? <p className="px-5 py-8 text-center text-sm text-muted">{tr("Loading…")}</p> : <QuotaTable rows={rows} edit={{}} setEdit={() => undefined} readOnly />}
    </Card>
  );
}
