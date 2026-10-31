/** Command palette: "Create DNS zone", search words, and zones and record sets. */
import { type PaletteContext, type PaletteContribution, os, tr } from "@rassvet/sdk";
import { DNS, type RecordSet, type Zone } from "./api";

const enc = encodeURIComponent;
/** Admins look across projects (Designate's `all_projects`). */
const all = (c: PaletteContext) => (c.admin ? { all_projects: 1 } : {});
/** Designate filters names with `*` wildcards. */
const like = (q: string) => `*${q.replace(/\*/g, "")}*`;

export const palette: PaletteContribution = {
  keywords: "dns designate domain zone record recordset ptr reverse",
  actions: [{ id: "new-zone", label: tr("Create DNS zone"), icon: "globe", path: "zones?new=1", keywords: "dns designate domain zone" }],
  resources: [
    {
      kind: tr("DNS zone"),
    aliases: ["zone", "dns", "domain"],
      icon: "globe",
      get: (id, c) => os.get<Zone>(DNS, `zones/${enc(id)}`, all(c), { signal: c.signal }),
      search: (q, c) => os.get<{ zones: Zone[] }>(DNS, "zones", { ...all(c), name: like(q), limit: 8 }, { signal: c.signal }).then((r) => r.zones),
      path: (z: Zone, c) => `${c.base}/zones/${z.id}`,
    },
    {
      kind: tr("Record set"),
    aliases: ["record", "recordset", "rr"],
      icon: "list-checks",
      search: (q, c) => os.get<{ recordsets: RecordSet[] }>(DNS, "recordsets", { ...all(c), name: like(q), limit: 8 }, { signal: c.signal }).then((r) => r.recordsets),
      name: (r: RecordSet) => `${r.name} ${r.type}`,
      path: (r: RecordSet, c) => `${c.base}/zones/${r.zone_id}`,
    },
  ],
};
