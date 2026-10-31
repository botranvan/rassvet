import type { ExtensionUi } from "@rassvet/sdk";
import { cleanup } from "./cleanup";
import { palette } from "./palette";
import Amphorae from "./Amphorae";
import { ListenerDetail, LoadBalancerDetail, PoolDetail } from "./Detail";
import LoadBalancers from "./LoadBalancers";
import Settings from "./Settings";
import { terraform } from "./terraform";

const ui: ExtensionUi = {
  routes: [
    { path: "load-balancers", component: LoadBalancers },
    { path: "load-balancers/:id", component: LoadBalancerDetail },
    { path: "load-balancers/:id/listeners/:lid", component: ListenerDetail },
    { path: "load-balancers/:id/pools/:pid", component: PoolDetail },
    { path: "amphorae", component: Amphorae, adminOnly: true },
    { path: "settings", component: Settings, adminOnly: true },
  ],
  palette,
  terraform,
  cleanup,
};

export default ui;
