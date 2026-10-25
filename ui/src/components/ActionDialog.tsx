import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { type Svc, useInvalidate } from "@/lib/os";
import { Dialog } from "./Dialog";
import { useToast } from "./Toast";
import { Button, ErrorNotice } from "./ui";
import { tr } from "@/lib/i18n";

/**
 * A dialog that runs one operation: submit button with spinner, error shown in place,
 * toast and cache refresh on success, then closes. Used by the resource action menus.
 */
export function ActionDialog<R = unknown>({
  open = true,
  onClose,
  title,
  description,
  submitLabel,
  run,
  done,
  refresh = [],
  canSubmit = true,
  danger,
  size = "sm",
  children,
  onDone,
}: {
  open?: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  run: () => Promise<R>;
  /** Toast text after success (or a function of the result). */
  done?: string | ((r: R) => string);
  /** Services whose cached lists are refreshed afterwards. */
  refresh?: Svc[];
  canSubmit?: boolean;
  danger?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
  children?: ReactNode;
  onDone?: (r: R) => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const m = useMutation({
    mutationFn: run,
    onSuccess: (r) => {
      if (done) toast(typeof done === "function" ? done(r) : done);
      invalidate(...refresh);
      onDone?.(r);
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size={size}
      title={title}
      description={description}
      onSubmit={() => canSubmit && m.mutate()}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} busy={m.isPending} disabled={!canSubmit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      {children}
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}
