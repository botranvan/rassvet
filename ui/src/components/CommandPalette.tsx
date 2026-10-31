/**
 * Command palette (Ctrl/⌘ K): jump to any page, run a quick action (launch, create, switch
 * cloud / project / region / view, theme, language, sign out) or find a resource by name or by a
 * pasted UUID: every kind in lib/palette.ts plus those the enabled extensions add
 * (`ExtensionUi.palette`), which also bring their own "Create …" actions and search words.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate as useRouterNavigate } from "react-router";
import { useNavigate } from "@/components/Link";
import { Icon } from "@/components/ui";
import { LANGS, lang, setLang, tr } from "@/lib/i18n";
import { extBase, useExtensionUis } from "@/extensions";
import { CORE_RESOURCES, type Found, type PaletteContext, type ResourceKind } from "@/lib/palette";
import { type NavItem, type SessionInfo, useLogout, useNav, useSwitchCloud, useSwitchProject, useSwitchRegion } from "@/lib/session";
import { toggleSidebar } from "@/lib/sidebar";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface Cmd {
  id: string;
  group: string;
  label: string;
  /** Right-hand hint (group, project, id…). */
  hint?: string;
  icon: string;
  /** Extra words matched by the search. */
  keywords?: string;
  run: () => void;
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const PALETTE_KEY = isMac ? "⌘K" : "Ctrl K";

/** All words of `q` appear in the text; earlier / word-start matches score higher. */
function score(c: Cmd, q: string) {
  if (!q) return 1;
  const label = c.label.toLowerCase();
  const text = `${label} ${c.group.toLowerCase()} ${(c.hint ?? "").toLowerCase()} ${(c.keywords ?? "").toLowerCase()}`;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.every((w) => text.includes(w))) return 0;
  const w = words[0];
  if (label.startsWith(w)) return 4;
  if (label.split(/[\s/·-]+/).some((x) => x.startsWith(w))) return 3;
  if (label.includes(w)) return 2;
  return 1;
}

/** A kind of resource, with the context it is searched in (an extension's base path). */
type Searched = { k: ResourceKind; c: Omit<PaletteContext, "signal"> };

const defId = (r: { id: string }) => r.id;
const defName = (r: { name?: string | null }) => r.name;

/**
 * Resources whose name contains `q` (or whose ID is `q`), from every kind of the host and of
 * the enabled extensions. Each kind is asked separately; failures (a 404, a service that
 * refuses) are skipped. Kinds without a name filter in their API list once and are cached.
 */
function useResourceSearch(q: string, kinds: Searched[], key: unknown) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["palette", q, key],
    enabled: q.length >= 2,
    staleTime: 30_000,
    queryFn: async ({ signal }): Promise<Found[]> => {
      // One bucket per kind keeps the results in a stable order whatever answers first.
      const out: Found[][] = kinds.map(() => []);
      const add = (i: number, rows: unknown[]) => {
        const { k, c } = kinds[i];
        for (const r of rows.filter((x) => x && (!k.keep || k.keep(x, c))).slice(0, 8)) {
          const id = (k.id ?? defId)(r as never);
          out[i].push({ kind: k.kind, icon: k.icon, id, name: (k.name ?? defName)(r as never) || id, path: k.path(r, c) });
        }
      };
      if (UUID.test(q)) {
        const id = q.toLowerCase();
        await Promise.allSettled(kinds.map(({ k, c }, i) => k.get?.(id, { ...c, signal }).then((r) => r && add(i, [r]))));
        return out.flat();
      }
      const needle = q.toLowerCase();
      const named = (i: number, rows: unknown[]) => rows.filter((r) => ((kinds[i].k.name ?? defName)(r as never) ?? "").toLowerCase().includes(needle));
      await Promise.allSettled(
        kinds.map(({ k, c }, i) => {
          const listed = () =>
            qc
              .fetchQuery({ queryKey: ["palette-list", k.kind, c.base, c.admin, c.project], queryFn: () => k.list!(c), staleTime: 60_000 })
              .then((rows) => add(i, named(i, rows)));
          // A kind with both searches by name and lists when the API refuses that filter.
          if (k.search) return k.search(q, { ...c, signal }).then((rows) => add(i, named(i, rows)), (e) => (k.list && !signal.aborted ? listed() : Promise.reject(e)));
          return k.list ? listed() : undefined;
        }),
      );
      return out.flat();
    },
  });
}

export function CommandPalette({ session, open, onClose }: { session: SessionInfo; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={tr("Command palette")}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      className="mx-auto mt-[12vh] mb-auto w-[calc(100%-2rem)] max-w-xl rounded-xl border border-line bg-panel p-0 text-ink shadow-2xl shadow-black/30 backdrop:bg-rack/55 backdrop:backdrop-blur-[2px]"
    >
      {open && <Palette session={session} onClose={onClose} />}
    </dialog>
  );
}

function Palette({ session, onClose }: { session: SessionInfo; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const go = useRouterNavigate();
  const goRes = useNavigate();
  const nav = useNav(true);
  const admin = window.location.pathname.startsWith("/admin");
  const switchCloud = useSwitchCloud();
  const switchProject = useSwitchProject();
  const switchRegion = useSwitchRegion();
  const logout = useLogout();
  const [, setTheme] = useTheme();
  const services = session.services;
  const has = (t: string) => services.includes(t);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const exts = useExtensionUis();
  const view = admin && session.is_admin;
  const kinds = useMemo<Searched[]>(() => {
    const c = { admin: view, project: session.project?.id, base: "" };
    const ok = (k: ResourceKind) => (!k.view || (k.view === "admin") === view) && (!k.services || k.services.some((s) => services.includes(s)));
    return [
      ...CORE_RESOURCES.filter(ok).map((k) => ({ k, c })),
      ...(exts ?? []).flatMap((e) => (e.ui.palette?.resources ?? []).filter(ok).map((k) => ({ k, c: { ...c, base: extBase(e.id, view) } }))),
    ];
  }, [exts, view, session.project?.id, services]);
  const found = useResourceSearch(debounced, kinds, [view, session.project?.id, exts?.map((e) => e.id)]);

  const done = (f: () => void) => () => {
    onClose();
    f();
  };

  const commands = useMemo<Cmd[]>(() => {
    const items: NavItem[] = nav.data?.items ?? [];
    const pages: Cmd[] = [
      { id: "page:/", group: tr("Go to"), label: tr("Overview"), hint: tr("Project"), icon: "layout-dashboard", run: done(() => go("/")) },
      ...(session.is_admin ? [{ id: "page:/admin", group: tr("Go to"), label: tr("Overview"), hint: tr("Admin"), icon: "layout-dashboard", run: done(() => go("/admin")) }] : []),
      // Pages of the current view (project / admin) first.
      ...[...items].sort((a, b) => Number(b.section === (admin ? "admin" : "project")) - Number(a.section === (admin ? "admin" : "project"))).map((i) => ({
        id: `page:${i.path}`,
        group: tr("Go to"),
        label: tr(i.label),
        hint: i.section === "admin" ? `${tr("Admin")} · ${tr(i.group)}` : tr(i.group),
        keywords: `${i.label} ${i.group} ${i.section === "admin" ? "admin" : ""} ${exts?.find((e) => e.id === i.id.split(".")[0])?.ui.palette?.keywords ?? ""}`,
        icon: i.icon,
        run: done(() => go(i.path)),
      })),
    ];
    const create = (id: string, label: string, icon: string, path: string, when: boolean, keywords = ""): Cmd[] =>
      when ? [{ id, group: tr("Actions"), label, icon, keywords: `new create ${keywords}`, run: done(() => go(path)) }] : [];
    const vol = has("block-storage") || has("volumev3") || has("volume");
    const actions: Cmd[] = [
      ...create("launch", tr("Launch instance"), "rocket", "/compute/instances/launch", has("compute"), "server vm"),
      ...create("new-volume", tr("Create volume"), "hard-drive", "/storage/volumes?new=1", vol, "disk"),
      ...create("new-network", tr("Create network"), "network", "/network/networks?new=1", has("network")),
      ...create("new-router", tr("Create router"), "router", "/network/routers?new=1", has("network")),
      ...create("new-sg", tr("Create security group"), "shield", "/network/security-groups?new=1", has("network"), "firewall"),
      ...create("new-fip", tr("Allocate floating IP"), "globe", "/network/floating-ips?new=1", has("network"), "public address"),
      ...create("new-keypair", tr("Create key pair"), "key-round", "/compute/keypairs?new=1", has("compute"), "ssh"),
      ...create("new-container", tr("Create container"), "archive", "/object-store/containers?new=1", has("object-store"), "bucket swift s3"),
      ...(exts ?? []).flatMap((e) =>
        (e.ui.palette?.actions ?? []).flatMap((x) => create(`${e.id}:${x.id}`, x.label, x.icon, `${extBase(e.id, view)}/${x.path}`, true, x.keywords)),
      ),
      ...create("terraform", tr("Export to Terraform"), "file-code", "/operations/terraform", true, "hcl iac opentofu"),
      ...(session.is_admin
        ? [{ id: "view", group: tr("Actions"), label: admin ? tr("Switch to project view") : tr("Switch to admin view"), icon: "arrow-right-left", keywords: "mode", run: done(() => go(admin ? "/" : "/admin")) }]
        : []),
      { id: "sidebar", group: tr("Actions"), label: tr("Collapse or expand the menu"), icon: "panel-left-close", keywords: "sidebar navigation hide show icons full width", run: done(toggleSidebar) },
      { id: "theme-light", group: tr("Actions"), label: tr("Light theme"), icon: "sun", keywords: "appearance", run: done(() => setTheme("light")) },
      { id: "theme-dark", group: tr("Actions"), label: tr("Dark theme"), icon: "moon", keywords: "appearance", run: done(() => setTheme("dark")) },
      ...LANGS.filter((l) => l.id !== lang).map((l) => ({ id: `lang-${l.id}`, group: tr("Actions"), label: tr("Language: {name}", { name: l.label }), icon: "globe", keywords: "language ngôn ngữ", run: done(() => setLang(l.id)) })),
      { id: "profile", group: tr("Actions"), label: tr("My profile"), icon: "users", run: done(() => go("/account/profile")) },
      { id: "logout", group: tr("Actions"), label: tr("Sign out"), icon: "log-out", keywords: "logout", run: done(() => logout.mutate(undefined)) },
    ];
    const projects: Cmd[] = session.can_switch_project
      ? session.projects
          .filter((p) => p.id !== session.project?.id)
          .map((p) => ({ id: `project:${p.id}`, group: tr("Switch project"), label: p.name, hint: p.id.slice(0, 8), icon: "folder", keywords: "project switch", run: done(() => switchProject.mutate(p.id)) }))
      : [];
    const regions: Cmd[] = session.regions
      .filter((r) => r !== session.region)
      .map((r) => ({ id: `region:${r}`, group: tr("Switch region"), label: r, icon: "map-pin", keywords: "region switch", run: done(() => switchRegion.mutate(r)) }));
    const clouds: Cmd[] = session.clouds
      .filter((c) => c.id !== session.cloud.id)
      .map((c) => ({ id: `cloud:${c.id}`, group: tr("Switch cloud"), label: c.name, hint: c.user.name, icon: "cloud", keywords: "cloud switch", run: done(() => switchCloud.mutate(c.id)) }));
    return [...pages, ...actions, ...clouds, ...projects, ...regions];
  }, [nav.data, session, admin, exts]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = q.trim();
  const results = useMemo(() => {
    const ranked = commands
      .map((c, i) => ({ c, s: score(c, query), i }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.c);
    // Without a query: actions first, then pages; clouds/projects/regions only when searched.
    const shown = query ? ranked.slice(0, 40) : [...ranked.filter((c) => c.group === tr("Actions")).slice(0, 6), ...ranked.filter((c) => c.group === tr("Go to")).slice(0, 8)];
    const res: Cmd[] =
      query.length >= 2 && debounced === query
        ? (found.data ?? []).map((f) => ({ id: `res:${f.kind}:${f.id}`, group: tr("Resources"), label: f.name, hint: f.kind, icon: f.icon, run: done(() => goRes(f.path)) }))
        : [];
    // One block per group, groups in the order of their best match.
    const groups = new Map<string, Cmd[]>();
    for (const c of UUID.test(query) ? [...res, ...shown] : [...shown, ...res]) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
    return [...groups.values()].flat();
  }, [commands, query, debounced, found.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const searching = query.length >= 2 && (debounced !== query || found.isFetching);
  let lastGroup = "";
  const rows: ReactNode[] = [];
  results.forEach((c, i) => {
    if (c.group !== lastGroup) {
      lastGroup = c.group;
      rows.push(
        <div key={`h:${c.group}`} className="px-3 pt-3 pb-1 text-xs font-medium text-muted">
          {c.group}
        </div>,
      );
    }
    rows.push(
      <button
        key={c.id}
        type="button"
        role="option"
        aria-selected={i === active}
        data-index={i}
        onMouseMove={() => i !== active && setActive(i)}
        onClick={c.run}
        className={cn("flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm", i === active ? "bg-cable-soft text-ink" : "hover:bg-surface")}
      >
        <Icon name={c.icon} className={cn("size-4 shrink-0", i === active ? "text-cable" : "text-muted")} />
        <span className="min-w-0 flex-1 truncate">{c.label}</span>
        {c.hint && <span className="max-w-[45%] shrink-0 truncate text-xs text-muted">{c.hint}</span>}
      </button>,
    );
  });

  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Icon name="search" className="size-4 shrink-0 text-muted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              results[active]?.run();
            }
          }}
          placeholder={tr("Search pages, actions, or resources by name or ID…")}
          aria-label={tr("Search")}
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          className="h-12 min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-muted/70 focus:outline-none"
        />
        {searching && <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted border-r-transparent" aria-label={tr("Searching…")} />}
        <kbd className="shrink-0 rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted">Esc</kbd>
      </div>
      <div ref={listRef} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {rows.length ? rows : <p className="px-3 py-6 text-center text-sm text-muted">{searching ? tr("Searching…") : tr("Nothing matches “{q}”.", { q: query })}</p>}
      </div>
      <div className="flex gap-4 border-t border-line px-4 py-2 text-xs text-muted">
        <span>↑ ↓ {tr("to move")}</span>
        <span>↵ {tr("to open")}</span>
        <span className="ml-auto">{tr("Names or a pasted UUID find resources")}</span>
      </div>
    </div>
  );
}

/** Ctrl/⌘ K anywhere opens the palette. */
export function usePaletteShortcut(open: () => void) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [open]);
}
