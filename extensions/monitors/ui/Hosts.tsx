/** Admin: monitors of the physical servers, picked by host name; without one, the fleet overview. */
import { ErrorNotice, Field, Mono, PageHeader, Picker, tr } from "@rassvet/sdk";
import { type HostItem, useDashboards, useInfo, useTargets } from "./api";
import { useParamSetter } from "./Instances";
import { DashboardPicker, PanelGrid, RangeBar, VariableBar, pickedVars, useDashboardVars, useNow } from "./Panels";
import { formatSpec, parseRange, resolve } from "./range";

export default function Hosts() {
  const info = useInfo();
  if (info.error) return <ErrorNotice error={info.error} />;
  if (!info.data) return <p className="text-sm text-muted">{tr("Loading…")}</p>;
  if (!info.data.admin) return <ErrorNotice error={new Error(tr("Only admins can see physical servers."))} />;
  return <HostsPage maxDays={info.data.max_range_days} />;
}

/** The value identifying a server in the URL: its compute node id, or its host name. */
const hostKey = (h: HostItem) => h.compute_node_id || h.hostname;

function HostsPage({ maxDays }: { maxDays: number }) {
  const [params, set] = useParamSetter();
  const [now, refresh] = useNow();
  const spec = parseRange(params.get("range"), maxDays);
  const range = resolve(spec, now);

  const dashboards = useDashboards("physical");
  const list = dashboards.data ?? [];
  const dash = list.find((d) => d.id === params.get("dashboard")) ?? list[0];
  // No server list when the dashboard picks servers with its own variables.
  const targets = useTargets(dash?.server_picker === false ? undefined : dash?.id, range);
  const hosts: HostItem[] = targets.data?.kind === "physical" ? targets.data.hosts : [];
  const hostId = params.get("host") ?? "";
  const host = hosts.find((h) => hostKey(h) === hostId);
  const regions = new Set(hosts.map((h) => h.region).filter(Boolean));

  const target = dash?.panels.filter((p) => p.scope === "target") ?? [];
  const overview = dash?.panels.filter((p) => p.scope === "overview") ?? [];
  // A dashboard defining compute_node_id / hostname as variables picks servers with them.
  const picker = dash?.server_picker ?? true;
  const hostTarget = host ? { compute_node_id: host.compute_node_id || undefined, hostname: host.hostname || undefined } : {};
  const dv = useDashboardVars(dash, params, picker ? hostTarget : {}, range);
  const clearVars = Object.fromEntries(Object.keys(pickedVars(params)).map((k) => [`var-${k}`, null]));

  return (
    <>
      <PageHeader
        title={tr("Physical server monitors")}
        description={tr("Dashboards of the physical servers, from the cloud's Prometheus. Pick a server, or see the whole fleet.")}
      />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <DashboardPicker list={list} value={dash?.id ?? ""} onChange={(v) => set({ dashboard: v, host: null, ...clearVars })} />
        {picker && (
        <Field label={tr("Physical server")}>
          {(id) => (
            <Picker
              id={id}
              className="w-72"
              value={hostId}
              onChange={(v) => set({ host: v })}
              clearable
              searchable
              loading={targets.isLoading}
              placeholder={tr("Choose a physical server")}
              emptyText={tr("No physical server has metrics in this time range")}
              options={hosts.map((h) => ({
                value: hostKey(h),
                label: h.hostname || h.compute_node_id,
                description: h.compute_node_id ? <Mono>{h.compute_node_id}</Mono> : undefined,
                group: regions.size > 1 ? h.region : undefined,
                icon: "server",
                keywords: h.compute_node_id,
              }))}
            />
          )}
        </Field>
        )}
        <VariableBar resolved={dv.resolved} loading={dv.loading} onChange={(name, v) => set({ [`var-${name}`]: v })} />
        <RangeBar spec={spec} maxDays={maxDays} onChange={(s) => set({ range: formatSpec(s) })} onRefresh={refresh} />
      </div>
      {(dashboards.error || targets.error || dv.error) && (
        <ErrorNotice error={dashboards.error ?? targets.error ?? dv.error} className="mb-4" />
      )}
      {!dash ? (
        dashboards.data && <p className="text-sm text-muted">{tr("No physical server dashboard is defined in the panel files.")}</p>
      ) : !dv.vars ? (
        !dv.error && <p className="text-sm text-muted">{tr("Loading…")}</p>
      ) : !picker ? (
        <PanelGrid dashboard={dash.id} panels={dash.panels} target={{ vars: dv.vars }} range={range} />
      ) : hostId ? (
        host ? (
          <>
            <h2 className="mb-3 text-sm font-semibold">{host.hostname || hostId}</h2>
            <PanelGrid
              dashboard={dash.id}
              panels={target}
              target={{ ...hostTarget, vars: dv.vars }}
              range={range}
            />
          </>
        ) : (
          targets.data && <p className="text-sm text-muted">{tr("This server has no metrics in this time range.")}</p>
        )
      ) : overview.length ? (
        <PanelGrid dashboard={dash.id} panels={overview} target={{ vars: dv.vars }} range={range} />
      ) : (
        <p className="text-sm text-muted">{tr("Choose a physical server.")}</p>
      )}
    </>
  );
}
