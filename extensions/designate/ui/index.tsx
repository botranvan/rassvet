import type { ExtensionUi } from "@rassvet/sdk";
import { cleanup } from "./cleanup";
import { palette } from "./palette";
import Reverse from "./Reverse";
import Settings from "./Settings";
import { terraform } from "./terraform";
import ZoneDetail from "./ZoneDetail";
import Zones from "./Zones";

const ui: ExtensionUi = {
  routes: [
    { path: "zones", component: Zones },
    { path: "zones/:id", component: ZoneDetail },
    { path: "reverse", component: Reverse },
    { path: "settings", component: Settings, adminOnly: true },
  ],
  palette,
  terraform,
  cleanup,
};

export default ui;
