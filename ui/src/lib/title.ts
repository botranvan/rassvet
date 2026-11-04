import { useEffect } from "react";

/** Shown until a cloud is known (and in index.html). */
const FALLBACK = "rassvet";

/**
 * The browser tab's title: the name of the cloud the tab works on (`[[cloud]] name` in
 * rassvet.toml, e.g. "Ministry Cloud"), or "rassvet" without one.
 */
export function useDocumentTitle(cloudName: string | null | undefined) {
  useEffect(() => {
    document.title = cloudName?.trim() || FALLBACK;
  }, [cloudName]);
}
