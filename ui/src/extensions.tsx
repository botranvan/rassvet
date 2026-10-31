import { useQuery } from "@tanstack/react-query";
import { Suspense, lazy, useMemo } from "react";
import { Route } from "react-router";
import type { ExtensionUi } from "@rassvet/sdk";
import { tr } from "@/lib/i18n";
import { useNav } from "@/lib/session";

/**
 * Every `extensions/<id>/ui/index.tsx` is discovered at build time and code-split.
 * Its routes are only mounted when the server reports the extension as available
 * for the current session (service present in the catalog).
 */
const modules = import.meta.glob<{ default: ExtensionUi }>("../../extensions/*/ui/index.tsx");

const byId: Record<string, () => Promise<{ default: ExtensionUi }>> = {};
for (const [path, load] of Object.entries(modules)) {
  const id = path.split("/").at(-3)!;
  byId[id] = load;
}

/** One lazy page per (extension, route) pair. */
function pageFor(id: string, index: number) {
  return lazy(async () => {
    const mod = await byId[id]();
    const route = mod.default.routes[index];
    return { default: route.component };
  });
}

export interface LoadedExtension {
  id: string;
  routes: { path: string; index: number; adminOnly?: boolean }[];
}

/** Route definitions per extension (paths only) are needed synchronously by the router. */
export async function loadExtensionRoutes(ids: string[]): Promise<LoadedExtension[]> {
  const out: LoadedExtension[] = [];
  for (const id of ids) {
    if (!byId[id]) continue;
    const mod = await byId[id]();
    out.push({ id, routes: mod.default.routes.map((r, index) => ({ path: r.path, index, adminOnly: r.adminOnly })) });
  }
  return out;
}

/**
 * Every extension page is mounted at `/ext/<id>/<path>` (project view) and, for admins, at
 * `/admin/ext/<id>/<path>` too (admin view: the page can check `useInAdmin()` to look
 * across projects). Routes marked `adminOnly` are only mounted under /admin.
 */
export function useExtensionRouteElements(exts: LoadedExtension[], isAdmin: boolean) {
  return useMemo(
    () =>
      exts.flatMap((e) =>
        e.routes.flatMap((r) => {
          const Page = pageFor(e.id, r.index);
          const element = (
            <Suspense fallback={<p className="text-sm text-muted">{tr("Loading…")}</p>}>
              <Page />
            </Suspense>
          );
          return [
            !r.adminOnly && <Route key={`${e.id}:${r.path}`} path={`/ext/${e.id}/${r.path}`} element={element} />,
            isAdmin && <Route key={`admin:${e.id}:${r.path}`} path={`/admin/ext/${e.id}/${r.path}`} element={element} />,
          ].filter(Boolean);
        }),
      ),
    [exts, isAdmin],
  );
}

export interface ExtensionModule {
  id: string;
  ui: ExtensionUi;
}

/**
 * The UI modules of the extensions available in this session, for the host features they
 * plug into (command palette, Terraform export, Cleanup). Undefined while loading.
 */
export function useExtensionUis(): ExtensionModule[] | undefined {
  const nav = useNav(true);
  const ids = (nav.data?.extensions.map((e) => e.id) ?? []).filter((id) => byId[id]);
  const q = useQuery({
    queryKey: ["extension-uis", ids],
    queryFn: () => Promise.all(ids.map(async (id) => ({ id, ui: (await byId[id]()).default }))),
    enabled: nav.isSuccess,
    staleTime: Infinity,
  });
  return nav.isError ? [] : q.data;
}

/** Where an extension's pages are: `/ext/<id>`, or `/admin/ext/<id>` in the admin view. */
export const extBase = (id: string, admin: boolean) => `${admin ? "/admin" : ""}/ext/${id}`;
