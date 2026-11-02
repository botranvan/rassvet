import type { ExtensionUi } from "@rassvet/sdk";
import Hosts from "./Hosts";
import Instances from "./Instances";

const ui: ExtensionUi = {
  routes: [
    { path: "instances", component: Instances },
    { path: "hosts", component: Hosts, adminOnly: true },
  ],
  palette: { keywords: "monitoring metrics prometheus telegraf graphs charts cpu memory" },
};

export default ui;
