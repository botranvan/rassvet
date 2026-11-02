/**
 * The Monitors extension's API (`/api/ext/monitors/...`): who may see what, the dashboards and
 * panels defined in the cloud's YAML panel files, what can be picked on a dashboard, and the
 * data of one panel. The server fills every PromQL template and scopes a project user's
 * `$project_id` to their own project.
 */
import { api, useQuery } from "@rassvet/sdk";

export const BASE = "/ext/monitors";

export type Kind = "instance" | "physical";
export type ChartType = "time_series" | "pie_chart" | "stat" | "gauge";
export type Unit =
  | "count"
  | "percent"
  | "percent_unit"
  | "bytes"
  | "bytes_per_sec"
  | "bits_per_sec"
  | "ops_per_sec"
  | "packets_per_sec"
  | "seconds";

export interface Info {
  admin: boolean;
  /** How far back the session may look. */
  max_range_days: number;
  project: { id: string; name: string } | null;
  region: string | null;
}

export interface Panel {
  name: string;
  title: string;
  description?: string;
  unit: Unit;
  width: "half" | "full";
  min?: number;
  max?: number;
  /** `target`: needs a picked instance / server; `overview`: the project / fleet. */
  scope: "target" | "overview";
  queries: { type: ChartType; unit: Unit }[];
}

export interface Dashboard {
  id: string;
  title: string;
  kind: Kind;
  panels: Panel[];
}

export interface GuestItem {
  guest_id: string;
  guest_name: string;
  project_id: string;
  project_name: string;
}

export interface HostItem {
  compute_node_id: string;
  hostname: string;
  region: string;
}

export type Targets = { kind: "instance"; guests: GuestItem[] } | { kind: "physical"; hosts: HostItem[] };

export interface Series {
  name: string;
  labels: Record<string, string>;
  /** [unix seconds, value]; one point for stat, gauge and pie chart queries. */
  values: [number, number][];
}

export interface PanelData {
  start: number;
  end: number;
  step: number;
  /** `unit`: of a stat, gauge or pie chart query; a time series chart uses the panel's. */
  results: { type: ChartType; unit: Unit; series: Series[] }[];
  /** Quiet time series left out of the chart. */
  hidden: number;
}

/** A time range in unix seconds. */
export interface Range {
  start: number;
  end: number;
}

const qs = (p: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  return s.toString();
};

export const useInfo = () =>
  useQuery({ queryKey: ["monitors", "info"], queryFn: () => api.get<Info>(`${BASE}/info`), staleTime: 300_000 });

/** Panel files are re-read by the server when they change: refresh every few minutes. */
export const useDashboards = (kind: Kind, enabled = true) =>
  useQuery({
    queryKey: ["monitors", "dashboards", kind],
    queryFn: () => api.get<Dashboard[]>(`${BASE}/dashboards?${qs({ kind })}`),
    staleTime: 120_000,
    enabled,
  });

/** Lists only change as instances come and go: keep them a minute, keyed by whole hours. */
const listKey = (r: Range) => [Math.floor(r.start / 3600), Math.floor(r.end / 3600)];

export const useTargets = (dashboard: string | undefined, range: Range) =>
  useQuery({
    queryKey: ["monitors", "targets", dashboard, listKey(range)],
    queryFn: () => api.get<Targets>(`${BASE}/targets?${qs({ dashboard, ...range })}`),
    staleTime: 60_000,
    enabled: !!dashboard,
  });

/** What a panel is drawn for. */
export interface Target {
  project_id?: string;
  guest_id?: string;
  compute_node_id?: string;
  hostname?: string;
}

export const usePanelData = (dashboard: string, panel: string, target: Target, range: Range) =>
  useQuery({
    queryKey: ["monitors", "panel", dashboard, panel, target, range],
    queryFn: ({ signal }) => api.get<PanelData>(`${BASE}/query?${qs({ dashboard, panel, ...target, ...range })}`, { signal }),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
