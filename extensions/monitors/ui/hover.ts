/**
 * Grafana's "Graph tooltip" for the time series charts of a page: hovering one chart can show
 * the same moment on every other chart (crosshair, and optionally their tooltips too).
 *
 * The hovered time lives in a small store outside React state, so only the charts re-render
 * while the pointer moves, not the panels around them.
 */
import { createContext, createElement, type ReactNode, useContext, useState, useSyncExternalStore } from "react";

export type GraphTooltip = "default" | "shared_crosshair" | "shared_tooltip";

export const GRAPH_TOOLTIPS: GraphTooltip[] = ["default", "shared_crosshair", "shared_tooltip"];

export const isGraphTooltip = (v: string | null | undefined): v is GraphTooltip =>
  !!v && (GRAPH_TOOLTIPS as string[]).includes(v);

interface Hover {
  /** Hovered time (unix seconds), or null. */
  t: number | null;
  /** The chart under the pointer. */
  source: string | null;
}

interface HoverStore {
  get: () => Hover;
  set: (t: number | null, source: string | null) => void;
  subscribe: (f: () => void) => () => void;
}

function createStore(): HoverStore {
  let state: Hover = { t: null, source: null };
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(t, source) {
      if (state.t === t && state.source === source) return;
      state = { t, source };
      subs.forEach((f) => f());
    },
    subscribe(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

const Ctx = createContext<{ mode: GraphTooltip; store: HoverStore } | null>(null);

/** Charts inside share their hover according to `mode`. */
export function GraphTooltipProvider({ mode, children }: { mode: GraphTooltip; children: ReactNode }) {
  const [store] = useState(createStore);
  return createElement(Ctx.Provider, { value: { mode, store } }, children);
}

const idle: Hover = { t: null, source: null };
const noop = () => () => {};

/**
 * The hovered time for chart `id`: its own (default mode, or outside a provider) or the page's.
 * `tooltip` says whether this chart shows its tooltip at that time.
 */
export function useChartHover(id: string) {
  const ctx = useContext(Ctx);
  const [own, setOwn] = useState<number | null>(null);
  const shared = ctx && ctx.mode !== "default" ? ctx : null;
  const page = useSyncExternalStore(shared ? shared.store.subscribe : noop, shared ? shared.store.get : () => idle);
  if (!shared) return { t: own, tooltip: own !== null, set: setOwn };
  return {
    t: page.t,
    tooltip: page.t !== null && (shared.mode === "shared_tooltip" || page.source === id),
    set: (t: number | null) => {
      // Leaving a chart only clears the hover it set (the pointer may already be on another).
      if (t === null && shared.store.get().source !== id) return;
      shared.store.set(t, t === null ? null : id);
    },
  };
}
