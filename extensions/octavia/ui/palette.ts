/** Command palette: "Create load balancer", search words, and load balancers, listeners and pools. */
import { type PaletteContext, type PaletteContribution, os, tr } from "@rassvet/sdk";
import { LB } from "./api";

type Row = { id: string; name?: string; vip_address?: string; loadbalancers?: { id: string }[] };
const enc = encodeURIComponent;
/** Octavia shows admins every project's objects: the project view asks for its own. */
const scope = (c: PaletteContext) => (c.admin ? undefined : { project_id: c.project });
const get = (path: string, key: string) => (id: string, c: PaletteContext) =>
  os.get<Record<string, Row>>(LB, `lbaas/${path}/${enc(id)}`, undefined, { signal: c.signal }).then((r) => r[key]);
const lbOf = (r: Row) => r.loadbalancers?.[0]?.id;

export const palette: PaletteContribution = {
  keywords: "lb octavia load balancer balancing listener pool vip",
  actions: [{ id: "new-lb", label: tr("Create load balancer"), icon: "split", path: "load-balancers?new=1", keywords: "lb octavia balancing vip" }],
  resources: [
    {
      kind: tr("Load balancer"),
      icon: "split",
      get: get("loadbalancers", "loadbalancer"),
      list: (c) => os.list<Row>(LB, "lbaas/loadbalancers", "loadbalancers", scope(c)),
      // The VIP finds it too.
      name: (r: Row) => (r.name ? `${r.name} (${r.vip_address})` : r.vip_address),
      path: (r: Row, c) => `${c.base}/load-balancers/${r.id}`,
    },
    {
      kind: tr("Listener"),
      icon: "radio-tower",
      get: get("listeners", "listener"),
      list: (c) => os.list<Row>(LB, "lbaas/listeners", "listeners", scope(c)),
      keep: (r: Row) => !!lbOf(r),
      path: (r: Row, c) => `${c.base}/load-balancers/${lbOf(r)}/listeners/${r.id}`,
    },
    {
      kind: tr("Pool"),
      icon: "layers",
      get: get("pools", "pool"),
      list: (c) => os.list<Row>(LB, "lbaas/pools", "pools", scope(c)),
      keep: (r: Row) => !!lbOf(r),
      path: (r: Row, c) => `${c.base}/load-balancers/${lbOf(r)}/pools/${r.id}`,
    },
  ],
};
