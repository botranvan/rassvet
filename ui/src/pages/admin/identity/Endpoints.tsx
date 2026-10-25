import { useMemo, useState } from "react";
import { Picker } from "@/components/Picker";
import { type Column, DataTable } from "@/components/DataTable";
import { ErrorNotice, PageHeader } from "@/components/ui";
import { useAdminCatalog } from "@/lib/identity";
import { Enabled } from "./shared";
import { tr } from "@/lib/i18n";

interface Row {
  id: string;
  type: string;
  name: string;
  serviceEnabled: boolean;
  iface: string;
  region: string;
  url: string;
  enabled: boolean;
}

const columns: Column<Row>[] = [
  {
    key: "service", width: "11rem",
    header: tr("Service"),
    cell: (r) => (
      <div>
        <p className="font-medium">{r.name || r.type}</p>
        <p className="text-xs text-muted">{r.type}</p>
      </div>
    ),
    value: (r) => `${r.name} ${r.type}`,
  },
  { key: "iface", width: "6.5rem", hideBelow: "sm", header: tr("Interface"), cell: (r) => r.iface, value: (r) => r.iface },
  { key: "region", width: "8rem", hideBelow: "md", header: tr("Region"), cell: (r) => r.region, value: (r) => r.region },
  { key: "url", header: "URL", cell: (r) => <span className="select-all">{r.url}</span>, value: (r) => r.url, mono: true },
  {
    key: "enabled", width: "7.5rem",
    header: tr("Status"),
    cell: (r) => <Enabled enabled={r.enabled && r.serviceEnabled} />,
    value: (r) => (r.enabled && r.serviceEnabled ? 1 : 0),
    csv: (r) => (r.enabled && r.serviceEnabled ? "Enabled" : "Disabled"),
  },
];

export default function Endpoints() {
  const cat = useAdminCatalog();
  const [region, setRegion] = useState("");
  const [iface, setIface] = useState("");

  const rows = useMemo<Row[]>(() => {
    if (!cat.data) return [];
    const svc = new Map(cat.data.services.map((s) => [s.id, s]));
    return cat.data.endpoints.map((e) => {
      const s = svc.get(e.service_id);
      return {
        id: e.id,
        type: s?.type ?? e.service_id,
        name: s?.name ?? "",
        serviceEnabled: s?.enabled ?? true,
        iface: e.interface,
        region: e.region_id ?? "",
        url: e.url,
        enabled: e.enabled,
      };
    });
  }, [cat.data]);

  const shown = rows.filter((r) => (!region || r.region === region) && (!iface || r.iface === iface));

  return (
    <>
      <PageHeader
        title={tr("Services & endpoints")}
        description={
          cat.data
            ? tr("{length} services and {length2} endpoints in {length3} regions, as registered in Keystone.", { length: cat.data.services.length, length2: cat.data.endpoints.length, length3: cat.data.regions.length })
            : tr("Every service and endpoint registered in Keystone, including disabled ones.")
        }
      />
      <ErrorNotice error={cat.error} className="mb-4" />
      <DataTable
        rows={shown}
        columns={columns}
        rowKey={(r) => r.id}
        loading={cat.isPending}
        tableId="admin-endpoints"
        onRefresh={() => cat.refetch()}
        refreshing={cat.isFetching}
        filterPlaceholder={tr("Filter by service or URL")}
        empty={tr("No endpoints match these filters.")}
        toolbar={
          <>
            <Picker
              aria-label={tr("Region")}
              size="sm"
              className="h-9 w-44"
              value={region}
              onChange={setRegion}
              options={[{ value: "", label: tr("All regions") }, ...(cat.data?.regions ?? []).map((r) => ({ value: r.id, label: r.id }))]}
            />
            <Picker
              aria-label={tr("Interface")}
              size="sm"
              className="h-9 w-40"
              value={iface}
              onChange={setIface}
              options={["", "public", "internal", "admin"].map((v) => ({ value: v, label: v || tr("All interfaces") }))}
            />
          </>
        }
      />
    </>
  );
}
