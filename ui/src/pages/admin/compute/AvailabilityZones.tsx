/** Admin: availability zones of Nova (with hosts and services), Cinder and Neutron. */
import { Link } from "@/components/Link";
import { type Column, DataTable } from "@/components/DataTable";
import { Badge, Card, ErrorNotice, PageHeader, StatusDot, Tabs } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { useOsGet } from "@/lib/os";
import { useSession } from "@/lib/session";
import { useTab } from "@/lib/useTab";
import { tr } from "@/lib/i18n";

type ServiceState = { available: boolean; active: boolean; updated_at?: string | null };
interface ComputeZone {
  zoneName: string;
  zoneState: { available: boolean };
  hosts: Record<string, Record<string, ServiceState>> | null;
}
interface SimpleZone {
  zoneName: string;
  zoneState: { available: boolean };
}
interface NetZone {
  name: string;
  resource: string;
  state: string;
}

const TABS = ["compute", "volume", "network"] as const;

export default function AvailabilityZones() {
  const session = useSession().data!;
  const [tab, setTab] = useTab(TABS, "compute");
  const has = (t: string[]) => t.some((x) => session.services.includes(x));
  return (
    <>
      <PageHeader
        title={tr("Availability zones")}
        description={tr("Failure domains users pick when they launch instances or create volumes. Nova zones come from host aggregates with an availability_zone; hosts outside them are in the default zone.")}
      />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { id: "compute", label: tr("Compute") },
          ...(has(["block-storage", "volumev3", "volume"]) ? [{ id: "volume" as const, label: tr("Block storage") }] : []),
          ...(has(["network"]) ? [{ id: "network" as const, label: tr("Network") }] : []),
        ]}
      />
      {tab === "compute" && <ComputeZones />}
      {tab === "volume" && <VolumeZones />}
      {tab === "network" && <NetworkZones />}
    </>
  );
}

function ComputeZones() {
  const zones = useOsGet<ComputeZone[]>("compute", "os-availability-zone/detail", (r: { availabilityZoneInfo: ComputeZone[] }) => r.availabilityZoneInfo);
  // The "internal" zone holds control-plane services (scheduler, conductor); show it last.
  const list = (zones.data ?? []).slice().sort((a, b) => (a.zoneName === "internal" ? 1 : b.zoneName === "internal" ? -1 : a.zoneName.localeCompare(b.zoneName)));
  return (
    <>
      <ErrorNotice error={zones.error} className="mb-4" />
      {zones.isPending && <p className="text-sm text-muted">{tr("Loading…")}</p>}
      <div className="grid items-start gap-6 xl:grid-cols-2">
        {list.map((z) => {
          const hosts = Object.entries(z.hosts ?? {}).sort(([a], [b]) => a.localeCompare(b));
          const services = hosts.flatMap(([, s]) => Object.values(s));
          const down = services.filter((s) => s.active && !s.available).length;
          return (
            <Card
              key={z.zoneName}
              flush
              title={
                <span className="flex items-center gap-2">
                  {z.zoneName}
                  {z.zoneName === "internal" && <Badge>{tr("control plane")}</Badge>}
                </span>
              }
              actions={
                <span className="flex items-center gap-3 text-xs text-muted">
                  {tr("{n} host(s)", { n: hosts.length })}
                  <StatusDot status={!z.zoneState.available ? "error" : down ? "warn" : "ok"} label={!z.zoneState.available ? tr("unavailable") : down ? tr("{n} service(s) down", { n: down }) : tr("available")} />
                </span>
              }
            >
              <ul className="text-sm">
                {hosts.map(([host, svcs]) => (
                  <li key={host} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-5 py-2.5 last:border-0">
                    <span className="w-48 min-w-0 truncate font-medium" title={host}>
                      {host}
                    </span>
                    <span className="flex flex-1 flex-wrap gap-x-4 gap-y-1">
                      {Object.entries(svcs).map(([name, st]) => (
                        <span key={name} title={st.updated_at ? tr("Last report {date}", { date: fmtDate(st.updated_at) ?? "" }) : undefined}>
                          <StatusDot status={!st.active ? "off" : st.available ? "ok" : "error"} label={`${name}${!st.active ? ` (${tr("disabled")})` : !st.available ? ` (${tr("down")})` : ""}`} />
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
                {hosts.length === 0 && <li className="px-5 py-4 text-muted">{tr("No hosts in this zone.")}</li>}
              </ul>
            </Card>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-muted">
        {tr("Move hosts between zones from")}{" "}
        <Link to="/admin/compute/aggregates" className="text-cable hover:underline">
          {tr("Host aggregates")}
        </Link>
        .
      </p>
    </>
  );
}

function VolumeZones() {
  const zones = useOsGet<SimpleZone[]>("volume", "os-availability-zone", (r: { availabilityZoneInfo: SimpleZone[] }) => r.availabilityZoneInfo);
  const cols: Column<SimpleZone>[] = [
    { key: "name", header: tr("Zone"), cell: (z) => <span className="font-medium">{z.zoneName}</span>, value: (z) => z.zoneName },
    { key: "state", header: tr("State"), width: "10rem", cell: (z) => <StatusDot status={z.zoneState.available ? "ok" : "error"} label={z.zoneState.available ? tr("available") : tr("unavailable")} />, value: (z) => (z.zoneState.available ? 1 : 0) },
  ];
  return (
    <>
      <ErrorNotice error={zones.error} className="mb-4" />
      <DataTable rows={zones.data} columns={cols} rowKey={(z) => z.zoneName} loading={zones.isPending} tableId="admin-volume-azs" noun={tr("zones")} rowLabel={(z) => z.zoneName} onRefresh={() => zones.refetch()} refreshing={zones.isFetching} />
      <p className="mt-3 text-xs text-muted">{tr("Cinder zones come from storage_availability_zone of each cinder-volume service (see Storage backends).")}</p>
    </>
  );
}

function NetworkZones() {
  const zones = useOsGet<NetZone[]>("network", "availability_zones", (r: { availability_zones: NetZone[] }) => r.availability_zones);
  const cols: Column<NetZone>[] = [
    { key: "name", header: tr("Zone"), cell: (z) => <span className="font-medium">{z.name}</span>, value: (z) => z.name },
    { key: "resource", header: tr("Resource"), width: "10rem", cell: (z) => z.resource, value: (z) => z.resource },
    { key: "state", header: tr("State"), width: "10rem", cell: (z) => <StatusDot status={z.state === "available" ? "ok" : "error"} label={z.state} />, value: (z) => z.state },
  ];
  return (
    <>
      <ErrorNotice error={zones.error} className="mb-4" />
      <DataTable
        rows={zones.data}
        columns={cols}
        rowKey={(z) => `${z.name}|${z.resource}`}
        loading={zones.isPending}
        tableId="admin-network-azs"
        noun={tr("zones")}
        rowLabel={(z) => z.name}
        empty={tr("No network zones (the agents report none, or the extension is off).")}
        onRefresh={() => zones.refetch()}
        refreshing={zones.isFetching}
      />
    </>
  );
}
