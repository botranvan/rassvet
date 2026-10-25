/**
 * Host maintenance pieces shared by the Hypervisors list and a host's page: host state,
 * instance count, and the Start / End maintenance dialogs (disable / enable nova-compute).
 */
import { useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { useNavigate } from "@/components/Link";
import { Field, Input, Switch } from "@/components/ui";
import { limiter } from "@/lib/limiter";
import { os } from "@/lib/os";
import { tr } from "@/lib/i18n";
import type { ComputeService } from "./ComputeAdmin";

export const HOSTS = "/admin/compute/hypervisors";
/** A compute host's page, optionally opening a dialog (`?start=1`, `?drain=1`, `?evacuate=1`). */
export const hostPath = (host: string, action?: "start" | "drain" | "evacuate") => `${HOSTS}/${encodeURIComponent(host)}${action ? `?${action}=1` : ""}`;

const slot = limiter(4);

/** The host can't run instances: Nova lets you evacuate it. */
export const isDown = (s?: ComputeService) => !!s && (s.forced_down || s.state === "down");

export function hostState(s: ComputeService): { status: "ok" | "warn" | "error"; label: string } {
  if (s.forced_down) return { status: "error", label: tr("forced down") };
  if (s.state === "down") return { status: "error", label: s.status === "disabled" ? tr("down, disabled") : tr("down") };
  if (s.status === "disabled") return { status: "warn", label: tr("in maintenance") };
  return { status: "ok", label: tr("in service") };
}

export const hostServers = (host: string, signal?: AbortSignal) =>
  slot(() => os.list<{ id: string }>("compute", "servers", "servers", { all_tenants: 1, host }), { signal });

export const putService = (s: ComputeService, body: object) => os.put("compute", `os-services/${s.id}`, body);

export function StartDialog({ s, onClose }: { s: ComputeService; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [drain, setDrain] = useState(!isDown(s));
  const navigate = useNavigate();
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Start maintenance on {host}?", { host: s.host })}
      submitLabel={drain ? tr("Disable and drain") : tr("Start maintenance")}
      done={tr("{host} is in maintenance", { host: s.host })}
      refresh={["compute"]}
      run={() => putService(s, { status: "disabled", disabled_reason: reason.trim() || "Maintenance (Rassvet)" })}
      onDone={() => drain && navigate(hostPath(s.host, "drain"))}
    >
      <p className="text-sm">{tr("Disables nova-compute on the host: the scheduler stops placing new instances there. Instances already on it keep running until you move them.")}</p>
      <Field label={tr("Reason")} hint={tr("Shown to other admins, e.g. “Firmware update, back at 18:00”.")}>
        {(id) => <Input id={id} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} placeholder={tr("Maintenance")} />}
      </Field>
      {!isDown(s) && <Switch checked={drain} onChange={setDrain} label={tr("Then drain the host")} hint={tr("Opens the drain dialog to move its instances to other hosts.")} />}
    </ActionDialog>
  );
}

export function EndDialog({ s, busy, onClose }: { s: ComputeService; busy: boolean; onClose: () => void }) {
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("End maintenance on {host}?", { host: s.host })}
      submitLabel={tr("End maintenance")}
      done={tr("{host} is back in service", { host: s.host })}
      refresh={["compute"]}
      run={async () => {
        if (s.forced_down) await putService(s, { forced_down: false });
        await putService(s, { status: "enabled" });
      }}
    >
      <p className="text-sm">
        {s.forced_down
          ? tr("Clears “forced down” and enables the host: Nova trusts its heartbeat again and the scheduler may place new instances on it. Make sure nova-compute is running.")
          : tr("Enables the host: the scheduler may place new instances on it again. Instances moved away stay where they are.")}
      </p>
      {busy && <p className="text-sm text-led-amber">{tr("Instances are still being moved off this host; they may be scheduled back here once it's enabled.")}</p>}
    </ActionDialog>
  );
}
