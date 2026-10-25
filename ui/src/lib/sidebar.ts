/** Left menu visibility on wide screens, remembered per browser. */
const KEY = "rassvet.sidebar.hidden";
const EVENT = "rassvet:toggle-sidebar";

export function readSidebarHidden() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSidebarHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: lasts for this page view */
  }
}

/** Hide / show the left menu from anywhere (command palette, shortcuts). */
export const toggleSidebar = () => window.dispatchEvent(new Event(EVENT));
export const onToggleSidebar = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

/** Wide screens show the menu beside the page; narrow ones open it as a drawer. */
export const isWide = () => window.matchMedia("(min-width: 1024px)").matches;
