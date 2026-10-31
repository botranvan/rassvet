/**
 * Designate v2 through the extension's allowlisted gateway (`/api/ext/designate/os/...`, service
 * name `ext:designate` in the SDK's `os` helpers): types, hooks, record helpers.
 *
 * In the admin view every call carries `all_projects=1` (Designate's `X-Auth-All-Projects`):
 * without it Designate only finds the admin's own project's zones, also for reads and changes
 * of one zone.
 */
import { type Status, api, tr, useInAdmin, useOsGet, useOsList } from "@rassvet/sdk";

export const DNS = "ext:designate" as const;
export const BASE = "/ext/designate";

// =========================================================================== types

export type ZoneType = "PRIMARY" | "SECONDARY";
/** Designate's status of a zone, record set, import, export…; `action` says what is pending. */
export type DnsStatus = "ACTIVE" | "PENDING" | "ERROR" | "DELETED" | "COMPLETE" | "SUCCESS" | string;
export type DnsAction = "CREATE" | "UPDATE" | "DELETE" | "NONE" | string;

export interface Zone {
  id: string;
  name: string;
  email?: string | null;
  ttl?: number | null;
  serial?: number;
  status: DnsStatus;
  action?: DnsAction;
  type: ZoneType;
  masters?: string[];
  description?: string | null;
  pool_id?: string;
  project_id?: string;
  attributes?: Record<string, string>;
  /** Shared with other projects (2023.1). */
  shared?: boolean;
  transferred_at?: string | null;
  version?: number;
  created_at?: string;
  updated_at?: string | null;
}

export interface RecordSet {
  id: string;
  zone_id: string;
  zone_name?: string;
  name: string;
  type: string;
  records: string[];
  ttl?: number | null;
  status: DnsStatus;
  action?: DnsAction;
  description?: string | null;
  project_id?: string;
  version?: number;
  created_at?: string;
  updated_at?: string | null;
}

export interface ZoneImport {
  id: string;
  status: DnsStatus;
  message?: string | null;
  zone_id?: string | null;
  project_id?: string;
  created_at?: string;
  updated_at?: string | null;
}

export interface ZoneExport {
  id: string;
  status: DnsStatus;
  message?: string | null;
  zone_id: string;
  location?: string | null;
  project_id?: string;
  created_at?: string;
  updated_at?: string | null;
}

export interface TransferRequest {
  id: string;
  zone_id: string;
  zone_name?: string;
  key?: string;
  target_project_id?: string | null;
  description?: string | null;
  status: DnsStatus;
  project_id?: string;
  created_at?: string;
  updated_at?: string | null;
}

export interface TransferAccept {
  id: string;
  zone_transfer_request_id: string;
  zone_id?: string;
  status: DnsStatus;
  project_id?: string;
  created_at?: string;
}

export interface ZoneShare {
  id: string;
  zone_id: string;
  project_id?: string;
  target_project_id: string;
  created_at?: string;
  updated_at?: string | null;
}

/** Reverse DNS of a floating IP; `id` is `<region>:<floating IP id>`. */
export interface ReversePtr {
  id: string;
  ptrdname: string | null;
  ttl?: number | null;
  address: string;
  description?: string | null;
  status?: DnsStatus;
  action?: DnsAction;
}

export interface Tld {
  id: string;
  name: string;
  description?: string | null;
  created_at?: string;
  updated_at?: string | null;
}

export interface TsigKey {
  id: string;
  name: string;
  algorithm: string;
  secret: string;
  scope: "POOL" | "ZONE";
  resource_id: string;
  created_at?: string;
  updated_at?: string | null;
}

export interface Blacklist {
  id: string;
  pattern: string;
  description?: string | null;
  created_at?: string;
  updated_at?: string | null;
}

export interface Pool {
  id: string;
  name: string;
  description?: string | null;
  ns_records: { hostname: string; priority: number }[];
  attributes?: Record<string, string>;
  project_id?: string | null;
  created_at?: string;
  updated_at?: string | null;
}

export interface ServiceStatus {
  id: string;
  hostname: string;
  service_name: string;
  status: "UP" | "DOWN" | "WARNING" | string;
  heartbeated_at?: string;
  capabilities?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string | null;
}

export interface Nameserver {
  hostname: string;
  priority: number;
}

/** Per-project limits (`GET quotas/<project>`). */
export interface DnsQuota {
  zones: number;
  zone_recordsets: number;
  zone_records: number;
  recordset_records: number;
  api_export_size: number;
}

export const QUOTA_KEYS: { key: keyof DnsQuota; label: string; hint: string }[] = [
  { key: "zones", label: tr("Zones"), hint: tr("Zones the project may own") },
  { key: "zone_recordsets", label: tr("Record sets per zone"), hint: tr("Record sets in one zone") },
  { key: "zone_records", label: tr("Records per zone"), hint: tr("Records in one zone, all record sets together") },
  { key: "recordset_records", label: tr("Records per record set"), hint: tr("Values in one record set") },
  { key: "api_export_size", label: tr("Export size"), hint: tr("Record sets in one zone export") },
];

// =========================================================================== status

export function dnsStatus(s?: string): Status {
  if (s === "ACTIVE" || s === "COMPLETE" || s === "SUCCESS" || s === "UP") return "ok";
  if (s === "PENDING" || s === "WARNING") return "warn";
  if (s === "ERROR" || s === "DOWN") return "error";
  return "off";
}

/** "Pending update" for PENDING / UPDATE, else "Active". */
export function statusText(o: { status?: string; action?: string }) {
  const s = o.status ?? "";
  const word = s ? s.charAt(0) + s.slice(1).toLowerCase() : tr("Unknown");
  if (s === "PENDING" && o.action && o.action !== "NONE") return tr("Pending {action}", { action: o.action.toLowerCase() });
  return tr(word);
}

export const busy = (o: { status?: string }) => o.status === "PENDING";
const poll = (rows: { status?: string }[]) => rows.some(busy);

// =========================================================================== names

/** `example.org` → `example.org.` (Designate wants fully qualified names). */
export const dot = (s: string) => {
  const t = s.trim();
  return !t || t.endsWith(".") ? t : `${t}.`;
};
export const undot = (s?: string | null) => (s ?? "").replace(/\.$/, "");

/** Record set name typed in a zone (`www`, `@`, `www.example.org.`) → fully qualified. */
export function fqdn(name: string, zone: string) {
  const n = name.trim();
  if (!n || n === "@") return zone;
  if (n.endsWith(".")) return n;
  return `${n}.${zone}`;
}

/** Fully qualified record set name → its name in the zone (`@` for the apex). */
export function relName(name: string, zone: string) {
  if (name === zone) return "@";
  return name.endsWith(`.${zone}`) ? name.slice(0, -zone.length - 1) : name;
}

// =========================================================================== record types

export interface RecordType {
  type: string;
  hint: string;
  example: string;
  /** Problem with one value, or false. */
  check?: (v: string) => string | false;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const ipv4 = (v: string) => !IPV4.test(v) && tr("Not an IPv4 address");
const ipv6 = (v: string) => (!/^[0-9a-fA-F:.]+$/.test(v) || !v.includes(":")) && tr("Not an IPv6 address");
const absolute = (v: string) => !v.endsWith(".") && tr("End the name with a dot, e.g. {v}.", { v });
const lastAbsolute = (n: number) => (v: string) => {
  const parts = v.split(/\s+/);
  if (parts.length !== n) return tr("Expected {n} fields", { n });
  if (parts.slice(0, -1).some((p) => !/^\d+$/.test(p))) return tr("The leading fields are numbers");
  return absolute(parts[n - 1]);
};

export const RECORD_TYPES: RecordType[] = [
  { type: "A", hint: tr("IPv4 address"), example: "203.0.113.10", check: ipv4 },
  { type: "AAAA", hint: tr("IPv6 address"), example: "2001:db8::10", check: ipv6 },
  { type: "CNAME", hint: tr("Alias of another name; nothing else can have the same name"), example: "www.example.org.", check: absolute },
  { type: "MX", hint: tr("Mail server: priority and host"), example: "10 mail.example.org.", check: lastAbsolute(2) },
  { type: "TXT", hint: tr("Text, e.g. SPF, DKIM or domain verification; quoted, 255 characters per string"), example: '"v=spf1 mx -all"' },
  { type: "SRV", hint: tr("Service: priority, weight, port and host; the name is _service._proto"), example: "10 5 5060 sip.example.org.", check: lastAbsolute(4) },
  { type: "CAA", hint: tr("Which certificate authorities may issue certificates"), example: '0 issue "letsencrypt.org"' },
  { type: "NS", hint: tr("Delegate a subdomain to other name servers"), example: "ns1.example.net.", check: absolute },
  { type: "PTR", hint: tr("Reverse DNS: the name of an address (in in-addr.arpa / ip6.arpa zones)"), example: "host.example.org.", check: absolute },
  { type: "SSHFP", hint: tr("SSH host key fingerprint: algorithm, type and fingerprint"), example: "4 2 123456789abcdef67890123456789abcdef67890123456789abcdef123456789" },
  { type: "NAPTR", hint: tr("Naming authority pointer: order, preference, flags, service, regexp, replacement"), example: '100 10 "S" "SIP+D2U" "" _sip._udp.example.org.' },
  { type: "CERT", hint: tr("Certificate: type, key tag, algorithm and certificate"), example: "1 0 0 MIIB…" },
  { type: "SPF", hint: tr("Obsolete; publish SPF as TXT"), example: '"v=spf1 mx -all"' },
];

/** Types Designate manages itself (the apex SOA and NS); they are shown but not edited. */
export const managed = (rs: RecordSet, zone: string) => rs.type === "SOA" || (rs.type === "NS" && rs.name === zone);

/**
 * TXT and SPF values as Designate wants them: a value without quotes is quoted, and split into
 * 255-character strings when it is longer.
 */
export function quoteTxt(v: string) {
  const t = v.trim();
  if (t.startsWith('"')) return t;
  const esc = t.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const parts: string[] = [];
  for (let i = 0; i < esc.length; i += 255) parts.push(`"${esc.slice(i, i + 255)}"`);
  return parts.join(" ") || '""';
}

/** Values typed one per line → the record set's records. */
export function parseRecords(type: string, text: string) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return type === "TXT" || type === "SPF" ? lines.map(quoteTxt) : lines;
}

/** First problem with the values of a record set, or false. */
export function recordsProblem(type: string, records: string[]) {
  if (!records.length) return tr("Enter at least one value");
  if (type === "CNAME" && records.length > 1) return tr("A CNAME has a single value");
  const check = RECORD_TYPES.find((t) => t.type === type)?.check;
  for (const r of records) {
    const p = check?.(r);
    if (p) return `${r}: ${p}`;
  }
  return false;
}

/** `203.0.113.10` → `10.113.0.203.in-addr.arpa.` (IPv6: nibbles under ip6.arpa). */
export function reverseName(ip: string) {
  if (IPV4.test(ip)) return `${ip.split(".").reverse().join(".")}.in-addr.arpa.`;
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return `${groups
    .map((g) => g.padStart(4, "0"))
    .join("")
    .split("")
    .reverse()
    .join(".")}.ip6.arpa.`;
}

// =========================================================================== calls

type Q = Record<string, string | number | boolean | undefined | null>;

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");
function gw(path: string, all: boolean, q?: Q) {
  const p = new URLSearchParams();
  if (all) p.set("all_projects", "1");
  for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return `/ext/designate/os/${enc(path)}${s ? `?${s}` : ""}`;
}

/**
 * Writes through the gateway. `all`: the admin view (the zone may belong to another project);
 * `q` adds parameters, e.g. `sudo_project_id` to create a zone for another project.
 */
export const dns = {
  post: <T>(path: string, body: object, all = false, q?: Q) => api.post<T>(gw(path, all, q), body as never),
  put: <T>(path: string, body: object, all = false) => api.put<T>(gw(path, all), body as never),
  patch: <T>(path: string, body: object, all = false) => api.patch<T>(gw(path, all), body as never),
  del: (path: string, all = false) => api.del<void>(gw(path, all)),
};

/** Start an import of a zone file (an import task; the zone appears once it is COMPLETE). */
export const importZone = (zonefile: string, sudo?: string) =>
  api.post<ZoneImport>(`/ext/designate/zones/import${sudo ? `?sudo_project_id=${encodeURIComponent(sudo)}` : ""}`, { zonefile });

/** The zone file of a finished export. */
export const exportFile = (id: string) => api.get<{ zonefile: string }>(`/ext/designate/exports/${encodeURIComponent(id)}/zonefile`);

// =========================================================================== hooks

/** `{ all_projects: 1 }` in the admin view. */
export function useAll() {
  const admin = useInAdmin();
  return { admin, q: admin ? { all_projects: 1 } : undefined };
}

export function useZones(enabled = true) {
  const { q } = useAll();
  return useOsList<Zone>(DNS, "zones", "zones", q, { poll, enabled });
}

export function useZone(id: string) {
  const { q } = useAll();
  return useOsGet<Zone>(DNS, `zones/${id}`, (r: Zone) => r, { q, poll: busy, enabled: !!id });
}

export function useRecordSets(zoneId: string) {
  const { q } = useAll();
  return useOsList<RecordSet>(DNS, `zones/${zoneId}/recordsets`, "recordsets", q, { poll, enabled: !!zoneId });
}

export function useNameservers(zoneId: string) {
  const { q } = useAll();
  return useOsGet<Nameserver[]>(DNS, `zones/${zoneId}/nameservers`, (r: { nameservers: Nameserver[] }) => r.nameservers, { q, enabled: !!zoneId });
}

export function useShares(zoneId: string) {
  const { q } = useAll();
  return useOsList<ZoneShare>(DNS, `zones/${zoneId}/shares`, "shared_zones", q, { enabled: !!zoneId });
}

export function useImports() {
  const { q } = useAll();
  return useOsList<ZoneImport>(DNS, "zones/tasks/imports", "imports", q, { poll });
}

export function useExports() {
  const { q } = useAll();
  return useOsList<ZoneExport>(DNS, "zones/tasks/exports", "exports", q, { poll });
}

export function useTransferRequests() {
  const { q } = useAll();
  return useOsList<TransferRequest>(DNS, "zones/tasks/transfer_requests", "transfer_requests", q);
}

export const useReverse = () => useOsList<ReversePtr>(DNS, "reverse/floatingips", "floatingips", undefined, { poll });

export const useTlds = (enabled = true) => useOsList<Tld>(DNS, "tlds", "tlds", undefined, { enabled });
export const useTsigKeys = () => useOsList<TsigKey>(DNS, "tsigkeys", "tsigkeys");
export const useBlacklists = () => useOsList<Blacklist>(DNS, "blacklists", "blacklists");
export const usePools = (enabled = true) => useOsList<Pool>(DNS, "pools", "pools", undefined, { enabled });
export const useServiceStatuses = () => useOsList<ServiceStatus>(DNS, "service_statuses", "service_statuses");
export const useQuota = (projectId?: string) => useOsGet<DnsQuota>(DNS, `quotas/${projectId}`, (r: DnsQuota) => r, { enabled: !!projectId });

export const zoneName = (z?: { name?: string } | null, fallback = "") => undot(z?.name) || fallback;
