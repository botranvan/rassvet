/**
 * What the command palette can find: one `ResourceKind` per kind of resource, looked up by
 * a pasted full ID and searched by name. The host lists its own kinds here; extensions add
 * theirs through `ExtensionUi.palette.resources` (see the SDK).
 */
import { api } from "./api";
import { os } from "./os";
import { tr } from "@/lib/i18n";

export interface PaletteContext {
  /** Admin view: look across projects. */
  admin: boolean;
  /** The current project (project view). */
  project?: string;
  /** Base of an extension's pages: `/ext/<id>` or, in the admin view, `/admin/ext/<id>`. */
  base: string;
  signal?: AbortSignal;
}

/** One kind of resource the palette can find. `R` is the API's row. */
export interface ResourceKind<R = any> {
  /** Shown next to each result, e.g. "Volume snapshot". */
  kind: string;
  icon: string;
  /** Catalog service types; the kind is searched when any of them is in the region. */
  services?: string[];
  /** Only in this view (default: both). */
  view?: "admin" | "project";
  /** One row by its full ID (404: not of this kind). Without it, IDs aren't looked up. */
  get?: (id: string, c: PaletteContext) => Promise<R | null | undefined>;
  /** Rows whose name may contain `q`, filtered by the API; they are matched again here. */
  search?: (q: string, c: PaletteContext) => Promise<R[]>;
  /** Without `search`: every row (cached for a minute per view), matched by name here. */
  list?: (c: PaletteContext) => Promise<R[]>;
  /** Default `r.id`. */
  id?: (r: R) => string;
  /** What the query is matched against and the result shows (default `r.name`). */
  name?: (r: R) => string | null | undefined;
  /** Drop rows that don't belong in this view (another project's, in the project view). */
  keep?: (r: R, c: PaletteContext) => boolean;
  /** Page that shows the row (a project path: the admin view maps it to its admin twin). */
  path: (r: R, c: PaletteContext) => string;
}

export interface Found {
  kind: string;
  icon: string;
  id: string;
  name: string;
  path: string;
}

type Row = { id: string; name?: string | null };
const enc = encodeURIComponent;
const all = (c: PaletteContext) => (c.admin ? { all_tenants: 1 } : {});
const sig = (c: PaletteContext) => ({ signal: c.signal });
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `GET <path>/<id>` through the gateway, unwrapped from `{ <key>: … }` (no key: the body itself). */
const one =
  <R,>(svc: Parameters<typeof os.get>[0], path: string, key?: string) =>
  (id: string, c: PaletteContext) =>
    os.get<Record<string, R>>(svc, `${path}/${enc(id)}`, undefined, sig(c)).then((r) => (key ? r[key] : (r as unknown as R)));
/** Ready-made row path for lists without a detail page: the list opened on that row. */
export const findPath = (list: string, value: string) => `${list}?find=${enc(value)}`;

const VOLUME = ["block-storage", "volumev3", "volume"];
const refId = (ref?: string | null) => (ref ? (ref.replace(/\/+$/, "").split("/").pop() ?? "") : "");

export const CORE_RESOURCES: ResourceKind[] = [
  // ------------------------------------------------------------------ compute
  {
    kind: tr("Instance"),
    icon: "server",
    services: ["compute"],
    get: one("compute", "servers", "server"),
    search: (q, c) => os.get<{ servers: Row[] }>("compute", "servers", { ...all(c), name: escapeRe(q), limit: 8 }, sig(c)).then((r) => r.servers),
    path: (r: Row) => `/compute/instances/${r.id}`,
  },
  {
    kind: tr("Image"),
    icon: "disc-3",
    services: ["image"],
    // Glance goes through Rassvet's image API (not the generic gateway).
    get: (id, c) => api.get<Row>(`/image/images/${enc(id)}`, sig(c)),
    list: () => api.get<{ images: Row[] }>("/image/images?view=all").then((r) => r.images),
    path: (r: Row) => `/compute/images/${r.id}`,
  },
  {
    kind: tr("Flavor"),
    icon: "cpu",
    services: ["compute"],
    get: one("compute", "flavors", "flavor"),
    list: (c) => os.list<Row>("compute", "flavors", "flavors", c.admin ? { is_public: "None" } : undefined),
    path: (r: Row, c) => (c.admin ? `/admin/compute/flavors/${enc(r.id)}` : findPath("/compute/flavors", r.id)),
  },
  {
    kind: tr("Key pair"),
    icon: "key-round",
    services: ["compute"],
    view: "project",
    list: () => os.get<{ keypairs: { keypair: { name: string } }[] }>("compute", "os-keypairs").then((r) => r.keypairs.map((k) => k.keypair)),
    id: (k: { name: string }) => k.name,
    path: (k: { name: string }) => findPath("/compute/keypairs", k.name),
  },
  {
    kind: tr("Server group"),
    icon: "group",
    services: ["compute"],
    get: one("compute", "os-server-groups", "server_group"),
    list: (c) => os.list<Row>("compute", "os-server-groups", "server_groups", c.admin ? { all_projects: true } : undefined),
    path: (r: Row) => findPath("/compute/server-groups", r.id),
  },
  // ------------------------------------------------------------------ block storage
  {
    kind: tr("Volume"),
    icon: "hard-drive",
    services: VOLUME,
    get: one("volume", "volumes", "volume"),
    search: (q, c) => os.get<{ volumes: Row[] }>("volume", "volumes", { ...all(c), "name~": q, limit: 8 }, sig(c)).then((r) => r.volumes),
    path: (r: Row) => `/storage/volumes/${r.id}`,
  },
  {
    kind: tr("Volume snapshot"),
    icon: "camera",
    services: VOLUME,
    get: one("volume", "snapshots", "snapshot"),
    search: (q, c) => os.get<{ snapshots: Row[] }>("volume", "snapshots", { ...all(c), "name~": q, limit: 8 }, sig(c)).then((r) => r.snapshots),
    path: (r: Row) => findPath("/storage/snapshots", r.id),
  },
  {
    kind: tr("Volume backup"),
    icon: "archive-restore",
    services: VOLUME,
    get: one("volume", "backups", "backup"),
    search: (q, c) => os.get<{ backups: Row[] }>("volume", "backups", { ...all(c), "name~": q, limit: 8 }, sig(c)).then((r) => r.backups),
    path: (r: Row) => findPath("/storage/backups", r.id),
  },
  {
    kind: tr("Volume group"),
    icon: "layers",
    services: VOLUME,
    get: one("volume", "groups", "group"),
    list: (c) => os.list<Row>("volume", "groups", "groups", all(c)),
    path: (r: Row) => `/storage/groups/${r.id}`,
  },
  {
    kind: tr("Group snapshot"),
    icon: "camera",
    services: VOLUME,
    get: one("volume", "group_snapshots", "group_snapshot"),
    list: (c) => os.list<Row>("volume", "group_snapshots", "group_snapshots", all(c)),
    path: (r: Row) => `/storage/group-snapshots/${r.id}`,
  },
  {
    kind: tr("Volume type"),
    icon: "layers",
    services: VOLUME,
    view: "admin",
    get: one("volume", "types", "volume_type"),
    list: () => os.list<Row>("volume", "types", "volume_types", { is_public: "None" }),
    path: (r: Row) => `/admin/storage/volume-types/${r.id}`,
  },
  // ------------------------------------------------------------------ network (Neutron can't search names: lists are cached)
  {
    kind: tr("Network"),
    icon: "network",
    services: ["network"],
    get: one("network", "networks", "network"),
    list: () => os.list<Row>("network", "networks", "networks", { fields: ["id", "name"] }),
    path: (r: Row) => `/network/networks/${r.id}`,
  },
  {
    kind: tr("Subnet"),
    icon: "network",
    services: ["network"],
    get: one("network", "subnets", "subnet"),
    list: () => os.list<Row & { network_id: string; cidr: string }>("network", "subnets", "subnets", { fields: ["id", "name", "network_id", "cidr"] }),
    // The CIDR finds it too.
    name: (s: Row & { cidr: string }) => (s.name ? `${s.name} (${s.cidr})` : s.cidr),
    path: (s: { network_id: string }) => `/network/networks/${s.network_id}`,
  },
  {
    kind: tr("Port"),
    icon: "ethernet-port",
    services: ["network"],
    get: one("network", "ports", "port"),
    list: (c) => os.list<Row>("network", "ports", "ports", { fields: ["id", "name"], ...(c.admin ? {} : { project_id: c.project }) }),
    path: (r: Row) => findPath("/network/ports", r.id),
  },
  {
    kind: tr("Router"),
    icon: "router",
    services: ["network"],
    get: one("network", "routers", "router"),
    list: () => os.list<Row>("network", "routers", "routers", { fields: ["id", "name"] }),
    path: (r: Row) => `/network/routers/${r.id}`,
  },
  {
    kind: tr("Security group"),
    icon: "shield",
    services: ["network"],
    get: one("network", "security-groups", "security_group"),
    list: () => os.list<Row>("network", "security-groups", "security_groups", { fields: ["id", "name"] }),
    path: (r: Row) => `/network/security-groups/${r.id}`,
  },
  {
    kind: tr("Floating IP"),
    icon: "globe",
    services: ["network"],
    get: one("network", "floatingips", "floatingip"),
    list: (c) => os.list<Row>("network", "floatingips", "floatingips", { fields: ["id", "floating_ip_address", "description"], ...(c.admin ? {} : { project_id: c.project }) }),
    // Found by its address (or description).
    name: (f: { floating_ip_address: string; description?: string }) => (f.description ? `${f.floating_ip_address} (${f.description})` : f.floating_ip_address),
    path: (r: Row) => findPath("/network/floating-ips", r.id),
  },
  {
    kind: tr("Trunk"),
    icon: "cable",
    services: ["network"],
    get: one("network", "trunks", "trunk"),
    list: () => os.list<Row>("network", "trunks", "trunks", { fields: ["id", "name"] }),
    path: (r: Row) => `/network/trunks/${r.id}`,
  },
  {
    kind: tr("QoS policy"),
    icon: "gauge",
    services: ["network"],
    get: one("network", "qos/policies", "policy"),
    list: () => os.list<Row>("network", "qos/policies", "policies", { fields: ["id", "name"] }),
    path: (r: Row) => `/network/qos/${r.id}`,
  },
  {
    kind: tr("Subnet pool"),
    icon: "boxes",
    services: ["network"],
    get: one("network", "subnetpools", "subnetpool"),
    list: () => os.list<Row>("network", "subnetpools", "subnetpools", { fields: ["id", "name"] }),
    path: (r: Row) => `/network/subnet-pools/${r.id}`,
  },
  // ------------------------------------------------------------------ key manager (project pages only)
  {
    kind: tr("Secret"),
    icon: "key-round",
    services: ["key-manager"],
    view: "project",
    get: (id, c) => one<{ secret_ref: string; name: string | null }>("key-manager", "secrets")(id, c).then((r) => r && { ...r, id: refId(r.secret_ref) }),
    list: () => os.list<{ secret_ref: string; name: string | null }>("key-manager", "secrets", "secrets").then((l) => l.map((r) => ({ ...r, id: refId(r.secret_ref) }))),
    path: (r: Row) => `/key-manager/secrets/${r.id}`,
  },
  {
    kind: tr("Secret container"),
    icon: "package",
    services: ["key-manager"],
    view: "project",
    get: (id, c) => one<{ container_ref: string; name: string | null }>("key-manager", "containers")(id, c).then((r) => r && { ...r, id: refId(r.container_ref) }),
    list: () => os.list<{ container_ref: string; name: string | null }>("key-manager", "containers", "containers").then((l) => l.map((r) => ({ ...r, id: refId(r.container_ref) }))),
    path: (r: Row) => `/key-manager/containers/${r.id}`,
  },
  {
    kind: tr("Order"),
    icon: "list-checks",
    services: ["key-manager"],
    view: "project",
    get: (id, c) => one<{ order_ref: string; meta: { name?: string | null } }>("key-manager", "orders")(id, c).then((r) => r && { ...r, id: refId(r.order_ref) }),
    list: () => os.list<{ order_ref: string; meta: { name?: string | null } }>("key-manager", "orders", "orders").then((l) => l.map((r) => ({ ...r, id: refId(r.order_ref) }))),
    name: (o: { meta: { name?: string | null } }) => o.meta?.name,
    // What the order made, when it's done.
    path: (o: { secret_ref?: string; container_ref?: string }) =>
      o.container_ref ? `/key-manager/containers/${refId(o.container_ref)}` : o.secret_ref ? `/key-manager/secrets/${refId(o.secret_ref)}` : "/key-manager/orders",
  },
  // ------------------------------------------------------------------ object storage
  {
    kind: tr("Object container"),
    icon: "archive",
    services: ["object-store"],
    view: "project",
    list: () => api.get<{ containers: { name: string }[] }>("/object-store/containers").then((r) => r.containers),
    id: (c: { name: string }) => c.name,
    path: (c: { name: string }) => `/object-store/containers/${enc(c.name)}`,
  },
  // ------------------------------------------------------------------ identity (admin view)
  {
    kind: tr("Project"),
    icon: "folder",
    view: "admin",
    get: (id, c) => api.get<{ project: Row }>(`/identity/admin/projects/${enc(id)}`, sig(c)).then((r) => r.project),
    search: (q, c) => api.get<{ projects: Row[] }>(`/identity/admin/projects?q=${enc(q)}`, sig(c)).then((r) => r.projects),
    path: (r: Row) => `/admin/identity/projects/${r.id}`,
  },
  {
    kind: tr("User"),
    icon: "users-round",
    view: "admin",
    get: (id, c) => api.get<{ user: Row }>(`/identity/admin/users/${enc(id)}`, sig(c)).then((r) => r.user),
    search: (q, c) => api.get<{ users: Row[] }>(`/identity/admin/users?q=${enc(q)}`, sig(c)).then((r) => r.users),
    path: (r: Row) => `/admin/identity/users/${r.id}`,
  },
  {
    kind: tr("Group"),
    icon: "users",
    view: "admin",
    get: one("identity", "groups", "group"),
    list: () => os.list<Row>("identity", "groups", "groups"),
    path: (r: Row) => `/admin/identity/groups/${r.id}`,
  },
];
