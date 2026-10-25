/** Keystone feature: types and data hooks for /api/identity. */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// ------------------------------------------------------------------ types

export interface Domain {
  id: string;
  name: string;
  enabled: boolean;
  description?: string;
}

export interface User {
  id: string;
  name: string;
  domain_id: string;
  enabled: boolean;
  email?: string;
  description?: string;
  default_project_id?: string | null;
  password_expires_at?: string | null;
}

export interface Project {
  id: string;
  name: string;
  domain_id: string;
  enabled: boolean;
  description?: string;
  parent_id?: string | null;
  is_domain?: boolean;
  tags?: string[];
}

export interface Role {
  id: string;
  name: string;
  description?: string | null;
  domain_id?: string | null;
}

interface Named {
  id: string;
  name?: string;
  domain?: { id: string; name?: string };
}

export interface RoleAssignment {
  role: Named;
  user?: Named;
  group?: Named;
  scope: { project?: Named; domain?: Named; system?: unknown };
}

export interface AppCredential {
  id: string;
  name: string;
  description?: string | null;
  project_id: string;
  roles: { id: string; name: string }[];
  expires_at?: string | null;
  unrestricted: boolean;
  /** Only present in the create response. */
  secret?: string;
}

export interface CatalogEndpoint {
  interface: string;
  region_id?: string | null;
  region?: string | null;
  url: string;
}
export interface CatalogService {
  type: string;
  name?: string | null;
  endpoints: CatalogEndpoint[];
}

export interface KsService {
  id: string;
  type: string;
  name?: string;
  description?: string;
  enabled: boolean;
}
export interface KsEndpoint {
  id: string;
  service_id: string;
  interface: string;
  region_id?: string | null;
  url: string;
  enabled: boolean;
}
export interface KsRegion {
  id: string;
  description?: string;
  parent_region_id?: string | null;
}

export interface CliInfo {
  cloud_id: string;
  cloud_name: string;
  auth_url: string;
  region: string | null;
  interface: string;
  user_name: string;
  user_domain_name: string | null;
  project_id: string | null;
  project_name: string | null;
  project_domain_id: string | null;
  project_domain_name: string | null;
}

// ------------------------------------------------------------------ queries

const A = "/identity/admin";
const enc = encodeURIComponent;

export const useCatalog = () =>
  useQuery({
    queryKey: ["identity", "catalog"],
    queryFn: () => api.get<{ catalog: CatalogService[] }>("/identity/catalog").then((r) => r.catalog),
  });

export const useCliInfo = () =>
  useQuery({ queryKey: ["identity", "cli"], queryFn: () => api.get<CliInfo>("/identity/cli") });

export const useMyAppCreds = () =>
  useQuery({
    queryKey: ["identity", "app-creds", "me"],
    queryFn: () =>
      api
        .get<{ application_credentials: AppCredential[] }>("/identity/application-credentials")
        .then((r) => r.application_credentials),
  });

export const useDomains = () =>
  useQuery({
    queryKey: ["identity", "domains"],
    queryFn: () => api.get<{ domains: Domain[] }>(`${A}/domains`).then((r) => r.domains),
    staleTime: 5 * 60_000,
  });

export const useUsers = (enabled = true) =>
  useQuery({
    queryKey: ["identity", "users"],
    queryFn: () => api.get<{ users: User[] }>(`${A}/users`).then((r) => r.users),
    enabled,
  });

/**
 * Users or projects filtered by Keystone itself (name contains `q`, optional domain), so
 * big LDAP/SQL backends aren't asked for everything on each keystroke. Keystone has no
 * paging; `truncated` is set when its `list_limit` cut the answer short.
 */
export function useIdentitySearch<T>(kind: "users" | "projects", params: { q?: string; domain_id?: string }) {
  return useQuery({
    queryKey: ["identity", kind, "search", params],
    queryFn: () => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
      return api.get<Record<string, unknown>>(`${A}/${kind}${qs ? `?${qs}` : ""}`).then((r) => ({ rows: (r[kind] ?? []) as T[], truncated: !!r.truncated }));
    },
    placeholderData: keepPreviousData,
  });
}

export const useUser = (id: string) =>
  useQuery({
    queryKey: ["identity", "users", id],
    queryFn: () => api.get<{ user: User }>(`${A}/users/${enc(id)}`).then((r) => r.user),
  });

export const useUserAssignments = (id: string) =>
  useQuery({
    queryKey: ["identity", "assignments", "user", id],
    queryFn: () =>
      api
        .get<{ role_assignments: RoleAssignment[] }>(`${A}/users/${enc(id)}/assignments`)
        .then((r) => r.role_assignments),
  });

export const useUserAppCreds = (id: string) =>
  useQuery({
    queryKey: ["identity", "app-creds", id],
    queryFn: () =>
      api
        .get<{ application_credentials: AppCredential[] }>(`${A}/users/${enc(id)}/application-credentials`)
        .then((r) => r.application_credentials),
  });

/** All projects (admin API). Pass `enabled=false` for users who may not be admins. */
export const useProjects = (enabled = true) =>
  useQuery({
    queryKey: ["identity", "projects"],
    queryFn: () => api.get<{ projects: Project[] }>(`${A}/projects`).then((r) => r.projects),
    enabled,
  });

export const useProject = (id: string) =>
  useQuery({
    queryKey: ["identity", "projects", id],
    queryFn: () => api.get<{ project: Project }>(`${A}/projects/${enc(id)}`).then((r) => r.project),
  });

export const useProjectAssignments = (id: string) =>
  useQuery({
    queryKey: ["identity", "assignments", "project", id],
    queryFn: () =>
      api
        .get<{ role_assignments: RoleAssignment[] }>(`${A}/projects/${enc(id)}/assignments`)
        .then((r) => r.role_assignments),
  });

export const useRoles = () =>
  useQuery({
    queryKey: ["identity", "roles"],
    queryFn: () =>
      api
        .get<{ roles: Role[] }>(`${A}/roles`)
        .then((r) => r.roles.sort((a, b) => a.name.localeCompare(b.name))),
  });

export const useAdminCatalog = () =>
  useQuery({
    queryKey: ["identity", "admin-catalog"],
    queryFn: () =>
      api.get<{ services: KsService[]; endpoints: KsEndpoint[]; regions: KsRegion[] }>(`${A}/catalog`),
  });

// ------------------------------------------------------------------ mutations

/** Mutation that refreshes every identity query when it succeeds. */
function useIdentityMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["identity"] }),
  });
}

export const useCreateAppCred = () =>
  useIdentityMutation(
    (body: {
      name: string;
      description?: string;
      expires_at?: string;
      roles?: string[];
      unrestricted: boolean;
    }) =>
      api
        .post<{ application_credential: AppCredential }>("/identity/application-credentials", body)
        .then((r) => r.application_credential),
  );

export const useDeleteMyAppCred = () =>
  useIdentityMutation((id: string) => api.del(`/identity/application-credentials/${enc(id)}`));

export const useDeleteUserAppCred = () =>
  useIdentityMutation(({ userId, id }: { userId: string; id: string }) =>
    api.del(`${A}/users/${enc(userId)}/application-credentials/${enc(id)}`),
  );

export const useChangePassword = () =>
  useMutation({
    mutationFn: (body: { original_password: string; password: string }) =>
      api.post<void>("/identity/password", body),
  });

export const useCreateUser = () =>
  useIdentityMutation((body: Omit<User, "id"> & { password?: string }) =>
    api.post<{ user: User }>(`${A}/users`, body).then((r) => r.user),
  );

export const useUpdateUser = () =>
  useIdentityMutation(({ id, ...body }: Partial<User> & { id: string; password?: string }) =>
    api.patch<{ user: User }>(`${A}/users/${enc(id)}`, body).then((r) => r.user),
  );

export const useDeleteUser = () => useIdentityMutation((id: string) => api.del(`${A}/users/${enc(id)}`));

export const useCreateProject = () =>
  useIdentityMutation((body: { name: string; domain_id: string; description?: string; enabled: boolean; tags?: string[] }) =>
    api.post<{ project: Project }>(`${A}/projects`, body).then((r) => r.project),
  );

export const useUpdateProject = () =>
  useIdentityMutation(({ id, ...body }: { id: string; name?: string; description?: string; enabled?: boolean; tags?: string[] }) =>
    api.patch<{ project: Project }>(`${A}/projects/${enc(id)}`, body).then((r) => r.project),
  );

export const useDeleteProject = () =>
  useIdentityMutation((id: string) => api.del(`${A}/projects/${enc(id)}`));

/** Grant and revoke several roles of one user on one project in one go. */
export const useSetProjectRoles = () =>
  useIdentityMutation(
    async ({
      projectId,
      userId,
      grant = [],
      revoke = [],
    }: {
      projectId: string;
      userId: string;
      grant?: string[];
      revoke?: string[];
    }) => {
      const base = `${A}/projects/${enc(projectId)}/users/${enc(userId)}/roles/`;
      for (const r of grant) await api.put(base + enc(r));
      for (const r of revoke) await api.del(base + enc(r));
    },
  );

export const useCreateRole = () =>
  useIdentityMutation((body: { name: string; description?: string }) =>
    api.post<{ role: Role }>(`${A}/roles`, body).then((r) => r.role),
  );

export const useUpdateRole = () =>
  useIdentityMutation(({ id, ...body }: { id: string; name?: string; description?: string }) =>
    api.patch<{ role: Role }>(`${A}/roles/${enc(id)}`, body).then((r) => r.role),
  );

export const useDeleteRole = () => useIdentityMutation((id: string) => api.del(`${A}/roles/${enc(id)}`));

// ------------------------------------------------------------------ helpers

/** Group project-scoped user assignments into one row per (user, project). */
export function groupAssignments(list: RoleAssignment[] | undefined, by: "user" | "project") {
  const rows = new Map<string, { key: Named; roles: Named[] }>();
  for (const a of list ?? []) {
    const key = by === "user" ? a.user : a.scope.project;
    if (!key || !a.scope.project || !a.user) continue;
    const row = rows.get(key.id) ?? { key, roles: [] };
    row.roles.push(a.role);
    rows.set(key.id, row);
  }
  return [...rows.values()].sort((a, b) => (a.key.name ?? "").localeCompare(b.key.name ?? ""));
}

// ------------------------------------------------------------------ CLI files

const q = (s: string | null | undefined) => JSON.stringify(s ?? "");

export function openrc(c: CliInfo, appCred?: { id: string; secret: string }) {
  const head = [
    "#!/usr/bin/env bash",
    `# OpenStack credentials for ${appCred ? "an application credential" : `project ${c.project_name}`} on ${c.cloud_name}.`,
    "# Generated by Rassvet. Load with:  source <this file>",
    "",
    "unset OS_TENANT_ID OS_TENANT_NAME OS_PROJECT_ID OS_PROJECT_NAME OS_PROJECT_DOMAIN_ID \\\n      OS_USERNAME OS_PASSWORD OS_USER_DOMAIN_NAME OS_APPLICATION_CREDENTIAL_ID OS_APPLICATION_CREDENTIAL_SECRET",
    `export OS_AUTH_URL=${q(c.auth_url)}`,
    "export OS_IDENTITY_API_VERSION=3",
    `export OS_INTERFACE=${q(c.interface)}`,
    ...(c.region ? [`export OS_REGION_NAME=${q(c.region)}`] : []),
  ];
  if (appCred) {
    return [
      ...head,
      'export OS_AUTH_TYPE="v3applicationcredential"',
      `export OS_APPLICATION_CREDENTIAL_ID=${q(appCred.id)}`,
      `export OS_APPLICATION_CREDENTIAL_SECRET=${q(appCred.secret)}`,
      "",
    ].join("\n");
  }
  return [
    ...head,
    'export OS_AUTH_TYPE="password"',
    `export OS_USERNAME=${q(c.user_name)}`,
    `export OS_USER_DOMAIN_NAME=${q(c.user_domain_name)}`,
    `export OS_PROJECT_ID=${q(c.project_id)}`,
    `export OS_PROJECT_NAME=${q(c.project_name)}`,
    `export OS_PROJECT_DOMAIN_ID=${q(c.project_domain_id)}`,
    "",
    'echo -n "Password for $OS_USERNAME on project $OS_PROJECT_NAME: "',
    "read -sr OS_PASSWORD_INPUT",
    "echo",
    'export OS_PASSWORD="$OS_PASSWORD_INPUT"',
    "",
  ].join("\n");
}

export function cloudsYaml(c: CliInfo, appCred?: { id: string; secret: string; name: string }) {
  const name = appCred ? `${c.cloud_id}-${appCred.name}`.replace(/[^\w.-]+/g, "-") : c.cloud_id;
  const lines = ["clouds:", `  ${name}:`];
  if (appCred) {
    lines.push(
      '    auth_type: "v3applicationcredential"',
      "    auth:",
      `      auth_url: ${q(c.auth_url)}`,
      `      application_credential_id: ${q(appCred.id)}`,
      `      application_credential_secret: ${q(appCred.secret)}`,
    );
  } else {
    lines.push(
      "    auth:",
      `      auth_url: ${q(c.auth_url)}`,
      `      username: ${q(c.user_name)}`,
      `      user_domain_name: ${q(c.user_domain_name)}`,
      `      project_id: ${q(c.project_id)}`,
      `      project_name: ${q(c.project_name)}`,
      `      project_domain_id: ${q(c.project_domain_id)}`,
      "      # password: put it here, or in secure.yaml next to this file",
    );
  }
  if (c.region) lines.push(`    region_name: ${q(c.region)}`);
  lines.push(`    interface: ${q(c.interface)}`, "    identity_api_version: 3", "");
  return `# Generated by Rassvet. Use with:  openstack --os-cloud ${name} <command>\n${lines.join("\n")}`;
}

// ------------------------------------------------------------------ EC2 credentials

/** An S3 / EC2-style access key pair of the signed-in user, bound to one project. */
export interface Ec2Credential {
  access: string;
  secret: string;
  tenant_id: string;
  user_id: string;
  trust_id?: string | null;
}

export const useEc2Creds = () =>
  useQuery({
    queryKey: ["identity", "ec2"],
    queryFn: () => api.get<{ credentials: Ec2Credential[] }>("/identity/ec2-credentials").then((r) => r.credentials),
  });

export const useCreateEc2Cred = () =>
  useIdentityMutation(() => api.post<{ credential: Ec2Credential }>("/identity/ec2-credentials").then((r) => r.credential));

export const useDeleteEc2Cred = () => useIdentityMutation((access: string) => api.del(`/identity/ec2-credentials/${enc(access)}`));

/**
 * S3 endpoint for the region: a catalog service of type "s3" when the cloud registers one,
 * else the origin of the object-store endpoint (Ceph RGW and Swift's s3api answer S3 at the
 * root of the same host and port).
 */
export function s3Endpoint(catalog: CatalogService[] | undefined, region: string | null) {
  const pub = (type: string) =>
    catalog
      ?.find((s) => s.type === type)
      ?.endpoints.filter((e) => e.interface === "public")
      .find((e, _, all) => !region || all.length === 1 || (e.region_id ?? e.region) === region)?.url;
  const s3 = pub("s3");
  if (s3) return { url: s3.replace(/\/+$/, ""), guessed: false };
  const swift = pub("object-store");
  if (!swift) return null;
  try {
    return { url: new URL(swift).origin, guessed: true };
  } catch {
    return null;
  }
}
