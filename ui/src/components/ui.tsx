import {
  type ButtonHTMLAttributes,
  type TextareaHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  forwardRef,
  useId,
  useRef,
  useState,
} from "react";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Floating } from "./Floating";
import { lookupIcon } from "./icons";
import { tr } from "@/lib/i18n";

// ---------------------------------------------------------------- Button

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean }
>(function Button({ variant = "secondary", busy, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || busy}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-medium",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-55",
        variant === "primary" && "bg-cable text-white hover:brightness-110",
        variant === "secondary" && "border border-line bg-panel hover:bg-surface",
        variant === "ghost" && "hover:bg-ink/5",
        variant === "danger" && "bg-led-red text-white hover:brightness-110",
        className,
      )}
      {...rest}
    >
      {busy && (
        <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
      )}
      {children}
    </button>
  );
});

// ---------------------------------------------------------------- Form fields

const fieldBase =
  "h-10 w-full rounded-md border border-line bg-panel px-3 text-sm text-ink placeholder:text-muted/70 " +
  "focus:border-cable focus:outline-none focus:ring-3 focus:ring-cable/15";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(fieldBase, className)} {...rest} />;
  },
);

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldBase, "pr-8", className)} {...rest} />;
}

// ---------------------------------------------------------------- Icon

/** Renders a lucide icon by kebab-case name (as sent in nav items). */
export function Icon({ name, className }: { name: string; className?: string }) {
  const C = lookupIcon(name);
  return <C aria-hidden className={cn("size-4 shrink-0", className)} />;
}

// ---------------------------------------------------------------- Status

export type Status = "ok" | "warn" | "error" | "off";

/** A status LED. Use only for real resource state. */
export function StatusDot({ status, label }: { status: Status; label?: string }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-2">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          status === "ok" && "bg-led-green shadow-[0_0_6px] shadow-led-green/60",
          status === "warn" && "bg-led-amber shadow-[0_0_6px] shadow-led-amber/60",
          status === "error" && "bg-led-red shadow-[0_0_6px] shadow-led-red/60",
          status === "off" && "bg-muted/40",
        )}
      />
      {label && (
        <span className="truncate" title={tr(label)}>
          {tr(label)}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- Errors

export function ErrorNotice({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <div
      role="alert"
      className={cn(
        "rounded-md border border-led-red/30 bg-led-red/8 px-3 py-2.5 text-sm",
        className,
      )}
    >
      <p>{message}</p>
      {requestId && (
        <p className="mt-1 text-xs text-muted">
          {tr("Request ID")}{" "}<code className="font-mono select-all">{requestId}</code>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Page layout

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 flex-1 basis-80">
        <h1 className="truncate text-2xl font-semibold tracking-tight" title={title}>
          {title}
        </h1>
        {description && (
          // Page descriptions explain the page, so they wrap instead of being cut with "…".
          <p className="mt-1 max-w-[100ch] text-sm text-pretty break-words text-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Popover menu

export function Popover({
  trigger,
  children,
  align = "end",
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      <Floating anchor={ref.current} open={open} onClose={() => setOpen(false)} align={align} maxHeight={520}>
        <div className={cn("overflow-y-auto p-1", className)}>{children(() => setOpen(false))}</div>
      </Floating>
    </div>
  );
}

export function MenuItem({
  active,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-surface [&>span]:truncate",
        active && "text-cable font-medium",
        className,
      )}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------- More form controls

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, "h-auto min-h-20 py-2", className)} {...rest} />;
}

/** On/off switch with a visible label (role="switch"). */
export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
          checked ? "bg-cable" : "bg-ink/20",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform",
            checked && "translate-x-4",
          )}
        />
      </button>
      <label htmlFor={id} className="text-sm">
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </label>
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex items-center gap-2.5 text-sm", disabled ? "opacity-50" : "cursor-pointer")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 rounded border-line accent-cable"
      />
      {children}
    </label>
  );
}

// ---------------------------------------------------------------- Display

export function Badge({
  children,
  tone = "neutral",
  onRemove,
  removeLabel,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "warn";
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-56 items-center gap-1 rounded-md px-2 text-xs font-medium",
        tone === "neutral" && "bg-ink/6 text-ink",
        tone === "accent" && "bg-cable-soft text-cable",
        tone === "warn" && "bg-led-amber/15 text-[#9a6412] dark:text-led-amber",
      )}
    >
      <span className="truncate" title={typeof children === "string" ? children : undefined}>
        {children}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? tr("Remove")}
          className="-mr-1 rounded p-0.5 opacity-60 hover:bg-ink/10 hover:opacity-100"
        >
          <Icon name="x" className="size-3" />
        </button>
      )}
    </span>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No body padding (for tables and lists that draw their own rows). */
  flush?: boolean;
}) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-line bg-panel", className)}>
      {(title || actions) && (
        <div className="flex min-h-12 items-center gap-3 border-b border-line px-5 py-2.5">
          {title && (
            <h2 className="min-w-0 truncate text-sm font-semibold" title={typeof title === "string" ? title : undefined}>
              {title}
            </h2>
          )}
          {actions && <div className="ml-auto flex gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn(!flush && "px-5 py-4")}>{children}</div>
    </section>
  );
}

/** Label/value rows for detail pages. Long values are cut with "…" unless `wrap`. */
export function Detail({ label, children, wrap }: { label: string; children: ReactNode; wrap?: boolean }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-4 border-b border-line py-2.5 text-sm last:border-0">
      <dt className="truncate text-muted">{label}</dt>
      <dd
        className={cn("min-w-0", wrap ? "break-words" : "truncate")}
        title={!wrap && (typeof children === "string" || typeof children === "number") ? String(children) : undefined}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * Text that never wraps: cut with "…" and shown in full on hover.
 * The default for names, descriptions and other user-supplied text.
 */
export function Ellipsis({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      className={cn("block min-w-0 truncate", className)}
      title={title ?? (typeof children === "string" || typeof children === "number" ? String(children) : undefined)}
    >
      {children}
    </span>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { id: T; label: string }[];
  className?: string;
}) {
  return (
    // The base line is an inset shadow rather than a border so the active tab's underline can cover it without
    // overflowing the container — overflow-x-auto would otherwise make that 1px overflow scroll vertically.
    <div
      role="tablist"
      className={cn("flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--color-line)]", className)}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap text-muted hover:text-ink",
            value === t.id ? "border-cable text-ink" : "border-transparent",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Monospace id with click-to-select, for UUIDs. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn("font-mono text-[12.5px] select-all", className)}>{children}</code>;
}
