import { useEffect, useState } from "react";
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

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * `?find=<id or name>` (command palette results of list pages without a detail page): the
 * starting search of a list, read once, then dropped from the URL so it doesn't stick.
 */
export function useFindParam(): string {
  const [params, setParams] = useSearchParams();
  const [find] = useState(() => params.get("find") ?? "");
  useEffect(() => {
    if (!params.has("find")) return;
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("find");
        return next;
      },
      { replace: true },
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return find;
}

/** The filter a `?find=` value starts a paged list with: by ID for a UUID, else by name. */
export function findFilter(find: string, filters?: { key: string }[]) {
  if (!find || !filters) return null;
  const key = UUID.test(find) && filters.some((f) => f.key === "id") ? "id" : filters.some((f) => f.key === "name") ? "name" : null;
  return key ? { key, value: find } : null;
}
