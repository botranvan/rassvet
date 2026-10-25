/**
 * A free-text input with a suggestion list in the same floating panel as `Picker`
 * (keyboard navigation, descriptions, match highlighting). Unlike Picker, any text is
 * allowed: suggestions only help (extra-spec keys, typical values…). Replaces <datalist>,
 * whose look and behaviour differ per browser.
 */
import { type KeyboardEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Floating } from "./Floating";
import { Icon, Input } from "./ui";
import { tr } from "@/lib/i18n";

export interface ComboOption {
  value: string;
  /** Second line, e.g. what the key does. */
  description?: string;
  /** Short text on the right. */
  meta?: string;
}

/** `text` with the first case-insensitive occurrence of `q` in bold. */
function highlight(text: string, q: string): ReactNode {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <span className="font-semibold text-cable">{text.slice(i, i + q.length)}</span>
      {text.slice(i + q.length)}
    </>
  );
}

export function ComboInput({
  value,
  onChange,
  options,
  onPick,
  placeholder,
  className,
  wrapClassName,
  mono,
  invalid,
  emptyText = tr("No suggestions match — your own text is fine too."),
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
  /** Called when a suggestion is chosen (after onChange). */
  onPick?: (o: ComboOption) => void;
  placeholder?: string;
  /** Classes for the input. */
  className?: string;
  /** Classes for the wrapper (e.g. flex-1 in a row). */
  wrapClassName?: string;
  mono?: boolean;
  invalid?: boolean;
  emptyText?: string;
  "aria-label"?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Filter only once the user types: on focus show everything, so a chosen key can be swapped.
  const [typed, setTyped] = useState(false);

  const q = typed ? value.trim() : "";
  const shown = useMemo(() => {
    if (!q) return options;
    const n = q.toLowerCase();
    const hits = options.filter((o) => `${o.value} ${o.description ?? ""}`.toLowerCase().includes(n));
    // Keys starting with the text first, then other matches.
    return [...hits.filter((o) => o.value.toLowerCase().startsWith(n)), ...hits.filter((o) => !o.value.toLowerCase().startsWith(n))];
  }, [options, q]);

  const show = () => {
    if (!options.length) return;
    setOpen(true);
    setActive(Math.max(0, shown.findIndex((o) => o.value === value)));
  };
  const close = () => {
    setOpen(false);
    setTyped(false);
  };
  const choose = (o: ComboOption) => {
    onChange(o.value);
    onPick?.(o);
    close();
  };
  const scrollTo = (i: number) => list.current?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" });

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return show();
      if (!shown.length) return;
      const next = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      setActive(next);
      scrollTo(next);
    } else if (e.key === "Enter" && open && shown[active]) {
      e.preventDefault(); // don't submit the form while choosing
      choose(shown[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation(); // keep the dialog open
      close();
    } else if (e.key === "Tab") {
      close();
    }
  };

  return (
    <div ref={wrap} className={cn("relative min-w-0", wrapClassName)}>
      <Input
        ref={input}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(true);
          setActive(0);
          if (!open && options.length) setOpen(true);
        }}
        onFocus={show}
        onClick={() => !open && show()}
        onBlur={close}
        onKeyDown={onKey}
        className={cn(options.length > 0 && "pr-8", mono && "font-mono text-[13px]", invalid && "border-led-red", className)}
      />
      {options.length > 0 && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={tr("Show suggestions")}
          onMouseDown={(e) => {
            e.preventDefault(); // keep focus in the input
            if (open) close();
            else {
              input.current?.focus();
              show();
            }
          }}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-ink"
        >
          <Icon name="chevrons-up-down" className="size-3.5" />
        </button>
      )}
      <Floating anchor={wrap.current} open={open} onClose={close} matchWidth minWidth={260} maxHeight={300}>
        <ul ref={list} id={listId} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {shown.length === 0 && <li className="px-3 py-3 text-center text-sm text-muted">{emptyText}</li>}
          {shown.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              data-index={i}
              // mousedown, not click: the input must not blur (and close the list) first.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
              onMouseMove={() => active !== i && setActive(i)}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                i === active && "bg-surface",
                o.value === value && "text-cable",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate", mono && "font-mono text-[13px]")}>{highlight(o.value, q)}</span>
                {o.description && <span className="block truncate text-xs text-muted">{highlight(o.description, q)}</span>}
              </span>
              {o.meta && <span className="shrink-0 text-xs text-muted">{o.meta}</span>}
              {o.value === value && <Icon name="check" className="size-4 shrink-0 text-cable" />}
            </li>
          ))}
        </ul>
      </Floating>
    </div>
  );
}
