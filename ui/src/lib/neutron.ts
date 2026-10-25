/**
 * Neutron beyond networks/subnets/ports/routers: trunks, QoS policies and rules, RBAC
 * sharing, agents and their scheduling, IP availability. All through the gateway (`os.*`).
 */
import { useQuery } from "@tanstack/react-query";
import { os, useOsList } from "./os";
import { tr } from "@/lib/i18n";

type Query = Record<string, string | number | boolean | undefined>;

/** Loaded Neutron extensions (aliases), to hide features the cloud doesn't have. */
export const useNeutronExtensions = () =>
  useQuery({
    queryKey: ["os", "network", "extensions"],
    queryFn: () => os.get<{ extensions: { alias: string }[] }>("network", "extensions").then((r) => new Set(r.extensions.map((e) => e.alias))),
    staleTime: 10 * 60_000,
  });

// =========================================================================== trunks

export interface SubPort {
  port_id: string;
  segmentation_type: "vlan" | "inherit" | string;
  segmentation_id: number;
  mac_address?: string;
}

export interface Trunk {
  id: string;
  name: string;
  description?: string;
  port_id: string;
  status: string;
  admin_state_up: boolean;
  project_id: string;
  sub_ports: SubPort[];
  created_at?: string;
  updated_at?: string;
}

export const useTrunks = (q?: Query) => useOsList<Trunk>("network", "trunks", "trunks", q, { poll: (rows) => rows.some((t) => t.status === "BUILD") });

// =========================================================================== NDP proxies

/** l3-ndp-proxy: an internal IPv6 address answered for (NDP) on the router's external side. */
export interface NdpProxy {
  id: string;
  name: string;
  router_id: string;
  port_id: string;
  ip_address: string;
  description?: string;
  project_id: string;
  created_at?: string;
}

export const useNdpProxies = (q?: Query, enabled = true) => useOsList<NdpProxy>("network", "ndp-proxies", "ndp_proxies", q, { enabled });

// =========================================================================== QoS

export type QosRuleType = "bandwidth_limit" | "dscp_marking" | "minimum_bandwidth" | "minimum_packet_rate" | "packet_rate_limit";

export interface QosRule {
  id: string;
  type: QosRuleType;
  qos_policy_id?: string;
  max_kbps?: number;
  max_burst_kbps?: number;
  min_kbps?: number;
  dscp_mark?: number;
  min_kpps?: number;
  max_kpps?: number;
  max_burst_kpps?: number;
  direction?: "ingress" | "egress" | "any";
}

export interface QosPolicy {
  id: string;
  name: string;
  description?: string;
  shared: boolean;
  is_default?: boolean;
  project_id: string;
  rules: QosRule[];
  created_at?: string;
}

export const useQosPolicies = (q?: Query) => useOsList<QosPolicy>("network", "qos/policies", "policies", q);
export const useQosRuleTypes = () =>
  useQuery({
    queryKey: ["os", "network", "qos/rule-types"],
    queryFn: () => os.get<{ rule_types: { type: QosRuleType }[] }>("network", "qos/rule-types").then((r) => r.rule_types.map((t) => t.type)),
    staleTime: 10 * 60_000,
  });

export const RULE_INFO: Record<QosRuleType, { label: string; path: string; key: string; help: string }> = {
  bandwidth_limit: { label: tr("Bandwidth limit"), path: "bandwidth_limit_rules", key: "bandwidth_limit_rule", help: tr("Caps throughput per port (kbps), with an optional burst.") },
  dscp_marking: { label: tr("DSCP marking"), path: "dscp_marking_rules", key: "dscp_marking_rule", help: tr("Marks outgoing packets with a DSCP value for the physical network's QoS.") },
  minimum_bandwidth: { label: tr("Minimum bandwidth"), path: "minimum_bandwidth_rules", key: "minimum_bandwidth_rule", help: tr("Guarantees throughput; Placement schedules instances where it is available.") },
  minimum_packet_rate: { label: tr("Minimum packet rate"), path: "minimum_packet_rate_rules", key: "minimum_packet_rate_rule", help: tr("Guarantees packets per second (kpps), scheduled through Placement.") },
  packet_rate_limit: { label: tr("Packet rate limit"), path: "packet_rate_limit_rules", key: "packet_rate_limit_rule", help: tr("Caps packets per second (kpps).") },
};

const kbps = (n?: number) => (n == null ? "" : n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)} Gbps` : n >= 1000 ? `${+(n / 1000).toFixed(1)} Mbps` : `${n} kbps`);

/** One line per rule, e.g. "Bandwidth limit egress 100 Mbps (burst 80 Mbps)". */
export function ruleSummary(r: QosRule) {
  const dir = r.direction ? ` ${r.direction}` : "";
  switch (r.type) {
    case "bandwidth_limit":
      return `Limit${dir} ${kbps(r.max_kbps)}${r.max_burst_kbps ? tr(" (burst {kbps})", { kbps: kbps(r.max_burst_kbps) }) : ""}`;
    case "minimum_bandwidth":
      return `Minimum${dir} ${kbps(r.min_kbps)}`;
    case "dscp_marking":
      return `DSCP ${r.dscp_mark}${DSCP_NAMES[r.dscp_mark ?? -1] ? ` (${DSCP_NAMES[r.dscp_mark!]})` : ""}`;
    case "minimum_packet_rate":
      return tr("Minimum{dir} {min_kpps} kpps", { dir, min_kpps: r.min_kpps });
    case "packet_rate_limit":
      return tr("Limit{dir} {max_kpps} kpps{v}", { dir, max_kpps: r.max_kpps, v: r.max_burst_kpps ? tr(" (burst {max_burst_kpps})", { max_burst_kpps: r.max_burst_kpps }) : "" });
    default:
      return r.type;
  }
}

/** Valid DSCP marks in Neutron, with their per-hop behaviour names. */
export const DSCP_NAMES: Record<number, string> = {
  0: tr("best effort"),
  8: "CS1",
  10: "AF11",
  12: "AF12",
  14: "AF13",
  16: "CS2",
  18: "AF21",
  20: "AF22",
  22: "AF23",
  24: "CS3",
  26: "AF31",
  28: "AF32",
  30: "AF33",
  32: "CS4",
  34: "AF41",
  36: "AF42",
  38: "AF43",
  40: "CS5",
  46: "EF",
  48: "CS6",
  56: "CS7",
};

// =========================================================================== subnet pools

export interface SubnetPool {
  id: string;
  name: string;
  description?: string;
  project_id: string;
  ip_version: 4 | 6;
  prefixes: string[];
  /** Neutron returns these as numbers (very old releases as strings). */
  default_prefixlen: number | string;
  min_prefixlen: number | string;
  max_prefixlen: number | string;
  /** Per-project quota: IPv4 addresses, or IPv6 /64 blocks. Null = unlimited. */
  default_quota?: number | null;
  shared: boolean;
  is_default: boolean;
  address_scope_id?: string | null;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface AddressScope {
  id: string;
  name: string;
  project_id: string;
  ip_version: 4 | 6;
  shared: boolean;
}

export const useSubnetPools = (q?: Query, enabled = true) => useOsList<SubnetPool>("network", "subnetpools", "subnetpools", q, { enabled });
export const useAddressScopes = (q?: Query, enabled = true) => useOsList<AddressScope>("network", "address-scopes", "address_scopes", q, { enabled });

// =========================================================================== RBAC

export type RbacObjectType = "network" | "qos_policy" | "security_group" | "address_scope" | "subnetpool" | "address_group";
export type RbacAction = "access_as_shared" | "access_as_external";

export interface RbacPolicy {
  id: string;
  object_type: RbacObjectType;
  object_id: string;
  action: RbacAction;
  target_tenant: string;
  project_id: string;
}

export const useRbacPolicies = (q?: Query) => useOsList<RbacPolicy>("network", "rbac-policies", "rbac_policies", q);

export const RBAC_OBJECTS: Record<RbacObjectType, string> = {
  network: tr("Network"),
  qos_policy: tr("QoS policy"),
  security_group: tr("Security group"),
  address_scope: tr("Address scope"),
  subnetpool: tr("Subnet pool"),
  address_group: tr("Address group"),
};

// =========================================================================== agents

export interface Agent {
  id: string;
  agent_type: string;
  binary: string;
  host: string;
  alive: boolean;
  admin_state_up: boolean;
  availability_zone?: string | null;
  heartbeat_timestamp: string;
  started_at?: string;
  created_at?: string;
  description?: string | null;
  topic?: string;
  configurations?: Record<string, unknown>;
}

export const useAgents = (q?: Query, enabled = true) => useOsList<Agent>("network", "agents", "agents", q, { enabled });

// =========================================================================== IP availability

export interface IpAvailability {
  network_id: string;
  network_name: string;
  project_id: string;
  total_ips: number;
  used_ips: number;
  subnet_ip_availability: { subnet_id: string; subnet_name: string; cidr: string; ip_version: number; total_ips: number; used_ips: number }[];
}

export const useIpAvailability = (enabled = true) =>
  useOsList<IpAvailability>("network", "network-ip-availabilities", "network_ip_availabilities", undefined, { enabled });
