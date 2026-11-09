import { type FormEvent, useEffect, useState } from "react";
import { Button, ErrorNotice, Field, Input } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { tr } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CloudField, useCloudChoice } from "../CloudField";
import type { PlatformSignInProps } from "../types";

type Method = "password" | "application_credential";

/**
 * OpenStack: Keystone password (with TOTP when the account's rules ask for it) or an
 * application credential. Server side: `crates/clients/openstack`.
 */
export default function OpenStackSignInForm({ clouds: list, mutation, error, submitLabel, onCloudChange }: PlatformSignInProps) {
  const [method, setMethod] = useState<Method>("password");
  const { selected, setCloud } = useCloudChoice(list, onCloudChange);
  const [domain, setDomain] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [credId, setCredId] = useState("");
  const [credSecret, setCredSecret] = useState("");
  // Two-factor accounts: Keystone wants a TOTP code with the password (asked for by the server).
  const [totp, setTotp] = useState("");
  const [askTotp, setAskTotp] = useState(false);

  const errorCode = mutation.error instanceof ApiError ? mutation.error.code : null;
  useEffect(() => {
    if (errorCode === "totp_required" || errorCode === "totp_invalid") setAskTotp(true);
    // A refused code can't be used again: clear it for the next one.
    if (errorCode === "totp_invalid") setTotp("");
  }, [mutation.error, errorCode]);

  /** Another account or cloud: the code asked for belonged to the previous one. */
  const resetTotp = () => {
    setAskTotp(false);
    setTotp("");
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    mutation.mutate(
      method === "password"
        ? {
            method,
            cloud: selected.id,
            domain: domain || undefined,
            username,
            password,
            totp: askTotp && totp.trim() ? totp.replace(/\s/g, "") : undefined,
          }
        : { method, cloud: selected.id, id: credId, secret: credSecret },
    );
  }

  return (
    <>
      <div role="tablist" className="mt-6 grid grid-cols-2 rounded-lg bg-ink/5 p-1 text-sm">
        {(
          [
            ["password", tr("Password")],
            ["application_credential", tr("App credential")],
          ] as [Method, string][]
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={method === m}
            onClick={() => {
              setMethod(m);
              resetTotp();
            }}
            className={cn(
              "rounded-md px-3 py-1.5 font-medium text-muted transition-colors",
              method === m && "bg-panel text-ink shadow-sm",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="mt-6 space-y-4">
        <CloudField
          list={list}
          selected={selected}
          icon="cloud"
          onChange={(v) => {
            setCloud(v);
            resetTotp();
          }}
        />

        {method === "password" ? (
          <>
            <Field label={tr("Domain")}>
              {(id) => (
                <Input
                  id={id}
                  value={domain}
                  onChange={(e) => {
                    setDomain(e.target.value);
                    resetTotp();
                  }}
                  placeholder={selected?.default_domain ?? tr("Default")}
                  autoComplete="organization"
                />
              )}
            </Field>
            <Field label={tr("Username")}>
              {(id) => (
                <Input
                  id={id}
                  required
                  autoFocus
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    resetTotp();
                  }}
                  autoComplete="username"
                />
              )}
            </Field>
            <Field label={tr("Password")}>
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              )}
            </Field>
            {askTotp && (
              <Field
                label={tr("Authentication code")}
                hint={tr("Your account uses two-step verification: enter the code shown by your authenticator app.")}
              >
                {(id) => (
                  <Input
                    id={id}
                    required
                    autoFocus
                    value={totp}
                    onChange={(e) => setTotp(e.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9 ]{4,12}"
                    maxLength={12}
                    placeholder="123456"
                    className="font-mono tracking-widest"
                  />
                )}
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label={tr("Credential ID")}>
              {(id) => (
                <Input
                  id={id}
                  required
                  value={credId}
                  onChange={(e) => setCredId(e.target.value)}
                  className="font-mono text-[13px]"
                  spellCheck={false}
                />
              )}
            </Field>
            <Field label={tr("Secret")} hint={tr("Application credentials are bound to a single project.")}>
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  required
                  value={credSecret}
                  onChange={(e) => setCredSecret(e.target.value)}
                  autoComplete="off"
                />
              )}
            </Field>
          </>
        )}

        {/* "Enter the code" is a step, not an error: the code field's hint says it. */}
        <ErrorNotice
          error={
            errorCode === "totp_required"
              ? error
              : errorCode === "totp_invalid"
                ? new Error(tr("The password or the authentication code was not accepted. Wait for a new code and try again."))
                : (mutation.error ?? error)
          }
        />

        <Button
          type="submit"
          variant="primary"
          busy={mutation.isPending}
          disabled={!selected}
          className="h-10 w-full"
        >
          {submitLabel}
        </Button>
      </form>
    </>
  );
}
