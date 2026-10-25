import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "@/components/Toast";
import { Button, Card, ErrorNotice, Field, Input, PageHeader } from "@/components/ui";
import { useChangePassword } from "@/lib/identity";
import { useSession } from "@/lib/session";
import { tr } from "@/lib/i18n";

export default function ChangePassword() {
  const session = useSession().data!;
  const change = useChangePassword();
  const qc = useQueryClient();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && next !== confirm;

  return (
    <>
      <PageHeader
        title={tr("Change password")}
        description={tr("For {name}{v}. You'll be signed out everywhere and asked to sign in again.", { name: session.user.name, v: session.user.domain ? tr(" in domain {name}", { name: session.user.domain.name }) : "" })}
      />
      <Card className="max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (mismatch) return;
            change.mutate(
              { original_password: current, password: next },
              {
                onSuccess: () => {
                  qc.setQueryData(["session"], null);
                  toast(tr("Password changed. Sign in with your new password."));
                },
              },
            );
          }}
        >
          <Field label={tr("Current password")}>
            {(id) => (
              <Input id={id} type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            )}
          </Field>
          <Field label={tr("New password")} hint={tr("Your cloud's password rules apply; Keystone explains what's missing if it rejects it.")}>
            {(id) => (
              <Input id={id} type="password" required autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            )}
          </Field>
          <Field label={tr("Confirm new password")} hint={mismatch ? <span className="text-led-red">{tr("The passwords don't match.")}</span> : undefined}>
            {(id) => (
              <Input
                id={id}
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                aria-invalid={mismatch}
                onChange={(e) => setConfirm(e.target.value)}
              />
            )}
          </Field>
          <ErrorNotice error={change.error} />
          <Button type="submit" variant="primary" busy={change.isPending} disabled={!current || !next || mismatch}>
            {tr("Change password")}
          </Button>
        </form>
      </Card>
    </>
  );
}
