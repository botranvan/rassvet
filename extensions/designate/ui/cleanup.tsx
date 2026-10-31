/** Cleanup: DNS zones in error. */
import { type CleanupContext, type CleanupContribution, Link, StatusDot, tr, useOsList } from "@rassvet/sdk";
import { DNS, type Zone, dns, undot } from "./api";

export const cleanup: CleanupContribution = {
  useFindings: ({ admin, base, projectCol, ageCol, table }: CleanupContext) => {
    const zones = useOsList<Zone>(DNS, "zones", "zones", admin ? { all_projects: 1 } : undefined);
    const errored = zones.partial ? undefined : zones.data?.filter((z) => z.status === "ERROR");
    return [
      {
        id: "error-zones",
        icon: "globe",
        title: tr("DNS zones in error"),
        hint: tr("Zones Designate couldn't create, update or push to its name servers. They still count against the zone quota."),
        count: errored?.length,
        loading: !errored,
        error: zones.error,
        table: () =>
          table(
            "error-zones",
            errored,
            [
              {
                key: "name",
                header: tr("Name"),
                cell: (z) => (
                  <Link to={`${base}/zones/${z.id}`} className="truncate font-medium text-cable hover:underline">
                    {undot(z.name)}
                  </Link>
                ),
                value: (z) => z.name,
              },
              { key: "status", header: tr("Status"), width: "10rem", cell: (z) => <StatusDot status="error" label={`${z.action ?? ""} ${z.status}`.trim()} />, value: (z) => `${z.action} ${z.status}` },
              ...projectCol<Zone>((z) => z.project_id),
              ageCol<Zone>(tr("Age"), (z) => z.updated_at ?? z.created_at),
            ],
            (z) => undot(z.name),
            [{ id: "delete", label: tr("Delete"), icon: "trash", danger: true, title: tr("Delete zones?"), body: tr("Every record set of each zone goes with it."), past: tr("deleted"), run: (z) => dns.del(`zones/${z.id}`, admin) }],
            () => zones.refetch(),
            tr("zones"),
          ),
      },
    ];
  },
};
