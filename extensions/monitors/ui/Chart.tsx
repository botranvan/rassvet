/**
 * A time series line chart in SVG: value axis from zero, local-time axis, gaps where data is
 * missing, a crosshair with every series' value on hover, and a legend table (last / avg / max)
 * so values are readable as text and series aren't told apart by colour alone.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { cn, lang, tr } from "@rassvet/sdk";
import type { Range, Series, Unit } from "./api";
import { fmt, fmtTick, niceTicks } from "./units";

/** Categorical slots, light and dark steps (validated for colour-vision deficiency, in this order). */
const STYLE = `
.mon-chart{--mon-1:#2a78d6;--mon-2:#eb6834;--mon-3:#1baf7a;--mon-4:#eda100;--mon-5:#e87ba4;--mon-6:#008300;--mon-7:#6250d6;--mon-8:#e34948}
.dark .mon-chart{--mon-1:#3987e5;--mon-2:#d95926;--mon-3:#199e70;--mon-4:#c98500;--mon-5:#d55181;--mon-6:#008300;--mon-7:#9085e9;--mon-8:#e66767}
`;
let styled = false;
export function useChartStyle() {
  useEffect(() => {
    if (styled) return;
    styled = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.appendChild(el);
  }, []);
}

export const seriesColor = (i: number) => `var(--mon-${(i % 8) + 1})`;

const HEIGHT = 190;
const M = { top: 10, right: 12, bottom: 22, left: 62 };
const locale = lang === "vi" ? "vi-VN" : undefined;

const TIME_STEPS = [60, 120, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400];

function timeTicks(start: number, end: number, width: number) {
  const want = Math.max(2, Math.floor(width / 100));
  const step = TIME_STEPS.find((s) => (end - start) / s <= want + 0.5);
  const out: number[] = [];
  if (step === undefined || step >= 30 * 86400) {
    // Long ranges: the first of every n-th month, local time.
    const months = (end - start) / (30.44 * 86400);
    const n = [1, 2, 3, 6, 12].find((m) => months / m <= want + 0.5) ?? 12;
    const d = new Date(start * 1000);
    const m = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    m.setMonth(Math.ceil(m.getMonth() / n) * n);
    for (; m.getTime() / 1000 <= end; m.setMonth(m.getMonth() + n)) out.push(m.getTime() / 1000);
    return { ticks: out, step: 30 * 86400 };
  }
  // Align to local midnight / whole hours.
  const off = new Date(start * 1000).getTimezoneOffset() * 60;
  for (let t = Math.ceil((start - off) / step) * step + off; t <= end; t += step) out.push(t);
  return { ticks: out, step };
}

const timeLabel = (t: number, step: number) =>
  new Date(t * 1000).toLocaleString(
    locale,
    step >= 30 * 86400
      ? { month: "short", year: "2-digit" }
      : step >= 86400
        ? { month: "short", day: "numeric" }
        : { hour: "2-digit", minute: "2-digit" },
  );

const fullTime = (t: number) => new Date(t * 1000).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });

/** Index of the point nearest to `t` (values are sorted by time). */
function nearest(values: [number, number][], t: number) {
  let lo = 0;
  let hi = values.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(values[lo - 1][0] - t) < Math.abs(values[lo][0] - t)) lo--;
  return lo;
}

function stats(values: [number, number][]) {
  if (!values.length) return { last: null, avg: null, max: null };
  let sum = 0;
  let max = -Infinity;
  for (const [, v] of values) {
    sum += v;
    if (v > max) max = v;
  }
  return { last: values[values.length - 1][1], avg: sum / values.length, max };
}

export function Chart({ series, unit, range, step }: { series: Series[]; unit: Unit; range: Range; step: number }) {
  useChartStyle();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = width - M.left - M.right;
  const plotH = HEIGHT - M.top - M.bottom;
  const max = useMemo(() => Math.max(0, ...series.flatMap((s) => s.values.map((v) => v[1]))), [series]);
  const y = niceTicks(max, unit);
  const x = (t: number) => M.left + ((t - range.start) / (range.end - range.start)) * plotW;
  const yPos = (v: number) => M.top + plotH - (v / y.top) * plotH;
  const tt = timeTicks(range.start, range.end, plotW);

  const paths = useMemo(
    () =>
      series.map((s) => {
        let d = "";
        const dots: [number, number][] = [];
        let prev: number | null = null;
        s.values.forEach(([t, v], i) => {
          const gap = prev === null || t - prev > step * 2.5;
          const next = s.values[i + 1];
          const alone = gap && (!next || next[0] - t > step * 2.5);
          if (alone) dots.push([x(t), yPos(v)]);
          d += `${gap ? "M" : "L"}${x(t).toFixed(1)},${yPos(v).toFixed(1)}`;
          prev = t;
        });
        return { d, dots };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, width, y.top, range.start, range.end, step],
  );

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    setHover(range.start + (px / r.width) * (range.end - range.start));
  };

  // The hovered time snaps to the nearest point of any series.
  const hoverPoints =
    hover === null
      ? null
      : series.map((s) => {
          const i = nearest(s.values, hover);
          const p = i >= 0 ? s.values[i] : null;
          return p && Math.abs(p[0] - hover) <= step * 1.5 ? p : null;
        });
  const hoverT = hoverPoints?.find((p) => p)?.[0] ?? null;

  return (
    <div className="mon-chart">
      <div ref={box} className="relative">
        <svg width={width} height={HEIGHT} role="img" aria-label={series.map((s) => s.name).join(", ")} className="block select-none">
          {y.ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={yPos(t)} y2={yPos(t)} stroke="var(--color-line)" strokeWidth={1} />
              <text x={M.left - 8} y={yPos(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px]">
                {fmtTick(t, y.scale)}
              </text>
            </g>
          ))}
          {tt.ticks.filter((t) => x(t) > M.left + 20 && x(t) < width - 30).map((t) => (
            <text key={t} x={x(t)} y={HEIGHT - 6} textAnchor="middle" className="fill-muted text-[11px]">
              {timeLabel(t, tt.step)}
            </text>
          ))}
          {paths.map((p, i) => (
            <g key={series[i].name} stroke={seriesColor(i)} fill={seriesColor(i)}>
              <path d={p.d} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {p.dots.map(([cx, cy]) => (
                <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={2} stroke="none" />
              ))}
            </g>
          ))}
          {hoverT !== null && (
            <g>
              <line x1={x(hoverT)} x2={x(hoverT)} y1={M.top} y2={M.top + plotH} stroke="var(--color-muted)" strokeWidth={1} strokeDasharray="3 3" />
              {hoverPoints!.map(
                (p, i) =>
                  p && (
                    <circle key={i} cx={x(p[0])} cy={yPos(p[1])} r={4} fill={seriesColor(i)} stroke="var(--color-panel)" strokeWidth={2} />
                  ),
              )}
            </g>
          )}
          <rect
            x={M.left}
            y={M.top}
            width={Math.max(0, plotW)}
            height={plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hoverT !== null && (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-40 rounded-md border border-line bg-panel px-3 py-2 text-xs shadow-lg"
            style={x(hoverT) > width / 2 ? { right: width - x(hoverT) + 10 } : { left: x(hoverT) + 10 }}
          >
            <div className="mb-1 font-medium text-ink">{fullTime(hoverT)}</div>
            {series.map((s, i) => (
              <div key={s.name} className="flex items-center gap-2 whitespace-nowrap">
                <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: seriesColor(i) }} />
                <span className="min-w-0 flex-1 truncate text-muted">{s.name}</span>
                <span className="font-mono text-ink">{fmt(hoverPoints![i]?.[1], unit)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <Legend series={series} unit={unit} highlight={hoverPoints} />
    </div>
  );
}

function Legend({ series, unit, highlight }: { series: Series[]; unit: Unit; highlight: ([number, number] | null)[] | null }) {
  return (
    <table className="mt-2 w-full table-fixed text-xs">
      <thead className="text-muted">
        <tr>
          <th className="py-1 text-left font-normal">{series.length > 1 ? tr("Series") : ""}</th>
          <th className="w-24 py-1 text-right font-normal">{tr("Last")}</th>
          <th className="w-24 py-1 text-right font-normal">{tr("Avg")}</th>
          <th className="w-24 py-1 text-right font-normal">{tr("Max")}</th>
        </tr>
      </thead>
      <tbody>
        {series.map((s, i) => {
          const st = stats(s.values);
          return (
            <tr key={s.name} className={cn("border-t border-line", highlight && !highlight[i] && "opacity-60")}>
              <td className="truncate py-1" title={s.name}>
                <span className="mr-2 inline-block size-2.5 rounded-sm align-middle" style={{ background: seriesColor(i) }} />
                {s.name}
              </td>
              <td className="py-1 text-right font-mono">{fmt(st.last, unit)}</td>
              <td className="py-1 text-right font-mono">{fmt(st.avg, unit)}</td>
              <td className="py-1 text-right font-mono">{fmt(st.max, unit)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
