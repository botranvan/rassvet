import { initI18n } from "./lib/i18n";
import { initTheme } from "./lib/theme";
import "./index.css";

initTheme();
// Load the language first: the app's modules build some labels when they are imported.
void initI18n().then(() => import("./root"));
