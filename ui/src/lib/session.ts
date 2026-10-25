import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "./api";

export interface IdName {
  id: string;
  name: string;
}
export interface ProjectRef extends IdName {
  domain?: IdName | null;
}

export interface SessionInfo {
  cloud: IdName;
  user: ProjectRef;
  project: ProjectRef | null;
  roles: IdName[];
  is_admin: boolean;
  expires_at: string;
  region: string | null;
  regions: string[];
  projects: ProjectRef[];
  services: string[];
  can_switch_project: boolean;
  /** UI preferences saved in the session (see lib/prefs.ts). */
  prefs?: Record<string, unknown>;
  /** Rassvet's own version (shown under the menu). */
  version?: string;
}

export type NavSection = "project" | "admin";

export interface NavItem {
  id: string;
  group: string;
  label: string;
  path: string;
  icon: string;
  section: NavSection;
  role?: string;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  service_types: string[];
}

export interface CloudInfo {
  id: string;
  name: string;
  default_domain: string;
}

export type LoginRequest =
  | {
      method: "password";
      cloud: string;
      domain?: string;
      username: string;
      password: string;
    }
  | { method: "application_credential"; cloud: string; id: string; secret: string };

export const SESSION = ["session"];

export function useSession() {
  return useQuery({
    queryKey: SESSION,
    queryFn: async () => {
      try {
        return await api.get<SessionInfo>("/session");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export function useClouds() {
  return useQuery({
    queryKey: ["clouds"],
    queryFn: () => api.get<{ clouds: CloudInfo[]; version?: string }>("/clouds").then((r) => r.clouds),
    staleTime: Infinity,
  });
}

/** Rassvet's version before sign-in (the clouds endpoint is public). */
export function useServerVersion() {
  return useQuery({
    queryKey: ["clouds", "version"],
    queryFn: () => api.get<{ version?: string }>("/clouds").then((r) => r.version ?? ""),
    staleTime: Infinity,
  });
}

export function useNav(enabled: boolean) {
  return useQuery({
    queryKey: ["nav"],
    queryFn: () => api.get<{ items: NavItem[]; extensions: ExtensionManifest[] }>("/nav"),
    enabled,
  });
}

/** Any change of identity, project or region invalidates every cached resource. */
function useSessionMutation<V>(fn: (v: V) => Promise<SessionInfo | void>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      // Drop every cached resource but keep the session query object itself:
      // `qc.clear()` would detach the components currently observing it.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION[0] && q.queryKey[0] !== "clouds" });
      qc.setQueryData(SESSION, data ?? null);
    },
  });
}

export const useLogin = () =>
  useSessionMutation((req: LoginRequest) => api.post<SessionInfo>("/auth/login", req));

export const useLogout = () => useSessionMutation(() => api.post<void>("/auth/logout"));

export const useSwitchProject = () =>
  useSessionMutation((project_id: string) =>
    api.post<SessionInfo>("/session/project", { project_id }),
  );

export const useSwitchRegion = () =>
  useSessionMutation((region: string) => api.post<SessionInfo>("/session/region", { region }));
