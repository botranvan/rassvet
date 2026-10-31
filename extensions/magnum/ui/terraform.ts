/**
 * Export to Terraform: Kubernetes cluster templates and clusters
 * (openstack_containerinfra_clustertemplate_v1 / _cluster_v1).
 */
import { type TerraformContribution, type TfGen, type TfSelection, tr, useOsList } from "@rassvet/sdk";
import type { Cluster, ClusterTemplate } from "./api";

const TEMPLATES = "magnum.clustertemplates";
const CLUSTERS = "magnum.clusters";
const T = {
  template: "openstack_containerinfra_clustertemplate_v1",
  cluster: "openstack_containerinfra_cluster_v1",
} as const;

const picked = <R extends { uuid: string }>(rows: R[], sel: TfSelection, kind: string) => rows.filter((r) => sel[kind]?.has(r.uuid));

export const terraform: TerraformContribution = {
  useSource: ({ projectId }) => {
    // Magnum lists every project's clusters and templates to admins: keep this project's.
    const tq = useOsList<ClusterTemplate>("ext:magnum", "clustertemplates", "clustertemplates");
    const cq = useOsList<Cluster>("ext:magnum", "clusters/detail", "clusters");
    const templates = tq.data ?? [];
    const clusters = (cq.data ?? []).filter((c) => c.project_id === projectId);

    const write = (g: TfGen, sel: TfSelection) => {
      /** Magnum keeps what it was given: an ID of a visible network, else a name. */
      const net = (v?: string | null) => (!v ? null : g.input.networks.some((n) => n.id === v) ? g.network(v) : g.str(v));
      const subnet = (v?: string | null) => (!v ? null : g.input.subnets.some((n) => n.id === v) ? g.subnet(v) : g.str(v));
      const keypair = (v?: string | null) => (v ? g.keypair(v) : null);
      const image = (v: string) => (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) ? g.image(v) : g.str(v));
      const labels = (l?: Record<string, unknown> | null) => {
        const m = Object.fromEntries(Object.entries(l ?? {}).map(([k, v]) => [k, String(v)]));
        return Object.keys(m).length ? ["", `labels = ${g.map(m).join("\n  ")}`] : [];
      };
      const bool = (b?: boolean | null) => (b === undefined || b === null ? null : String(b));
      const num = (n?: number | null) => (n === undefined || n === null ? null : String(n));
      const s = (v?: string | null) => (v ? g.str(v) : null);

      const ts = picked(templates, sel, TEMPLATES);
      if (ts.length) g.section("Kubernetes cluster templates (Magnum)");
      for (const t of ts) {
        g.block(
          T.template,
          g.addr(T.template, t.uuid)!,
          [
            ...g.attrs([
              ["name", g.str(t.name)],
              ["coe", g.str(t.coe)],
              ["image", image(t.image_id)],
              ["keypair_id", keypair(t.keypair_id)],
              ["external_network_id", net(t.external_network_id)],
              ["fixed_network", net(t.fixed_network)],
              ["fixed_subnet", subnet(t.fixed_subnet)],
              ["flavor", s(t.flavor_id)],
              ["master_flavor", s(t.master_flavor_id)],
              ["dns_nameserver", s(t.dns_nameserver)],
              ["network_driver", s(t.network_driver)],
              ["volume_driver", s(t.volume_driver)],
              ["docker_volume_size", num(t.docker_volume_size)],
              ["docker_storage_driver", s(t.docker_storage_driver)],
              ["server_type", s(t.server_type)],
              ["master_lb_enabled", bool(t.master_lb_enabled)],
              ["floating_ip_enabled", bool(t.floating_ip_enabled)],
              ["tls_disabled", t.tls_disabled ? "true" : null],
              ["registry_enabled", t.registry_enabled ? "true" : null],
              ["public", t.public ? "true" : null],
              ["hidden", t.hidden ? "true" : null],
            ]),
            ...labels(t.labels),
          ],
          t.uuid,
        );
      }
      const cs = picked(clusters, sel, CLUSTERS);
      if (cs.length) g.section("Kubernetes clusters (Magnum)");
      for (const c of cs) {
        const tpl = g.addr(T.template, c.cluster_template_id);
        const tplName = templates.find((x) => x.uuid === c.cluster_template_id)?.name;
        g.block(
          T.cluster,
          g.addr(T.cluster, c.uuid)!,
          [
            ...g.attrs([
              ["name", g.str(c.name)],
              ["cluster_template_id", tpl ? `${T.template}.${tpl}.id` : g.variable("cluster_template", c.cluster_template_id, tplName)],
              ["master_count", String(c.master_count)],
              ["node_count", String(c.node_count)],
              ["keypair", keypair(c.keypair)],
              ["flavor", s(c.flavor_id)],
              ["master_flavor", s(c.master_flavor_id)],
              ["docker_volume_size", num(c.docker_volume_size)],
              ["create_timeout", num(c.create_timeout)],
              ["fixed_network", net(c.fixed_network)],
              ["fixed_subnet", subnet(c.fixed_subnet)],
              ["floating_ip_enabled", bool(c.floating_ip_enabled)],
              ["master_lb_enabled", bool(c.master_lb_enabled)],
            ]),
            // Magnum returns the cluster's effective labels (template's plus its own).
            ...labels(c.labels),
          ],
          c.uuid,
          ["merge_labels", "create_timeout"],
        );
      }
    };

    return {
      sections: [
        {
          kind: TEMPLATES,
          icon: "file-code",
          title: tr("Kubernetes cluster templates"),
          items: tq.data
            ?.filter((t) => t.project_id === projectId)
            .map((t) => ({ id: t.uuid, name: t.name, sub: [t.coe, t.driver ?? "", t.network_driver].filter(Boolean).join(" · ") })),
          loading: tq.isPending,
          error: tq.error,
        },
        {
          kind: CLUSTERS,
          icon: "container",
          title: tr("Kubernetes clusters"),
          items: cq.data && clusters.map((c) => ({ id: c.uuid, name: c.name, sub: tr("{m} master(s), {n} worker(s)", { m: c.master_count, n: c.node_count }) })),
          loading: cq.isPending,
          error: cq.error,
        },
      ],
      // A cluster needs its template (when the project owns it) and its key pair.
      dependencies: (sel, input) => {
        const add = (kind: string, id: string) => (sel[kind] ??= new Set()).add(id);
        for (const c of picked(clusters, sel, CLUSTERS)) {
          const t = templates.find((x) => x.uuid === c.cluster_template_id);
          if (t && t.project_id === projectId) add(TEMPLATES, t.uuid);
          if (c.keypair && input.keypairs.some((k) => k.name === c.keypair)) add("keypairs", c.keypair);
        }
        for (const t of picked(templates, sel, TEMPLATES)) {
          if (t.keypair_id && input.keypairs.some((k) => k.name === t.keypair_id)) add("keypairs", t.keypair_id);
        }
      },
      names: (g, sel) => {
        for (const t of picked(templates, sel, TEMPLATES)) g.name(T.template, t.uuid, t.name);
        for (const c of picked(clusters, sel, CLUSTERS)) g.name(T.cluster, c.uuid, c.name);
      },
      generate: write,
    };
  },
};
