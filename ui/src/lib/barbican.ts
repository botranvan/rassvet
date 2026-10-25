/**
 * Barbican (key manager): secrets, secret containers, orders, ACLs and quotas through the
 * gateway (`/api/os/key-manager/…`); payloads through `/api/key-manager/secrets/{id}/payload`.
 * Barbican identifies everything by full URLs (`secret_ref`, `container_ref`, `order_ref`);
 * rows get an `id` (the last path segment) for tables and routes.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { RemotePaging } from "@/components/DataTable";
import { api } from "./api";
import { type ServerFilter, os, useOsGet, useOsList } from "./os";
import { tr } from "@/lib/i18n";

type Query = Record<string, string | number | boolean | string[] | null | undefined>;

export const refId = (ref?: string | null) => (ref ? (ref.replace(/\/+$/, "").split("/").pop() ?? "") : "");

export type SecretType = "symmetric" | "public" | "private" | "passphrase" | "certificate" | "opaque";

export interface Secret {
  id: string;
  secret_ref: string;
  name: string | null;
  status: string;
  secret_type: SecretType;
  algorithm?: string | null;
  bit_length?: number | null;
  mode?: string | null;
  expiration?: string | null;
  created: string;
  updated?: string;
  creator_id?: string;
  /** null when the secret has no payload yet. */
  content_types?: { default: string } | null;
}

export interface SecretContainer {
  id: string;
  container_ref: string;
  name: string | null;
  type: "generic" | "certificate" | "rsa";
  status: string;
  secret_refs: { name: string; secret_ref: string }[];
  consumers?: { name: string; URL: string }[];
  created: string;
  updated?: string;
  creator_id?: string;
}

export interface Order {
  id: string;
  order_ref: string;
  type: "key" | "asymmetric" | "certificate";
  status: string;
  meta: { name?: string | null; algorithm?: string; bit_length?: number; mode?: string | null; expiration?: string | null; payload_content_type?: string };
  secret_ref?: string;
  container_ref?: string;
  error_status_code?: string;
  error_reason?: string;
  created: string;
  updated?: string;
  creator_id?: string;
}

export interface Acl {
  read?: { users?: string[]; "project-access"?: boolean; created?: string; updated?: string };
}

export interface BarbicanQuotas {
  secrets?: number | null;
  orders?: number | null;
  containers?: number | null;
  consumers?: number | null;
  cas?: number | null;
}

export const SECRET_TYPES: { value: SecretType; label: string; description: string }[] = [
  { value: "opaque", label: tr("Opaque"), description: tr("Any data (default)") },
  { value: "passphrase", label: tr("Passphrase"), description: tr("A password or passphrase") },
  { value: "symmetric", label: tr("Symmetric key"), description: tr("AES and other symmetric keys (base64)") },
  { value: "certificate", label: tr("Certificate"), description: tr("X.509 certificate (PEM)") },
  { value: "private", label: tr("Private key"), description: tr("Asymmetric private key (PEM)") },
  { value: "public", label: tr("Public key"), description: tr("Asymmetric public key (PEM)") },
];
export const secretTypeLabel = (t: string) => SECRET_TYPES.find((x) => x.value === t)?.label ?? t;

const withId = <T extends object>(refKey: keyof T) => (r: T) => ({ ...r, id: refId(r[refKey] as string) });
const pick = <T extends object>(key: string, refKey: keyof T) => (r: Record<string, unknown>) => ((r[key] ?? []) as T[]).map(withId<T>(refKey));

/** Every secret (all pages) for pickers; rows carry `id`. */
export function useAllSecrets(enabled = true) {
  const q = useOsList<Secret>("key-manager", "secrets", "secrets", undefined, { enabled });
  return { ...q, data: q.data?.map(withId<Secret>("secret_ref")) };
}

export function useSecret(id: string) {
  return useOsGet<Secret>("key-manager", `secrets/${id}`, (r: Secret) => withId<Secret>("secret_ref")(r));
}

export function useContainer(id: string) {
  return useOsGet<SecretContainer>("key-manager", `containers/${id}`, (r: SecretContainer) => withId<SecretContainer>("container_ref")(r));
}

export const useAcl = (kind: "secrets" | "containers", id: string) => useOsGet<Acl>("key-manager", `${kind}/${id}/acl`, (r: Acl) => r);

export const usePayload = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: ["key-manager", "payload", id],
    queryFn: () => api.get<{ content_type: string; encoding: "text" | "base64"; payload: string }>(`/key-manager/secrets/${encodeURIComponent(id)}/payload`),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

export const storePayload = (id: string, payload: string, encoding: "text" | "base64") =>
  api.put(`/key-manager/secrets/${encodeURIComponent(id)}/payload`, { payload, encoding });

/** Base64 of a File's bytes. */
export async function fileBase64(f: File) {
  const buf = new Uint8Array(await f.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** UTF-8 text → base64. */
export const textBase64 = (t: string) => {
  const bytes = new TextEncoder().encode(t);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** base64 → text, or null when it isn't printable UTF-8. */
export function base64Text(b64: string): string | null {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const t = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /^[\t\n\r\x20-\x7e -￿]*$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * One page at a time from a Barbican list (limit + offset; Barbican reports `total`), with
 * server-side filters and sort, in the shape DataTable's remote paging expects.
 */
export function useOffsetPaged<T extends object>(
  path: "secrets" | "containers" | "orders",
  refKey: keyof T,
  opts: { filters?: ServerFilter[]; sort?: Record<string, string>; poll?: (rows: (T & { id: string })[]) => boolean; defaultSort?: { key: string; dir: 1 | -1 } } = {},
) {
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<{ key: string; value: string }>({ key: opts.filters?.[0]?.key ?? "", value: "" });
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(opts.defaultSort ?? null);
  const def = opts.filters?.find((f) => f.key === filter.key);
  const value = filter.value.trim();
  const fq: Query = def && value ? (typeof def.param === "string" ? { [def.param]: value } : def.param(value)) : {};
  const sq: Query = sort && opts.sort?.[sort.key] ? { sort: `${opts.sort[sort.key]}:${sort.dir === 1 ? "asc" : "desc"}` } : {};
  const query = useQuery({
    queryKey: ["os", "key-manager", path, "offset", pageSize, page, fq, sq],
    queryFn: () =>
      os.get<Record<string, unknown>>("key-manager", path, { ...fq, ...sq, limit: pageSize, offset: page * pageSize }).then((r) => ({
        rows: pick<T>(path, refKey)(r),
        total: Number(r.total ?? 0),
      })),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (opts.poll && q.state.data && opts.poll(q.state.data.rows as (T & { id: string })[]) ? 4000 : false),
  });
  const total = query.data?.total ?? 0;
  const remote: RemotePaging = {
    page,
    hasNext: (page + 1) * pageSize < total,
    pageSize,
    fetching: query.isFetching,
    onPageSize: (n) => {
      setPageSize(n);
      setPage(0);
    },
    onNext: () => setPage((p) => p + 1),
    onPrev: () => setPage((p) => Math.max(0, p - 1)),
    onFirst: () => setPage(0),
    filters: opts.filters?.map(({ key, label, options, placeholder }) => ({ key, label, options, placeholder })),
    filter,
    onFilter: (k, v) => {
      if (filter.key === k && filter.value === v) return;
      setFilter({ key: k, value: v });
      setPage(0);
    },
    sort,
    sortable: opts.sort ? Object.keys(opts.sort) : undefined,
    onSort: opts.sort
      ? (s) => {
          setSort(s);
          setPage(0);
        }
      : undefined,
  };
  return { query, rows: query.data?.rows as (T & { id: string })[] | undefined, total, remote };
}

export const statusOf = (s: string) => (s === "ACTIVE" ? "ok" : s === "ERROR" ? "error" : s === "PENDING" ? "warn" : "off") as "ok" | "error" | "warn" | "off";

export const useBarbicanQuotas = () => useOsGet<BarbicanQuotas>("key-manager", "quotas", (r: { quotas: BarbicanQuotas }) => r.quotas);
