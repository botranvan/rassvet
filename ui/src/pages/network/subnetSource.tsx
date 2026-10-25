/**
 * Where a new subnet's addresses come from: a CIDR typed by the user, or an allocation
 * from a subnet pool (a prefix length, or a specific CIDR inside the pool). Shared by the
 * create-subnet and create-network dialogs.
 */
import { useState } from "react";
import { Picker } from "@/components/Picker";
import { Badge, Field, Input, Tabs } from "@/components/ui";
import { cidrContains, parseCidr } from "@/lib/ipmath";
import { type SubnetPool, useSubnetPools } from "@/lib/neutron";
import { tr } from "@/lib/i18n";

export interface SourceValue {
  mode: "cidr" | "pool";
  cidr: string;
  pool: string;
  /** Prefix length to allocate ("" = the pool's default). */
  prefixlen: string;
  /** Optional: a specific CIDR inside the pool. */
  poolCidr: string;
}

export const plen = (n: number | string) => Number(n);

/** Problem with a pool request, or null when it can be sent. */
export function poolRequestError(pool: SubnetPool | undefined, v: SourceValue): string | null {
  if (!pool) return tr("Choose a subnet pool");
  const min = plen(pool.min_prefixlen);
  const max = plen(pool.max_prefixlen);
  if (v.poolCidr.trim()) {
    const c = parseCidr(v.poolCidr);
    if (!c) return tr("Not a valid CIDR");
    if (!c.aligned) return tr("Host bits are set; use the network address");
    if (!pool.prefixes.some((p) => { const pc = parseCidr(p); return !!pc && cidrContains(pc, c); })) return tr("Not inside the pool's prefixes");
    if (c.len < min || c.len > max) return tr("Prefix length must be /{min} to /{max}", { min, max });
    return null;
  }
  if (v.prefixlen.trim()) {
    const n = Number(v.prefixlen);
    if (!Number.isInteger(n) || n < min || n > max) return tr("Prefix length must be /{min} to /{max}", { min, max });
  }
  return null;
}

/** State, validation and request body for the address source of a new subnet. */
export function useSubnetSource(init?: Partial<SourceValue>) {
  const pools = useSubnetPools();
  const [v, setV] = useState<SourceValue>({ mode: "cidr", cidr: "", pool: "", prefixlen: "", poolCidr: "", ...init });
  const set = (p: Partial<SourceValue>) => setV((x) => ({ ...x, ...p }));
  const pool = pools.data?.find((p) => p.id === v.pool);
  const cidr = parseCidr(v.cidr);
  const error = v.mode === "cidr" ? (cidr ? null : tr("Enter a network address such as 10.0.0.0/24")) : poolRequestError(pool, v);
  /** Fields for the `subnet` body: cidr + ip_version, or subnetpool_id (+ prefixlen / cidr). */
  const body = (): Record<string, unknown> => {
    if (v.mode === "cidr") return { cidr: v.cidr.trim(), ip_version: v.cidr.includes(":") ? 6 : 4 };
    const b: Record<string, unknown> = { subnetpool_id: v.pool, ip_version: pool?.ip_version ?? 4 };
    if (v.poolCidr.trim()) b.cidr = v.poolCidr.trim();
    else if (v.prefixlen.trim()) b.prefixlen = Number(v.prefixlen);
    return b;
  };
  const ipVersion = v.mode === "cidr" ? (v.cidr.includes(":") ? 6 : 4) : (pool?.ip_version ?? 4);
  /** Short text for toasts: the CIDR, or "from <pool>". */
  const label = v.mode === "cidr" ? v.cidr.trim() : tr("from {pool}", { pool: pool?.name || v.pool });
  return { v, set, pools, pool, valid: !error, error, body, ipVersion, label };
}

export type SubnetSourceState = ReturnType<typeof useSubnetSource>;

export function SubnetSourceFields({ src, cidrLabel = tr("Network address (CIDR)") }: { src: SubnetSourceState; cidrLabel?: string }) {
  const { v, set, pools, pool } = src;
  const available = (pools.data ?? []).length > 0;
  const cidrField = (
    <Field label={cidrLabel}>
      {(id) => <Input id={id} value={v.cidr} onChange={(e) => set({ cidr: e.target.value })} placeholder="10.0.0.0/24" className="font-mono text-[13px]" />}
    </Field>
  );
  if (!available && v.mode === "cidr") return cidrField;
  return (
    <div className="space-y-3">
      <Tabs
        value={v.mode}
        onChange={(mode) => set({ mode })}
        tabs={[
          { id: "cidr", label: tr("Enter a CIDR") },
          { id: "pool", label: tr("Allocate from a subnet pool") },
        ]}
      />
      {v.mode === "cidr" ? (
        cidrField
      ) : (
        <>
          <Field label={tr("Subnet pool")}>
            {(id) => (
              <Picker
                id={id}
                value={v.pool}
                onChange={(p) => set({ pool: p, prefixlen: "", poolCidr: "" })}
                searchable
                loading={pools.isPending}
                placeholder={tr("Choose a subnet pool")}
                options={(pools.data ?? []).map((p) => ({
                  value: p.id,
                  label: p.name || p.id,
                  icon: "split",
                  description: p.prefixes.join(", "),
                  meta: (
                    <span className="inline-flex items-center gap-1.5">
                      {p.is_default && <Badge tone="accent">{tr("default")}</Badge>}
                      {tr("IPv{ip_version}", { ip_version: p.ip_version })} · /{plen(p.default_prefixlen)}
                    </span>
                  ),
                }))}
              />
            )}
          </Field>
          {pool && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={tr("Prefix length")} hint={tr("/{min} to /{max}; empty uses the pool's default (/{def}).", { min: plen(pool.min_prefixlen), max: plen(pool.max_prefixlen), def: plen(pool.default_prefixlen) })}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={plen(pool.min_prefixlen)}
                    max={plen(pool.max_prefixlen)}
                    value={v.prefixlen}
                    disabled={!!v.poolCidr.trim()}
                    onChange={(e) => set({ prefixlen: e.target.value })}
                    placeholder={String(plen(pool.default_prefixlen))}
                    className="w-28"
                  />
                )}
              </Field>
              <Field label={tr("Specific CIDR (optional)")} hint={tr("Must be free and inside {prefixes}.", { prefixes: pool.prefixes.join(", ") })}>
                {(id) => <Input id={id} value={v.poolCidr} onChange={(e) => set({ poolCidr: e.target.value })} placeholder={tr("Next free block")} className="font-mono text-[13px]" />}
              </Field>
            </div>
          )}
          {pool && src.error && (v.prefixlen.trim() || v.poolCidr.trim()) && <p className="text-xs text-led-red">{src.error}</p>}
        </>
      )}
    </div>
  );
}
