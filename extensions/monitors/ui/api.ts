/**
 * The Monitors extension's API (`/api/ext/monitors/...`): who may see what, the instances,
 * projects and physical servers with metrics, and the series of one chart. The server builds
 * every PromQL query and scopes a project user's to their own project.
 */
import { api, useQuery } from "@rassvet/sdk";

export const BASE = "/ext/monitors";

export type Kind = "guest" | "host" | "project";
export type Unit = "percent" | "bytes" | "bytes_per_sec" | "bits_per_sec" | "ops_per_sec" | "packets_per_sec" | "seconds" | "count";

export interface Info {
  admin: boolean;
  /** How far back the session may look. */
  max_range_days: number;
  project: { id: string; name: string } | null;
  region: string | null;
  region_filter: boolean;
}

export interface Panel {
  id: string;
  kind: Kind;
  title: string;
  unit: Unit;
  queries: { name: string; legend: string[] }[];
}

export interface ProjectItem {
  project_id: string;
  project_name: string;
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

export interface Series {
  name: string;
  query: string;
  labels: Record<string, string>;
  /** [unix seconds, value] */
  values: [number, number][];
}

export interface SeriesResult {
  panel: Panel;
  start: number;
  end: number;
  step: number;
  series: Series[];
  /** Quiet series left out of the chart. */
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

export const usePanels = (kind: Kind, enabled = true) =>
  useQuery({
    queryKey: ["monitors", "panels", kind],
    queryFn: () => api.get<Panel[]>(`${BASE}/panels?${qs({ kind })}`),
    staleTime: Infinity,
    enabled,
  });

/** Lists only change as instances come and go: keep them a minute, keyed by whole hours. */
const listKey = (r: Range) => [Math.floor(r.start / 3600), Math.floor(r.end / 3600)];

export const useMonitoredProjects = (range: Range, enabled: boolean) =>
  useQuery({
    queryKey: ["monitors", "projects", listKey(range)],
    queryFn: () => api.get<ProjectItem[]>(`${BASE}/projects?${qs({ ...range })}`),
    staleTime: 60_000,
    enabled,
  });

export const useGuests = (range: Range, projectId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: ["monitors", "guests", projectId ?? "", listKey(range)],
    queryFn: () => api.get<GuestItem[]>(`${BASE}/guests?${qs({ ...range, project_id: projectId })}`),
    staleTime: 60_000,
    enabled,
  });

export const useHosts = (range: Range, enabled: boolean) =>
  useQuery({
    queryKey: ["monitors", "hosts", listKey(range)],
    queryFn: () => api.get<HostItem[]>(`${BASE}/hosts?${qs({ ...range })}`),
    staleTime: 60_000,
    enabled,
  });

export interface Target {
  kind: Kind;
  guest_id?: string;
  compute_node_id?: string;
  project_id?: string;
}

export const useSeries = (target: Target, panel: string, range: Range, refresh: number | false) =>
  useQuery({
    queryKey: ["monitors", "series", target, panel, range],
    queryFn: ({ signal }) => api.get<SeriesResult>(`${BASE}/series?${qs({ ...target, panel, ...range })}`, { signal }),
    staleTime: 15_000,
    refetchInterval: refresh,
    placeholderData: (prev) => prev,
  });
