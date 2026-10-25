import type { ExtensionUi } from "@rassvet/sdk";
import Amphorae from "./Amphorae";
import { ListenerDetail, LoadBalancerDetail, PoolDetail } from "./Detail";
import LoadBalancers from "./LoadBalancers";
import Settings from "./Settings";

const ui: ExtensionUi = {
  routes: [
    { path: "load-balancers", component: LoadBalancers },
    { path: "load-balancers/:id", component: LoadBalancerDetail },
    { path: "load-balancers/:id/listeners/:lid", component: ListenerDetail },
    { path: "load-balancers/:id/pools/:pid", component: PoolDetail },
    { path: "amphorae", component: Amphorae, adminOnly: true },
    { path: "settings", component: Settings, adminOnly: true },
  ],
};

export default ui;
