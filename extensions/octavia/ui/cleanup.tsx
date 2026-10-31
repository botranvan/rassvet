/** Cleanup: load balancers in error and load balancers without listeners. */
import { type CleanupContext, type CleanupContribution, Link, StatusDot, type Column, type BulkAction, tr, useOsList } from "@rassvet/sdk";
import { LB, type LoadBalancer, deleteLb, lbName } from "./api";

/** Only a complete list (not the first pages of one still loading). */
const full = <T,>(q: { data?: T[]; partial?: boolean }) => (q.partial ? undefined : q.data);

export const cleanup: CleanupContribution = {
  useFindings: ({ admin, projectId, base, idle, projectCol, ageCol, table }: CleanupContext) => {
    // Octavia shows admins every project's load balancers; members ask for their own.
    const lbs = useOsList<LoadBalancer>(LB, "lbaas/loadbalancers", "loadbalancers", admin ? undefined : { project_id: projectId });
    const rows = full(lbs);
    const errored = rows?.filter((l) => l.provisioning_status === "ERROR");
    const idleLbs = rows?.filter((l) => l.provisioning_status === "ACTIVE" && !l.listeners.length && idle(l.updated_at, l.created_at));

    const columns: Column<LoadBalancer>[] = [
      {
        key: "name",
        header: tr("Name"),
        cell: (l) => (
          <Link to={`${base}/load-balancers/${l.id}`} className="truncate font-medium text-cable hover:underline">
            {lbName(l)}
          </Link>
        ),
        value: (l) => l.name,
      },
      { key: "vip", header: tr("VIP"), mono: true, width: "10rem", hideBelow: "md", cell: (l) => l.vip_address, value: (l) => l.vip_address },
      ...projectCol<LoadBalancer>((l) => l.project_id),
    ];
    const del: BulkAction<LoadBalancer> = {
      id: "delete",
      label: tr("Delete"),
      icon: "trash",
      danger: true,
      title: tr("Delete load balancers?"),
      body: tr("Each load balancer is deleted with its listeners, pools, members, health monitors and L7 policies (cascade). The VIP port is released; floating IPs stay allocated."),
      past: tr("deleted"),
      run: (l) => deleteLb(l.id, true),
    };
    const refresh = () => lbs.refetch();

    return [
      {
        id: "error-load-balancers",
        icon: "split",
        title: tr("Load balancers in error"),
        hint: tr("Load balancers whose create, update or failover failed. Their amphorae and VIP ports may still hold quota."),
        count: errored?.length,
        loading: !errored,
        error: lbs.error,
        table: () =>
          table(
            "error-load-balancers",
            errored,
            [...columns.slice(0, 1), { key: "status", header: tr("Status"), width: "9rem", cell: () => <StatusDot status="error" label="ERROR" />, value: (l) => l.operating_status }, ...columns.slice(1), ageCol<LoadBalancer>(tr("Age"), (l) => l.created_at)],
            lbName,
            [del],
            refresh,
            tr("load balancers"),
          ),
      },
      {
        id: "idle-load-balancers",
        icon: "split",
        title: tr("Load balancers without listeners"),
        hint: tr("Load balancers that accept no traffic. Each still runs its amphorae (or provider resources) and holds a VIP address."),
        count: idleLbs?.length,
        loading: !idleLbs,
        error: lbs.error,
        table: () => table("idle-load-balancers", idleLbs, [...columns, ageCol<LoadBalancer>(tr("Idle for"), (l) => l.updated_at ?? l.created_at)], lbName, [del], refresh, tr("load balancers")),
      },
    ];
  },
};
