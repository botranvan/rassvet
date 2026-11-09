import { type FormEvent, useState } from "react";
import { Button, ErrorNotice, Field, Input } from "@/components/ui";
import { tr } from "@/lib/i18n";
import { CloudField, useCloudChoice } from "./CloudField";
import type { PlatformSignInProps } from "./types";

/**
 * User name + password sign-in, for platforms that sign in with nothing else (vCenter, ESXi,
 * SDDC Manager). The server sends it to the platform's own client.
 */
export function UserPasswordForm({
  clouds,
  mutation,
  error,
  submitLabel,
  onCloudChange,
  icon,
  userPlaceholder,
  userHint,
}: PlatformSignInProps & { icon: string; userPlaceholder: string; userHint?: string }) {
  const { selected, setCloud } = useCloudChoice(clouds, onCloudChange);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    mutation.mutate({ method: "password", cloud: selected.id, username, password });
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <CloudField list={clouds} selected={selected} onChange={setCloud} icon={icon} />
      <Field label={tr("Username")} hint={userHint}>
        {(id) => (
          <Input
            id={id}
            required
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={userPlaceholder}
            autoComplete="username"
            spellCheck={false}
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
      <ErrorNotice error={mutation.error ?? error} />
      <Button type="submit" variant="primary" busy={mutation.isPending} disabled={!selected} className="h-10 w-full">
        {submitLabel}
      </Button>
    </form>
  );
}
