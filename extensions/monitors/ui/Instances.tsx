/**
 * Instance monitors. Project view: pick one of the project's instances. Admin view: pick a
 * project (or all of them) and then an instance. Without an instance, the dashboard's overview
 * panels for the project. The dashboard, choices and time range are kept in the URL.
 */
import { ErrorNotice, Field, Mono, PageHeader, Picker, tr, useInAdmin, useSearchParams } from "@rassvet/sdk";
import { type GuestItem, useDashboards, useInfo, useTargets } from "./api";
import { DashboardPicker, PanelGrid, RangeBar, useNow } from "./Panels";
import { formatSpec, parseRange, resolve } from "./range";

export default function Instances() {
  const info = useInfo();
  if (info.error) return <ErrorNotice error={info.error} />;
  if (!info.data) return <p className="text-sm text-muted">{tr("Loading…")}</p>;
  return <InstancesPage admin={info.data.admin} maxDays={info.data.max_range_days} ownProject={info.data.project} />;
}

export function useParamSetter() {
  const [params, setParams] = useSearchParams();
  const set = (changes: Record<string, string | null>) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(changes)) {
          if (v) n.set(k, v);
          else n.delete(k);
        }
        return n;
      },
      { replace: true },
    );
  return [params, set] as const;
}

function InstancesPage({ admin, maxDays, ownProject }: { admin: boolean; maxDays: number; ownProject: { id: string; name: string } | null }) {
  const adminView = useInAdmin() && admin;
  const [params, set] = useParamSetter();
  const [now, refresh] = useNow();
  const spec = parseRange(params.get("range"), maxDays);
  const range = resolve(spec, now);

  const dashboards = useDashboards("instance");
  const list = dashboards.data ?? [];
  const dash = list.find((d) => d.id === params.get("dashboard")) ?? list[0];
  // Project users get their own instances only; admins every project's (filtered here).
  const targets = useTargets(dash?.id, range);
  const all: GuestItem[] = targets.data?.kind === "instance" ? targets.data.guests : [];

  const chosenProject = adminView ? params.get("project") ?? "" : ownProject?.id ?? "";
  const guestId = params.get("guest") ?? "";
  const guests = adminView && chosenProject ? all.filter((g) => g.project_id === chosenProject) : all;
  const guest = all.find((g) => g.guest_id === guestId);
  // An instance brings its project ($project_id of every instance query).
  const projectId = guest?.project_id || chosenProject;
  const projects = [...new Map(all.map((g) => [g.project_id, g.project_name])).entries()].sort((a, b) =>
    (a[1] || a[0]).localeCompare(b[1] || b[0]),
  );
  const projectName = adminView ? projects.find(([id]) => id === projectId)?.[1] : ownProject?.name;

  const target = dash?.panels.filter((p) => p.scope === "target") ?? [];
  const overview = dash?.panels.filter((p) => p.scope === "overview") ?? [];

  return (
    <>
      <PageHeader
        title={tr("Instance monitors")}
        description={
          adminView
            ? tr("Dashboards of any project's instances, from the cloud's Prometheus. Pick a project, then an instance.")
            : tr("Dashboards of this project's instances, from the cloud's Prometheus. Pick an instance.")
        }
      />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <DashboardPicker list={list} value={dash?.id ?? ""} onChange={(v) => set({ dashboard: v, guest: null })} />
        {adminView && (
          <Field label={tr("Project")}>
            {(id) => (
              <Picker
                id={id}
                className="w-64"
                value={chosenProject}
                onChange={(v) => set({ project: v, guest: null })}
                loading={targets.isLoading}
                searchable
                options={[
                  { value: "", label: tr("All projects"), icon: "folder-tree" },
                  ...projects.map(([pid, name]) => ({
                    value: pid,
                    label: name || pid,
                    description: <Mono>{pid}</Mono>,
                    keywords: pid,
                  })),
                ]}
              />
            )}
          </Field>
        )}
        <Field label={tr("Instance")}>
          {(id) => (
            <Picker
              id={id}
              className="w-72"
              value={guestId}
              onChange={(v) => set({ guest: v })}
              clearable
              loading={targets.isLoading}
              searchable
              placeholder={tr("Choose an instance")}
              emptyText={tr("No instance has metrics in this time range")}
              options={guests.map((g) => ({
                value: g.guest_id,
                label: g.guest_name || g.guest_id,
                description: <Mono>{g.guest_id}</Mono>,
                group: adminView && !chosenProject ? g.project_name || g.project_id : undefined,
                keywords: `${g.guest_id} ${g.project_name}`,
              }))}
            />
          )}
        </Field>
        <RangeBar spec={spec} maxDays={maxDays} onChange={(s) => set({ range: formatSpec(s) })} onRefresh={refresh} />
      </div>
      {(dashboards.error || targets.error) && <ErrorNotice error={dashboards.error ?? targets.error} className="mb-4" />}

      {!dash ? (
        dashboards.data && <p className="text-sm text-muted">{tr("No instance dashboard is defined in the panel files.")}</p>
      ) : guestId ? (
        <>
          <h2 className="mb-3 text-sm font-semibold">
            {guest?.guest_name ?? guestId}
            {guest && adminView && <span className="ml-2 font-normal text-muted">{guest.project_name}</span>}
          </h2>
          {projectId ? (
            <PanelGrid dashboard={dash.id} panels={target} target={{ project_id: projectId, guest_id: guestId }} range={range} />
          ) : (
            <p className="text-sm text-muted">{tr("This instance has no metrics in this time range.")}</p>
          )}
        </>
      ) : projectId ? (
        <>
          <h2 className="mb-1 text-sm font-semibold">{tr("Project: {name}", { name: projectName || projectId })}</h2>
          <p className="mb-3 text-xs text-muted">{tr("Choose an instance to see its own panels.")}</p>
          <PanelGrid dashboard={dash.id} panels={overview} target={{ project_id: projectId }} range={range} />
        </>
      ) : (
        <p className="text-sm text-muted">{tr("Choose a project or an instance.")}</p>
      )}
    </>
  );
}
