import { type FormEvent, type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button, ErrorNotice, Icon } from "./ui";
import { tr } from "@/lib/i18n";

/**
 * Modal dialog on the native <dialog> element (focus trap, Esc, inert background).
 * When `onSubmit` is given the body is a form, so Enter submits.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  onSubmit,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onSubmit?: () => void;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const Body = onSubmit ? "form" : "div";
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-xl border border-line bg-panel p-0 text-ink shadow-2xl shadow-black/30",
        "backdrop:bg-rack/55 backdrop:backdrop-blur-[2px]",
        size === "sm" && "max-w-md",
        size === "md" && "max-w-lg",
        size === "lg" && "max-w-2xl",
        size === "xl" && "max-w-5xl",
      )}
    >
      {open && (
        <Body
          onSubmit={
            onSubmit
              ? (e: FormEvent) => {
                  e.preventDefault();
                  onSubmit();
                }
              : undefined
          }
        >
          <div className="flex items-start gap-4 px-6 pt-5">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
              {description && <div className="mt-1 text-sm text-muted">{description}</div>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={tr("Close")}
              className="-mr-2 rounded-md p-1.5 text-muted hover:bg-ink/5 hover:text-ink"
            >
              <Icon name="x" />
            </button>
          </div>
          {children && (
            <div className={cn("space-y-4 overflow-y-auto px-6 py-5", size === "xl" ? "max-h-[78vh]" : "max-h-[65vh]")}>
              {children}
            </div>
          )}
          {footer && (
            <div className="flex justify-end gap-2 border-t border-line bg-surface/50 px-6 py-3.5">{footer}</div>
          )}
        </Body>
      )}
    </dialog>
  );
}

/** Confirmation for destructive or irreversible actions. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  onConfirm,
  busy,
  error,
  danger = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  error?: unknown;
  danger?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      onSubmit={onConfirm}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} busy={busy} autoFocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm">{children}</div>
      <ErrorNotice error={error} />
    </Dialog>
  );
}
