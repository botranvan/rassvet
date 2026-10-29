import type { ExtensionUi } from "@rassvet/sdk";
import ClusterDetail from "./ClusterDetail";
import Clusters from "./Clusters";
import Settings from "./Settings";
import Templates from "./Templates";

const ui: ExtensionUi = {
  routes: [
    { path: "clusters", component: Clusters },
    { path: "clusters/:id", component: ClusterDetail },
    { path: "templates", component: Templates },
    { path: "settings", component: Settings, adminOnly: true },
  ],
};

export default ui;
