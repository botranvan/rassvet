import type { ExtensionUi } from "@rassvet/sdk";
import Reverse from "./Reverse";
import Settings from "./Settings";
import ZoneDetail from "./ZoneDetail";
import Zones from "./Zones";

const ui: ExtensionUi = {
  routes: [
    { path: "zones", component: Zones },
    { path: "zones/:id", component: ZoneDetail },
    { path: "reverse", component: Reverse },
    { path: "settings", component: Settings, adminOnly: true },
  ],
};

export default ui;
