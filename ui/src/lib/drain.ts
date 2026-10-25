/**
 * Moving instances off a compute host (host maintenance): live migration, cold migration
 * (confirmed automatically) and evacuation, a few at a time, each followed until the
 * instance has landed on another host or failed.
 *
 * Runs live in a module-level store, not in a component, so they keep going while the admin
 * looks at other pages (but not across a page reload: moves already requested continue in
 * Nova, queued ones don't start).
 */
import { useSyncExternalStore } from "react";
import { ApiError } from "./api";
import { limiter } from "./limiter";
import { type Server, os, serverAction, serverLabel } from "./os";
import { tr } from "@/lib/i18n";

export type MoveKind = "live" | "cold" | "evacuate";

export interface MoveJob {
  /** Server id. */
  id: string;
  name: string;
  project: string;
  kind: MoveKind;
  /** Host the instance was on when the job was queued. */
  from: string;
  /** Requested destination; undefined lets the scheduler pick. */
  target?: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  /** What is happening now, in words ("Migrating", "Confirming"). */
  step?: string;
  /** Live migration: memory copied so far, 0–100. */
  progress?: number;
  /** Live migration in progress (for abort / force complete). */
  migrationId?: number;
  /** Host it ended up on. */
  to?: string;
  message?: string;
  started?: number;
  finished?: number;
}

export interface HostRun {
  host: string;
  concurrency: number;
  jobs: MoveJob[];
  started: number;
}

const runs = new Map<string, HostRun>();
const controllers = new Map<string, AbortController>();
const slots = new Map<string, ReturnType<typeof limiter>>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function update(host: string, id: string, patch: Partial<MoveJob>) {
  const run = runs.get(host);
  if (!run) return;
  run.jobs = run.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
  runs.set(host, { ...run });
  emit();
}

export const isActive = (j: MoveJob) => j.state === "queued" || j.state === "running";
export const runActive = (r?: HostRun) => !!r?.jobs.some(isActive);

/** The run of one host (re-renders on every change). */
export function useHostRun(host: string) {
  return useSyncExternalStore(subscribe, () => runs.get(host));
}

/** Every run, keyed by host (for the hosts list). */
export function useRuns() {
  useSyncExternalStore(subscribe, () => version);
  return runs;
}

// Closing the tab stops queued moves: ask first while any run is busy.
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (e) => {
    if ([...runs.values()].some(runActive)) e.preventDefault();
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const TIMEOUT = 60 * 60 * 1000;
const POLL = 3000;

export interface MoveRequest {
  server: Server;
  kind: MoveKind;
}

/**
 * Queue moves of instances off `host`. Instances already queued or moving are left alone;
 * finished jobs of the same instances are replaced (retry).
 */
export function startMoves(host: string, moves: MoveRequest[], opts: { target?: string; concurrency?: number } = {}) {
  const prev = runs.get(host);
  const busy = new Set(prev?.jobs.filter(isActive).map((j) => j.id));
  const fresh: MoveJob[] = moves
    .filter((m) => !busy.has(m.server.id))
    .map((m) => ({
      id: m.server.id,
      name: m.server.name,
      project: m.server.tenant_id,
      kind: m.kind,
      from: m.server["OS-EXT-SRV-ATTR:host"] ?? host,
      target: opts.target || undefined,
      state: "queued",
    }));
  if (!fresh.length) return 0;
  const ids = new Set(fresh.map((j) => j.id));
  const concurrency = opts.concurrency ?? prev?.concurrency ?? 2;
  if (!prev || !runActive(prev) || prev.concurrency !== concurrency) {
    // A new limiter when idle (or the concurrency changed): earlier queued jobs keep their own.
    slots.set(host, limiter(concurrency));
  }
  if (!controllers.get(host) || controllers.get(host)!.signal.aborted) controllers.set(host, new AbortController());
  runs.set(host, {
    host,
    concurrency,
    started: prev && runActive(prev) ? prev.started : Date.now(),
    jobs: [...(prev?.jobs.filter((j) => !ids.has(j.id)) ?? []), ...fresh],
  });
  emit();
  const slot = slots.get(host)!;
  const signal = controllers.get(host)!.signal;
  for (const j of fresh)
    slot(() => follow(host, j), { signal }).catch(() => {
      if (runs.get(host)?.jobs.find((x) => x.id === j.id)?.state === "queued") update(host, j.id, { state: "cancelled", message: tr("Cancelled before it started") });
    });
  return fresh.length;
}

/** Stop starting queued moves (moves already running carry on in Nova). */
export function cancelQueued(host: string) {
  controllers.get(host)?.abort();
  const run = runs.get(host);
  if (!run) return;
  runs.set(host, { ...run, jobs: run.jobs.map((j) => (j.state === "queued" ? { ...j, state: "cancelled", message: tr("Cancelled before it started") } : j)) });
  emit();
}

/** Forget finished jobs of a host. */
export function clearFinished(host: string) {
  const run = runs.get(host);
  if (!run) return;
  const jobs = run.jobs.filter(isActive);
  if (jobs.length) runs.set(host, { ...run, jobs });
  else runs.delete(host);
  emit();
}

function body(j: MoveJob) {
  if (j.kind === "live") return { "os-migrateLive": { host: j.target ?? null, block_migration: "auto" } };
  if (j.kind === "cold") return { migrate: j.target ? { host: j.target } : null };
  return { evacuate: j.target ? { host: j.target } : {} };
}

const getServer = (id: string) => os.get<{ server: Server }>("compute", `servers/${id}`).then((r) => r.server);

interface Migration {
  id: number;
  status: string;
  migration_type?: string;
  created_at?: string;
  dest_compute?: string | null;
  memory_total_bytes?: number | null;
  memory_processed_bytes?: number | null;
}

/** Status of the instance's latest migration started by this job, or null (none yet / not allowed). */
async function lastMigration(j: MoveJob) {
  try {
    const r = await os.get<{ migrations: Migration[] }>("compute", "os-migrations", { instance_uuid: j.id });
    const last = [...r.migrations].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0];
    // Older migrations of the instance don't count (allow for clock skew).
    const t = last?.created_at ? new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(last.created_at) ? last.created_at : `${last.created_at}Z`).getTime() : 0;
    return last && t >= (j.started ?? 0) - 120_000 ? last.status : null;
  } catch {
    return null;
  }
}

const FAILED = new Set(["error", "failed", "cancelled"]);

const notMoved = (host: string, status: string | null) =>
  status
    ? tr("Still on {host}: migration {status}. The instance's action log has the details.", { host, status })
    : tr("Still on {host}: the scheduler found no other host, or the move was refused. The instance's action log has the details.", { host });

async function follow(host: string, j: MoveJob) {
  update(host, j.id, { state: "running", step: tr("Requesting"), started: Date.now() });
  const fail = (message: string) => update(host, j.id, { state: "failed", step: undefined, message, finished: Date.now(), progress: undefined, migrationId: undefined });
  try {
    await serverAction(j.id, body(j));
  } catch (e) {
    return fail(errText(e));
  }
  const deadline = Date.now() + TIMEOUT;
  let sawBusy = false;
  let settled = 0;
  let errors = 0;
  while (Date.now() < deadline) {
    await sleep(POLL);
    let s: Server;
    try {
      s = await getServer(j.id);
      errors = 0;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return fail(tr("The instance was deleted"));
      if (++errors >= 5) return fail(errText(e));
      continue;
    }
    const now = s["OS-EXT-SRV-ATTR:host"] ?? "";
    const task = s["OS-EXT-STS:task_state"];
    if (s.status === "ERROR") return fail(s.fault?.message || tr("The instance went to ERROR"));
    if (s.status === "VERIFY_RESIZE" && !task) {
      // Cold migration done: confirm it so the source host frees the resources.
      update(host, j.id, { step: tr("Confirming") });
      try {
        await serverAction(j.id, { confirmResize: null });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) return fail(errText(e));
      }
      sawBusy = true;
      continue;
    }
    if (task || ["MIGRATING", "RESIZE", "REBUILD"].includes(s.status)) {
      sawBusy = true;
      settled = 0;
      const patch: Partial<MoveJob> = { step: serverLabel(s) };
      if (j.kind === "live" && s.status === "MIGRATING") {
        try {
          const m = (await os.get<{ migrations: Migration[] }>("compute", `servers/${j.id}/migrations`)).migrations[0];
          if (m) {
            patch.migrationId = m.id;
            if (m.memory_total_bytes) patch.progress = Math.min(100, Math.round(((m.memory_processed_bytes ?? 0) / m.memory_total_bytes) * 100));
          }
        } catch {
          /* progress is optional */
        }
      }
      update(host, j.id, patch);
      continue;
    }
    if (now && now !== j.from) return update(host, j.id, { state: "done", step: undefined, to: now, finished: Date.now(), progress: undefined, migrationId: undefined, message: undefined });
    // Settled on the same host: Nova gave up (live migrations fail asynchronously), or hasn't
    // picked the request up yet. The migration record tells; without one, allow a few polls.
    const mig = await lastMigration(j);
    if ((mig && FAILED.has(mig)) || sawBusy || ++settled >= 4) return fail(notMoved(now || j.from, mig));
  }
  fail(tr("No result after 60 minutes; check the instance."));
}

/** Abort a live migration in progress (Nova 2.24+). */
export const abortMigration = (j: MoveJob) => os.del("compute", `servers/${j.id}/migrations/${j.migrationId}`);
/** Pause the guest so a live migration that can't keep up with memory writes completes (2.22+). */
export const forceComplete = (j: MoveJob) => os.action("compute", `servers/${j.id}/migrations/${j.migrationId}`, { force_complete: null });

// --------------------------------------------------------------------------- planning

const LIVE_STATES = new Set(["ACTIVE", "PAUSED"]);

/** Can't live-migrate: SEV/TDX guests, and vTPMs whose secret the user holds. */
export function liveBlocker(s: Server): string | null {
  const x = s.flavor?.extra_specs ?? {};
  if ((x["hw:mem_encryption"] ?? "").toLowerCase() === "true" || x["hw:mem_encryption_model"]) return tr("Confidential computing (SEV/TDX) can't live-migrate");
  if (x["hw:tpm_version"] && x["hw:tpm_secret_security"] !== "host") return tr("vTPM with a user-held secret can't live-migrate");
  return null;
}

export type Plan = { kind: MoveKind } | { skip: string };

/** What draining does with an instance on a host that is up. */
export function drainPlan(s: Server, opts: { cold: boolean }): Plan {
  const task = s["OS-EXT-STS:task_state"];
  if (task) return { skip: tr("Busy: {task}", { task: serverLabel(s) }) };
  if (s.status === "SHELVED_OFFLOADED") return { skip: tr("Shelved: not on a host") };
  if (s.status === "ERROR") return { skip: tr("In ERROR: reset its state first") };
  if (s.status === "VERIFY_RESIZE") return { skip: tr("Waiting for resize confirmation") };
  if (LIVE_STATES.has(s.status)) {
    const why = liveBlocker(s);
    if (!why) return { kind: "live" };
    if (s.status === "ACTIVE" && opts.cold) return { kind: "cold" };
    return { skip: why };
  }
  if (s.status === "SHUTOFF") return opts.cold ? { kind: "cold" } : { skip: tr("Stopped (cold migration is off)") };
  if (s.status === "SUSPENDED") return { skip: tr("Suspended: resume or stop it first") };
  return { skip: tr("Can't be moved while {status}", { status: s.status }) };
}

/** What evacuating does with an instance on a host that is down. */
export function evacuatePlan(s: Server): Plan {
  if (s["OS-EXT-STS:task_state"]) return { skip: tr("Busy: {task}", { task: serverLabel(s) }) };
  if (s.status === "SHELVED_OFFLOADED") return { skip: tr("Shelved: not on a host") };
  if (["ACTIVE", "SHUTOFF", "ERROR"].includes(s.status)) return { kind: "evacuate" };
  return { skip: tr("Can't be evacuated while {status}", { status: s.status }) };
}

export const MOVE_LABEL: Record<MoveKind, string> = {
  live: tr("Live migrate"),
  cold: tr("Cold migrate"),
  evacuate: tr("Evacuate"),
};
