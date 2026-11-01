/** Admin: monitors of the physical servers (compute nodes), picked by host name. */
import { ErrorNotice, Field, Mono, PageHeader, Picker, tr, useSearchParams } from "@rassvet/sdk";
import { useHosts, useInfo } from "./api";
import { PanelGrid, RangeBar, useNow } from "./Panels";
import { formatSpec, parseRange, resolve } from "./range";

export default function Hosts() {
  const info = useInfo();
  if (info.error) return <ErrorNotice error={info.error} />;
  if (!info.data) return <p className="text-sm text-muted">{tr("Loading…")}</p>;
  if (!info.data.admin) return <ErrorNotice error={new Error(tr("Only admins can see physical servers."))} />;
  return <HostsPage maxDays={info.data.max_range_days} />;
}

function HostsPage({ maxDays }: { maxDays: number }) {
  const [params, setParams] = useSearchParams();
  const [now, refresh] = useNow();
  const spec = parseRange(params.get("range"), maxDays);
  const range = resolve(spec, now);
  const hostId = params.get("host") ?? "";
  const hosts = useHosts(range, true);
  const host = hosts.data?.find((h) => h.compute_node_id === hostId);
  const regions = new Set((hosts.data ?? []).map((h) => h.region).filter(Boolean));

  const set = (k: string, v: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );

  return (
    <>
      <PageHeader
        title={tr("Physical server monitors")}
        description={tr("CPU, load, memory, disks and network of the compute nodes, and what Nova has placed on them.")}
      />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <Field label={tr("Physical server")}>
          {(id) => (
            <Picker
              id={id}
              className="w-72"
              value={hostId}
              onChange={(v) => set("host", v)}
              clearable
              searchable
              loading={hosts.isLoading}
              placeholder={tr("Choose a physical server")}
              emptyText={tr("No physical server has metrics in this time range")}
              options={(hosts.data ?? []).map((h) => ({
                value: h.compute_node_id,
                label: h.hostname || h.compute_node_id,
                description: <Mono>{h.compute_node_id}</Mono>,
                group: regions.size > 1 ? h.region : undefined,
                icon: "server",
                keywords: h.compute_node_id,
              }))}
            />
          )}
        </Field>
        <RangeBar spec={spec} maxDays={maxDays} onChange={(s) => set("range", formatSpec(s))} onRefresh={refresh} />
      </div>
      {hosts.error && <ErrorNotice error={hosts.error} className="mb-4" />}
      {hostId ? (
        <>
          <h2 className="mb-3 text-sm font-semibold">{host?.hostname ?? hostId}</h2>
          <PanelGrid target={{ kind: "host", compute_node_id: hostId }} range={range} />
        </>
      ) : (
        <p className="text-sm text-muted">{tr("Choose a physical server.")}</p>
      )}
    </>
  );
}
