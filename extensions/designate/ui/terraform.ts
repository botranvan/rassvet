/** Export to Terraform: DNS zones with their record sets (openstack_dns_zone_v2 / _recordset_v2). */
import { type TerraformContribution, tr, useOsList } from "@rassvet/sdk";
import { DNS, type RecordSet, type Zone, undot } from "./api";

const ZONES = "designate.zones";
const T = { zone: "openstack_dns_zone_v2", recordset: "openstack_dns_recordset_v2" } as const;

/** Designate manages the SOA and the apex NS record set itself. */
const managed = (r: RecordSet, z: Zone) => r.type === "SOA" || (r.type === "NS" && r.name === z.name);

export const terraform: TerraformContribution = {
  useSource: ({ projectId }) => {
    const zq = useOsList<Zone>(DNS, "zones", "zones");
    // Every record set of the project in one list (Designate's cross-zone listing).
    const rq = useOsList<RecordSet>(DNS, "recordsets", "recordsets");
    const zones = (zq.data ?? []).filter((z) => !z.project_id || z.project_id === projectId);
    const recordsets = rq.data ?? [];
    const of = (z: Zone) => recordsets.filter((r) => r.zone_id === z.id && !managed(r, z));

    return {
      sections: [
        {
          kind: ZONES,
          icon: "globe",
          title: tr("DNS zones (with record sets)"),
          items: zq.data && rq.data && zones.map((z) => ({ id: z.id, name: undot(z.name), sub: [z.type, tr("{n} record sets", { n: of(z).length })].join(" · ") })),
          loading: zq.isPending || rq.isPending || !!zq.partial || !!rq.partial,
          error: zq.error ?? rq.error,
        },
      ],
      names: (g, sel) => {
        for (const z of zones.filter((x) => sel[ZONES]?.has(x.id))) {
          const zn = g.name(T.zone, z.id, undot(z.name));
          for (const r of of(z)) g.name(T.recordset, r.id, `${zn}_${r.type.toLowerCase()}_${undot(r.name).slice(0, -undot(z.name).length).replace(/\.$/, "") || "apex"}`);
        }
      },
      generate: (g, sel) => {
        const picked = zones.filter((z) => sel[ZONES]?.has(z.id));
        if (picked.length) g.section("DNS zones (Designate)");
        for (const z of picked) {
          const zn = g.addr(T.zone, z.id)!;
          g.block(
            T.zone,
            zn,
            [
              ...g.attrs([
                ["name", g.str(z.name)],
                ["email", z.email ? g.str(z.email) : null],
                ["ttl", z.ttl != null ? String(z.ttl) : null],
                ["type", z.type !== "PRIMARY" ? g.str(z.type) : null],
                ["masters", z.masters?.length ? `[${z.masters.map(g.str).join(", ")}]` : null],
                ["description", z.description ? g.str(z.description) : null],
              ]),
            ],
            z.id,
          );
          for (const r of of(z)) {
            g.block(
              T.recordset,
              g.addr(T.recordset, r.id)!,
              g.attrs([
                ["zone_id", `${T.zone}.${zn}.id`],
                ["name", g.str(r.name)],
                ["type", g.str(r.type)],
                ["ttl", r.ttl != null ? String(r.ttl) : null],
                ["records", `[${r.records.map(g.str).join(", ")}]`],
                ["description", r.description ? g.str(r.description) : null],
              ]),
              `${z.id}/${r.id}`,
            );
          }
        }
      },
    };
  },
};
