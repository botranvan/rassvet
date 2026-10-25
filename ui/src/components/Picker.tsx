import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Floating } from "./Floating";
import { Icon } from "./ui";
import { tr } from "@/lib/i18n";

export interface PickOption {
  value: string;
  label: string;
  /** Second line: size, CIDR, status… */
  description?: ReactNode;
  /** Short text on the right. */
  meta?: ReactNode;
  icon?: string;
  /** `true`, or a reason shown under the option. */
  disabled?: boolean | string;
  /** Options with the same group are listed under one heading, in order of appearance. */
  group?: string;
  /** Extra text matched by the search box. */
  keywords?: string;
}

type Common = {
  id?: string;
  options: PickOption[];
  placeholder?: string;
  /** Show the search box; defaults to on when there are more than 7 options. */
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: ReactNode;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  size?: "md" | "sm";
  /** Extra row at the bottom of the list (e.g. "Allocate a new floating IP"). */
  footer?: (close: () => void) => ReactNode;
  "aria-label"?: string;
  /** Minimum width of the open list in px (it is never narrower than the field). */
  panelWidth?: number;
};

const trigger =
  "flex w-full min-w-0 items-center gap-2 rounded-md border border-line bg-panel px-3 text-left text-sm text-ink transition-colors " +
  "hover:border-ink/25 focus:border-cable focus:outline-none focus:ring-3 focus:ring-cable/15 disabled:cursor-not-allowed disabled:opacity-55 " +
  "aria-expanded:border-cable aria-expanded:ring-3 aria-expanded:ring-cable/15";

/** Searchable dropdown for picking one value. Replaces native <select>. */
export function Picker({
  value,
  onChange,
  clearable,
  inlineDescription,
  ...rest
}: Common & {
  value: string;
  onChange: (v: string) => void;
  clearable?: boolean;
  /** Show the chosen option's description after its label on one line, e.g. "(60263670-16c3) default-net · 192.168.89.96". */
  inlineDescription?: boolean;
}) {
  const current = rest.options.find((o) => o.value === value);
  return (
    <PickerBase
      {...rest}
      isSelected={(v) => v === value}
      onPick={(v, close) => {
        onChange(v);
        close();
      }}
      display={
        current ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {current.icon && <Icon name={current.icon} className="text-muted" />}
            {inlineDescription && current.description ? (
              <span className="min-w-0 truncate" title={typeof current.description === "string" ? `${current.label} ${current.description}` : undefined}>
                {current.label} <span className="text-muted">{current.description}</span>
              </span>
            ) : (
              <span className="truncate">{current.label}</span>
            )}
            {current.meta && <span className="ml-auto shrink-0 pl-2 text-xs text-muted">{current.meta}</span>}
          </span>
        ) : null
      }
      onClear={clearable && value ? () => onChange("") : undefined}
    />
  );
}

/** Searchable dropdown for picking several values; chosen ones show as chips. */
export function MultiPicker({
  values,
  onChange,
  ...rest
}: Common & { values: string[]; onChange: (v: string[]) => void }) {
  const byValue = new Map(rest.options.map((o) => [o.value, o]));
  return (
    <PickerBase
      {...rest}
      multi
      isSelected={(v) => values.includes(v)}
      onPick={(v) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])}
      display={
        values.length ? (
          <span className="flex min-w-0 flex-1 flex-wrap gap-1 py-1">
            {values.map((v) => (
              <span key={v} className="inline-flex h-6 max-w-48 items-center gap-1 rounded-md bg-ink/6 pr-1 pl-2 text-xs font-medium">
                <span className="truncate">{byValue.get(v)?.label ?? v}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={tr("Remove {v}", { v: byValue.get(v)?.label ?? v })}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(values.filter((x) => x !== v));
                  }}
                  className="rounded p-0.5 opacity-60 hover:bg-ink/10 hover:opacity-100"
                >
                  <Icon name="x" className="size-3" />
                </span>
              </span>
            ))}
          </span>
        ) : null
      }
    />
  );
}

function PickerBase({
  id,
  options,
  placeholder = tr("Choose…"),
  searchable,
  searchPlaceholder = tr("Search"),
  emptyText = tr("Nothing to choose from."),
  loading,
  disabled,
  className,
  size = "md",
  footer,
  multi,
  isSelected,
  onPick,
  display,
  onClear,
  "aria-label": ariaLabel,
  panelWidth = 240,
}: Common & {
  multi?: boolean;
  isSelected: (v: string) => boolean;
  onPick: (v: string, close: () => void) => void;
  display: ReactNode;
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const showSearch = searchable ?? options.length > 7;

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return options;
    return options.filter((o) =>
      `${o.label} ${o.value} ${typeof o.description === "string" ? o.description : ""} ${typeof o.meta === "string" ? o.meta : ""} ${o.keywords ?? ""}`
        .toLowerCase()
        .includes(n),
    );
  }, [options, q]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    const sel = options.findIndex((o) => isSelected(o.value));
    setActive(Math.max(0, sel));
    const t = setTimeout(() => (showSearch ? search.current : listRef.current)?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const close = () => setOpen(false);
  const choose = (o: PickOption) => {
    if (o.disabled) return;
    onPick(o.value, () => {
      close();
      btn.current?.focus();
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(shown.length - 1, nextEnabled(shown, a, 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, nextEnabled(shown, a, -1)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = shown[active];
      if (o) choose(o);
    } else if (e.key === "Tab") close();
  };

  let lastGroup: string | undefined;
  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(trigger, size === "md" ? "min-h-10" : "min-h-8 px-2.5", className)}
      >
        {display ?? <span className="flex-1 truncate text-muted/80">{loading ? tr("Loading…") : placeholder}</span>}
        {onClear && (
          <span
            role="button"
            tabIndex={-1}
            aria-label={tr("Clear")}
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            className="rounded p-0.5 text-muted hover:bg-ink/8 hover:text-ink"
          >
            <Icon name="x" className="size-3.5" />
          </span>
        )}
        <Icon name="chevrons-up-down" className="ml-auto size-3.5 text-muted" />
      </button>
      <Floating anchor={btn.current} open={open} onClose={close} matchWidth minWidth={panelWidth} maxHeight={340}>
        {showSearch && (
          <div className="relative border-b border-line p-1.5">
            <Icon name="search" className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted" />
            <input
              ref={search}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              placeholder={searchPlaceholder}
              aria-controls={listId}
              aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
              className="h-9 w-full rounded-lg bg-surface/70 pr-3 pl-8 text-sm placeholder:text-muted/70 focus:outline-none"
            />
          </div>
        )}
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-multiselectable={multi || undefined}
          tabIndex={showSearch ? -1 : 0}
          onKeyDown={showSearch ? undefined : onKey}
          className="min-h-0 flex-1 overflow-y-auto p-1.5 outline-none"
        >
          {loading && <li className="px-3 py-2 text-sm text-muted">{tr("Loading…")}</li>}
          {!loading && shown.length === 0 && (
            <li className="px-3 py-3 text-center text-sm text-muted">{q ? tr("Nothing matches “{q}”.", { q }) : emptyText}</li>
          )}
          {shown.map((o, i) => {
            const heading = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            const sel = isSelected(o.value);
            return (
              <li key={o.value} role="presentation">
                {heading && <p className="px-3 pt-2 pb-1 text-[11.5px] font-medium text-muted">{heading}</p>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={sel}
                  aria-disabled={!!o.disabled || undefined}
                  data-index={i}
                  onMouseMove={() => !o.disabled && active !== i && setActive(i)}
                  onClick={() => choose(o)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                    i === active && !o.disabled && "bg-surface",
                    sel && "text-cable",
                    o.disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  {multi && (
                    <span
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded border",
                        sel ? "border-cable bg-cable text-white" : "border-line bg-panel",
                      )}
                    >
                      {sel && <Icon name="check" className="size-3" />}
                    </span>
                  )}
                  {o.icon && <Icon name={o.icon} className="text-muted" />}
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate", sel && "font-medium")}>{o.label}</span>
                    {(o.description || typeof o.disabled === "string") && (
                      <span className="block truncate text-xs text-muted">
                        {typeof o.disabled === "string" ? o.disabled : o.description}
                      </span>
                    )}
                  </span>
                  {o.meta && <span className="shrink-0 text-xs text-muted tabular-nums">{o.meta}</span>}
                  {!multi && sel && <Icon name="check" className="size-4 text-cable" />}
                </div>
              </li>
            );
          })}
        </ul>
        {multi && (
          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-muted">
            <span>{options.filter((o) => isSelected(o.value)).length}{" "}{tr("selected")}</span>
            <button type="button" className="font-medium text-cable hover:underline" onClick={close}>
              {tr("Done")}
            </button>
          </div>
        )}
        {footer && <div className="border-t border-line p-1.5">{footer(close)}</div>}
      </Floating>
    </>
  );
}

function nextEnabled(list: PickOption[], from: number, dir: 1 | -1) {
  let i = from + dir;
  while (i >= 0 && i < list.length && list[i].disabled) i += dir;
  return i < 0 || i >= list.length ? from : i;
}
