/**
 * UI language. English is the source language and the default: every UI string is written
 * in English and wrapped in `tr()` (text) or `trx()` (text with React nodes in it); the
 * English text is the lookup key. Other languages are dictionaries English → translation
 * (`i18n/vi.ts`), loaded before the app's modules so module-level labels are translated too.
 * Missing entries fall back to English. Placeholders are `{name}`.
 *
 * Proper nouns (OpenStack, Nova, Neutron, Cinder, Glance, Keystone, Placement, Rassvet…)
 * and resource names/ids coming from the cloud are never translated.
 *
 * Switching language reloads the page (cheap, and keeps every cached label consistent).
 */
import { Fragment, type ReactNode, createElement } from "react";

export type Lang = "en" | "vi";
export const LANGS: { id: Lang; label: string; short: string }[] = [
  { id: "en", label: "English", short: "EN" },
  { id: "vi", label: "Tiếng Việt", short: "VI" },
];
const KEY = "rassvet.lang";

function read(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "en" || v === "vi") return v;
  } catch {
    /* storage unavailable */
  }
  return "en";
}

export const lang: Lang = read();
let dict: Record<string, string> = {};

/** BCP 47 locale for dates and numbers: the browser's own for English, vi-VN for Vietnamese. */
export const locale: string | undefined = lang === "vi" ? "vi-VN" : undefined;

/** Load the dictionary of the chosen language. Call (and await) before importing the app. */
export async function initI18n() {
  document.documentElement.lang = lang;
  if (lang === "vi") dict = (await import("./i18n/vi")).default;
}

export function setLang(l: Lang) {
  if (l === lang) return;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* storage unavailable: nothing to remember */
  }
  window.location.reload();
}

const PH = /\{(\w+)\}/g;

/** Translate `s`; `{name}` placeholders are filled from `vars`. */
export function tr(s: string, vars?: Record<string, unknown>): string {
  const t = dict[s] ?? s;
  if (!vars) return t;
  return t.replace(PH, (m, k: string) => (k in vars ? String(vars[k] ?? "") : m));
}

/** Like `tr`, but placeholders may be React nodes (links, badges, formatted values…). */
export function trx(s: string, vars: Record<string, ReactNode>): ReactNode {
  const t = dict[s] ?? s;
  const parts: ReactNode[] = [];
  let last = 0;
  let allText = true;
  for (const m of t.matchAll(PH)) {
    parts.push(t.slice(last, m.index));
    const v = m[1] in vars ? vars[m[1]] : m[0];
    if (v != null && typeof v === "object") allText = false;
    parts.push(v);
    last = m.index + m[0].length;
  }
  parts.push(t.slice(last));
  if (allText) return parts.map((p) => (p == null || p === false || p === true ? "" : String(p))).join("");
  return createElement(Fragment, null, ...parts.map((p, i) => createElement(Fragment, { key: i }, p)));
}
