/** Cleanup: failed Kubernetes clusters and cluster templates no cluster uses. */
import { type CleanupContribution, Link, StatusDot, os, tr, useOsList } from "@rassvet/sdk";
import type { Cluster, ClusterTemplate } from "./api";

type Row<T> = T & { id: string };
const withId = <T extends { uuid: string }>(rows?: T[]) => rows?.map((r) => ({ ...r, id: r.uuid }));
/** Only a complete list (not the first pages of one still loading). */
const full = <T,>(q: { data?: T[]; partial?: boolean }) => (q.partial ? undefined : q.data);

export const cleanup: CleanupContribution = {
  useFindings: ({ admin, projectId, base, idle, projectCol, ageCol, table }) => {
    // Magnum shows admins every project's clusters and templates whatever the query.
    const clusters = useOsList<Cluster>("ext:magnum", "clusters/detail", "clusters");
    const templates = useOsList<ClusterTemplate>("ext:magnum", "clustertemplates", "clustertemplates");
    const cs = withId(full(clusters))?.filter((c) => admin || c.project_id === projectId);
    const used = new Set((full(clusters) ?? []).map((c) => c.cluster_template_id));
    const failed = cs?.filter((c) => c.status.endsWith("_FAILED") && idle(c.updated_at, c.created_at));
    const unused = cs && withId(full(templates))?.filter((t) => !used.has(t.uuid) && (admin || t.project_id === projectId) && idle(t.created_at));

    return [
      {
        id: "failed-clusters",
        icon: "container",
        title: tr("Failed Kubernetes clusters"),
        hint: tr("Magnum clusters whose create, update or delete failed. Their servers, volumes and load balancers still count against quota; deleting the cluster removes them too."),
        count: failed?.length,
        loading: !failed,
        error: clusters.error,
        table: () =>
          table<Row<Cluster>>(
            "failed-clusters",
            failed,
            [
              {
                key: "name",
                header: tr("Name"),
                cell: (c) => (
                  <Link to={`${base}/clusters/${c.uuid}`} className="truncate font-medium text-cable hover:underline">
                    {c.name || c.uuid.slice(0, 13)}
                  </Link>
                ),
                value: (c) => c.name,
              },
              { key: "status", header: tr("Status"), width: "11rem", cell: (c) => <StatusDot status="error" label={c.status} />, value: (c) => `${c.status} ${c.status_reason ?? ""}` },
              { key: "nodes", header: tr("Nodes"), width: "6rem", cell: (c) => c.master_count + c.node_count, value: (c) => c.master_count + c.node_count },
              ...projectCol<Row<Cluster>>((c) => c.project_id),
              ageCol<Row<Cluster>>(tr("Idle for"), (c) => c.updated_at ?? c.created_at),
            ],
            (c) => c.name || c.uuid,
            [
              {
                id: "delete",
                label: tr("Delete"),
                icon: "trash",
                danger: true,
                title: tr("Delete clusters?"),
                body: tr("Magnum deletes each cluster with the servers, load balancers, networks and volumes it created."),
                past: tr("deleted"),
                check: (c) => (c.status === "DELETE_IN_PROGRESS" ? tr("Already being deleted") : true),
                run: (c) => os.del("ext:magnum", `clusters/${c.uuid}`),
              },
            ],
            () => clusters.refetch(),
            tr("clusters"),
          ),
      },
      {
        id: "unused-templates",
        icon: "file-code",
        title: tr("Unused cluster templates"),
        hint: tr("Cluster templates no Kubernetes cluster was created from. Public templates of other projects aren't listed."),
        count: unused?.length,
        loading: !unused,
        error: templates.error ?? clusters.error,
        table: () =>
          table<Row<ClusterTemplate>>(
            "unused-templates",
            unused,
            [
              { key: "name", header: tr("Name"), cell: (t) => <span className="font-medium">{t.name || t.uuid.slice(0, 13)}</span>, value: (t) => t.name },
              { key: "public", header: tr("Visibility"), width: "8rem", cell: (t) => (t.public ? tr("Public") : tr("Private")), value: (t) => (t.public ? "public" : "private") },
              ...projectCol<Row<ClusterTemplate>>((t) => t.project_id),
              ageCol<Row<ClusterTemplate>>(tr("Age"), (t) => t.created_at),
            ],
            (t) => t.name || t.uuid,
            [
              {
                id: "delete",
                label: tr("Delete"),
                icon: "trash",
                danger: true,
                title: tr("Delete cluster templates?"),
                past: tr("deleted"),
                run: (t) => os.del("ext:magnum", `clustertemplates/${t.uuid}`),
              },
            ],
            () => {
              templates.refetch();
              clusters.refetch();
            },
            tr("cluster templates"),
          ),
      },
    ];
  },
};
