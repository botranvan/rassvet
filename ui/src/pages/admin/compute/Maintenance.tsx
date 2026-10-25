/**
 * Admin: one compute host (Compute → Hypervisors → host). Its capacity and instances, and
 * host maintenance: take it out of service (disable with a reason), drain it (live-migrate
 * running instances, cold-migrate stopped ones and confirm), evacuate the instances of a
 * host that is down, and put it back (enable).
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Link } from "@/components/Link";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Badge, Button, Card, ErrorNotice, Field, Icon, Input, PageHeader, Select, StatusDot, Switch } from "@/components/ui";
import {
  type HostRun,
  MOVE_LABEL,
  type MoveJob,
  type MoveKind,
  type Plan,
  abortMigration,
  cancelQueued,
  clearFinished,
  drainPlan,
  evacuatePlan,
  forceComplete,
  isActive,
  runActive,
  startMoves,
  useHostRun,
} from "@/lib/drain";
import { fmtDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import { type Server, age, os, serverAction, serverBusy, serverLabel, serverStatus, useInvalidate, useOsList } from "@/lib/os";
import { tr } from "@/lib/i18n";
import { HostCapacity } from "./Capacity";
import { type ComputeService, useComputeServices } from "./ComputeAdmin";
import { EndDialog, HOSTS, StartDialog, hostState, isDown, putService } from "./hostMaintenance";
import { runSummary } from "./runBadge";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// =========================================================================== one host

export function HostDetail() {
  const host = decodeURIComponent(useParams().host ?? "");
  const [params, setParams] = useSearchParams();
  const services = useComputeServices({ binary: "nova-compute" });
  const svc = services.data?.find((s) => s.host === host);
  const run = useHostRun(host);
  const active = runActive(run);
  const servers = useOsList<Server>("compute", "servers/detail", "servers", { all_tenants: 1, host }, { poll: (rows) => active || rows.some(serverBusy) });
  const projects = useProjects();
  const invalidate = useInvalidate();
  const toast = useToast();
  const [open, setOpen] = useState<null | "start" | "end" | "drain" | "evacuate">(null);
  const down = isDown(svc);

  // ?start=1 / ?drain=1 / ?evacuate=1 (from the hosts list or Hypervisors) open the dialog
  // once the host is known.
  useEffect(() => {
    if (!svc || services.isFetching) return;
    if (params.get("start")) setOpen(svc.status === "enabled" && !svc.forced_down ? "start" : null);
    else if (params.get("drain")) setOpen(down ? "evacuate" : "drain");
    else if (params.get("evacuate")) setOpen(down ? "evacuate" : null);
    else return;
    setParams({}, { replace: true });
  }, [svc, down, params, setParams, services.isFetching]);

  // Refresh the host list's counts and the instance lists as jobs finish.
  const finished = run?.jobs.filter((j) => !isActive(j)).length ?? 0;
  useEffect(() => {
    if (finished) invalidate("compute");
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  const projectName = useMemo(() => {
    const m = new Map(projects.data?.map((p) => [p.id, p.name]));
    return (id: string) => m.get(id) ?? id;
  }, [projects.data]);
  const jobOf = useMemo(() => new Map(run?.jobs.map((j) => [j.id, j])), [run]);
  const plan = (s: Server): Plan => (down ? evacuatePlan(s) : drainPlan(s, { cold: true }));

  const queue = (kind: MoveKind) => (s: Server) => {
    startMoves(host, [{ server: s, kind }]);
    return Promise.resolve();
  };
  const busyJob = (s: Server) => (jobOf.get(s.id) && isActive(jobOf.get(s.id)!) ? tr("Already moving") : null);

  const columns: Column<Server>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (s) => (
        <span className="flex min-w-0 flex-col">
          <Link to={`/compute/instances/${s.id}`} className="truncate font-medium text-cable hover:underline">
            {s.name}
          </Link>
          <span className="truncate text-xs text-muted">{projectName(s.tenant_id)}</span>
        </span>
      ),
      value: (s) => s.name,
    },
    { key: "status", header: tr("Status"), width: "10rem", cell: (s) => <StatusDot status={serverStatus(s)} label={serverLabel(s)} />, value: serverLabel },
    { key: "flavor", header: tr("Flavor"), width: "10rem", hideBelow: "md", cell: (s) => s.flavor.original_name ?? "", value: (s) => s.flavor.original_name ?? "" },
    {
      key: "plan",
      header: down ? tr("Evacuation") : tr("Drain"),
      wrap: true,
      cell: (s) => {
        const j = jobOf.get(s.id);
        if (j && isActive(j)) return <JobState j={j} />;
        const p = plan(s);
        return "kind" in p ? <Badge tone="accent">{MOVE_LABEL[p.kind]}</Badge> : <span className="text-sm text-muted">{p.skip}</span>;
      },
      value: (s) => {
        const p = plan(s);
        return "kind" in p ? MOVE_LABEL[p.kind] : p.skip;
      },
    },
    { key: "age", header: tr("Age"), width: "8rem", hideBelow: "lg", cell: (s) => age(s.created), value: (s) => s.created },
  ];

  const st = svc ? hostState(svc) : null;
  const n = servers.data?.length ?? 0;
  return (
    <>
      <Link to={HOSTS} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-4" />
        {tr("Hypervisors")}
      </Link>
      <PageHeader
        title={host}
        description={
          !svc
            ? services.isPending
              ? tr("Loading…")
              : tr("No nova-compute service on this host.")
            : down
              ? tr("The host is down: its instances can't be live-migrated. Evacuate rebuilds them on other hosts from their disks (shared storage or volumes) or images.")
              : svc.status === "disabled"
                ? tr("In maintenance: {reason}. New instances won't land here; drain it to move the instances it still runs.", { reason: svc.disabled_reason || tr("no reason given") })
                : tr("In service. Start maintenance before draining, or the scheduler may place instances back here.")
        }
        actions={
          svc && (
            <>
              {svc.status === "enabled" && !svc.forced_down ? (
                <Button onClick={() => setOpen("start")}>
                  <Icon name="wrench" />
                  {tr("Start maintenance")}
                </Button>
              ) : (
                <Button onClick={() => setOpen("end")}>
                  <Icon name="play" />
                  {tr("End maintenance")}
                </Button>
              )}
              {down ? (
                <Button variant="primary" disabled={!n} onClick={() => setOpen("evacuate")}>
                  <Icon name="life-buoy" />
                  {tr("Evacuate")}
                </Button>
              ) : (
                <Button variant="primary" disabled={!n} onClick={() => setOpen("drain")}>
                  <Icon name="arrow-right-left" />
                  {tr("Drain host")}
                </Button>
              )}
            </>
          )
        }
      />
      <ErrorNotice error={services.error ?? servers.error} className="mb-4" />
      {svc && st && (
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <StatusDot status={st.status} label={st.label} />
          <span className="text-muted">
            {tr("Zone")} <span className="text-ink">{svc.zone}</span>
          </span>
          <span className="text-muted">
            {tr("Last report")} <span className="text-ink">{fmtDate(svc.updated_at)}</span>
          </span>
          <span className="text-muted">
            {tr("Instances")} <span className="text-ink tabular-nums">{servers.isPending ? "…" : n}</span>
          </span>
        </div>
      )}
      {svc && <HostCapacity host={host} className="mb-4" />}
      {run && run.jobs.length > 0 && <RunCard run={run} projectName={projectName} />}
      <Card title={tr("Instances on {host}", { host })} flush className="mt-4">
        <div className="p-3">
          <DataTable
            rows={servers.data}
            columns={columns}
            rowKey={(s) => s.id}
            loading={servers.isPending}
            loadingMore={servers.partial}
            tableId="admin-host-instances"
            noun={tr("instances")}
            rowLabel={(s) => s.name}
            empty={tr("No instances on this host.")}
            onRefresh={() => servers.refetch()}
            refreshing={servers.isFetching}
            onBulkDone={() => toast(tr("Moves queued; progress shows above"))}
            bulkActions={
              down
                ? [
                    {
                      id: "evacuate",
                      label: tr("Evacuate"),
                      icon: "life-buoy",
                      title: tr("Evacuate instances?"),
                      past: tr("queued"),
                      body: tr("Each instance is rebuilt on another host. Only do this when {host} is really down (fenced), or the instances may run twice.", { host }),
                      check: (s) => busyJob(s) ?? ("kind" in evacuatePlan(s) ? true : (evacuatePlan(s) as { skip: string }).skip),
                      run: queue("evacuate"),
                    },
                  ]
                : [
                    {
                      id: "live",
                      label: tr("Live migrate"),
                      icon: "arrow-right-left",
                      title: tr("Live-migrate instances?"),
                      past: tr("queued"),
                      body: tr("Instances keep running while they move; the scheduler picks the destination. Progress shows above the list."),
                      check: (s) => busyJob(s) ?? (s["OS-EXT-STS:task_state"] ? tr("Busy") : !["ACTIVE", "PAUSED"].includes(s.status) ? tr("Only running or paused instances") : true),
                      run: queue("live"),
                    },
                    {
                      id: "cold",
                      label: tr("Cold migrate"),
                      icon: "move-right",
                      title: tr("Cold-migrate instances?"),
                      past: tr("queued"),
                      body: tr("Running instances are shut down, moved and started again; the move is confirmed automatically."),
                      check: (s) => busyJob(s) ?? (s["OS-EXT-STS:task_state"] ? tr("Busy") : !["ACTIVE", "SHUTOFF"].includes(s.status) ? tr("Only active or stopped instances") : true),
                      run: queue("cold"),
                    },
                    {
                      id: "confirm",
                      label: tr("Confirm resize"),
                      icon: "check",
                      title: tr("Confirm migrations?"),
                      past: tr("confirmed"),
                      check: (s) => (s.status === "VERIFY_RESIZE" ? true : tr("Not waiting for confirmation")),
                      run: (s) => serverAction(s.id, { confirmResize: null }),
                    },
                  ]
            }
          />
        </div>
      </Card>
      {open === "start" && svc && <StartDialog s={svc} onClose={() => setOpen(null)} />}
      {open === "end" && svc && <EndDialog s={svc} busy={active} onClose={() => setOpen(null)} />}
      {(open === "drain" || open === "evacuate") && svc && (
        <DrainDialog svc={svc} evacuate={open === "evacuate"} servers={servers.data ?? []} loading={servers.isPending || !!servers.partial} computes={services.data ?? []} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

function JobState({ j }: { j: MoveJob }) {
  if (j.state === "queued") return <StatusDot status="off" label={tr("Queued")} />;
  if (j.state === "running")
    return (
      <span className="inline-flex min-w-0 items-center gap-2">
        <StatusDot status="warn" label={j.step ?? tr("Moving")} />
        {j.progress != null && <span className="text-xs text-muted tabular-nums">{j.progress}%</span>}
      </span>
    );
  if (j.state === "done") return <StatusDot status="ok" label={tr("Moved to {host}", { host: j.to ?? "?" })} />;
  if (j.state === "cancelled") return <StatusDot status="off" label={tr("Cancelled")} />;
  return <StatusDot status="error" label={tr("Failed")} />;
}

function RunCard({ run, projectName }: { run: HostRun; projectName: (id: string) => string }) {
  const s = runSummary(run)!;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await f();
      toast(ok);
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const retry = (j: MoveJob) =>
    os
      .get<{ server: Server }>("compute", `servers/${j.id}`)
      .then((r) => startMoves(run.host, [{ server: r.server, kind: j.kind }], { target: j.target }))
      .catch((e) => toast(errText(e), "error"));
  const pct = Math.round(((s.done + s.failed) / s.total) * 100);
  const columns: Column<MoveJob>[] = [
    {
      key: "name",
      header: tr("Instance"),
      cell: (j) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{j.name}</span>
          <span className="truncate text-xs text-muted">{projectName(j.project)}</span>
        </span>
      ),
      value: (j) => j.name,
    },
    { key: "kind", header: tr("Move"), width: "8rem", cell: (j) => MOVE_LABEL[j.kind], value: (j) => MOVE_LABEL[j.kind] },
    { key: "state", header: tr("State"), width: "14rem", wrap: true, cell: (j) => <JobState j={j} />, value: (j) => j.state },
    {
      key: "detail",
      header: tr("Details"),
      cell: (j) => <span className={j.state === "failed" ? "text-led-red" : "text-muted"}>{j.message ?? (j.target ? tr("To {host}", { host: j.target }) : "")}</span>,
      value: (j) => j.message ?? "",
    },
    {
      key: "time",
      header: tr("Took"),
      width: "7rem",
      hideBelow: "lg",
      cell: (j) => (j.started && j.finished ? `${Math.max(1, Math.round((j.finished - j.started) / 1000))} s` : ""),
      value: (j) => (j.started && j.finished ? j.finished - j.started : 0),
    },
  ];
  return (
    <Card
      title={s.left ? tr("Moving instances off {host}", { host: run.host }) : tr("Last moves off {host}", { host: run.host })}
      flush
      actions={
        <>
          {s.left > 0 && run.jobs.some((j) => j.state === "queued") && (
            <Button className="h-8 px-2.5" onClick={() => cancelQueued(run.host)}>
              {tr("Cancel queued")}
            </Button>
          )}
          {s.total > s.left && (
            <Button className="h-8 px-2.5" variant="ghost" onClick={() => clearFinished(run.host)}>
              {tr("Clear finished")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-2 px-5 pt-4">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
          <span>
            <span className="font-semibold tabular-nums">{s.done}</span> {tr("moved")}
          </span>
          {s.failed > 0 && (
            <span className="text-led-red">
              <span className="font-semibold tabular-nums">{s.failed}</span> {tr("failed")}
            </span>
          )}
          {s.left > 0 && (
            <span className="text-muted">
              <span className="font-semibold tabular-nums">{s.left}</span> {tr("to go, {n} at a time", { n: run.concurrency })}
            </span>
          )}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-ink/8" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={s.failed ? "h-full bg-led-amber transition-all" : "h-full bg-cable transition-all"} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="p-3">
        <DataTable
          rows={run.jobs}
          columns={columns}
          rowKey={(j) => j.id}
          tableId="admin-host-moves"
          noun={tr("moves")}
          rowLabel={(j) => j.name}
          rowActions={(j) => [
            j.state === "running" &&
              j.kind === "live" && {
                label: tr("Force complete"),
                icon: "check",
                disabled: busy || !j.migrationId ? tr("Waiting for the migration to start") : false,
                onSelect: () => act(() => forceComplete(j), tr("{name}: forcing completion", { name: j.name })),
              },
            j.state === "running" &&
              j.kind === "live" && {
                label: tr("Abort migration"),
                icon: "x",
                danger: true,
                disabled: busy || !j.migrationId ? tr("Waiting for the migration to start") : false,
                onSelect: () => act(() => abortMigration(j), tr("{name}: aborting", { name: j.name })),
              },
            (j.state === "failed" || j.state === "cancelled") && { label: tr("Retry"), icon: "rotate-ccw", onSelect: () => retry(j) },
            { label: tr("Open instance"), icon: "external-link", onSelect: () => window.open(`/admin/compute/instances/${j.id}`, "_blank", "noopener") },
          ]}
        />
      </div>
    </Card>
  );
}

function DrainDialog({
  svc,
  evacuate,
  servers,
  loading,
  computes,
  onClose,
}: {
  svc: ComputeService;
  evacuate: boolean;
  servers: Server[];
  loading: boolean;
  computes: ComputeService[];
  onClose: () => void;
}) {
  const [cold, setCold] = useState(true);
  const [disable, setDisable] = useState(svc.status === "enabled");
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState("");
  const [concurrency, setConcurrency] = useState(2);
  const plans = servers.map((s) => ({ s, p: evacuate ? evacuatePlan(s) : drainPlan(s, { cold }) }));
  const moves = plans.flatMap(({ s, p }) => ("kind" in p ? [{ server: s, kind: p.kind }] : []));
  const skipped = plans.flatMap(({ s, p }) => ("skip" in p ? [{ s, why: p.skip }] : []));
  const by = (k: MoveKind) => moves.filter((m) => m.kind === k).length;
  const dests = computes.filter((c) => c.host !== svc.host);
  const canEvacuate = !evacuate || isDown(svc);
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      danger={evacuate}
      title={evacuate ? tr("Evacuate {host}", { host: svc.host }) : tr("Drain {host}", { host: svc.host })}
      description={
        evacuate
          ? tr("Rebuilds each instance on another host. Only do this when the host is really down (fenced), or instances may run twice.")
          : tr("Moves the instances to other hosts, {n} at a time, and follows each one until it has landed.", { n: concurrency })
      }
      submitLabel={evacuate ? tr("Evacuate {n}", { n: moves.length }) : tr("Move {n}", { n: moves.length })}
      canSubmit={!loading && moves.length > 0 && canEvacuate}
      done={tr("{n} instance(s) queued", { n: moves.length })}
      refresh={["compute"]}
      run={async () => {
        // svc may have been disabled since the dialog opened (Start maintenance → drain).
        if (disable && !evacuate && svc.status === "enabled") await putService(svc, { status: "disabled", disabled_reason: reason.trim() || "Maintenance (Rassvet)" });
        startMoves(svc.host, moves, { target, concurrency });
      }}
    >
      {loading ? (
        <p className="text-sm text-muted">{tr("Loading the host's instances…")}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {evacuate ? (
            <li>
              <span className="font-semibold tabular-nums">{by("evacuate")}</span> {tr("to evacuate")}
            </li>
          ) : (
            <>
              <li>
                <span className="font-semibold tabular-nums">{by("live")}</span> {tr("to live-migrate (keep running)")}
              </li>
              <li>
                <span className="font-semibold tabular-nums">{by("cold")}</span> {tr("to cold-migrate (moved powered off, confirmed automatically)")}
              </li>
            </>
          )}
          {skipped.length > 0 && (
            <li>
              <details>
                <summary className="cursor-pointer text-led-amber">{tr("{n} left on the host", { n: skipped.length })}</summary>
                <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto pl-4 text-xs text-muted">
                  {skipped.map(({ s, why }) => (
                    <li key={s.id}>
                      <span className="text-ink">{s.name}</span> — {why}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          )}
        </ul>
      )}
      {evacuate && !canEvacuate && <p className="text-sm text-led-red">{tr("Nova only evacuates from a host whose compute service is down or forced down.")}</p>}
      {!evacuate && svc.status === "enabled" && (
        <div className="space-y-2">
          <Switch checked={disable} onChange={setDisable} label={tr("Disable {host} first", { host: svc.host })} hint={tr("Otherwise the scheduler may place new or moved instances back on it.")} />
          {disable && (
            <Field label={tr("Reason")}>{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} placeholder={tr("Maintenance")} />}</Field>
          )}
        </div>
      )}
      {!evacuate && (
        <Switch
          checked={cold}
          onChange={setCold}
          label={tr("Cold-migrate what can't live-migrate")}
          hint={tr("Stopped instances, and confidential (SEV/TDX) or vTPM guests that can't move while running. Off: they stay on the host.")}
        />
      )}
      <Field label={tr("Destination")} hint={tr("Automatic lets the scheduler pick a host with room for each instance.")}>
        {(id) => (
          <Picker
            id={id}
            value={target}
            onChange={setTarget}
            searchable
            options={[
              { value: "", label: tr("Automatic"), icon: "gauge" },
              ...dests.map((c) => ({
                value: c.host,
                label: c.host,
                icon: "server",
                description: c.zone,
                disabled: c.forced_down || c.state === "down" ? tr("Down") : c.status === "disabled" ? tr("Disabled") : false,
              })),
            ]}
          />
        )}
      </Field>
      <Field label={tr("At a time")} hint={tr("Parallel moves. Live migrations compete for network bandwidth; 2 is a safe start.")}>
        {(id) => (
          <Select id={id} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} className="w-24">
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </ActionDialog>
  );
}
