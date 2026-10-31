import { Fragment, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { usePref } from "@/lib/prefs";
import { useFindParam } from "@/lib/useTab";
import { cn } from "@/lib/utils";
import { type BulkAction, BulkActionDialog } from "./BulkActions";
import { downloadText } from "./CodeBlock";
import { ActionMenu, type MenuEntry } from "./Menu";
import { Picker } from "./Picker";
import { Button, Checkbox, Icon, Input, Popover } from "./ui";
import { tr, trx } from "@/lib/i18n";

export type { BulkAction } from "./BulkActions";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Value used for sorting, text filtering, hover text and CSV export. */
  value?: (row: T) => string | number | null | undefined;
  /** Text written to CSV exports when `value` is a sort key rather than readable text. */
  csv?: (row: T) => string | number | null | undefined;
  /** Render as monospace (UUIDs, IPs, CIDRs). */
  mono?: boolean;
  className?: string;
  /**
   * Long text is cut with "…" by default and the full text shows on hover
   * (taken from `value`). Set `wrap` for cells that must not be cut
   * (badge lists, action buttons).
   */
  wrap?: boolean;
  /**
   * Fixed column width (CSS length, e.g. "8rem"). Columns without a width share the
   * remaining space (at least a minimum; the table scrolls sideways when even that won't fit).
   */
  width?: string;
  /**
   * Drop priority for narrow tables: when the columns don't fit the table's width, "2xl"
   * columns go first, then "xl" … "sm". Columns without it are always shown.
   */
  hideBelow?: "sm" | "md" | "lg" | "xl" | "2xl";
}

const PAGE_SIZES = [10, 20, 50, 100];

/**
 * Server-side paging (marker-based APIs: Nova, Neutron, Cinder): the table shows one page
 * as returned by the API with Previous / Next, and the filter box searches on the server.
 */
export interface RemotePaging {
  page: number;
  hasNext: boolean;
  pageSize: number;
  onPageSize: (n: number) => void;
  onNext: () => void;
  onPrev: () => void;
  onFirst: () => void;
  fetching?: boolean;
  /** Server-side filters: a field picker plus a value (text, or a picker when the field has options). */
  filters?: { key: string; label: string; options?: { value: string; label: string; description?: string; input?: { placeholder?: string } }[]; placeholder?: string }[];
  filter?: { key: string; value: string };
  onFilter?: (key: string, value: string) => void;
  /** Column keys the server can sort by; with `onSort` only these headers sort. */
  sortable?: string[];
  onSort?: (sort: { key: string; dir: 1 | -1 } | null) => void;
  sort?: { key: string; dir: 1 | -1 } | null;
  /**
   * Two-step lists: rows come from a light list first and get their details one by one.
   * Until then a row (by `rowKey`) is "pending" (its cells show placeholders, it can't be
   * selected and has no actions) or failed (`{ error }`, shown on hover of its "—" cells).
   */
  rowState?: (key: string) => "pending" | { error: string } | undefined;
  details?: { loaded: number; total: number; failed: number; retry: () => void };
}

type RemoteField = NonNullable<RemotePaging["filters"]>[number];

/**
 * Picker filter; a choice with `input` adds a text box after it (debounced), and the value
 * becomes `<choice>\t<text>`.
 */
function ChoiceFilter({ field, remote }: { field: RemoteField; remote: RemotePaging }) {
  const current = remote.filter?.key === field.key ? remote.filter.value : "";
  const tab = current.indexOf("\t");
  const choice = tab < 0 ? current : current.slice(0, tab);
  const saved = tab < 0 ? "" : current.slice(tab + 1);
  const input = field.options?.find((o) => o.value === choice)?.input;
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  useEffect(() => {
    if (!input || text === saved) return;
    const t = setTimeout(() => remote.onFilter?.(field.key, text.trim() ? `${choice}\t${text.trim()}` : choice), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <>
      <Picker
        aria-label={field.label}
        size="sm"
        className={cn("h-9 min-w-0 flex-1", input ? "sm:w-44" : "sm:w-64")}
        clearable
        value={choice}
        onChange={(v) => remote.onFilter?.(field.key, v)}
        placeholder={field.placeholder ?? tr("Any {toLowerCase}", { toLowerCase: field.label.toLowerCase() })}
        options={field.options!}
        panelWidth={280}
      />
      {input && (
        <div className="relative min-w-0 flex-1 sm:w-56">
          <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <Input aria-label={input.placeholder ?? field.label} value={text} onChange={(e) => setText(e.target.value)} placeholder={input.placeholder} className="h-9 pl-9" />
        </div>
      )}
    </>
  );
}

function stored<V>(key: string | undefined, fallback: V): V {
  if (!key) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as V) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string | undefined, v: unknown) {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: setting lasts for this page view only */
  }
}

function csvCell(v: unknown) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The list view used by every resource page: filter, sort, pagination, optional
 * multi-select with bulk actions, column chooser, CSV export and refresh.
 * Data is loaded by the page; paging happens in the browser.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading,
  empty,
  filterPlaceholder = tr("Filter"),
  toolbar,
  tableId,
  rowLabel,
  noun = tr("items"),
  bulkActions,
  onRefresh,
  refreshing,
  onBulkDone,
  rowActions,
  remote,
  loadingMore,
  onSearch,
  pendingCell,
  expand,
}: {
  rows: T[] | undefined;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  empty?: ReactNode;
  filterPlaceholder?: string;
  /** Extra controls (filters) shown next to the search box. */
  toolbar?: ReactNode;
  /** Stable id: remembers page size and hidden columns, names CSV exports. */
  tableId?: string;
  /** Human name of a row, for bulk action dialogs. */
  rowLabel?: (row: T) => string;
  /** Plural noun for messages, e.g. "images". */
  noun?: string;
  /** Actions for selected rows. Without any, rows can't be selected. */
  bulkActions?: BulkAction<T>[];
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Called after a bulk action finished (refresh caches). Defaults to `onRefresh`. */
  onBulkDone?: () => void;
  /** Per-row actions, shown in a ⋮ menu at the end of the row. Computed when the menu opens. */
  rowActions?: (row: T) => MenuEntry[];
  /** Server-side Previous / Next paging instead of paging in the browser. */
  remote?: RemotePaging;
  /** The first rows are shown while the rest are still loading. */
  loadingMore?: boolean;
  /** Search on the server (debounced) instead of filtering loaded rows. */
  onSearch?: (q: string) => void;
  /** First cell of a row whose details are still loading (default: `rowLabel`). */
  pendingCell?: (row: T) => ReactNode;
  /** Rows get a ▸ toggle that shows this under the row, across all columns. */
  expand?: (row: T) => ReactNode;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (k: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const prefix = tableId ? `rassvet.table.${tableId}` : undefined;
  // Tables that filter loaded rows remember their filter and sort per page in the session
  // (paged tables do it in useOsPaged), so coming back to a page shows the same view.
  const { pathname } = useLocation();
  const prefKey = tableId && !remote ? `table.${tableId}${pathname.replace(/[^A-Za-z0-9._-]+/g, ":")}`.slice(0, 120) : undefined;
  const [saved, save] = usePref<{ q?: string; sort?: { key: string; dir: 1 | -1 } | null }>(prefKey);
  const remoteText = remote?.filters?.find((f) => f.key === remote.filter?.key && !f.options) ? remote.filter!.value : "";
  const find = useFindParam();
  const [q, setQ] = useState(() => (remote ? remoteText : find || (saved?.q ?? "")));
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(() => (remote ? (remote.sort ?? null) : (saved?.sort ?? null)));
  useEffect(() => {
    if (!prefKey || (!saved && !q && !sort)) return;
    const t = setTimeout(() => save({ q, sort }), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefKey, q, sort]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(() => stored(prefix && `${prefix}.pageSize`, 20));
  const [hidden, setHidden] = useState<string[]>(() => stored(prefix && `${prefix}.hidden`, []));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<BulkAction<T> | null>(null);
  const lastClicked = useRef<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  /** Change page and bring the top of the table back into view if it scrolled away. */
  const goTo = (p: number) => {
    setPage(p);
    const top = box.current?.getBoundingClientRect().top ?? 0;
    if (top < 0) box.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const selectable = !!bulkActions?.length;

  const visible = columns.filter((c, i) => i === 0 || !hidden.includes(c.key));
  const boxWidth = useWidth(box);
  // Columns fit the table's own width (not the viewport): hideBelow ranks which columns
  // drop first (2xl, then xl, …; later columns before earlier ones). table-fixed gives
  // auto-width columns only what fixed ones leave, so each keeps a minimum; whatever
  // can't be dropped scrolls sideways.
  const { shown, minWidth } = useMemo(() => {
    const need = (cols: Column<T>[]) => {
      const auto = cols.filter((c) => !c.width).length;
      const fixed = cols.reduce((n, c) => n + remOf(c.width), 0);
      return fixed + (auto ? AUTO_MIN + (auto - 1) * AUTO_MIN_REST : 0) + (selectable ? 2.75 : 0) + (rowActions ? 3.5 : 0);
    };
    let cols = visible;
    const drop = visible
      .map((c, i) => ({ c, i, rank: c.hideBelow ? BP_ORDER.indexOf(c.hideBelow) : -1 }))
      .filter((x) => x.i > 0 && x.rank >= 0)
      .sort((x, y) => y.rank - x.rank || y.i - x.i);
    const avail = boxWidth / 16;
    for (const d of drop) {
      if (!avail || need(cols) <= avail) break;
      cols = cols.filter((c) => c !== d.c);
    }
    // A small shortfall just squeezes the auto columns a little; sideways scrolling is for
    // tables that really can't fit (several fixed columns on a phone).
    const n = need(cols);
    return { shown: cols, minWidth: avail && n > avail + SQUEEZE ? `${n}rem` : undefined };
  }, [visible, boxWidth, selectable, rowActions]);

  const fields = remote?.filters;
  const field = fields?.find((f) => f.key === remote?.filter?.key) ?? fields?.[0];
  // Text filters go to the server (debounced); picker filters are sent straight away.
  const serverSearch = useMemo(
    () => (field && !field.options ? (v: string) => remote!.onFilter!(field.key, v) : fields ? undefined : onSearch),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [field?.key, !!fields, onSearch],
  );
  const serverSort = !!remote?.onSort;
  const canSort = (c: Column<T>) => !!c.value && (!serverSort || !!remote?.sortable?.includes(c.key));
  // Debounce server-side searches.
  useEffect(() => {
    if (!serverSearch) return;
    const t = setTimeout(() => serverSearch(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q, serverSearch]);

  const view = useMemo(() => {
    let out = rows ?? [];
    const needle = serverSearch || fields ? "" : q.trim().toLowerCase();
    if (needle) {
      // The row's ID too: `?find=<uuid>` from the command palette lands on its row.
      out = out.filter((r) => rowKey(r).toLowerCase() === needle || columns.some((c) => String(c.value?.(r) ?? "").toLowerCase().includes(needle)));
    }
    if (sort && !serverSort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.value) {
        out = [...out].sort((a, b) => {
          const x = col.value!(a) ?? "";
          const y = col.value!(b) ?? "";
          return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
        });
      }
    }
    return out;
  }, [rows, columns, q, sort, serverSearch, serverSort, fields]);

  const pages = remote ? 1 : Math.max(1, Math.ceil(view.length / pageSize));
  const current = Math.min(page, pages - 1);
  const pageRows = remote ? view : view.slice(current * pageSize, current * pageSize + pageSize);

  // Back to the first page whenever the result set changes shape.
  useEffect(() => setPage(0), [q, sort, pageSize]);
  // Drop selections of rows that no longer exist (deleted, or gone after a refresh).
  useEffect(() => {
    if (!rows) return;
    const keys = new Set(rows.map(rowKey));
    setSelected((s) => {
      const next = new Set([...s].filter((k) => keys.has(k)));
      return next.size === s.size ? s : next;
    });
  }, [rows, rowKey]);

  const selectedRows = (rows ?? []).filter((r) => selected.has(rowKey(r)));
  const stateOf = (r: T) => remote?.rowState?.(rowKey(r));
  // Rows still waiting for their details can't be selected (bulk checks need the details).
  const pageKeys = pageRows.filter((r) => !stateOf(r)).map(rowKey);
  const pageAll = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
  const pageSome = pageKeys.some((k) => selected.has(k));

  function toggleRow(index: number, shift: boolean) {
    const k = rowKey(pageRows[index]);
    const rangeKeys = pageRows.map((r) => (stateOf(r) ? null : rowKey(r)));
    // Read the anchor now: the state updater below runs later, after it has moved.
    const anchor = lastClicked.current;
    setSelected((s) => {
      const next = new Set(s);
      const on = !s.has(k);
      if (shift && anchor != null) {
        const [a, b] = [anchor, index].sort((x, y) => x - y);
        for (const key of rangeKeys.slice(a, b + 1)) {
          if (!key) continue;
          if (on) next.add(key);
          else next.delete(key);
        }
      } else if (on) next.add(k);
      else next.delete(k);
      return next;
    });
    lastClicked.current = index;
  }

  function exportCsv() {
    const cols = visible.filter((c) => c.value && c.header);
    const lines = [
      cols.map((c) => csvCell(c.header)).join(","),
      ...view.map((r) => cols.map((c, i) => csvCell(stateOf(r) ? (i === 0 ? (rowLabel?.(r) ?? rowKey(r)) : "") : (c.csv ?? c.value)!(r))).join(",")),
    ];
    downloadText(`${tableId ?? "export"}-${new Date().toISOString().slice(0, 10)}.csv`, `${lines.join("\n")}\n`, "text/csv");
  }

  const choosable = columns.slice(1).filter((c) => c.header);

  return (
    <div ref={box} className="scroll-mt-4 overflow-hidden rounded-lg border border-line bg-panel">
      {/* Toolbar, replaced by the selection bar while rows are selected */}
      {selected.size > 0 ? (
        <div className="flex min-h-[3.75rem] flex-wrap items-center gap-2 border-b border-line bg-cable-soft/60 px-3 py-2.5">
          <span className="text-sm font-medium">{trx("{size} selected", { size: selected.size })}</span>
          {selected.size < view.length && (
            <button className="text-sm text-cable hover:underline" onClick={() => setSelected(new Set(view.filter((r) => !stateOf(r)).map(rowKey)))}>
              {trx("Select all {length}", { length: view.length })}
            </button>
          )}
          <button className="text-sm text-muted hover:text-ink" onClick={() => setSelected(new Set())}>
            {tr("Clear")}
          </button>
          <div className="ml-auto flex flex-wrap gap-2">
            {bulkActions!.map((a, i) => {
              if (!a.menu)
                return (
                  <Button key={a.id} className={cn("h-8", a.danger && "text-led-red")} onClick={() => setRunning(a)}>
                    {a.icon && <Icon name={a.icon} />}
                    {a.label}
                  </Button>
                );
              // Grouped actions: one dropdown, placed where the group first appears.
              if (bulkActions!.findIndex((b) => b.menu === a.menu) !== i) return null;
              const group = bulkActions!.filter((b) => b.menu === a.menu);
              return (
                <ActionMenu
                  key={`menu:${a.menu}`}
                  variant="button"
                  align="end"
                  className="h-8 px-3"
                  label={a.menu}
                  trigger={
                    <>
                      <Icon name="list-checks" />
                      {a.menu}
                    </>
                  }
                  items={() =>
                    group.flatMap((b): MenuEntry[] => {
                      // How many of the selected rows the action applies to, shown on the right.
                      const n = selectedRows.filter((r) => (b.check?.(r) ?? true) === true).length;
                      return [
                        b.divider && "-",
                        {
                          label: b.label,
                          icon: b.icon,
                          danger: b.danger,
                          hint: `${n}/${selectedRows.length}`,
                          disabled: n === 0 ? tr("Not possible for any selected row") : false,
                          onSelect: () => setRunning(b),
                        },
                      ];
                    })
                  }
                />
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex min-h-[3.75rem] flex-wrap items-center gap-2 border-b border-line p-3">
          {fields && field ? (
            <div className="flex w-full min-w-0 gap-2 sm:w-auto">
              {fields.length > 1 && (
                <Picker
                  aria-label={tr("Filter by")}
                  size="sm"
                  className="h-9 w-36 shrink-0"
                  value={field.key}
                  onChange={(k) => {
                    setQ("");
                    remote!.onFilter!(k, "");
                  }}
                  options={fields.map((f) => ({ value: f.key, label: f.label }))}
                />
              )}
              {field.options ? (
                <ChoiceFilter field={field} remote={remote!} />
              ) : (
                <div className="relative min-w-0 flex-1 sm:w-64">
                  <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={field.placeholder ?? tr("Filter by {toLowerCase}", { toLowerCase: field.label.toLowerCase() })} className="h-9 pl-9" />
                </div>
              )}
            </div>
          ) : (
            <div className="relative w-full sm:max-w-xs">
              <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={filterPlaceholder} className="h-9 pl-9" />
            </div>
          )}
          {toolbar && <div className="flex flex-wrap items-center gap-2">{toolbar}</div>}
          {remote?.details && remote.details.loaded < remote.details.total && !loading && (
            <span className="inline-flex items-center gap-2 text-xs text-muted" role="status">
              <span className="relative h-1.5 w-20 overflow-hidden rounded-full bg-ink/8">
                <span className="absolute inset-y-0 left-0 rounded-full bg-cable transition-[width]" style={{ width: `${Math.round((remote.details.loaded / remote.details.total) * 100)}%` }} />
              </span>
              {tr("Loading details: {n} of {total}", { n: remote.details.loaded, total: remote.details.total })}
            </span>
          )}
          {remote?.details && remote.details.failed > 0 && !loading && (
            <span className="inline-flex items-center gap-2 text-xs text-led-red">
              {tr("{n} row(s) failed to load (hover “—” for the error)", { n: remote.details.failed })}
              <button type="button" onClick={remote.details.retry} className="text-cable hover:underline">
                {tr("Retry")}
              </button>
            </span>
          )}
          {(loadingMore || remote?.fetching) && !loading && !(remote?.details && remote.details.loaded < remote.details.total) && (
            <span className="inline-flex items-center gap-2 text-xs text-muted" role="status">
              <span className="size-3 animate-spin rounded-full border-2 border-current border-r-transparent" />
              {loadingMore ? tr("Loading the rest…") : tr("Loading…")}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {onRefresh && (
              <IconButton label={tr("Refresh")} onClick={onRefresh}>
                <Icon name="refresh" className={cn(refreshing && "animate-spin")} />
              </IconButton>
            )}
            {choosable.length > 0 && (
              <Popover
                trigger={({ toggle, open }) => (
                  <IconButton label={tr("Choose columns")} onClick={toggle} active={open}>
                    <Icon name="columns" />
                  </IconButton>
                )}
              >
                {() => (
                  <div className="space-y-1.5 p-2">
                    <p className="pb-1 text-xs text-muted">{tr("Columns")}</p>
                    {choosable.map((c) => (
                      <Checkbox
                        key={c.key}
                        checked={!hidden.includes(c.key)}
                        onChange={(on) => {
                          const next = on ? hidden.filter((h) => h !== c.key) : [...hidden, c.key];
                          setHidden(next);
                          store(prefix && `${prefix}.hidden`, next);
                        }}
                      >
                        {c.header}
                      </Checkbox>
                    ))}
                  </div>
                )}
              </Popover>
            )}
            <IconButton label={tr("Export CSV")} onClick={exportCsv} disabled={!view.length}>
              <Icon name="file-down" />
            </IconButton>
          </div>
        </div>
      )}

      {/* relative: keeps absolutely positioned sr-only labels inside the scroller */}
      <div className="relative overflow-x-auto">
      <table className="w-full table-fixed text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-line text-left text-muted">
            {selectable && (
              <th style={{ width: "2.75rem" }} className="py-2.5 pl-4">
                <input
                  type="checkbox"
                  aria-label={tr("Select all on this page")}
                  checked={pageAll}
                  ref={(el) => {
                    if (el) el.indeterminate = pageSome && !pageAll;
                  }}
                  onChange={() =>
                    setSelected((s) => {
                      const next = new Set(s);
                      for (const k of pageKeys) {
                        if (pageAll) next.delete(k);
                        else next.add(k);
                      }
                      return next;
                    })
                  }
                  className="size-4 accent-cable"
                />
              </th>
            )}
            {expand && (
              <th style={{ width: "2.5rem" }} className="py-2.5 pl-3">
                <span className="sr-only">{tr("Details")}</span>
              </th>
            )}
            {shown.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                className={cn("truncate px-4 py-2.5 font-medium", c.className)}
              >
                {canSort(c) ? (
                  <button
                    className="inline-flex max-w-full items-center gap-1 hover:text-ink"
                    onClick={() => {
                      const next: { key: string; dir: 1 | -1 } = sort?.key === c.key ? { key: c.key, dir: sort.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 };
                      setSort(next);
                      remote?.onSort?.(next);
                    }}
                  >
                    <span className="truncate">{c.header}</span>
                    {sort?.key === c.key && <Icon name={sort.dir === 1 ? "chevron-up" : "chevron-down"} className="size-3.5" />}
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
            {rowActions && (
              <th style={{ width: "3.5rem" }} className="py-2.5 pr-3">
                <span className="sr-only">{tr("Actions")}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {loading &&
            !rows &&
            Array.from({ length: 5 }, (_, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                {selectable && <td className="py-3 pl-4" />}
                {expand && <td />}
                {shown.map((c) => (
                  <td key={c.key} className="px-4 py-3">
                    <div
                      className="h-3.5 animate-pulse rounded bg-ink/8"
                      style={{ width: `${45 + ((i * 17 + c.key.length * 7) % 45)}%` }}
                    />
                  </td>
                ))}
                {rowActions && <td />}
              </tr>
            ))}
          {pageRows.map((r, i) => {
            const k = rowKey(r);
            const isSel = selected.has(k);
            const st = stateOf(r);
            if (st) {
              const err = st === "pending" ? undefined : st.error;
              return (
                <tr key={k} className="border-b border-line last:border-0" aria-busy={!err || undefined}>
                  {selectable && (
                    <td className="py-2.5 pl-4">
                      <input type="checkbox" disabled aria-label={tr("Select {v}", { v: rowLabel?.(r) ?? k })} className="size-4 accent-cable opacity-40" />
                    </td>
                  )}
                  {expand && <td />}
                  {shown.map((c, ci) => (
                    <td key={c.key} className={cn("px-4 py-2.5", c.className)}>
                      {ci === 0 ? (
                        <div className="truncate font-medium">{pendingCell ? pendingCell(r) : (rowLabel?.(r) ?? k)}</div>
                      ) : err ? (
                        <span className="text-xs text-muted" title={err}>
                          —
                        </span>
                      ) : (
                        <div className="h-3 animate-pulse rounded bg-ink/8" style={{ width: `${40 + ((i * 13 + c.key.length * 7) % 40)}%` }} />
                      )}
                    </td>
                  ))}
                  {rowActions && <td />}
                </tr>
              );
            }
            const open = !!expand && expanded.has(k);
            return (
              <Fragment key={k}>
              <tr className={cn("border-b border-line last:border-0", isSel ? "bg-cable-soft/40" : "hover:bg-surface/60", open && "border-b-0 bg-surface/40")}>
                {selectable && (
                  <td className="py-2.5 pl-4">
                    <input
                      type="checkbox"
                      aria-label={tr("Select {v}", { v: rowLabel?.(r) ?? k })}
                      checked={isSel}
                      onChange={() => {}}
                      onClick={(e) => toggleRow(i, e.shiftKey)}
                      className="size-4 accent-cable"
                    />
                  </td>
                )}
                {expand && (
                  <td className="py-1.5 pl-3">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={open ? tr("Hide details of {v}", { v: rowLabel?.(r) ?? k }) : tr("Show details of {v}", { v: rowLabel?.(r) ?? k })}
                      onClick={() => toggleExpanded(k)}
                      className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface hover:text-ink"
                    >
                      <Icon name="chevron-right" className={cn("size-4 transition-transform", open && "rotate-90")} />
                    </button>
                  </td>
                )}
                {shown.map((c) => {
                  const full = c.value?.(r);
                  return (
                    <td
                      key={c.key}
                      className={cn("px-4 py-2.5", c.mono && "font-mono text-[13px]", c.className)}
                    >
                      {c.wrap ? (
                        c.cell(r)
                      ) : (
                        <div className="truncate [&_p]:truncate" title={typeof full === "string" && full ? full : undefined}>
                          {c.cell(r)}
                        </div>
                      )}
                    </td>
                  );
                })}
                {rowActions && (
                  <td className="py-1.5 pr-3 text-right">
                    <ActionMenu items={() => rowActions(r)} label={tr("Actions for {v}", { v: rowLabel?.(r) ?? k })} />
                  </td>
                )}
              </tr>
              {open && (
                <tr className="border-b border-line bg-surface/40 last:border-0">
                  <td colSpan={(selectable ? 1 : 0) + 1 + shown.length + (rowActions ? 1 : 0)} className="px-4 pb-3">
                    {expand(r)}
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      </div>
      {!loading && view.length === 0 && (
        <div className="px-4 py-12 text-center text-sm text-muted">{q || remote?.filter?.value ? tr("Nothing matches the filter.") : remote && remote.page > 0 ? tr("No more results.") : empty}</div>
      )}

      {remote && (remote.page > 0 || view.length > 0) && (
        <RemotePager
          remote={remote}
          count={view.length}
          onPageSize={(n) => {
            remote.onPageSize(n);
            store(prefix && `${prefix}.pageSize`, n);
          }}
          onMove={(f) => {
            f();
            const top = box.current?.getBoundingClientRect().top ?? 0;
            if (top < 0) box.current?.scrollIntoView({ block: "start", behavior: "smooth" });
          }}
        />
      )}

      {!remote && view.length > 0 && (
        <Pagination
          total={view.length}
          allRows={rows?.length ?? 0}
          page={current}
          pages={pages}
          pageSize={pageSize}
          onPage={goTo}
          onPageSize={(n) => {
            setPageSize(n);
            store(prefix && `${prefix}.pageSize`, n);
          }}
        />
      )}

      {running && (
        <BulkActionDialog
          action={running}
          rows={selectedRows}
          rowKey={rowKey}
          rowLabel={rowLabel ?? rowKey}
          noun={noun}
          onClose={() => setRunning(null)}
          onFinished={(ok) => {
            setSelected((s) => {
              const next = new Set(s);
              for (const k of ok) next.delete(k);
              return next;
            });
            (onBulkDone ?? onRefresh)?.();
          }}
        />
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  disabled,
  active,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid size-9 place-items-center rounded-md text-muted hover:bg-ink/5 hover:text-ink disabled:opacity-40",
        active && "bg-ink/5 text-ink",
      )}
    >
      {children}
    </button>
  );
}

function RemotePager({ remote, count, onPageSize, onMove }: { remote: RemotePaging; count: number; onPageSize: (n: number) => void; onMove: (f: () => void) => void }) {
  const nav =
    "inline-flex h-8 items-center gap-1 rounded-md px-2 text-muted hover:bg-ink/5 hover:text-ink disabled:pointer-events-none disabled:opacity-35";
  const from = remote.page * remote.pageSize + 1;
  return (
    <nav aria-label={tr("Pagination")} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-muted">
        <span className="hidden sm:inline">{tr("Rows per page")}</span>
        <Picker
          aria-label={tr("Rows per page")}
          size="sm"
          className="w-[4.75rem]"
          panelWidth={96}
          value={String(remote.pageSize)}
          onChange={(v) => onPageSize(Number(v))}
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
        />
      </div>
      <span className="text-muted tabular-nums">
        {trx("Page {v}", { v: remote.page + 1 })}
        {count > 0 && (
          <span className="hidden sm:inline">
            {trx("· rows {from}–{v}", { from, v: from + count - 1 })}
          </span>
        )}
      </span>
      <div className="ml-auto flex items-center gap-0.5">
        <button type="button" className={nav} onClick={() => onMove(remote.onFirst)} disabled={remote.page === 0 || remote.fetching} aria-label={tr("First page")}>
          <Icon name="chevrons-left" />
        </button>
        <button type="button" className={nav} onClick={() => onMove(remote.onPrev)} disabled={remote.page === 0 || remote.fetching}>
          <Icon name="chevron-left" />
          {tr("Prev")}
        </button>
        <button type="button" className={nav} onClick={() => onMove(remote.onNext)} disabled={!remote.hasNext || remote.fetching}>
          {tr("Next")}
          <Icon name="chevron-right" />
        </button>
      </div>
    </nav>
  );
}

/** Page numbers to show: first, last, and a window around the current page. */
function pageList(page: number, pages: number): (number | "…")[] {
  const out: (number | "…")[] = [];
  for (let i = 0; i < pages; i++) {
    if (i === 0 || i === pages - 1 || Math.abs(i - page) <= 1) out.push(i);
    else if (out[out.length - 1] !== "…") out.push("…");
  }
  return out;
}

function Pagination({
  total,
  allRows,
  page,
  pages,
  pageSize,
  onPage,
  onPageSize,
}: {
  total: number;
  allRows: number;
  page: number;
  pages: number;
  pageSize: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
}) {
  const from = page * pageSize + 1;
  const to = Math.min(total, from + pageSize - 1);
  const nav =
    "grid size-8 place-items-center rounded-md text-muted hover:bg-ink/5 hover:text-ink disabled:pointer-events-none disabled:opacity-35";
  return (
    <nav aria-label={tr("Pagination")} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-muted">
        <span className="hidden sm:inline">{tr("Rows per page")}</span>
        <Picker
          aria-label={tr("Rows per page")}
          size="sm"
          className="w-[4.75rem]"
          panelWidth={96}
          value={String(pageSize)}
          onChange={(v) => onPageSize(Number(v))}
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
        />
      </div>
      <span className="text-muted tabular-nums">
        {trx("{from}–{to} of {total}", { from, to, total })}
        {total < allRows && <span className="hidden sm:inline">{" "}{trx("(filtered from {allRows})", { allRows })}</span>}
      </span>
      {pages > 1 && (
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" className={nav} onClick={() => onPage(0)} disabled={page === 0} aria-label={tr("First page")}>
            <Icon name="chevrons-left" />
          </button>
          <button type="button" className={nav} onClick={() => onPage(page - 1)} disabled={page === 0} aria-label={tr("Previous page")}>
            <Icon name="chevron-left" />
          </button>
          {pageList(page, pages).map((p, i) =>
            p === "…" ? (
              <span key={`gap${i}`} className="hidden px-1 text-muted sm:inline">
                …
              </span>
            ) : (
              <button
                type="button"
                key={p}
                onClick={() => onPage(p)}
                aria-current={p === page ? "page" : undefined}
                className={cn(
                  "hidden h-8 min-w-8 rounded-md px-2 tabular-nums sm:block",
                  p === page ? "bg-cable text-white" : "text-muted hover:bg-ink/5 hover:text-ink",
                )}
              >
                {p + 1}
              </button>
            ),
          )}
          <span className="px-2 text-muted tabular-nums sm:hidden">
            {page + 1} / {pages}
          </span>
          <button
            type="button"
            className={nav}
            onClick={() => onPage(page + 1)}
            disabled={page >= pages - 1}
            aria-label={tr("Next page")}
          >
            <Icon name="chevron-right" />
          </button>
          <button
            type="button"
            className={nav}
            onClick={() => onPage(pages - 1)}
            disabled={page >= pages - 1}
            aria-label={tr("Last page")}
          >
            <Icon name="chevrons-right" />
          </button>
        </div>
      )}
    </nav>
  );
}

/** Minimum rem for the first auto-width column (usually the name) and for the others. */
const AUTO_MIN = 10;
const AUTO_MIN_REST = 7;
const SQUEEZE = 3;
const BP_ORDER = ["base", "sm", "md", "lg", "xl", "2xl"] as const;

/** Width in rem of a column's CSS width (rem / px / ch); 0 when it's auto or a percentage. */
function remOf(w?: string) {
  const m = w?.match(/^([\d.]+)(rem|px|ch)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] === "px" ? n / 16 : m[2] === "ch" ? n * 0.5 : n;
}

/** Content width in px of an element, tracked with a ResizeObserver (0 before mount). */
function useWidth(ref: RefObject<HTMLElement | null>) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
