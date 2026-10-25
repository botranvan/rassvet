import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Floating } from "./Floating";
import { Icon } from "./ui";
import { tr } from "@/lib/i18n";

export interface MenuAction {
  label: string;
  icon?: string;
  onSelect: () => void;
  danger?: boolean;
  /** `true`, or a reason shown on hover (e.g. "Stop the instance first"). */
  disabled?: boolean | string;
  /** Short text on the right (state, count). */
  hint?: string;
}

/** A menu entry: an action, "-" for a separator, `{ heading }`, or falsy to skip. */
export type MenuEntry = MenuAction | "-" | { heading: string } | null | false | undefined | "" | 0;

const isAction = (e: MenuEntry): e is MenuAction => !!e && typeof e === "object" && "onSelect" in e;

/** Drop falsy entries, leading/trailing/double separators and headings with nothing under them. */
export function tidy(entries: MenuEntry[]): Exclude<MenuEntry, null | false | undefined | "" | 0>[] {
  const list = entries.filter(Boolean) as Exclude<MenuEntry, null | false | undefined | "" | 0>[];
  const out: typeof list = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e === "-") {
      if (out.length && out[out.length - 1] !== "-") out.push(e);
    } else if (!isAction(e)) {
      // Heading: keep only when an action follows before the next separator/heading.
      const next = list[i + 1];
      if (next && isAction(next)) {
        if (out.length && out[out.length - 1] !== "-") out.push("-");
        out.push(e);
      }
    } else out.push(e);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

/**
 * The actions menu used on list rows (⋮) and detail pages ("Actions ▾").
 * Keyboard: arrows/Home/End move, Enter runs, Esc closes, letters jump.
 */
export function ActionMenu({
  items,
  label = tr("Actions"),
  variant = "kebab",
  align = "end",
  className,
  trigger,
}: {
  /** Entries, or a function so they are only computed when the menu opens. */
  items: MenuEntry[] | (() => MenuEntry[]);
  label?: string;
  variant?: "kebab" | "button" | "primary";
  align?: "start" | "end";
  className?: string;
  /** Custom trigger content for the "button" variant. */
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const entries = open ? tidy(typeof items === "function" ? items() : items) : [];

  const buttons = () => [...(list.current?.querySelectorAll<HTMLButtonElement>("button[role=menuitem]:not([aria-disabled=true])") ?? [])];
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => buttons()[0]?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const move = (d: number | "first" | "last") => {
    const all = buttons();
    if (!all.length) return;
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = d === "first" ? 0 : d === "last" ? all.length - 1 : (i + d + all.length) % all.length;
    all[next].focus();
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={variant === "kebab" ? label : undefined}
        title={variant === "kebab" ? label : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          variant === "kebab" &&
            "grid size-8 place-items-center rounded-md border border-transparent text-muted transition-colors hover:border-line hover:bg-panel hover:text-ink aria-expanded:border-line aria-expanded:bg-panel aria-expanded:text-ink aria-expanded:shadow-sm",
          variant !== "kebab" &&
            "inline-flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors",
          variant === "button" && "border border-line bg-panel hover:bg-surface aria-expanded:bg-surface",
          variant === "primary" && "bg-cable text-white hover:brightness-110",
          className,
        )}
      >
        {variant === "kebab" ? (
          <Icon name="more-vertical" />
        ) : (
          <>
            {trigger ?? label}
            <Icon name="chevron-down" className={cn("size-3.5 transition-transform duration-150", open && "rotate-180")} />
          </>
        )}
      </button>
      <Floating anchor={btn.current} open={open} onClose={() => setOpen(false)} align={align} minWidth={232} maxHeight={440}>
        <div
          ref={list}
          role="menu"
          aria-label={label}
          className="overflow-y-auto p-1.5"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), move(1));
            else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
            else if (e.key === "Home") (e.preventDefault(), move("first"));
            else if (e.key === "End") (e.preventDefault(), move("last"));
            else if (e.key === "Tab") setOpen(false);
            else if (e.key.length === 1 && /\S/.test(e.key)) {
              const all = buttons();
              const i = all.indexOf(document.activeElement as HTMLButtonElement);
              const k = e.key.toLowerCase();
              const hit = [...all.slice(i + 1), ...all.slice(0, i + 1)].find((b) => b.textContent?.trim().toLowerCase().startsWith(k));
              hit?.focus();
            }
          }}
        >
          {entries.length === 0 && <p className="px-3 py-2 text-sm text-muted">{tr("No actions available")}</p>}
          {entries.map((e, i) => {
            if (e === "-") return <div key={`s${i}`} role="separator" className="mx-1 my-1.5 border-t border-line" />;
            if (!isAction(e))
              return (
                <p key={`h${i}`} className="px-3 pt-1.5 pb-1 text-[11.5px] font-medium text-muted">
                  {e.heading}
                </p>
              );
            const off = !!e.disabled;
            return (
              <button
                key={`${e.label}${i}`}
                type="button"
                role="menuitem"
                aria-disabled={off || undefined}
                title={typeof e.disabled === "string" ? e.disabled : undefined}
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (off) return;
                  setOpen(false);
                  e.onSelect();
                }}
                className={cn(
                  "group flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors",
                  off ? "cursor-not-allowed opacity-45" : "hover:bg-surface focus-visible:bg-surface",
                  e.danger && !off && "text-led-red hover:bg-led-red/8 focus-visible:bg-led-red/8",
                  "focus-visible:outline-none",
                )}
              >
                {e.icon && <Icon name={e.icon} className={cn("text-muted", e.danger && !off && "text-led-red")} />}
                <span className="min-w-0 flex-1 truncate">{e.label}</span>
                {e.hint && <span className="shrink-0 text-xs text-muted">{e.hint}</span>}
              </button>
            );
          })}
        </div>
      </Floating>
    </>
  );
}
