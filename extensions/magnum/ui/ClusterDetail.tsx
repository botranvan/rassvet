/** Cluster detail: overview (with the OpenStack resources it uses), node groups and labels. */
import type { ReactNode } from "react";
import {
  ActionMenu,
  Badge,
  Card,
  type Column,
  CopyButton,
  DataTable,
  Detail,
  ErrorNotice,
  Icon,
  Link,
  Mono,
  PageHeader,
  StatusDot,
  Tabs,
  fmtDate,
  tr,
  useFlavors,
  useInAdmin,
  useNavigate,
  useParams,
  useProjects,
  useTab,
} from "@rassvet/sdk";
import { BASE, type Cluster, clusterStatus, healthStatus, labelOn, labelsOf, mgName, statusText, useCluster, useTemplate, useTemplateVersion } from "./api";
import { useClusterActions } from "./Clusters";
import { NodeGroupsTab, ResourcesCard } from "./NodeGroups";

export function Back({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
      <Icon name="arrow-left" className="size-3.5" />
      {children}
    </Link>
  );
}

const Statuses = ({ c }: { c: Cluster }) => (
  <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
    <StatusDot status={clusterStatus(c.status)} label={statusText(c.status)} />
    <StatusDot status={healthStatus(c.health_status)} label={tr("Health: {h}", { h: statusText(c.health_status) })} />
  </span>
);

const TABS = ["overview", "nodegroups", "labels"] as const;

interface LabelRow {
  key: string;
  value: string;
  source: "template" | "cluster" | "overridden";
}

export default function ClusterDetail() {
  const { id = "" } = useParams();
  const admin = useInAdmin();
  const navigate = useNavigate();
  const q = useCluster(id);
  const c = q.data;
  const template = useTemplate(c?.cluster_template_id ?? "", !!c);
  const flavors = useFlavors();
  const version = useTemplateVersion();
  const projects = useProjects(admin);
  const actions = useClusterActions({ onDeleted: () => navigate(`${BASE}/clusters`) });
  const [tab, setTab] = useTab(TABS, "overview");

  const flavorName = (fid?: string | null) => (fid ? (flavors.data?.find((f) => f.id === fid || f.name === fid)?.name ?? fid) : "—");
  const labels: LabelRow[] = (() => {
    if (!c) return [];
    const all = labelsOf(c.labels);
    const overridden = labelsOf(c.labels_overridden);
    const added = labelsOf(c.labels_added);
    return Object.entries(all)
      .map(([key, value]): LabelRow => ({ key, value, source: key in overridden ? "overridden" : key in added ? "cluster" : "template" }))
      .sort((a, b) => a.key.localeCompare(b.key));
  })();
  const sourceLabel: Record<LabelRow["source"], ReactNode> = {
    template: <Badge>{tr("Template")}</Badge>,
    cluster: <Badge tone="accent">{tr("Added")}</Badge>,
    overridden: <Badge tone="warn">{tr("Overridden")}</Badge>,
  };
  const labelCols: Column<LabelRow>[] = [
    { key: "key", header: tr("Label"), mono: true, cell: (l) => l.key, value: (l) => l.key },
    { key: "value", header: tr("Value"), mono: true, cell: (l) => l.value, value: (l) => l.value },
    { key: "source", header: tr("Source"), width: "9rem", wrap: true, cell: (l) => sourceLabel[l.source], value: (l) => l.source },
  ];
  const health = Object.entries(c?.health_status_reason ?? {});
  const faults = Object.entries(c?.faults ?? {});

  return (
    <>
      <Back to={`${BASE}/clusters`}>{admin ? tr("All Kubernetes clusters") : tr("Kubernetes clusters")}</Back>
      <PageHeader title={c ? mgName(c) : tr("Kubernetes cluster")} description={c && <Statuses c={c} />} actions={c && <ActionMenu variant="button" items={() => actions.items(c, "detail")} />} />
      <ErrorNotice error={q.error} className="mb-4" />
      {c && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "nodegroups", label: tr("Node groups") },
              { id: "labels", label: tr("Labels ({n})", { n: labels.length }) },
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 xl:grid-cols-2">
              <div className="space-y-6">
                <Card title={tr("Details")}>
                  <dl>
                    <Detail label={tr("Name")}>{c.name || "—"}</Detail>
                    <Detail label="ID">
                      <Mono>{c.uuid}</Mono>
                    </Detail>
                    {admin && (
                      <Detail label={tr("Project")}>
                        {projects.data?.find((p) => p.id === c.project_id)?.name ?? ""} <Mono className="text-muted">{c.project_id}</Mono>
                      </Detail>
                    )}
                    <Detail label={tr("Status")}>
                      <StatusDot status={clusterStatus(c.status)} label={statusText(c.status)} />
                    </Detail>
                    {c.status_reason && (
                      <Detail label={tr("Status reason")} wrap>
                        {c.status_reason}
                      </Detail>
                    )}
                    <Detail label={tr("Health")}>
                      <StatusDot status={healthStatus(c.health_status)} label={statusText(c.health_status)} />
                    </Detail>
                    <Detail label={tr("Template")}>{template.data ? mgName(template.data) : <Mono>{c.cluster_template_id}</Mono>}</Detail>
                    <Detail label={tr("Kubernetes version")}>{c.coe_version?.replace(/^v/, "") || version(template.data) || "—"}</Detail>
                    {template.data?.driver && <Detail label={tr("Driver")}>{template.data.driver}</Detail>}
                    <Detail label={tr("Key pair")}>{c.keypair || "—"}</Detail>
                    {c.created_at && <Detail label={tr("Created")}>{fmtDate(c.created_at)}</Detail>}
                    {c.updated_at && <Detail label={tr("Updated")}>{fmtDate(c.updated_at)}</Detail>}
                  </dl>
                </Card>
                {(health.length > 0 || faults.length > 0) && (
                  <Card title={tr("Problems")}>
                    <dl>
                      {health.map(([k, v]) => (
                        <Detail key={`h${k}`} label={k} wrap>
                          {v}
                        </Detail>
                      ))}
                      {faults.map(([k, v]) => (
                        <Detail key={`f${k}`} label={k} wrap>
                          <span className="text-led-red">{v}</span>
                        </Detail>
                      ))}
                    </dl>
                  </Card>
                )}
              </div>
              <div className="space-y-6">
                <Card title={tr("Kubernetes API")} actions={c.api_address ? <CopyButton className="h-8" text={c.api_address} /> : undefined}>
                  <dl>
                    <Detail label={tr("Address")}>{c.api_address ? <Mono>{c.api_address}</Mono> : tr("Not yet available")}</Detail>
                    <Detail label={tr("Load balancer")}>
                      {labelOn(labelsOf(c.labels), "master_lb_floating_ip_enabled", true) ? tr("With a floating IP") : tr("Internal address only")}
                    </Detail>
                    <Detail label={tr("kubeconfig")}>
                      {c.api_address ? (
                        <button type="button" className="text-cable hover:underline" onClick={() => actions.openDialog(c, "kubeconfig")}>
                          {tr("Download")}
                        </button>
                      ) : (
                        "—"
                      )}
                    </Detail>
                  </dl>
                </Card>
                <Card title={tr("Nodes")}>
                  <dl>
                    <Detail label={tr("Masters")}>{c.master_count}</Detail>
                    <Detail label={tr("Master flavor")}>{flavorName(c.master_flavor_id)}</Detail>
                    <Detail label={tr("Master addresses")} wrap>
                      {c.master_addresses?.length ? <Mono>{c.master_addresses.join(", ")}</Mono> : "—"}
                    </Detail>
                    <Detail label={tr("Workers")}>{c.node_count}</Detail>
                    <Detail label={tr("Worker flavor")}>{flavorName(c.flavor_id)}</Detail>
                    <Detail label={tr("Worker addresses")} wrap>
                      {c.node_addresses?.length ? <Mono>{c.node_addresses.join(", ")}</Mono> : "—"}
                    </Detail>
                  </dl>
                </Card>
                <ResourcesCard cluster={c} />
              </div>
            </div>
          )}
          {tab === "nodegroups" && <NodeGroupsTab cluster={c} />}
          {tab === "labels" && (
            <DataTable
              rows={labels}
              columns={labelCols}
              rowKey={(l) => l.key}
              tableId="magnum-cluster-labels"
              noun={tr("labels")}
              empty={tr("No labels.")}
              filterPlaceholder={tr("Filter labels")}
            />
          )}
        </>
      )}
      {actions.dialogs}
    </>
  );
}
