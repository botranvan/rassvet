import { useEffect } from "react";
import { useSearchParams } from "react-router";

/** Current tab kept in the URL (`?tab=ports`) so it survives reloads and can be linked to. */
export function useTab<T extends string>(tabs: readonly T[], fallback: T): [T, (t: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") as T | null;
  const tab = raw && tabs.includes(raw) ? raw : fallback;
  const set = (t: T) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (t === fallback) next.delete("tab");
        else next.set("tab", t);
        return next;
      },
      { replace: true },
    );
  return [tab, set];
}

/**
 * `?new=1` opens a page's create dialog once (command palette "Create …" actions), then
 * drops the parameter so a reload doesn't open it again.
 */
export function useNewParam(open: (v: true) => void) {
  const [params, setParams] = useSearchParams();
  const want = params.get("new") === "1";
  useEffect(() => {
    if (!want) return;
    open(true);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("new");
        return next;
      },
      { replace: true },
    );
  }, [want]); // eslint-disable-line react-hooks/exhaustive-deps
}
