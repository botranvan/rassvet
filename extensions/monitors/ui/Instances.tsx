/**
 * Instance monitors. Project view: pick one of the project's instances. Admin view: pick a
 * project (or all of them) and then an instance. Without an instance, the project's totals.
 * The choices and the time range are kept in the URL.
 */
import { ErrorNotice, Field, Mono, PageHeader, Picker, tr, useInAdmin, useSearchParams } from "@rassvet/sdk";
import { useGuests, useInfo, useMonitoredProjects } from "./api";
import { PanelGrid, RangeBar, useNow } from "./Panels";
import { formatSpec, parseRange, resolve } from "./range";

export default function Instances() {
  const info = useInfo();
  if (info.error) return <ErrorNotice error={info.error} />;
  if (!info.data) return <p className="text-sm text-muted">{tr("Loading…")}</p>;
  return <InstancesPage admin={info.data.admin} maxDays={info.data.max_range_days} ownProject={info.data.project} />;
}

function InstancesPage({ admin, maxDays, ownProject }: { admin: boolean; maxDays: number; ownProject: { id: string; name: string } | null }) {
  const adminView = useInAdmin() && admin;
  const [params, setParams] = useSearchParams();
  const [now, refresh] = useNow();
  const spec = parseRange(params.get("range"), maxDays);
  const range = resolve(spec, now);

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

  // The project view always looks at the session's project (the server enforces it anyway).
  const projectId = adminView ? params.get("project") ?? "" : ownProject?.id ?? "";
  const guestId = params.get("guest") ?? "";

  const projects = useMonitoredProjects(range, adminView);
  const guests = useGuests(range, projectId || undefined);
  const guest = guests.data?.find((g) => g.guest_id === guestId);
  const projectName = adminView
    ? projects.data?.find((p) => p.project_id === projectId)?.project_name
    : ownProject?.name;

  return (
    <>
      <PageHeader
        title={tr("Instance monitors")}
        description={
          adminView
            ? tr("CPU, memory, disk and network of any project's instances, from the cloud's Prometheus. Pick a project, then an instance.")
            : tr("CPU, memory, disk and network of this project's instances, from the cloud's Prometheus. Pick an instance.")
        }
      />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        {adminView && (
          <Field label={tr("Project")}>
            {(id) => (
              <Picker
                id={id}
                className="w-64"
                value={projectId}
                onChange={(v) => set({ project: v, guest: null })}
                loading={projects.isLoading}
                searchable
                options={[
                  { value: "", label: tr("All projects"), icon: "folder-tree" },
                  ...(projects.data ?? []).map((p) => ({
                    value: p.project_id,
                    label: p.project_name || p.project_id,
                    description: <Mono>{p.project_id}</Mono>,
                    keywords: p.project_id,
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
              loading={guests.isLoading}
              searchable
              placeholder={tr("Choose an instance")}
              emptyText={tr("No instance has metrics in this time range")}
              options={(guests.data ?? []).map((g) => ({
                value: g.guest_id,
                label: g.guest_name || g.guest_id,
                description: <Mono>{g.guest_id}</Mono>,
                group: adminView && !projectId ? g.project_name || g.project_id : undefined,
                keywords: `${g.guest_id} ${g.project_name}`,
              }))}
            />
          )}
        </Field>
        <RangeBar spec={spec} maxDays={maxDays} onChange={(s) => set({ range: formatSpec(s) })} onRefresh={refresh} />
      </div>
      {(projects.error || guests.error) && <ErrorNotice error={projects.error ?? guests.error} className="mb-4" />}

      {guestId ? (
        <>
          <h2 className="mb-3 text-sm font-semibold">
            {guest?.guest_name ?? guestId}
            {guest && adminView && <span className="ml-2 font-normal text-muted">{guest.project_name}</span>}
          </h2>
          <PanelGrid target={{ kind: "guest", guest_id: guestId, project_id: projectId || undefined }} range={range} />
        </>
      ) : projectId ? (
        <>
          <h2 className="mb-1 text-sm font-semibold">{tr("Project totals: {name}", { name: projectName ?? projectId })}</h2>
          <p className="mb-3 text-xs text-muted">{tr("Choose an instance to see its CPU, memory, disk and network.")}</p>
          <PanelGrid target={{ kind: "project", project_id: projectId }} range={range} />
        </>
      ) : (
        <p className="text-sm text-muted">{tr("Choose a project or an instance.")}</p>
      )}
    </>
  );
}
