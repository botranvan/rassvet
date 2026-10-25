/** Progress of a host's drain / evacuation run as a small badge (Hypervisors list, host page). */
import { Badge } from "@/components/ui";
import type { HostRun, MoveJob } from "@/lib/drain";
import { tr } from "@/lib/i18n";

export function runSummary(r?: HostRun) {
  if (!r?.jobs.length) return null;
  const n = (st: MoveJob["state"]) => r.jobs.filter((j) => j.state === st).length;
  const done = n("done");
  const failed = n("failed");
  const left = n("queued") + n("running");
  return { done, failed, left, total: r.jobs.length };
}

export function RunBadge({ run }: { run?: HostRun }) {
  const s = runSummary(run);
  if (!s) return null;
  if (s.left) return <Badge tone="accent">{tr("Moving {done}/{total}", { done: s.done + s.failed, total: s.total })}</Badge>;
  if (s.failed) return <Badge tone="warn">{tr("{n} failed", { n: s.failed })}</Badge>;
  return <Badge>{tr("{n} moved", { n: s.done })}</Badge>;
}
