/**
 * Export to Terraform: load balancers with their listeners, pools, members and health
 * monitors (openstack_lb_*_v2). A load balancer is picked as a whole.
 */
import { type TerraformContribution, type TfGen, os, tr, useOsList, useQuery } from "@rassvet/sdk";
import { type HealthMonitor, LB, type Listener, type LoadBalancer, type Member, type Pool, lbName } from "./api";

const LBS = "octavia.loadbalancers";
const T = {
  lb: "openstack_lb_loadbalancer_v2",
  listener: "openstack_lb_listener_v2",
  pool: "openstack_lb_pool_v2",
  member: "openstack_lb_member_v2",
  monitor: "openstack_lb_monitor_v2",
} as const;

const onLb = (o: { loadbalancers: { id: string }[] }, id: string) => o.loadbalancers.some((x) => x.id === id);
/** The listener a pool is created under: the one using it as its default pool. */
const ownerOf = (p: Pool, listeners: Listener[]) => listeners.find((l) => l.default_pool_id === p.id);

export const terraform: TerraformContribution = {
  useSource: ({ projectId }) => {
    const mine = { project_id: projectId };
    const lq = useOsList<LoadBalancer>(LB, "lbaas/loadbalancers", "loadbalancers", mine);
    const liq = useOsList<Listener>(LB, "lbaas/listeners", "listeners", mine);
    const pq = useOsList<Pool>(LB, "lbaas/pools", "pools", mine);
    const hq = useOsList<HealthMonitor>(LB, "lbaas/healthmonitors", "healthmonitors", mine);
    const pools = pq.data ?? [];
    // Members are listed per pool.
    const mq = useQuery({
      queryKey: ["os", LB, "terraform-members", pools.map((p) => p.id)],
      queryFn: async () => {
        const out: Record<string, Member[]> = {};
        await Promise.all(pools.map(async (p) => (out[p.id] = await os.list<Member>(LB, `lbaas/pools/${p.id}/members`, "members"))));
        return out;
      },
      enabled: !!pq.data && !pq.partial,
    });
    const lbs = lq.data ?? [];
    const listeners = liq.data ?? [];
    const monitors = hq.data ?? [];
    const members = mq.data ?? {};
    const picked = (sel: Record<string, Set<string>>) => lbs.filter((l) => sel[LBS]?.has(l.id));
    const parts = (lb: LoadBalancer) => {
      const ls = listeners.filter((l) => onLb(l, lb.id));
      const ps = pools.filter((p) => onLb(p, lb.id));
      return { ls, ps, ms: ps.flatMap((p) => (members[p.id] ?? []).map((m) => ({ p, m }))), hs: monitors.filter((h) => h.pools.some((x) => ps.some((p) => p.id === x.id))) };
    };

    const write = (g: TfGen, lb: LoadBalancer) => {
      const { ls, ps, ms, hs } = parts(lb);
      const s = (v?: string | null) => (v ? g.str(v) : null);
      const num = (n?: number | null) => (n == null ? null : String(n));
      const strs = (xs?: string[] | null) => (xs?.length ? `[${xs.map(g.str).join(", ")}]` : null);
      const off = (b: boolean) => (b ? null : "false");
      const addr = (type: string, id: string) => `${type}.${g.addr(type, id)}.id`;
      const lbAddr = addr(T.lb, lb.id);

      g.block(
        T.lb,
        g.addr(T.lb, lb.id)!,
        [
          ...g.attrs([
            ["name", g.str(lb.name)],
            ["description", s(lb.description)],
            ["vip_subnet_id", g.subnet(lb.vip_subnet_id)],
            ["vip_address", g.str(lb.vip_address)],
            ["flavor_id", s(lb.flavor_id)],
            ["availability_zone", s(lb.availability_zone)],
            ["admin_state_up", off(lb.admin_state_up)],
            ["tags", strs(lb.tags)],
          ]),
          ...(lb.vip_qos_policy_id ? [`# VIP QoS policy ${lb.vip_qos_policy_id} not exported`] : []),
        ],
        lb.id,
      );
      for (const l of ls) {
        // A listener's own default pool is created under it (listener_id), so it isn't set here too.
        const dp = l.default_pool_id ? pools.find((p) => p.id === l.default_pool_id) : undefined;
        const viaPool = dp && ownerOf(dp, ls)?.id === l.id;
        g.block(
          T.listener,
          g.addr(T.listener, l.id)!,
          [
            ...g.attrs([
              ["name", s(l.name)],
              ["description", s(l.description)],
              ["protocol", g.str(l.protocol)],
              ["protocol_port", String(l.protocol_port)],
              ["loadbalancer_id", lbAddr],
              ["default_pool_id", dp && !viaPool ? addr(T.pool, dp.id) : null],
              ["connection_limit", l.connection_limit >= 0 ? String(l.connection_limit) : null],
              ["timeout_client_data", num(l.timeout_client_data)],
              ["timeout_member_connect", num(l.timeout_member_connect)],
              ["timeout_member_data", num(l.timeout_member_data)],
              ["timeout_tcp_inspect", num(l.timeout_tcp_inspect)],
              ["allowed_cidrs", strs(l.allowed_cidrs)],
              ["default_tls_container_ref", s(l.default_tls_container_ref)],
              ["sni_container_refs", strs(l.sni_container_refs)],
              ["client_ca_tls_container_ref", s(l.client_ca_tls_container_ref)],
              ["client_authentication", l.client_authentication && l.client_authentication !== "NONE" ? g.str(l.client_authentication) : null],
              ["tls_versions", strs(l.tls_versions)],
              ["admin_state_up", off(l.admin_state_up)],
              ["tags", strs(l.tags)],
            ]),
            ...(l.insert_headers && Object.keys(l.insert_headers).length ? ["", `insert_headers = ${g.map(l.insert_headers).join("\n  ")}`] : []),
            ...(l.l7policies.length ? [`# ${l.l7policies.length} L7 policy(ies) not exported: use openstack_lb_l7policy_v2 / _l7rule_v2.`] : []),
          ],
          l.id,
          viaPool ? ["default_pool_id"] : undefined,
        );
        if (l.l7policies.length) g.notes.push(`Listener ${l.name || l.id}: L7 policies are not exported.`);
      }
      for (const p of ps) {
        const owner = ownerOf(p, ls);
        const body = g.attrs([
          ["name", s(p.name)],
          ["description", s(p.description)],
          ["protocol", g.str(p.protocol)],
          ["lb_method", g.str(p.lb_algorithm)],
          ["listener_id", owner ? addr(T.listener, owner.id) : null],
          ["loadbalancer_id", owner ? null : lbAddr],
          ["tls_enabled", p.tls_enabled ? "true" : null],
          ["tls_container_ref", s(p.tls_container_ref)],
          ["ca_tls_container_ref", s(p.ca_tls_container_ref)],
          ["admin_state_up", off(p.admin_state_up)],
          ["tags", strs(p.tags)],
        ]);
        const sp = p.session_persistence;
        if (sp) body.push("", "persistence {", ...g.attrs([["type", g.str(sp.type)], ["cookie_name", s(sp.cookie_name)]]).map((x) => `  ${x}`), "}");
        g.block(T.pool, g.addr(T.pool, p.id)!, body, p.id);
      }
      for (const { p, m } of ms) {
        g.block(
          T.member,
          g.addr(T.member, m.id)!,
          g.attrs([
            ["pool_id", addr(T.pool, p.id)],
            ["name", s(m.name)],
            ["address", g.str(m.address)],
            ["protocol_port", String(m.protocol_port)],
            ["subnet_id", m.subnet_id ? g.subnet(m.subnet_id) : null],
            ["weight", m.weight !== 1 ? String(m.weight) : null],
            ["backup", m.backup ? "true" : null],
            ["monitor_address", s(m.monitor_address)],
            ["monitor_port", num(m.monitor_port)],
            ["admin_state_up", off(m.admin_state_up)],
            ["tags", strs(m.tags)],
          ]),
          `${p.id}/${m.id}`,
        );
      }
      for (const h of hs) {
        const pool = ps.find((p) => h.pools.some((x) => x.id === p.id))!;
        const http = h.type === "HTTP" || h.type === "HTTPS";
        g.block(
          T.monitor,
          g.addr(T.monitor, h.id)!,
          g.attrs([
            ["pool_id", addr(T.pool, pool.id)],
            ["name", s(h.name)],
            ["type", g.str(h.type)],
            ["delay", String(h.delay)],
            ["timeout", String(h.timeout)],
            ["max_retries", String(h.max_retries)],
            ["max_retries_down", String(h.max_retries_down)],
            ["http_method", http ? s(h.http_method) : null],
            ["url_path", http ? s(h.url_path) : null],
            ["expected_codes", http ? s(h.expected_codes) : null],
            ["http_version", http && h.http_version ? String(h.http_version) : null],
            ["domain_name", http ? s(h.domain_name) : null],
            ["admin_state_up", off(h.admin_state_up)],
          ]),
          h.id,
        );
      }
    };

    const loading = [lq, liq, pq, hq].some((q) => q.isPending || q.partial) || mq.isPending;
    return {
      sections: [
        {
          kind: LBS,
          icon: "split",
          title: tr("Load balancers (with listeners, pools and members)"),
          items: loading
            ? undefined
            : lbs.map((l) => {
                const { ls, ps, ms } = parts(l);
                return { id: l.id, name: lbName(l), sub: [l.vip_address, tr("{l} listener(s), {p} pool(s), {m} member(s)", { l: ls.length, p: ps.length, m: ms.length })].join(" · ") };
              }),
          loading,
          error: lq.error ?? liq.error ?? pq.error ?? hq.error ?? mq.error,
        },
      ],
      // The VIP's network when the project owns it.
      dependencies: (sel, input) => {
        for (const l of picked(sel)) {
          const n = input.networks.find((x) => x.id === l.vip_network_id);
          if (n && n.project_id === projectId && !n["router:external"] && !n.shared) (sel.networks ??= new Set()).add(n.id);
        }
      },
      names: (g, sel) => {
        for (const lb of picked(sel)) {
          const n = g.name(T.lb, lb.id, lb.name);
          const { ls, ps, ms, hs } = parts(lb);
          for (const l of ls) g.name(T.listener, l.id, l.name || `${n}_${l.protocol.toLowerCase()}_${l.protocol_port}`);
          for (const p of ps) g.name(T.pool, p.id, p.name || `${n}_pool_${p.protocol.toLowerCase()}`);
          for (const { p, m } of ms) g.name(T.member, m.id, `${g.addr(T.pool, p.id)}_${m.address.replace(/[.:]/g, "_")}_${m.protocol_port}`);
          for (const h of hs) g.name(T.monitor, h.id, h.name || `${g.addr(T.pool, h.pools[0]?.id ?? "") ?? n}_monitor`);
        }
      },
      generate: (g, sel) => {
        const ps = picked(sel);
        if (ps.length) g.section("Load balancers (Octavia)");
        for (const lb of ps) write(g, lb);
      },
    };
  },
};
