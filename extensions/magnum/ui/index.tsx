import type { ExtensionUi } from "@rassvet/sdk";
import ClusterDetail from "./ClusterDetail";
import { cleanup } from "./cleanup";
import Clusters from "./Clusters";
import { palette } from "./palette";
import Settings from "./Settings";
import Templates from "./Templates";
import { terraform } from "./terraform";

const ui: ExtensionUi = {
  routes: [
    { path: "clusters", component: Clusters },
    { path: "clusters/:id", component: ClusterDetail },
    { path: "templates", component: Templates },
    { path: "settings", component: Settings, adminOnly: true },
  ],
  palette,
  terraform,
  cleanup,
};

export default ui;
