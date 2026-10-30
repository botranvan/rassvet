import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, currentCloud, setCurrentCloud } from "./api";

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
  /** Every cloud this session is signed in to (`cloud` is one of them). */
  clouds: SignedInCloud[];
  /** UI preferences saved in the session (see lib/prefs.ts). */
  prefs?: Record<string, unknown>;
  /** Rassvet's own version (shown under the menu). */
  version?: string;
}

export interface SignedInCloud extends IdName {
  user: ProjectRef;
  project: ProjectRef | null;
  expires_at: string;
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

/** Drop every cached resource but keep the session query object itself:
 * `qc.clear()` would detach the components currently observing it. */
function dropResources(qc: QueryClient) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION[0] && q.queryKey[0] !== "clouds" });
}

export function useSession() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: SESSION,
    queryFn: async () => {
      try {
        const s = await api.get<SessionInfo>("/session");
        // A new tab takes the session's active cloud; a tab whose cloud was signed out (here
        // or in another tab, or its token expired) moves to it, without that cloud's data.
        if (s.cloud.id !== currentCloud()) {
          if (currentCloud()) dropResources(qc);
          setCurrentCloud(s.cloud.id);
        }
        return s;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setCurrentCloud(null);
          return null;
        }
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

/** Any change of identity, cloud, project or region invalidates every cached resource. */
function useSessionMutation<V>(fn: (v: V) => Promise<SessionInfo | void>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      // This tab follows the cloud the answer is about (before anything refetches).
      setCurrentCloud(data ? data.cloud.id : null);
      dropResources(qc);
      qc.setQueryData(SESSION, data ?? null);
    },
  });
}

export const useLogin = () =>
  useSessionMutation((req: LoginRequest) => api.post<SessionInfo>("/auth/login", req));

export const useLogout = () => useSessionMutation(() => api.post<void>("/auth/logout"));

/** Sign this session in to one more cloud (or again to one it has); this tab moves there. */
export const useAddCloud = () =>
  useSessionMutation((req: LoginRequest) => api.post<SessionInfo>("/session/clouds", req));

/** Move this tab to another cloud the session is signed in to (no sign-in). */
export const useSwitchCloud = () =>
  useSessionMutation((cloud: string) => api.post<SessionInfo>("/session/cloud", { cloud }));

/** Sign out of one cloud. When it is this tab's cloud, the tab moves to the session's active
 * cloud; the session ends with its last cloud. */
export function useSignOutCloud() {
  const qc = useQueryClient();
  const moveTab = useSessionMutation((cloud: string) =>
    api.del<SessionInfo | undefined>(`/session/clouds/${encodeURIComponent(cloud)}`),
  );
  return useMutation({
    mutationFn: async (cloud: string) => {
      if (cloud === currentCloud()) return moveTab.mutateAsync(cloud);
      await api.del(`/session/clouds/${encodeURIComponent(cloud)}`);
      await qc.invalidateQueries({ queryKey: SESSION });
    },
  });
}

export const useSwitchProject = () =>
  useSessionMutation((project_id: string) =>
    api.post<SessionInfo>("/session/project", { project_id }),
  );

export const useSwitchRegion = () =>
  useSessionMutation((region: string) => api.post<SessionInfo>("/session/region", { region }));
