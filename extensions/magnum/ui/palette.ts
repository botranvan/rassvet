/** Command palette: "Create …" actions, search words and Kubernetes clusters / templates. */
import { type PaletteContribution, os, tr } from "@rassvet/sdk";

type Row = { uuid: string; name?: string | null; project_id?: string | null; public?: boolean };
const enc = encodeURIComponent;

export const palette: PaletteContribution = {
  keywords: "k8s kubernetes magnum container coe cluster",
  actions: [
    { id: "new-cluster", label: tr("Create Kubernetes cluster"), icon: "container", path: "clusters?new=1", keywords: "k8s kubernetes magnum container" },
    { id: "new-template", label: tr("Create cluster template"), icon: "file-code", path: "templates?new=1", keywords: "k8s kubernetes magnum container" },
  ],
  // Magnum can't search names and shows admins every project's: the project view keeps its
  // own clusters and the templates it can use.
  resources: [
    {
      kind: tr("Kubernetes cluster"),
    aliases: ["cluster", "k8s", "kubernetes", "coe"],
      icon: "container",
      get: (id, c) => os.get<Row>("ext:magnum", `clusters/${enc(id)}`, undefined, { signal: c.signal }),
      list: () => os.list<Row>("ext:magnum", "clusters/detail", "clusters"),
      id: (r: Row) => r.uuid,
      keep: (r: Row, c) => c.admin || !r.project_id || r.project_id === c.project,
      path: (r: Row, c) => `${c.base}/clusters/${r.uuid}`,
    },
    {
      kind: tr("Cluster template"),
    aliases: ["template", "cluster-template", "ct"],
      icon: "file-code",
      get: (id, c) => os.get<Row>("ext:magnum", `clustertemplates/${enc(id)}`, undefined, { signal: c.signal }),
      list: () => os.list<Row>("ext:magnum", "clustertemplates", "clustertemplates"),
      id: (r: Row) => r.uuid,
      keep: (r: Row, c) => c.admin || !r.project_id || r.project_id === c.project || !!r.public,
      path: (r: Row, c) => `${c.base}/templates?edit=${r.uuid}`,
    },
  ],
};
