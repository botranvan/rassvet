import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Ellipsis, Icon, MenuItem, Popover, StatusDot } from "@/components/ui";
import { Wordmark } from "@/pages/Login";
import {
  type NavItem,
  type NavSection,
  type SessionInfo,
  useLogout,
  useNav,
  useSwitchProject,
  useSwitchRegion,
} from "@/lib/session";
import { type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { tr, trx } from "@/lib/i18n";
import { LanguagePicker } from "@/components/LanguagePicker";
import { CommandPalette, PALETTE_KEY, usePaletteShortcut } from "@/components/CommandPalette";
import { isWide, onToggleSidebar, readSidebarHidden, saveSidebarHidden } from "@/lib/sidebar";

/** UI mode follows the URL: everything under /admin is the cloud-admin view. */
export function useMode(): NavSection {
  return useLocation().pathname.startsWith("/admin") ? "admin" : "project";
}

export default function AppShell({ session }: { session: SessionInfo }) {
  const nav = useNav(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const mode = useMode();
  const admin = mode === "admin";
  const [palette, setPalette] = useState(false);
  usePaletteShortcut(useCallback(() => setPalette(true), []));
  // Wide screens: the menu can be hidden for more room (remembered). Narrow screens: a drawer.
  // `rail`: collapsed to icons (wide screens only; the narrow-screen drawer always has labels).
  const [rail, setHidden] = useState(readSidebarHidden);
  // Name of the rail item under the pointer, shown beside the rail (labels are hidden there).
  const [tip, setTip] = useState<Tip>(null);
  const onTip = useCallback(
    (label: string | null, el?: HTMLElement | null) =>
      setTip(label && el && rail && isWide() ? { label, top: el.getBoundingClientRect().top + el.offsetHeight / 2 } : null),
    [rail],
  );
  useEffect(() => setTip(null), [location.pathname, rail]);
  const toggle = useCallback(() => {
    if (isWide()) {
      setHidden((h) => {
        saveSidebarHidden(!h);
        return !h;
      });
    } else setMobileOpen((o) => !o);
  }, []);
  useEffect(() => onToggleSidebar(toggle), [toggle]);

  const items = nav.data?.items.filter((i) => i.section === mode) ?? [];
  const cloudLabel = session.version ? `${session.cloud.name} - rassvet v${session.version}` : session.cloud.name;
  const current = items
    .filter((i) => location.pathname.startsWith(i.path))
    .sort((a, b) => b.path.length - a.path.length)[0];

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-side-line bg-side text-side-ink transition-[transform,width] duration-200 lg:static lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          rail && "lg:w-16",
        )}
      >
        <div className={cn("flex h-14 shrink-0 items-center gap-2 pr-3 pl-5", rail && "lg:justify-center lg:px-0")}>
          <Link to={admin ? "/admin" : "/"} aria-label="rassvet" onMouseEnter={(e) => onTip("rassvet", e.currentTarget)} onMouseLeave={() => onTip(null)}>
            <Wordmark className="text-base text-side-strong" textClassName={rail ? "lg:hidden" : undefined} />
          </Link>
          <button
            type="button"
            onClick={toggle}
            aria-label={tr("Collapse menu")}
            title={tr("Collapse menu")}
            className={cn("ml-auto hidden rounded-md p-1.5 text-side-dim hover:bg-side-hover hover:text-side-strong", !rail && "lg:block")}
          >
            <Icon name="panel-left-close" className="size-4" />
          </button>
        </div>
        {rail && (
          <button
            type="button"
            onClick={toggle}
            aria-label={tr("Expand menu")}
            onMouseEnter={(e) => onTip(tr("Expand menu"), e.currentTarget)}
            onMouseLeave={() => onTip(null)}
            className="mx-auto mb-2 hidden size-9 place-items-center rounded-md text-side-dim hover:bg-side-hover hover:text-side-strong lg:grid"
          >
            <Icon name="panel-left-open" className="size-4" />
          </button>
        )}
        {session.is_admin && <ModeSwitch mode={mode} rail={rail} onTip={onTip} />}
        <nav className={cn("flex-1 overflow-y-auto px-3 pb-6", rail && "lg:px-2")} onClick={() => setMobileOpen(false)} onScroll={() => setTip(null)}>
          <SideLink to={admin ? "/admin" : "/"} icon="layout-dashboard" label={tr("Overview")} end admin={admin} rail={rail} onTip={onTip} />
          <Groups items={items} admin={admin} rail={rail} onTip={onTip} />
        </nav>
        <div
          className={cn("flex min-w-0 items-center gap-2 border-t border-side-line px-5 py-3 text-xs text-side-dim", rail && "lg:justify-center lg:px-0")}
          title={rail ? undefined : cloudLabel}
          onMouseEnter={(e) => onTip(cloudLabel, e.currentTarget)}
          onMouseLeave={() => onTip(null)}
        >
          <StatusDot status="ok" />
          <span className={cn("truncate", rail && "lg:hidden")}>
            {session.cloud.name}
            {session.version && <span className="opacity-75"> - rassvet v{session.version}</span>}
          </span>
        </div>
      </aside>
      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none fixed left-[4.5rem] z-50 max-w-72 -translate-y-1/2 truncate rounded-md bg-ink px-2.5 py-1.5 text-xs font-medium text-panel shadow-lg"
          style={{ top: tip.top }}
        >
          {tip.label}
        </div>
      )}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "flex h-14 shrink-0 items-center gap-2 border-b bg-panel px-4 lg:px-6",
            admin ? "border-b-led-amber/70" : "border-line",
          )}
        >
          <button
            className="-ml-1 rounded-md p-2 hover:bg-ink/5 lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label={tr("Open navigation")}
          >
            <Icon name="menu" />
          </button>
          <div className="min-w-0 truncate text-sm text-muted">
            {admin && <span className="mr-2 font-medium text-[#9a6412] dark:text-led-amber">{tr("Admin")}</span>}
            {current ? (
              <>
                {tr(current.group)} <span className="mx-1 text-line">/</span>
                <span className="text-ink">{tr(current.label)}</span>
              </>
            ) : (
              <span className="text-ink">{tr("Overview")}</span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPalette(true)}
              aria-label={tr("Search and commands")}
              title={tr("Search pages, actions and resources ({key})", { key: PALETTE_KEY })}
              className="mr-1 flex h-9 items-center gap-2 rounded-md border border-line bg-surface/60 px-2.5 text-sm text-muted hover:border-cable/50 hover:text-ink"
            >
              <Icon name="search" className="size-4" />
              <span className="hidden md:inline">{tr("Search")}</span>
              <kbd className="hidden rounded border border-line bg-panel px-1 font-mono text-[11px] md:inline">{PALETTE_KEY}</kbd>
            </button>
            <ProjectSwitcher session={session} />
            <RegionSwitcher session={session} />
            <UserMenu session={session} />
          </div>
        </header>
        <CommandPalette session={session} open={palette} onClose={() => setPalette(false)} />
        <main className="flex-1 overflow-y-auto">
          <div className={cn("mx-auto px-4 py-8 lg:px-8", rail ? "lg:max-w-none" : "max-w-7xl")}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

type Tip = { label: string; top: number } | null;
type OnTip = (label: string | null, el?: HTMLElement | null) => void;

/** Project / Admin switch. Admin mode is marked in amber across the shell. */
function ModeSwitch({ mode, rail, onTip }: { mode: NavSection; rail: boolean; onTip: OnTip }) {
  const navigate = useNavigate();
  const opts: { id: NavSection; label: string; to: string }[] = [
    { id: "project", label: tr("Project"), to: "/" },
    { id: "admin", label: tr("Admin"), to: "/admin" },
  ];
  const icon = { project: "folder", admin: "shield-check" } as const;
  return (
    <>
      {rail && (
        <div role="radiogroup" aria-label={tr("View")} className="mx-auto mb-2 hidden flex-col gap-1 rounded-lg bg-side-well p-1 lg:flex">
          {opts.map((o) => (
            <button
              key={o.id}
              role="radio"
              aria-checked={mode === o.id}
              aria-label={o.label}
              onClick={() => mode !== o.id && navigate(o.to)}
              onMouseEnter={(e) => onTip(o.label, e.currentTarget)}
              onMouseLeave={() => onTip(null)}
              className={cn(
                "grid size-8 place-items-center rounded-md text-side-dim transition-colors hover:text-side-strong",
                mode === o.id && o.id === "project" && "bg-side text-side-strong shadow-sm dark:bg-side-line dark:shadow-none",
                mode === o.id && o.id === "admin" && "bg-side-admin text-side-admin-ink hover:text-side-admin-ink",
              )}
            >
              <Icon name={icon[o.id]} className="size-4" />
            </button>
          ))}
        </div>
      )}
    <div className={cn("px-3 pb-2", rail && "lg:hidden")}>
      <div role="radiogroup" aria-label={tr("View")} className="grid grid-cols-2 rounded-lg bg-side-well p-1 text-sm">
        {opts.map((o) => (
          <button
            key={o.id}
            role="radio"
            aria-checked={mode === o.id}
            onClick={() => mode !== o.id && navigate(o.to)}
            className={cn(
              "rounded-md py-1.5 font-medium text-side-dim transition-colors hover:text-side-strong",
              mode === o.id && o.id === "project" && "bg-side text-side-strong shadow-sm dark:bg-side-line dark:shadow-none",
              mode === o.id && o.id === "admin" && "bg-side-admin text-side-admin-ink hover:text-side-admin-ink",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
    </>
  );
}

function Groups({ items, admin, rail, onTip }: { items: NavItem[]; admin: boolean; rail: boolean; onTip: OnTip }) {
  const groups = useMemo(() => {
    const m = new Map<string, NavItem[]>();
    for (const i of items) m.set(i.group, [...(m.get(i.group) ?? []), i]);
    return [...m];
  }, [items]);
  return groups.map(([group, list]) => (
    <div key={group} className={cn("mt-5", rail && "lg:mt-2")}>
      <h3 className={cn("truncate px-2 pb-1 text-xs font-medium text-side-dim", rail && "lg:hidden")}>{tr(group)}</h3>
      {/* Collapsed: a rule between groups instead of their names. */}
      {rail && <div className="mx-2 mb-2 hidden border-t border-side-line lg:block" aria-hidden />}
      {list.map((i) => (
        <SideLink key={i.id} to={i.path} icon={i.icon} label={tr(i.label)} admin={admin} rail={rail} onTip={onTip} />
      ))}
    </div>
  ));
}

function SideLink({
  to,
  icon,
  label,
  end,
  admin,
  rail,
  onTip,
}: {
  to: string;
  icon: string;
  label: string;
  end?: boolean;
  admin?: boolean;
  rail?: boolean;
  onTip?: OnTip;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      onMouseEnter={(e) => onTip?.(label, e.currentTarget)}
      onMouseLeave={() => onTip?.(null)}
      onFocus={(e) => onTip?.(label, e.currentTarget)}
      onBlur={() => onTip?.(null)}
      className={({ isActive }) =>
        cn(
          "relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-side-ink hover:bg-side-hover hover:text-side-strong",
          rail && "lg:justify-center lg:px-0 lg:py-2 lg:before:-left-2",
          // Active item: a patch cable plugged into the rack.
          isActive && "font-medium before:absolute before:top-1.5 before:bottom-1.5 before:-left-3 before:w-[3px] before:rounded-r",
          isActive && (admin ? "bg-side-admin text-side-admin-ink before:bg-led-amber hover:bg-side-admin hover:text-side-admin-ink" : "bg-side-active text-side-strong before:bg-side-accent hover:bg-side-active"),
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon name={icon} className={cn("text-side-dim", isActive && (admin ? "text-side-admin-ink" : "text-side-accent"))} />
          <span className={cn("truncate", rail && "lg:hidden")} title={label}>
            {label}
          </span>
        </>
      )}
    </NavLink>
  );
}

function TopButton({ onClick, children, open }: { onClick: () => void; children: React.ReactNode; open: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-expanded={open}
      className={cn(
        "flex h-9 max-w-56 items-center gap-2 rounded-md px-2.5 text-sm hover:bg-ink/5",
        open && "bg-ink/5",
      )}
    >
      {children}
      <Icon name="chevrons-up-down" className="size-3.5 text-muted" />
    </button>
  );
}

function ProjectSwitcher({ session }: { session: SessionInfo }) {
  const sw = useSwitchProject();
  const [q, setQ] = useState("");
  const list = session.projects.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Popover
      className="w-72"
      trigger={({ open, toggle }) => (
        <TopButton open={open} onClick={toggle}>
          <Icon name="folder" className="text-muted" />
          <span className="truncate" title={session.project?.name}>
            {session.project?.name ?? tr("No project")}
          </span>
        </TopButton>
      )}
    >
      {(close) => (
        <div>
          {session.projects.length > 6 && (
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={tr("Find a project")}
              className="mb-1 h-8 w-full rounded-md border border-line bg-surface px-2.5 text-sm focus:outline-none"
            />
          )}
          <div className="max-h-72 overflow-y-auto">
            {list.map((p) => (
              <MenuItem
                key={p.id}
                active={p.id === session.project?.id}
                disabled={!session.can_switch_project || sw.isPending}
                onClick={() => {
                  if (p.id !== session.project?.id) sw.mutate(p.id);
                  close();
                }}
              >
                <span className="truncate">{p.name}</span>
                {p.id === session.project?.id && <Icon name="check" className="ml-auto size-3.5" />}
              </MenuItem>
            ))}
          </div>
          {!session.can_switch_project && (
            <p className="px-2.5 py-1.5 text-xs text-muted">
              {tr("Signed in with an application credential, which is bound to this project.")}
            </p>
          )}
        </div>
      )}
    </Popover>
  );
}

function RegionSwitcher({ session }: { session: SessionInfo }) {
  const sw = useSwitchRegion();
  if (session.regions.length <= 1) {
    return session.region ? (
      <span className="hidden items-center gap-2 px-2.5 text-sm text-muted sm:flex">
        <Icon name="map-pin" />
        {session.region}
      </span>
    ) : null;
  }
  return (
    <Popover
      trigger={({ open, toggle }) => (
        <TopButton open={open} onClick={toggle}>
          <Icon name="map-pin" className="text-muted" />
          <span className="truncate">{session.region}</span>
        </TopButton>
      )}
    >
      {(close) =>
        session.regions.map((r) => (
          <MenuItem
            key={r}
            active={r === session.region}
            onClick={() => {
              if (r !== session.region) sw.mutate(r);
              close();
            }}
          >
            {r}
          </MenuItem>
        ))
      }
    </Popover>
  );
}

function UserMenu({ session }: { session: SessionInfo }) {
  const logout = useLogout();
  const [theme, setTheme] = useTheme();
  const themes: { id: Theme; label: string; icon: string }[] = [
    { id: "light", label: tr("Light"), icon: "sun" },
    { id: "dark", label: tr("Dark"), icon: "moon" },
    { id: "system", label: tr("System"), icon: "monitor" },
  ];
  return (
    <Popover
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          aria-label={tr("Account")}
          className="ml-1 grid size-8 place-items-center rounded-full bg-cable text-sm font-semibold text-white uppercase"
        >
          {session.user.name.slice(0, 1)}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="px-2.5 py-2">
            <Ellipsis className="max-w-64 text-sm font-medium">{session.user.name}</Ellipsis>
            {session.user.domain && (
              <p className="text-xs text-muted">{trx("Domain {name}", { name: session.user.domain.name })}</p>
            )}
            <p className="text-xs text-muted">
              {tr("Roles:")}{" "}{session.roles.map((r) => r.name).join(", ") || tr("none")}
            </p>
          </div>
          <div className="my-1 border-t border-line" />
          <div className="grid grid-cols-3 gap-1 p-1">
            {themes.map((t) => (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-md py-2 text-xs text-muted hover:bg-surface",
                  theme === t.id && "bg-cable-soft text-cable",
                )}
              >
                <Icon name={t.icon} />
                {t.label}
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-line" />
          <LanguagePicker />
          <div className="my-1 border-t border-line" />
          <Link
            to="/account/profile"
            onClick={close}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface"
          >
            <Icon name="users" className="text-muted" />
            {tr("My profile")}
          </Link>
          <Link
            to="/account/password"
            onClick={close}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface"
          >
            <Icon name="key" className="text-muted" />
            {tr("Change password")}
          </Link>
          <MenuItem onClick={() => logout.mutate(undefined)}>
            <Icon name="log-out" className="text-muted" />
            {tr("Sign out")}
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}
