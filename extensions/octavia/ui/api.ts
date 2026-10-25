/**
 * Octavia v2 through the extension's allowlisted gateway (`/api/ext/octavia/os/...`, service
 * name `ext:octavia` in the SDK's `os` helpers): types, hooks, constants and helpers.
 */
import { type Status, os, tr, useInAdmin, useOsGet, useOsList, useSession } from "@rassvet/sdk";

export const LB = "ext:octavia" as const;
export const BASE = "/ext/octavia";

// =========================================================================== types

export interface Ref {
  id: string;
}

interface Common {
  id: string;
  name: string;
  description?: string;
  project_id: string;
  provisioning_status: string;
  operating_status: string;
  admin_state_up: boolean;
  tags?: string[];
  created_at?: string;
  updated_at?: string | null;
}

export interface LoadBalancer extends Common {
  vip_address: string;
  vip_port_id: string;
  vip_subnet_id: string;
  vip_network_id: string;
  vip_qos_policy_id?: string | null;
  provider: string;
  flavor_id?: string | null;
  availability_zone?: string | null;
  listeners: Ref[];
  pools: Ref[];
  additional_vips?: { subnet_id: string; ip_address?: string }[];
}

export type ListenerProtocol = "HTTP" | "HTTPS" | "TERMINATED_HTTPS" | "TCP" | "UDP" | "SCTP" | "PROMETHEUS";

export interface Listener extends Common {
  protocol: ListenerProtocol;
  protocol_port: number;
  connection_limit: number;
  default_pool_id: string | null;
  default_tls_container_ref?: string | null;
  sni_container_refs?: string[];
  insert_headers?: Record<string, string>;
  timeout_client_data?: number | null;
  timeout_member_connect?: number | null;
  timeout_member_data?: number | null;
  timeout_tcp_inspect?: number | null;
  allowed_cidrs?: string[] | null;
  tls_ciphers?: string | null;
  tls_versions?: string[] | null;
  alpn_protocols?: string[] | null;
  client_ca_tls_container_ref?: string | null;
  client_authentication?: "NONE" | "OPTIONAL" | "MANDATORY";
  client_crl_container_ref?: string | null;
  hsts_max_age?: number | null;
  hsts_include_subdomains?: boolean;
  hsts_preload?: boolean;
  loadbalancers: Ref[];
  l7policies: Ref[];
}

export type PoolProtocol = "HTTP" | "HTTPS" | "PROXY" | "PROXYV2" | "TCP" | "UDP" | "SCTP";
export type Algorithm = "ROUND_ROBIN" | "LEAST_CONNECTIONS" | "SOURCE_IP" | "SOURCE_IP_PORT";

export interface Persistence {
  type: "SOURCE_IP" | "HTTP_COOKIE" | "APP_COOKIE";
  cookie_name?: string | null;
  persistence_timeout?: number | null;
  persistence_granularity?: string | null;
}

export interface Pool extends Common {
  protocol: PoolProtocol;
  lb_algorithm: Algorithm;
  session_persistence: Persistence | null;
  loadbalancers: Ref[];
  listeners: Ref[];
  members: Ref[];
  healthmonitor_id: string | null;
  tls_enabled?: boolean;
  tls_container_ref?: string | null;
  ca_tls_container_ref?: string | null;
  crl_container_ref?: string | null;
  tls_ciphers?: string | null;
  tls_versions?: string[] | null;
  alpn_protocols?: string[] | null;
}

export interface Member extends Omit<Common, "description"> {
  address: string;
  protocol_port: number;
  weight: number;
  backup: boolean;
  subnet_id?: string | null;
  monitor_address?: string | null;
  monitor_port?: number | null;
}

export type MonitorType = "HTTP" | "HTTPS" | "PING" | "TCP" | "TLS-HELLO" | "UDP-CONNECT" | "SCTP";

export interface HealthMonitor extends Omit<Common, "description"> {
  type: MonitorType;
  delay: number;
  timeout: number;
  max_retries: number;
  max_retries_down: number;
  http_method?: string | null;
  url_path?: string | null;
  expected_codes?: string | null;
  http_version?: number | null;
  domain_name?: string | null;
  pools: Ref[];
}

export type L7Action = "REDIRECT_TO_POOL" | "REDIRECT_TO_URL" | "REDIRECT_PREFIX" | "REJECT";

export interface L7Policy extends Common {
  listener_id: string;
  action: L7Action;
  position: number;
  redirect_pool_id?: string | null;
  redirect_url?: string | null;
  redirect_prefix?: string | null;
  redirect_http_code?: number | null;
  rules: Ref[];
}

export type L7RuleType = "HOST_NAME" | "PATH" | "FILE_TYPE" | "HEADER" | "COOKIE" | "SSL_CONN_HAS_CERT" | "SSL_VERIFY_RESULT" | "SSL_DN_FIELD";
export type CompareType = "REGEX" | "STARTS_WITH" | "ENDS_WITH" | "CONTAINS" | "EQUAL_TO";

export interface L7Rule extends Omit<Common, "name" | "description"> {
  l7policy_id?: string;
  type: L7RuleType;
  compare_type: CompareType;
  key?: string | null;
  value: string;
  invert: boolean;
}

export interface Stats {
  active_connections: number;
  bytes_in: number;
  bytes_out: number;
  request_errors: number;
  total_connections: number;
}

export interface Amphora {
  id: string;
  loadbalancer_id: string | null;
  compute_id: string | null;
  lb_network_ip: string | null;
  vrrp_ip: string | null;
  ha_ip: string | null;
  role: "MASTER" | "BACKUP" | "STANDALONE" | null;
  status: string;
  cert_expiration?: string | null;
  vrrp_priority?: number | null;
  cached_zone?: string | null;
  image_id?: string | null;
  compute_flavor?: string | null;
  created_at?: string;
  updated_at?: string | null;
}

export interface LbFlavor {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  flavor_profile_id: string;
}

export interface FlavorProfile {
  id: string;
  name: string;
  provider_name: string;
  flavor_data: string;
}

export interface LbZone {
  name: string;
  description?: string;
  enabled: boolean;
  availability_zone_profile_id: string;
}

export interface ZoneProfile {
  id: string;
  name: string;
  provider_name: string;
  availability_zone_data: string;
}

export interface Provider {
  name: string;
  description: string;
}

export type LbQuota = Record<"load_balancer" | "listener" | "member" | "pool" | "health_monitor" | "l7policy" | "l7rule", number | null>;

/** Octavia's status tree (`GET loadbalancers/{id}/status`). */
export interface StatusNode {
  id: string;
  name?: string;
  type?: string;
  action?: string;
  address?: string;
  protocol_port?: number;
  provisioning_status: string;
  operating_status: string;
  listeners?: StatusNode[];
  pools?: StatusNode[];
  members?: StatusNode[];
  l7policies?: StatusNode[];
  rules?: StatusNode[];
  health_monitor?: StatusNode;
}

// =========================================================================== status

const PENDING = /^PENDING_/;
export const pending = (o: { provisioning_status: string }) => PENDING.test(o.provisioning_status);

export function provStatus(s: string): Status {
  if (s === "ACTIVE") return "ok";
  if (PENDING.test(s)) return "warn";
  if (s === "ERROR") return "error";
  return "off";
}

export function opStatus(s: string): Status {
  if (s === "ONLINE") return "ok";
  if (s === "DEGRADED" || s === "DRAINING" || s === "NO_MONITOR") return "warn";
  if (s === "ERROR") return "error";
  return "off";
}

/** "Pending create" from PENDING_CREATE, "No monitor" from NO_MONITOR. */
export const statusText = (s: string) => tr((s.charAt(0) + s.slice(1).toLowerCase()).replace(/_/g, " "));

export const lbName = (o: { name?: string; id: string }) => o.name || `(${o.id.slice(0, 13)})`;

// =========================================================================== labels

export const LISTENER_PROTOCOLS: { value: ListenerProtocol; label: string; description: string }[] = [
  { value: "HTTP", label: "HTTP", description: tr("Layer 7: L7 policies, X-Forwarded-For and other headers") },
  { value: "TERMINATED_HTTPS", label: "TERMINATED_HTTPS", description: tr("HTTPS ended at the load balancer with a certificate from Barbican") },
  { value: "HTTPS", label: "HTTPS", description: tr("TLS passed through to the members (no inspection)") },
  { value: "TCP", label: "TCP", description: tr("Layer 4") },
  { value: "UDP", label: "UDP", description: tr("Layer 4, connectionless (DNS, syslog…)") },
  { value: "SCTP", label: "SCTP", description: tr("Layer 4, multi-streaming") },
  { value: "PROMETHEUS", label: "PROMETHEUS", description: tr("Metrics endpoint of the load balancer itself (no pool)") },
];

/** Pool protocols a listener protocol can use (Octavia's compatibility matrix). */
export const POOL_FOR_LISTENER: Record<ListenerProtocol, PoolProtocol[]> = {
  HTTP: ["HTTP", "PROXY", "PROXYV2"],
  HTTPS: ["HTTPS", "PROXY", "PROXYV2", "TCP"],
  TERMINATED_HTTPS: ["HTTP", "PROXY", "PROXYV2"],
  TCP: ["TCP", "HTTP", "HTTPS", "PROXY", "PROXYV2"],
  UDP: ["UDP"],
  SCTP: ["SCTP"],
  PROMETHEUS: [],
};

export const POOL_PROTOCOLS: PoolProtocol[] = ["HTTP", "HTTPS", "PROXY", "PROXYV2", "TCP", "UDP", "SCTP"];

export const ALGORITHMS: { value: Algorithm; label: string; description: string }[] = [
  { value: "ROUND_ROBIN", label: tr("Round robin"), description: tr("Each member in turn (by weight)") },
  { value: "LEAST_CONNECTIONS", label: tr("Least connections"), description: tr("The member with the fewest open connections") },
  { value: "SOURCE_IP", label: tr("Source IP"), description: tr("Same client address → same member") },
  { value: "SOURCE_IP_PORT", label: tr("Source IP and port"), description: tr("Hash of client address and port (OVN provider)") },
];
export const PERSISTENCE_LABELS: Record<string, string> = {
  SOURCE_IP: tr("Source IP"),
  HTTP_COOKIE: tr("HTTP cookie"),
  APP_COOKIE: tr("Application cookie"),
};

export const algorithmLabel = (a: string) => ALGORITHMS.find((x) => x.value === a)?.label ?? a;

export const MONITOR_TYPES: MonitorType[] = ["HTTP", "HTTPS", "PING", "TCP", "TLS-HELLO", "UDP-CONNECT", "SCTP"];

export const L7_ACTIONS: { value: L7Action; label: string; description: string }[] = [
  { value: "REDIRECT_TO_POOL", label: tr("Send to pool"), description: tr("Matching requests go to another pool") },
  { value: "REDIRECT_TO_URL", label: tr("Redirect to URL"), description: tr("HTTP redirect to a fixed URL") },
  { value: "REDIRECT_PREFIX", label: tr("Redirect prefix"), description: tr("HTTP redirect keeping the path: prefix + original path") },
  { value: "REJECT", label: tr("Reject"), description: tr("Answer 403 Forbidden") },
];
export const actionLabel = (a: string) => L7_ACTIONS.find((x) => x.value === a)?.label ?? a;

export const RULE_TYPES: { value: L7RuleType; label: string; key?: string; description: string }[] = [
  { value: "HOST_NAME", label: tr("Host name"), description: tr("The Host header, e.g. www.example.com") },
  { value: "PATH", label: tr("Path"), description: tr("The request path, e.g. /api") },
  { value: "FILE_TYPE", label: tr("File type"), description: tr("The extension of the requested file, e.g. jpg") },
  { value: "HEADER", label: tr("Header"), key: tr("Header name"), description: tr("A request header's value") },
  { value: "COOKIE", label: tr("Cookie"), key: tr("Cookie name"), description: tr("A cookie's value") },
  { value: "SSL_CONN_HAS_CERT", label: tr("Client certificate"), description: tr("Whether the client sent a certificate (value: True)") },
  { value: "SSL_VERIFY_RESULT", label: tr("Certificate verify result"), description: tr("The client certificate's verification result (0 = valid)") },
  { value: "SSL_DN_FIELD", label: tr("Certificate DN field"), key: tr("DN field"), description: tr("A field of the client certificate's DN, e.g. CN") },
];
export const ruleTypeLabel = (t: string) => RULE_TYPES.find((x) => x.value === t)?.label ?? t;

export const COMPARE_TYPES: { value: CompareType; label: string }[] = [
  { value: "EQUAL_TO", label: tr("equals") },
  { value: "STARTS_WITH", label: tr("starts with") },
  { value: "ENDS_WITH", label: tr("ends with") },
  { value: "CONTAINS", label: tr("contains") },
  { value: "REGEX", label: tr("matches regex") },
];
export const compareLabel = (c: string) => COMPARE_TYPES.find((x) => x.value === c)?.label ?? c;

export const ruleText = (r: L7Rule) =>
  `${r.invert ? tr("NOT") + " " : ""}${ruleTypeLabel(r.type)}${r.key ? ` ${r.key}` : ""} ${compareLabel(r.compare_type)} “${r.value}”`;

export function policyTarget(p: L7Policy, poolName: (id: string) => string) {
  switch (p.action) {
    case "REDIRECT_TO_POOL":
      return p.redirect_pool_id ? `→ ${poolName(p.redirect_pool_id)}` : "";
    case "REDIRECT_TO_URL":
      return `→ ${p.redirect_url ?? ""}${p.redirect_http_code ? ` (${p.redirect_http_code})` : ""}`;
    case "REDIRECT_PREFIX":
      return `→ ${p.redirect_prefix ?? ""}…${p.redirect_http_code ? ` (${p.redirect_http_code})` : ""}`;
    default:
      return "403";
  }
}

export const fmtCount = (n?: number | null) => (n == null ? "—" : n.toLocaleString());

// =========================================================================== hooks

type Q = Record<string, string | number | boolean | undefined | null>;
const poll = (rows: { provisioning_status: string }[]) => rows.some(pending);

/** `project_id` in the project view (Octavia shows admins every project's objects otherwise). */
export function useScope(): Q {
  const admin = useInAdmin();
  const session = useSession();
  return admin ? {} : { project_id: session.data?.project?.id };
}

export const useLoadBalancers = (q?: Q, enabled = true) =>
  useOsList<LoadBalancer>(LB, "lbaas/loadbalancers", "loadbalancers", q, { poll, enabled });
export const useListeners = (q?: Q, enabled = true) => useOsList<Listener>(LB, "lbaas/listeners", "listeners", q, { poll, enabled });
export const usePools = (q?: Q, enabled = true) => useOsList<Pool>(LB, "lbaas/pools", "pools", q, { poll, enabled });
export const useMembers = (poolId: string, enabled = true) =>
  useOsList<Member>(LB, `lbaas/pools/${poolId}/members`, "members", undefined, { poll, enabled: enabled && !!poolId });
export const useHealthMonitors = (q?: Q, enabled = true) =>
  useOsList<HealthMonitor>(LB, "lbaas/healthmonitors", "healthmonitors", q, { poll, enabled });
export const useL7Policies = (q?: Q, enabled = true) => useOsList<L7Policy>(LB, "lbaas/l7policies", "l7policies", q, { poll, enabled });
export const useL7Rules = (policyId: string) => useOsList<L7Rule>(LB, `lbaas/l7policies/${policyId}/rules`, "rules", undefined, { poll });

export const useLoadBalancer = (id: string) =>
  useOsGet<LoadBalancer>(LB, `lbaas/loadbalancers/${id}`, (r: { loadbalancer: LoadBalancer }) => r.loadbalancer, { poll: pending });
export const useListener = (id: string) =>
  useOsGet<Listener>(LB, `lbaas/listeners/${id}`, (r: { listener: Listener }) => r.listener, { poll: pending });
export const usePool = (id: string) => useOsGet<Pool>(LB, `lbaas/pools/${id}`, (r: { pool: Pool }) => r.pool, { poll: pending });

export const useFlavorsLb = () => useOsList<LbFlavor>(LB, "lbaas/flavors", "flavors");
export const useZonesLb = () => useOsList<LbZone>(LB, "lbaas/availabilityzones", "availability_zones");
export const useProviders = () => useOsList<Provider>(LB, "lbaas/providers", "providers");

export const useLbStats = (path: string, enabled = true) =>
  useOsGet<Stats>(LB, `${path}/stats`, (r: { stats: Stats }) => r.stats, { enabled });

/** Delete with Octavia's cascade (a load balancer and everything under it). */
export const deleteLb = (id: string, cascade: boolean) => os.del(LB, `lbaas/loadbalancers/${id}`, cascade ? { cascade: "true" } : undefined);

/** Comma/space separated list → array (empty → undefined). */
export const splitList = (s: string) => {
  const v = s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return v.length ? v : undefined;
};

export const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
