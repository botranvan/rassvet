/** Admin: Magnum quotas, usage per project and the Magnum services. */
import { useMemo, useState } from "react";
import {
  ActionDialog,
  Button,
  Card,
  type Column,
  DataTable,
  Detail,
  ErrorNotice,
  Field,
  Icon,
  Input,
  type MenuEntry,
  PageHeader,
  Picker,
  StatusDot,
  Tabs,
  age,
  fmtDate,
  os,
  tr,
  useInvalidate,
  useProjects,
  useTab,
} from "@rassvet/sdk";
import { MG, type MService, type Quota, useClusters, useMServices, useQuotas, useStats } from "./api";

const TABS = ["quotas", "usage", "services"] as const;

export default function Settings() {
  const [tab, setTab] = useTab(TABS, "quotas");
  return (
    <>
      <PageHeader title={tr("Kubernetes service")} description={tr("Magnum cluster quotas, usage per project and the state of the Magnum services in this region.")} />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { id: "quotas", label: tr("Quotas") },
          { id: "usage", label: tr("Usage") },
          { id: "services", label: tr("Services") },
        ]}
      />
      {tab === "quotas" && <Quotas />}
      {tab === "usage" && <Usage />}
      {tab === "services" && <Services />}
    </>
  );
}

// =========================================================================== quotas

function Quotas() {
  const quotas = useQuotas();
  const projects = useProjects();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "set" | "delete"; q?: Quota } | null>(null);
  const close = () => setOpen(null);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;
  const columns: Column<Quota>[] = [
    { key: "project", header: tr("Project"), cell: (q) => projectName(q.project_id), value: (q) => `${projectName(q.project_id)} ${q.project_id}` },
    { key: "resource", header: tr("Resource"), width: "8rem", cell: (q) => q.resource, value: (q) => q.resource },
    { key: "limit", header: tr("Clusters allowed"), width: "9rem", className: "text-right", cell: (q) => q.hard_limit, value: (q) => q.hard_limit },
    { key: "updated", header: tr("Updated"), width: "8rem", hideBelow: "md", cell: (q) => <span title={fmtDate(q.updated_at ?? q.created_at) ?? ""}>{age(q.updated_at ?? q.created_at)}</span>, value: (q) => q.updated_at ?? q.created_at ?? "" },
  ];
  const items = (q: Quota): MenuEntry[] => [
    { label: tr("Change limit"), icon: "edit", onSelect: () => setOpen({ kind: "set", q }) },
    { label: tr("Reset to default"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", q }) },
  ];
  return (
    <>
      <p className="mb-4 text-sm text-muted">{tr("Projects without an entry here get Magnum's default ([quotas] max_clusters_per_project in magnum.conf).")}</p>
      <ErrorNotice error={quotas.error} className="mb-4" />
      <DataTable
        rows={quotas.data}
        columns={columns}
        rowKey={(q) => `${q.project_id}/${q.resource}`}
        loading={quotas.isPending}
        tableId="magnum-quotas"
        noun={tr("quotas")}
        rowLabel={(q) => projectName(q.project_id)}
        onRefresh={() => quotas.refetch()}
        refreshing={quotas.isFetching}
        onBulkDone={() => invalidate(MG)}
        empty={tr("No project has its own quota; every project gets the default.")}
        filterPlaceholder={tr("Filter by project")}
        rowActions={items}
        toolbar={
          <Button onClick={() => setOpen({ kind: "set" })}>
            <Icon name="plus" />
            {tr("Set quota")}
          </Button>
        }
        bulkActions={[
          {
            id: "delete",
            label: tr("Reset"),
            icon: "trash",
            danger: true,
            title: tr("Reset quotas to the default?"),
            past: tr("reset"),
            run: (q) => os.del(MG, `quotas/${q.project_id}/${q.resource}`),
          },
        ]}
      />
      {open?.kind === "set" && <QuotaDialog quota={open.q} existing={quotas.data ?? []} onClose={close} />}
      {open?.kind === "delete" && open.q && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Reset the quota of {project}?", { project: projectName(open.q.project_id) })}
          submitLabel={tr("Reset")}
          done={tr("Quota reset")}
          refresh={[MG]}
          run={() => os.del(MG, `quotas/${open.q!.project_id}/${open.q!.resource}`)}
        >
          <p className="text-sm">{tr("The project gets Magnum's default limit again. Existing clusters are kept.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function QuotaDialog({ quota, existing, onClose }: { quota?: Quota; existing: Quota[]; onClose: () => void }) {
  const projects = useProjects();
  const [project, setProject] = useState(quota?.project_id ?? "");
  const [limit, setLimit] = useState(String(quota?.hard_limit ?? 5));
  const current = quota ?? existing.find((q) => q.project_id === project && q.resource === "Cluster");
  const n = Number(limit);
  return (
    <ActionDialog
      onClose={onClose}
      title={quota ? tr("Cluster quota") : tr("Set a cluster quota")}
      submitLabel={tr("Save")}
      canSubmit={!!project && Number.isInteger(n) && n >= 0}
      done={tr("Quota saved")}
      refresh={[MG]}
      run={() =>
        current
          ? os.patch(MG, `quotas/${project}/Cluster`, { project_id: project, resource: "Cluster", hard_limit: n })
          : os.post(MG, "quotas", { project_id: project, resource: "Cluster", hard_limit: n })
      }
    >
      <Field label={tr("Project")}>
        {(id) =>
          quota ? (
            <Input id={id} value={projects.data?.find((p) => p.id === project)?.name ?? project} disabled />
          ) : (
            <Picker id={id} value={project} onChange={setProject} loading={projects.isPending} options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name, description: p.id }))} />
          )
        }
      </Field>
      <Field label={tr("Clusters allowed")} hint={current && !quota ? tr("This project already has a quota of {n}; it is replaced.", { n: current.hard_limit }) : undefined}>
        {(id) => <Input id={id} type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} />}
      </Field>
    </ActionDialog>
  );
}

// =========================================================================== usage

interface UsageRow {
  project: string;
  clusters: number;
  nodes: number;
  failed: number;
}

function Usage() {
  const stats = useStats();
  const clusters = useClusters();
  const projects = useProjects();
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;
  const rows = useMemo(() => {
    const m = new Map<string, UsageRow>();
    for (const c of clusters.data ?? []) {
      const p = c.project_id ?? "";
      const r = m.get(p) ?? { project: p, clusters: 0, nodes: 0, failed: 0 };
      r.clusters += 1;
      r.nodes += c.master_count + c.node_count;
      if (c.status.endsWith("_FAILED")) r.failed += 1;
      m.set(p, r);
    }
    return [...m.values()];
  }, [clusters.data]);
  const columns: Column<UsageRow>[] = [
    { key: "project", header: tr("Project"), cell: (r) => projectName(r.project), value: (r) => projectName(r.project) },
    { key: "clusters", header: tr("Clusters"), width: "7rem", className: "text-right", cell: (r) => r.clusters, value: (r) => r.clusters },
    { key: "nodes", header: tr("Nodes"), width: "7rem", className: "text-right", cell: (r) => r.nodes, value: (r) => r.nodes },
    { key: "failed", header: tr("Failed"), width: "7rem", className: "text-right", cell: (r) => (r.failed ? <span className="text-led-red">{r.failed}</span> : 0), value: (r) => r.failed },
  ];
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
      <Card title={tr("Region total")}>
        <ErrorNotice error={stats.error} />
        <dl>
          <Detail label={tr("Clusters")}>{stats.data?.clusters ?? "—"}</Detail>
          <Detail label={tr("Nodes")}>{stats.data?.nodes ?? "—"}</Detail>
        </dl>
      </Card>
      <div>
        <ErrorNotice error={clusters.error} className="mb-4" />
        <DataTable rows={rows} columns={columns} rowKey={(r) => r.project} loading={clusters.isPending} tableId="magnum-usage" noun={tr("projects")} empty={tr("No clusters in this region.")} filterPlaceholder={tr("Filter by project")} />
      </div>
    </div>
  );
}

// =========================================================================== services

function Services() {
  const services = useMServices();
  const columns: Column<MService>[] = [
    { key: "host", header: tr("Host"), cell: (s) => s.host, value: (s) => s.host },
    { key: "binary", header: tr("Service"), width: "11rem", cell: (s) => s.binary, value: (s) => s.binary },
    { key: "state", header: tr("State"), width: "7rem", cell: (s) => <StatusDot status={s.state === "up" ? "ok" : "error"} label={s.state === "up" ? tr("Up") : tr("Down")} />, value: (s) => s.state },
    {
      key: "status",
      header: tr("Status"),
      width: "12rem",
      cell: (s) => (s.disabled ? <span title={s.disabled_reason ?? ""}>{tr("Disabled")}</span> : tr("Enabled")),
      value: (s) => `${s.disabled ? "disabled" : "enabled"} ${s.disabled_reason ?? ""}`,
    },
    { key: "updated", header: tr("Last report"), width: "9rem", hideBelow: "md", cell: (s) => <span title={fmtDate(s.updated_at) ?? ""}>{age(s.updated_at ?? undefined)}</span>, value: (s) => s.updated_at ?? "" },
  ];
  return (
    <>
      <ErrorNotice error={services.error} className="mb-4" />
      <DataTable
        rows={services.data}
        columns={columns}
        rowKey={(s) => String(s.id)}
        loading={services.isPending}
        tableId="magnum-services"
        noun={tr("services")}
        onRefresh={() => services.refetch()}
        refreshing={services.isFetching}
        empty={tr("Magnum reports no services.")}
        filterPlaceholder={tr("Filter by host or service")}
      />
    </>
  );
}
