/** Time ranges: presets relative to now, or a fixed from / to, kept in the URL (`?range=`). */
import { tr } from "@rassvet/sdk";
import type { Range } from "./api";

const M = 60;
const H = 3600;
const D = 86400;

export interface Preset {
  id: string;
  label: string;
  seconds: number;
}

export const PRESETS: Preset[] = [
  { id: "5m", label: tr("Last 5 minutes"), seconds: 5 * M },
  { id: "15m", label: tr("Last 15 minutes"), seconds: 15 * M },
  { id: "30m", label: tr("Last 30 minutes"), seconds: 30 * M },
  { id: "1h", label: tr("Last hour"), seconds: H },
  { id: "3h", label: tr("Last 3 hours"), seconds: 3 * H },
  { id: "6h", label: tr("Last 6 hours"), seconds: 6 * H },
  { id: "12h", label: tr("Last 12 hours"), seconds: 12 * H },
  { id: "24h", label: tr("Last 24 hours"), seconds: D },
  { id: "2d", label: tr("Last 2 days"), seconds: 2 * D },
  { id: "7d", label: tr("Last 7 days"), seconds: 7 * D },
  { id: "30d", label: tr("Last 30 days"), seconds: 30 * D },
  { id: "60d", label: tr("Last 60 days"), seconds: 60 * D },
  { id: "90d", label: tr("Last 90 days"), seconds: 90 * D },
  { id: "180d", label: tr("Last 180 days"), seconds: 180 * D },
  { id: "365d", label: tr("Last year"), seconds: 365 * D },
];

/** The preset used when the URL names none. */
const DEFAULT_PRESET = "1h";

/** Presets within the session's limit. */
export const presetsFor = (maxDays: number) => PRESETS.filter((p) => p.seconds <= maxDays * D);

/** `"6h"` → a preset; `"<start>-<end>"` (unix seconds) → a fixed range. */
export type RangeSpec = { preset: Preset } | { start: number; end: number };

export function parseRange(v: string | null, maxDays: number): RangeSpec {
  const presets = presetsFor(maxDays);
  const fixed = v?.match(/^(\d+)-(\d+)$/);
  if (fixed) {
    const start = Number(fixed[1]);
    const end = Number(fixed[2]);
    if (start < end) return { start, end };
  }
  return {
    preset:
      presets.find((p) => p.id === v) ?? presets.find((p) => p.id === DEFAULT_PRESET) ?? presets[0] ?? PRESETS[0],
  };
}

export const formatSpec = (s: RangeSpec) => ("preset" in s ? s.preset.id : `${s.start}-${s.end}`);

/**
 * The range to ask for. A preset ends now, rounded down to `round` seconds so that charts
 * drawn together (and a re-render) share one range and its cached answers.
 */
export function resolve(s: RangeSpec, now: number, round = 15): Range {
  if ("preset" in s) {
    const end = Math.floor(now / round) * round;
    return { start: end - s.preset.seconds, end };
  }
  return { start: s.start, end: s.end };
}

/** Whether a fixed range starts earlier than the session may look back. */
export const tooOld = (r: Range, maxDays: number, now: number) => r.start < now - maxDays * D;

/** `<input type="datetime-local">` value ↔ unix seconds, in the browser's time zone. */
export function toLocalInput(t: number) {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const fromLocalInput = (v: string) => {
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
};
