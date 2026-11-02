/** Single-value panels: stat tiles, gauges and a pie (donut) chart, from the last value of each series. */
import { useState } from "react";
import { tr } from "@rassvet/sdk";
import type { Series, Unit } from "./api";
import { seriesColor, useChartStyle } from "./Chart";
import { fmt } from "./units";

const last = (s: Series) => s.values.at(-1)?.[1] ?? null;

export function Stats({ series, unit }: { series: Series[]; unit: Unit }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
      {series.map((s) => (
        <div key={s.name} className="min-w-0 rounded-md bg-surface px-4 py-3">
          <div className="truncate text-xs text-muted" title={s.name}>
            {s.name}
          </div>
          <div className="mt-1 truncate text-2xl font-semibold tracking-tight">{fmt(last(s), unit)}</div>
        </div>
      ))}
    </div>
  );
}

/** A 180° gauge per series, from `min` (default 0) to `max` (default 100 for percentages). */
export function Gauges({ series, unit, min, max }: { series: Series[]; unit: Unit; min?: number; max?: number }) {
  useChartStyle();
  const lo = min ?? 0;
  const hi = max ?? (unit === "percent" ? 100 : Math.max(lo + 1, ...series.map((s) => last(s) ?? 0)));
  return (
    <div className="mon-chart grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
      {series.map((s, i) => {
        const v = last(s);
        const share = v == null ? 0 : Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
        const r = 60;
        const arc = (f: number) => {
          const a = Math.PI * (1 - f);
          return `${70 + r * Math.cos(a)},${72 - r * Math.sin(a)}`;
        };
        return (
          <div key={s.name} className="flex min-w-0 flex-col items-center">
            <svg viewBox="0 0 140 96" className="w-full max-w-48" role="img" aria-label={`${s.name}: ${fmt(v, unit)}`}>
              <path d={`M${arc(0)} A${r},${r} 0 0 1 ${arc(1)}`} fill="none" stroke="var(--color-line)" strokeWidth={12} strokeLinecap="round" />
              {share > 0 && (
                <path
                  d={`M${arc(0)} A${r},${r} 0 0 1 ${arc(share)}`}
                  fill="none"
                  stroke={seriesColor(i)}
                  strokeWidth={12}
                  strokeLinecap="round"
                />
              )}
              <text x={70} y={68} textAnchor="middle" className="fill-ink text-[17px] font-semibold">
                {fmt(v, unit)}
              </text>
              <text x={10} y={93} textAnchor="middle" className="fill-muted text-[9px]">
                {fmt(lo, unit)}
              </text>
              <text x={130} y={93} textAnchor="middle" className="fill-muted text-[9px]">
                {fmt(hi, unit)}
              </text>
            </svg>
            <div className="mt-1 max-w-full truncate text-xs text-muted" title={s.name}>
              {s.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const MAX_SLICES = 8;

/** A donut of the series' last values: the 7 largest and "Other". */
export function Pie({ series, unit }: { series: Series[]; unit: Unit }) {
  useChartStyle();
  const [hover, setHover] = useState<number | null>(null);
  let items = series
    .map((s) => ({ name: s.name, value: Math.max(0, last(s) ?? 0) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value);
  if (items.length > MAX_SLICES) {
    const rest = items.slice(MAX_SLICES - 1).reduce((t, x) => t + x.value, 0);
    items = [...items.slice(0, MAX_SLICES - 1), { name: tr("Other"), value: rest }];
  }
  const total = items.reduce((t, x) => t + x.value, 0);
  if (!total) return <p className="py-6 text-center text-sm text-muted">{tr("No data in this time range")}</p>;

  const color = (i: number) => (items.length === MAX_SLICES && i === MAX_SLICES - 1 ? "var(--color-muted)" : seriesColor(i));
  let angle = -Math.PI / 2;
  const R = 70;
  const r = 44;
  const slices = items.map((x, i) => {
    const a0 = angle;
    const a1 = angle + (x.value / total) * Math.PI * 2;
    angle = a1;
    const p = (a: number, rad: number) => `${80 + rad * Math.cos(a)},${80 + rad * Math.sin(a)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d =
      items.length === 1
        ? `M${p(-Math.PI / 2, R)} A${R},${R} 0 1 1 ${p(Math.PI * 1.5 - 0.0001, R)} L${p(Math.PI * 1.5 - 0.0001, r)} A${r},${r} 0 1 0 ${p(-Math.PI / 2, r)} Z`
        : `M${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, r)} A${r},${r} 0 ${large} 0 ${p(a0, r)} Z`;
    return { ...x, d, i };
  });
  const shown = hover === null ? null : items[hover];

  return (
    <div className="mon-chart flex flex-wrap items-center gap-4">
      <svg viewBox="0 0 160 160" className="w-40 shrink-0" role="img" aria-label={items.map((x) => `${x.name}: ${fmt(x.value, unit)}`).join(", ")}>
        {slices.map((s) => (
          <path
            key={s.name}
            d={s.d}
            fill={color(s.i)}
            stroke="var(--color-panel)"
            strokeWidth={2}
            opacity={hover === null || hover === s.i ? 1 : 0.45}
            onPointerEnter={() => setHover(s.i)}
            onPointerLeave={() => setHover(null)}
          >
            <title>{`${s.name}: ${fmt(s.value, unit)}`}</title>
          </path>
        ))}
        <text x={80} y={78} textAnchor="middle" className="fill-ink text-[13px] font-semibold">
          {fmt(shown ? shown.value : total, unit)}
        </text>
        <text x={80} y={94} textAnchor="middle" className="fill-muted text-[10px]">
          {shown ? `${((shown.value / total) * 100).toFixed(1)}%` : tr("Total")}
        </text>
      </svg>
      <table className="min-w-0 flex-1 table-fixed text-xs">
        <tbody>
          {items.map((x, i) => (
            <tr
              key={x.name}
              className="border-t border-line first:border-0"
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
            >
              <td className="truncate py-1" title={x.name}>
                <span className="mr-2 inline-block size-2.5 rounded-sm align-middle" style={{ background: color(i) }} />
                {x.name}
              </td>
              <td className="w-24 py-1 text-right font-mono">{fmt(x.value, unit)}</td>
              <td className="w-14 py-1 text-right font-mono text-muted">{((x.value / total) * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
