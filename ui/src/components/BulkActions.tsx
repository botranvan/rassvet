import { type ReactNode, useState } from "react";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Dialog } from "./Dialog";
import { useToast } from "./Toast";
import { Button, Icon } from "./ui";
import { tr } from "@/lib/i18n";

/** An action that can run on several selected rows of a DataTable. */
export interface BulkAction<T> {
  id: string;
  /** Button label in the selection bar, e.g. "Delete". */
  label: string;
  icon?: string;
  danger?: boolean;
  /** `true` when the action applies to the row, else the reason it is skipped. */
  check?: (row: T) => true | string;
  /** Performs the action on one row. Errors are reported per row. */
  run: (row: T) => Promise<unknown>;
  /** Dialog title, e.g. "Delete images?". */
  title: string;
  /** Extra explanation shown above the list (consequences, irreversibility). */
  body?: ReactNode;
  /** Past-tense verb for the summary, e.g. "deleted". */
  past: string;
  /**
   * Show the action inside a dropdown button with this label (e.g. "Instance actions")
   * instead of as its own button. Actions with the same label share one dropdown.
   */
  menu?: string;
  /** In a dropdown: draw a separator before this action. */
  divider?: boolean;
}

type RowState = { state: "pending" | "running" | "ok" | "skipped" | "error"; message?: string };

const CONCURRENCY = 4;

/**
 * Confirms a bulk action, then runs it with limited concurrency and shows the result
 * of every row. Rows the action doesn't apply to are listed as skipped with the reason.
 */
export function BulkActionDialog<T>({
  action,
  rows,
  rowKey,
  rowLabel,
  noun,
  onClose,
  onFinished,
}: {
  action: BulkAction<T>;
  rows: T[];
  rowKey: (r: T) => string;
  rowLabel: (r: T) => string;
  /** Plural noun for messages, e.g. "images". */
  noun: string;
  onClose: () => void;
  /** Called once with the keys that succeeded. */
  onFinished: (ok: string[]) => void;
}) {
  const toast = useToast();
  const [states, setStates] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(
      rows.map((r) => {
        const c = action.check?.(r) ?? true;
        return [rowKey(r), c === true ? { state: "pending" } : { state: "skipped", message: c }];
      }),
    ),
  );
  const [phase, setPhase] = useState<"confirm" | "running" | "done">("confirm");

  const runnable = rows.filter((r) => states[rowKey(r)].state === "pending");
  const skipped = rows.length - runnable.length;
  const counts = Object.values(states).reduce<Record<string, number>>((m, s) => ((m[s.state] = (m[s.state] ?? 0) + 1), m), {});

  async function start() {
    setPhase("running");
    const queue = [...runnable];
    const ok: string[] = [];
    const set = (k: string, s: RowState) => setStates((m) => ({ ...m, [k]: s }));
    async function worker() {
      for (let r = queue.shift(); r; r = queue.shift()) {
        const k = rowKey(r);
        set(k, { state: "running" });
        try {
          await action.run(r);
          ok.push(k);
          set(k, { state: "ok" });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const rid = e instanceof ApiError && e.requestId ? tr(" (request {requestId})", { requestId: e.requestId }) : "";
          set(k, { state: "error", message: msg + rid });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    const failed = runnable.length - ok.length;
    toast(
      failed
        ? tr("{length} {noun} {past}, {failed} failed", { length: ok.length, noun, past: action.past, failed })
        : `${ok.length} ${ok.length === 1 ? noun.replace(/s$/, "") : noun} ${action.past}`,
      failed ? "error" : "success",
    );
    onFinished(ok);
    // Close automatically when everything worked; keep the dialog open to show failures.
    if (failed === 0) onClose();
    else setPhase("done");
  }

  return (
    <Dialog
      open
      onClose={phase === "running" ? () => {} : onClose}
      title={action.title}
      size="md"
      onSubmit={phase === "confirm" ? start : onClose}
      description={
        phase === "done"
          ? tr("{v} {past}, {v2} failed{v3}.", { v: counts.ok ?? 0, past: action.past, v2: counts.error ?? 0, v3: skipped ? tr(", {skipped} skipped", { skipped }) : "" })
          : skipped
            ? tr("{length} of {length2} selected {noun} will be {past}; {skipped} can't be and will be skipped.", { length: runnable.length, length2: rows.length, noun, past: action.past, skipped })
            : tr("{length} {v} will be {past}.", { length: rows.length, v: rows.length === 1 ? noun.replace(/s$/, "") : noun, past: action.past })
      }
      footer={
        phase === "done" ? (
          <Button type="submit" variant="primary">
            {tr("Close")}
          </Button>
        ) : (
          <>
            <Button type="button" onClick={onClose} disabled={phase === "running"}>
              {tr("Cancel")}
            </Button>
            <Button
              type="submit"
              variant={action.danger ? "danger" : "primary"}
              busy={phase === "running"}
              disabled={runnable.length === 0}
              autoFocus
            >
              {action.label} {runnable.length || ""}
            </Button>
          </>
        )
      }
    >
      {action.body && phase === "confirm" && <div className="text-sm">{action.body}</div>}
      <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line text-sm">
        {rows.map((r) => {
          const s = states[rowKey(r)];
          return (
            <li key={rowKey(r)} className="flex items-start gap-2.5 px-3 py-2">
              <StateIcon s={s.state} />
              <div className="min-w-0 flex-1">
                <p className={cn("truncate", s.state === "skipped" && "text-muted")} title={rowLabel(r)}>
                  {rowLabel(r)}
                </p>
                {s.message && (
                  <p className={cn("text-xs", s.state === "error" ? "text-led-red" : "text-muted")}>{s.message}</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

function StateIcon({ s }: { s: RowState["state"] }) {
  if (s === "running")
    return <span className="mt-0.5 size-4 shrink-0 animate-spin rounded-full border-2 border-cable border-r-transparent" />;
  const map: Record<string, [string, string]> = {
    pending: ["circle-dashed", "text-muted"],
    ok: ["circle-check", "text-led-green"],
    skipped: ["x", "text-muted"],
    error: ["warning", "text-led-red"],
  };
  const [name, cls] = map[s];
  return <Icon name={name} className={cn("mt-0.5", cls)} />;
}
