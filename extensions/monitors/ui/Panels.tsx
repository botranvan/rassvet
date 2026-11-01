/** The chart grid of one target (instance, physical server or project) and the time range bar. */
import { useEffect, useState } from "react";
import { Button, Card, ErrorNotice, Field, Icon, Input, Picker, tr } from "@rassvet/sdk";
import { type Kind, type Panel, type Range, type Target, usePanels, useSeries } from "./api";
import { Chart } from "./Chart";
import { type RangeSpec, formatSpec, fromLocalInput, presetsFor, toLocalInput } from "./range";

export function PanelGrid({ target, range }: { target: Target; range: Range }) {
  const panels = usePanels(target.kind);
  if (panels.error) return <ErrorNotice error={panels.error} />;
  if (!panels.data) return <p className="text-sm text-muted">{tr("Loading…")}</p>;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {panels.data.map((p) => (
        <PanelCard key={`${p.kind}:${p.id}`} panel={p} target={target} range={range} />
      ))}
    </div>
  );
}

function PanelCard({ panel, target, range }: { panel: Panel; target: Target; range: Range }) {
  const q = useSeries(target, panel.id, range, false);
  const series = (q.data?.series ?? []).map((s) => ({
    ...s,
    name: [tr(s.query), ...Object.values(s.labels)].join(" "),
  }));
  return (
    <Card
      title={tr(panel.title)}
      actions={q.isFetching ? <Icon name="refresh" className="size-3.5 animate-spin text-muted" /> : undefined}
    >
      {q.error ? (
        <ErrorNotice error={q.error} />
      ) : !q.data ? (
        <div className="h-[190px] animate-pulse rounded-md bg-surface" />
      ) : series.length === 0 ? (
        <p className="flex h-[120px] items-center justify-center text-sm text-muted">{tr("No data in this time range")}</p>
      ) : (
        <>
          <Chart series={series} unit={panel.unit} range={{ start: q.data.start, end: q.data.end }} step={q.data.step} />
          {q.data.hidden > 0 && (
            <p className="mt-2 text-xs text-muted">{tr("{n} quieter series not shown", { n: q.data.hidden })}</p>
          )}
        </>
      )}
    </Card>
  );
}

const CUSTOM = "custom";

/** Preset ranges within the session's limit, a custom from / to, and refresh. */
export function RangeBar({
  spec,
  maxDays,
  onChange,
  onRefresh,
}: {
  spec: RangeSpec;
  maxDays: number;
  onChange: (s: RangeSpec) => void;
  onRefresh: () => void;
}) {
  const isCustom = !("preset" in spec);
  const [custom, setCustom] = useState(isCustom);
  const now = Math.floor(Date.now() / 1000);
  const [from, setFrom] = useState(toLocalInput(isCustom ? spec.start : now - 86400));
  const [to, setTo] = useState(toLocalInput(isCustom ? spec.end : now));
  useEffect(() => setCustom(isCustom), [isCustom]);

  const start = fromLocalInput(from);
  const end = fromLocalInput(to);
  const oldest = now - maxDays * 86400;
  const problem =
    start === null || end === null
      ? tr("Enter a start and an end")
      : start >= end
        ? tr("The end must be after the start")
        : start < oldest
          ? tr("You can look back at most {n} days", { n: maxDays })
          : null;

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label={tr("Time range")}>
        {(id) => (
        <Picker
          id={id}
          className="w-52"
          value={custom ? CUSTOM : formatSpec(spec)}
          onChange={(v) => {
            if (v === CUSTOM) return setCustom(true);
            setCustom(false);
            const p = presetsFor(maxDays).find((x) => x.id === v);
            if (p) onChange({ preset: p });
          }}
          options={[
            ...presetsFor(maxDays).map((p) => ({ value: p.id, label: p.label })),
            { value: CUSTOM, label: tr("Custom range…"), icon: "history" },
          ]}
        />
        )}
      </Field>
      {custom && (
        <>
          <Field label={tr("From")}>
            {(id) => <Input id={id} type="datetime-local" value={from} min={toLocalInput(oldest)} onChange={(e) => setFrom(e.target.value)} />}
          </Field>
          <Field label={tr("To")}>
            {(id) => <Input id={id} type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />}
          </Field>
          <Button disabled={!!problem} title={problem ?? undefined} onClick={() => start !== null && end !== null && onChange({ start, end })}>
            {tr("Apply")}
          </Button>
        </>
      )}
      <Button onClick={onRefresh} title={tr("Refresh")} aria-label={tr("Refresh")}>
        <Icon name="refresh" />
      </Button>
      {custom && problem && <p className="basis-full text-xs text-muted">{problem}</p>}
    </div>
  );
}

/** "Now" for preset ranges: moves on every minute and on refresh. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => clearInterval(t);
  }, []);
  return [now, () => setNow(Date.now() / 1000)] as const;
}

export type { Kind };
