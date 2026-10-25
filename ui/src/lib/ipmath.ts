/** IPv4 / IPv6 prefix arithmetic with BigInt: parsing, sizes, containment, overlap. */

export interface Cidr {
  version: 4 | 6;
  /** First address of the prefix (host bits cleared). */
  base: bigint;
  len: number;
  /** False when the text had host bits set (e.g. 10.0.0.5/24). */
  aligned: boolean;
}

const bits = (v: 4 | 6) => (v === 4 ? 32 : 128);

function parseV4(s: string): bigint | null {
  const p = s.split(".");
  if (p.length !== 4) return null;
  let n = 0n;
  for (const o of p) {
    if (!/^\d{1,3}$/.test(o) || Number(o) > 255) return null;
    n = (n << 8n) | BigInt(o);
  }
  return n;
}

function parseV6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:]+$/.test(s) || (s.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = s.includes("::") ? s.split("::") : [s, undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  if (fill < 0 || (tail === undefined && h.length !== 8)) return null;
  const groups = [...h, ...Array<string>(fill).fill("0"), ...t];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

export function parseCidr(text: string): Cidr | null {
  const m = text.trim().match(/^([^/\s]+)\/(\d{1,3})$/);
  if (!m) return null;
  const version: 4 | 6 = m[1].includes(":") ? 6 : 4;
  const addr = version === 4 ? parseV4(m[1]) : parseV6(m[1]);
  const len = Number(m[2]);
  if (addr === null || len > bits(version)) return null;
  const host = (1n << BigInt(bits(version) - len)) - 1n;
  const base = addr & ~host;
  return { version, base, len, aligned: base === addr };
}

/** Number of addresses in a prefix. */
export const cidrSize = (c: Cidr) => 1n << BigInt(bits(c.version) - c.len);

/** Whether `inner` lies entirely inside `outer`. */
export const cidrContains = (outer: Cidr, inner: Cidr) =>
  outer.version === inner.version && inner.len >= outer.len && inner.base >> BigInt(bits(outer.version) - outer.len) === outer.base >> BigInt(bits(outer.version) - outer.len);

export const cidrOverlaps = (a: Cidr, b: Cidr) => cidrContains(a, b) || cidrContains(b, a);

/** Canonical text of a prefix (IPv6 with the longest zero run compressed). */
export function cidrText(c: Cidr) {
  if (c.version === 4) {
    const o = [24n, 16n, 8n, 0n].map((s) => String((c.base >> s) & 255n));
    return `${o.join(".")}/${c.len}`;
  }
  const g = Array.from({ length: 8 }, (_, i) => Number((c.base >> BigInt(112 - i * 16)) & 0xffffn));
  let best = [-1, 0];
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > best[1] && j - i > 1) best = [i, j - i];
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  const txt = best[0] < 0 ? hex.join(":") : `${hex.slice(0, best[0]).join(":")}::${hex.slice(best[0] + best[1]).join(":")}`;
  return `${txt}/${c.len}`;
}

/** Percentage of `used` in `total` with two decimals (BigInt-safe). */
export const pctOf = (used: bigint, total: bigint) => (total > 0n ? Number((used * 10000n) / total) / 100 : 0);

/** "65,536" for small numbers, "2^64" style for huge IPv6 counts. */
export function fmtCount(n: bigint) {
  if (n < 10n ** 12n) return n.toLocaleString();
  const p = n.toString(2).length - 1;
  return 1n << BigInt(p) === n ? `2^${p}` : `≈ 2^${p}`;
}
