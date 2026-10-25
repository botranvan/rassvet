/** Flavors this project can use (read-only; admins manage them under Admin → Flavors). */
import { FeatureBadges } from "@/components/FeatureBadges";
import { useNavigate } from "@/components/Link";
import { type Column, DataTable } from "@/components/DataTable";
import { Badge, ErrorNotice, PageHeader } from "@/components/ui";
import { type Flavor, gib, useFlavors } from "@/lib/os";
import { tr } from "@/lib/i18n";

export default function FlavorList() {
  const flavors = useFlavors();
  const navigate = useNavigate();
  const specs = (f: Flavor) =>
    Object.entries(f.extra_specs ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
  const columns: Column<Flavor>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (f) => (
        <span className="inline-flex max-w-full items-center gap-2" title={f.description ?? undefined}>
          <span className="truncate font-medium">{f.name}</span>
          {f["os-flavor-access:is_public"] === false && <Badge tone="warn">{tr("private")}</Badge>}
          <FeatureBadges specs={f.extra_specs} />
        </span>
      ),
      value: (f) => `${f.name} ${f.description ?? ""}`,
    },
    { key: "vcpus", header: tr("vCPUs"), width: "5rem", className: "text-right", cell: (f) => f.vcpus, value: (f) => f.vcpus },
    { key: "ram", header: "RAM", width: "6.5rem", className: "text-right", cell: (f) => gib(f.ram), value: (f) => f.ram, csv: (f) => f.ram },
    { key: "disk", header: tr("Root disk"), width: "7rem", className: "text-right", cell: (f) => (f.disk ? `${f.disk} GB` : tr("0 (volume)")), value: (f) => f.disk },
    { key: "eph", header: tr("Ephemeral"), width: "6.5rem", className: "text-right", hideBelow: "lg", cell: (f) => `${f["OS-FLV-EXT-DATA:ephemeral"] ?? 0} GB`, value: (f) => f["OS-FLV-EXT-DATA:ephemeral"] ?? 0 },
    { key: "swap", header: tr("Swap"), width: "6rem", className: "text-right", hideBelow: "xl", cell: (f) => (f.swap ? `${f.swap} MiB` : "—"), value: (f) => Number(f.swap || 0) },
    { key: "specs", header: tr("Extra specs"), hideBelow: "md", mono: true, cell: (f) => specs(f) || <span className="text-muted">—</span>, value: specs },
  ];
  return (
    <>
      <PageHeader
        title={tr("Flavors")}
        description={tr("Instance sizes this project can launch: vCPUs, memory and disks. Flavors with a 0 GB root disk boot from a volume.")}
      />
      <ErrorNotice error={flavors.error} className="mb-4" />
      <DataTable
        rows={flavors.data}
        columns={columns}
        rowKey={(f) => f.id}
        loading={flavors.isPending}
        tableId="flavors"
        noun={tr("flavors")}
        rowLabel={(f) => f.name}
        empty={tr("No flavors are available to this project.")}
        onRefresh={() => flavors.refetch()}
        refreshing={flavors.isFetching}
        rowActions={(f) => [{ label: tr("Launch instance with this flavor"), icon: "rocket", onSelect: () => navigate(`/compute/instances/launch?flavor=${encodeURIComponent(f.id)}`) }]}
      />
    </>
  );
}
