import { locale } from "@/lib/i18n";

export function fmtDate(iso: string | null | undefined, withTime = true) {
  if (!iso) return null;
  const d = new Date(iso.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
}

/** Today in the browser's time zone as YYYY-MM-DD (toISOString would give the UTC date). */
export function localDate(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Default name for snapshots and backups: "<name>-<local date>", e.g. "ansible-prod-2026-10-20". */
export const datedName = (name: string) => `${name}-${localDate()}`;

export function isPast(iso: string | null | undefined) {
  return !!iso && new Date(iso.endsWith("Z") ? iso : `${iso}Z`).getTime() < Date.now();
}

/** 1536 → "1.5 KiB". Binary units, as Glance and Nova count them. */
export function fmtBytes(n: number | null | undefined) {
  if (n == null) return null;
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** "1 region", "2 regions". */
export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
