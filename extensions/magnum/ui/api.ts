/**
 * Magnum v1 through the extension's allowlisted gateway (`/api/ext/magnum/os/...`, service
 * name `ext:magnum` in the SDK's `os` helpers): types, hooks, constants and helpers.
 */
import { type Status, api, os, tr, useBootImages, useInAdmin, useOsGet, useOsList, useQuery, useSession } from "@rassvet/sdk";

export const MG = "ext:magnum" as const;
export const BASE = "/ext/magnum";

// =========================================================================== types

export type Labels = Record<string, string>;

export interface ClusterTemplate {
  uuid: string;
  name: string;
  coe: "kubernetes" | "swarm" | "swarm-mode" | "mesos" | string;
  image_id: string;
  keypair_id?: string | null;
  external_network_id?: string | null;
  fixed_network?: string | null;
  fixed_subnet?: string | null;
  flavor_id?: string | null;
  master_flavor_id?: string | null;
  dns_nameserver?: string | null;
  network_driver?: string | null;
  volume_driver?: string | null;
  docker_volume_size?: number | null;
  docker_storage_driver?: string | null;
  cluster_distro?: string | null;
  server_type?: "vm" | "bm" | string;
  apiserver_port?: number | null;
  http_proxy?: string | null;
  https_proxy?: string | null;
  no_proxy?: string | null;
  registry_enabled?: boolean;
  insecure_registry?: string | null;
  tls_disabled?: boolean;
  public?: boolean;
  hidden?: boolean;
  master_lb_enabled?: boolean;
  floating_ip_enabled?: boolean;
  labels?: Labels | null;
  tags?: string | null;
  driver?: string | null;
  project_id?: string;
  user_id?: string;
  created_at?: string;
  updated_at?: string | null;
}

export interface Cluster {
  uuid: string;
  name: string;
  cluster_template_id: string;
  keypair?: string | null;
  node_count: number;
  master_count: number;
  docker_volume_size?: number | null;
  labels?: Labels | null;
  labels_overridden?: Labels | null;
  labels_added?: Labels | null;
  labels_skipped?: Labels | null;
  master_flavor_id?: string | null;
  flavor_id?: string | null;
  create_timeout?: number;
  status: string;
  status_reason?: string | null;
  health_status?: "HEALTHY" | "UNHEALTHY" | "UNKNOWN" | null;
  health_status_reason?: Record<string, string> | null;
  api_address?: string | null;
  coe_version?: string | null;
  container_version?: string | null;
  discovery_url?: string | null;
  node_addresses?: string[];
  master_addresses?: string[];
  faults?: Record<string, string> | null;
  fixed_network?: string | null;
  fixed_subnet?: string | null;
  floating_ip_enabled?: boolean | null;
  master_lb_enabled?: boolean | null;
  stack_id?: string | null;
  cluster_id?: string | null;
  project_id?: string;
  user_id?: string;
  created_at?: string;
  updated_at?: string | null;
}

export interface NodeGroup {
  uuid: string;
  id?: number;
  name: string;
  cluster_id?: string;
  project_id?: string;
  flavor_id?: string | null;
  image_id?: string | null;
  docker_volume_size?: number | null;
  labels?: Labels | null;
  node_addresses?: string[];
  node_count: number;
  role: string;
  min_node_count?: number;
  max_node_count?: number | null;
  is_default?: boolean;
  stack_id?: string | null;
  status?: string;
  status_reason?: string | null;
  version?: string | null;
  created_at?: string;
  updated_at?: string | null;
}

export interface Quota {
  id?: number;
  project_id: string;
  resource: string;
  hard_limit: number;
  created_at?: string;
  updated_at?: string | null;
}

export interface MService {
  id: number;
  host: string;
  binary: string;
  state: "up" | "down" | string;
  disabled: boolean;
  disabled_reason?: string | null;
  report_count?: number;
  created_at?: string;
  updated_at?: string | null;
}

export interface Stats {
  clusters: number;
  nodes: number;
}

/** A JSON-Patch operation (Magnum's update format for clusters, templates and node groups). */
export interface PatchOp {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

// =========================================================================== status

const IN_PROGRESS = /_IN_PROGRESS$/;
export const busy = (o: { status?: string }) => IN_PROGRESS.test(o.status ?? "");

export function clusterStatus(s?: string): Status {
  if (!s) return "off";
  if (s.endsWith("_COMPLETE")) return s.startsWith("DELETE") ? "off" : "ok";
  if (IN_PROGRESS.test(s)) return "warn";
  if (s.endsWith("_FAILED")) return "error";
  return "off";
}

export function healthStatus(s?: string | null): Status {
  if (s === "HEALTHY") return "ok";
  if (s === "UNHEALTHY") return "error";
  return "off";
}

/** "Create complete" from CREATE_COMPLETE. */
export const statusText = (s?: string | null) => (s ? tr((s.charAt(0) + s.slice(1).toLowerCase()).replace(/_/g, " ")) : tr("Unknown"));

export const mgName = (o: { name?: string | null; uuid: string }) => o.name || `(${o.uuid.slice(0, 13)})`;

// =========================================================================== Cluster API driver

/**
 * Rassvet supports Magnum's Cluster API driver (magnum-capi-helm, `k8s_capi_helm_v1`) only.
 * It takes the Kubernetes version from the image's `kube_version` property (not a label),
 * always puts an Octavia load balancer in front of the API, and ignores the template's
 * floating_ip_enabled, docker_volume_size and volume_driver, a node group's image and the
 * nodes_to_remove of a resize.
 */
export const CAPI_DRIVER = "k8s_capi_helm_v1";
export const CAPI_OS_DISTROS = ["ubuntu", "flatcar"];
/** The driver's default minimum flavor ([capi_helm] minimum_flavor_ram / _vcpus in magnum.conf). */
export const MIN_FLAVOR_RAM = 2048;
export const MIN_FLAVOR_VCPUS = 2;

export const flavorTooSmall = (f: { ram: number; vcpus: number }) =>
  f.ram < MIN_FLAVOR_RAM ? tr("Under {mb} MB RAM", { mb: MIN_FLAVOR_RAM }) : f.vcpus < MIN_FLAVOR_VCPUS ? tr("Under {n} vCPUs", { n: MIN_FLAVOR_VCPUS }) : false;

/** `kube_version` property of a node image, without the leading "v". */
export const imageKubeVersion = (i?: { [key: string]: unknown } | null) => {
  const v = i?.kube_version;
  return typeof v === "string" && v.trim() ? v.trim().replace(/^v/, "") : undefined;
};

/** Why an image can't be used by the driver, or false. */
export function imageProblem(i: { [key: string]: unknown }) {
  const distro = typeof i.os_distro === "string" ? i.os_distro : "";
  if (!CAPI_OS_DISTROS.includes(distro)) return tr("os_distro must be ubuntu or flatcar");
  if (!imageKubeVersion(i)) return tr("No kube_version property");
  return false;
}

/** [major, minor] of "1.30.4". */
const minorOf = (v?: string) => {
  const m = /^(\d+)\.(\d+)/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2])] : undefined;
};

/** The driver doesn't check upgrades: warn about downgrades and skipped minor versions. */
export function upgradeProblem(from?: string, to?: string) {
  const a = minorOf(from);
  const b = minorOf(to);
  if (!a || !b) return false;
  if (b[0] < a[0] || (b[0] === a[0] && b[1] < a[1])) return tr("This is a downgrade, which Kubernetes doesn't support.");
  if (b[0] === a[0] && b[1] - a[1] > 1) return tr("Kubernetes upgrades one minor version at a time; go through the versions in between.");
  return false;
}

// =========================================================================== labels

/** Labels registered by the driver ([capi_helm_cluster_labels] in magnum.conf holds the defaults). */
export const LABEL_SUGGESTIONS = [
  { key: "master_lb_floating_ip_enabled", hint: tr("true (default): public address on the API load balancer"), values: ["true", "false"] },
  { key: "api_master_lb_allowed_cidrs", hint: tr("Comma-separated CIDRs allowed to reach the API; empty: all") },
  { key: "octavia_provider", hint: tr("Octavia provider of the cluster's load balancers"), values: ["amphora", "ovn"] },
  { key: "octavia_lb_algorithm", hint: tr("Load balancer algorithm; default ROUND_ROBIN (SOURCE_IP_PORT with ovn)") },
  { key: "octavia_lb_healthcheck", hint: tr("true (default): health checks on Service load balancers"), values: ["true", "false"] },
  { key: "auto_healing_enabled", hint: tr("true (default): replace unhealthy nodes"), values: ["true", "false"] },
  { key: "auto_scaling_enabled", hint: tr("true: cluster autoscaler within each node group's min / max"), values: ["true", "false"] },
  { key: "min_node_count", hint: tr("Autoscaler lower bound of the default worker group") },
  { key: "max_node_count", hint: tr("Autoscaler upper bound of the default worker group") },
  { key: "keystone_auth_enabled", hint: tr("true: sign in to Kubernetes with OpenStack tokens"), values: ["true", "false"] },
  { key: "monitoring_enabled", hint: tr("true: Prometheus monitoring stack"), values: ["true", "false"] },
  { key: "kube_dashboard_enabled", hint: tr("true (default): Kubernetes Dashboard"), values: ["true", "false"] },
  { key: "boot_volume_size", hint: tr("Root volume size in GiB (boot from volume)") },
  { key: "boot_volume_type", hint: tr("Cinder volume type of the root volume") },
  { key: "etcd_blockdevice_size", hint: tr("Size in GB of a separate etcd disk; 0: on the root disk") },
  { key: "etcd_blockdevice_type", hint: tr("volume (Cinder) or local (ephemeral disk)"), values: ["volume", "local"] },
  { key: "etcd_blockdevice_volume_type", hint: tr("Cinder volume type of the etcd disk") },
  { key: "etcd_blockdevice_volume_az", hint: tr("Availability zone of the etcd volume") },
  { key: "csi_cinder_availability_zone", hint: tr("Availability zone of persistent volumes (default nova)") },
  { key: "csi_cinder_reclaim_policy", hint: tr("Retain (default) or Delete volumes with their claim"), values: ["Retain", "Delete"] },
  { key: "csi_cinder_volume_binding_mode", hint: tr("WaitForFirstConsumer (default) or Immediate"), values: ["WaitForFirstConsumer", "Immediate"] },
  { key: "csi_cinder_fstype", hint: tr("Filesystem of persistent volumes (default ext4)") },
  { key: "csi_cinder_allow_volume_expansion", hint: tr("true (default): grow volumes by editing the claim"), values: ["true", "false"] },
  { key: "fixed_subnet_cidr", hint: tr("CIDR of the node network Magnum creates when none is given (default 10.0.0.0/24)") },
  { key: "pod_network_cidr", hint: tr("Pod CIDR (default 10.100.0.0/16); must not overlap OpenStack networks") },
  { key: "service_network_cidr", hint: tr("Service CIDR (default 172.24.0.0/13); must not overlap OpenStack networks") },
  { key: "extra_network_names", hint: tr("Space-separated names of more networks to attach to every node") },
  { key: "capi_helm_chart_version", hint: tr("capi-helm-charts version; template only, not per cluster") },
];

/** CNIs of capi-helm-charts (the template's network_driver). */
export const NETWORK_DRIVERS = ["calico", "cilium"];
export const OCTAVIA_PROVIDERS = ["amphora", "ovn"];

const TRUE = new Set(["true", "True", "1", "yes"]);
export const labelOn = (l: Labels, key: string, dflt: boolean) => (key in l ? TRUE.has(l[key]) : dflt);

/** Magnum stores label values as strings; the API also returns numbers and booleans. */
export const labelsOf = (l?: Labels | Record<string, unknown> | null): Labels =>
  Object.fromEntries(Object.entries(l ?? {}).map(([k, v]) => [k, String(v)]));

/** JSON-Patch that turns `before` into `after` for the given top-level attributes. */
export function diffPatch(before: Record<string, unknown>, after: Record<string, unknown>): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const [k, v] of Object.entries(after)) {
    const old = before[k];
    if (JSON.stringify(old ?? null) === JSON.stringify(v ?? null)) continue;
    if (v === undefined || v === null || v === "") {
      if (old !== undefined && old !== null && old !== "") ops.push({ op: "remove", path: `/${k}` });
    } else ops.push({ op: old === undefined || old === null ? "add" : "replace", path: `/${k}`, value: v });
  }
  return ops;
}

// =========================================================================== hooks

type Q = Record<string, string | number | boolean | undefined | null>;
const poll = (rows: { status?: string }[]) => rows.some(busy);

/**
 * Magnum answers `POST clusters` before magnum-conductor has created the cluster's node groups;
 * until then every read of a project's clusters fails with "Invalid input for field/attribute
 * master_count. Value: '0'" (the count is summed from the master node groups). Wait it out.
 */
const notReady = (e: Error) => /master_count\b.*'0'/.test(e.message);
const clusterRetry = {
  retry: (n: number, e: Error) => (notReady(e) ? n < 10 : !(e instanceof Error && "status" in e && Number(e.status) < 500) && n < 2),
  retryDelay: 3000,
};

/**
 * Magnum shows admins the clusters of every project, so the project view keeps only the
 * current project's (`project_id` is in the detailed list).
 */
export function useClusters(enabled = true) {
  const admin = useInAdmin();
  const project = useSession().data?.project?.id;
  const q = useOsList<Cluster>(MG, "clusters/detail", "clusters", undefined, { poll, enabled, ...clusterRetry });
  const data = admin || !q.data ? q.data : q.data.filter((c) => !c.project_id || c.project_id === project);
  return { ...q, data } as typeof q;
}

export const useCluster = (id: string) => useOsGet<Cluster>(MG, `clusters/${id}`, (r: Cluster) => r, { poll: busy, enabled: !!id, ...clusterRetry });

export function useTemplates(enabled = true) {
  const admin = useInAdmin();
  const project = useSession().data?.project?.id;
  const q = useOsList<ClusterTemplate>(MG, "clustertemplates", "clustertemplates", undefined, { enabled });
  const data = admin || !q.data ? q.data : q.data.filter((t) => t.public || !t.project_id || t.project_id === project);
  return { ...q, data } as typeof q;
}

/** Kubernetes version of a template: its image's kube_version (looked up among the bootable images). */
export function useTemplateVersion() {
  const images = useBootImages();
  return (t?: { image_id: string } | null) => imageKubeVersion(images.data?.find((i) => i.id === t?.image_id || i.name === t?.image_id));
}

export const useTemplate = (id: string, enabled = true) =>
  useOsGet<ClusterTemplate>(MG, `clustertemplates/${id}`, (r: ClusterTemplate) => r, { enabled: enabled && !!id });

/** The list only has a summary of each group; the details (min / max, labels…) come one by one. */
export const useNodeGroups = (clusterId: string, enabled = true) =>
  useOsList<NodeGroup>(MG, `clusters/${clusterId}/nodegroups`, "nodegroups", undefined, { poll, enabled: enabled && !!clusterId });

export const useNodeGroup = (clusterId: string, id: string, enabled = true) =>
  useOsGet<NodeGroup>(MG, `clusters/${clusterId}/nodegroups/${id}`, (r: NodeGroup) => r, { poll: busy, enabled: enabled && !!clusterId && !!id });

export const useStats = (q?: Q, enabled = true) => useOsGet<Stats>(MG, "stats", (r: Stats) => r, { q, enabled });

export const useQuotas = (enabled = true) => useOsList<Quota>(MG, "quotas", "quotas", undefined, { enabled });
export const useOwnQuota = (projectId?: string) =>
  useOsGet<Quota | null>(MG, `quotas/${projectId}/Cluster`, (r: Quota) => r, { enabled: !!projectId });

/** Microversion negotiated with the cloud's Magnum (`GET /api/ext/magnum/info`). */
export const useMagnumInfo = () =>
  useQuery({ queryKey: ["ext:magnum", "info"], queryFn: () => api.get<{ microversion: string | null }>("/ext/magnum/info"), staleTime: 10 * 60_000 });

/** `have` (e.g. "1.11") is at least `want` ("1.12"). */
export function atLeast(have: string | null | undefined, want: string) {
  if (!have) return false;
  const [a, b] = have.split(".").map(Number);
  const [c, d] = want.split(".").map(Number);
  return a > c || (a === c && b >= d);
}

/** Why a feature that needs Magnum `want` can't be used, or false (unknown yet: allowed). */
export function needsVersion(have: string | null | undefined, want: string, loaded: boolean): string | false {
  if (!loaded || atLeast(have, want)) return false;
  return tr("Needs Magnum API {want} or later; this cloud has {have}", { want, have: have ?? "?" });
}

export const useMServices = (enabled = true) => useOsList<MService>(MG, "mservices", "mservices", undefined, { enabled });

// =========================================================================== calls

export const patchCluster = (id: string, ops: PatchOp[]) => os.patch<{ uuid: string }>(MG, `clusters/${id}`, ops);
export const patchTemplate = (id: string, ops: PatchOp[]) => os.patch<ClusterTemplate>(MG, `clustertemplates/${id}`, ops);
/** New application credential for the cluster, made with the caller's credentials. */
export const rotateCredentials = (id: string) => os.patch<{ uuid: string }>(MG, `credentials/${id}`);

/** A kubeconfig for the cluster (`cert`: new client certificate signed by the cluster CA). */
export const fetchKubeconfig = (id: string, auth: "cert" | "keystone") =>
  api.post<{ filename: string; kubeconfig: string }>(`/ext/magnum/clusters/${encodeURIComponent(id)}/kubeconfig`, { auth });
