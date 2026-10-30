import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { Picker } from "@/components/Picker";
import { Button, ErrorNotice, Field, Input } from "@/components/ui";
import { type CloudInfo, type LoginRequest, useClouds, useLogin, useServerVersion } from "@/lib/session";
import { cn } from "@/lib/utils";
import { LanguagePicker } from "@/components/LanguagePicker";
import { tr, trx } from "@/lib/i18n";

type Method = "password" | "application_credential";

export default function Login() {
  const clouds = useClouds();
  const version = useServerVersion();
  const login = useLogin();

  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(0,1.1fr)_minmax(420px,1fr)]">
      <RackPanel />

      <main className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Wordmark className="text-ink" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{tr("Sign in")}</h1>
          <SignInForm
            clouds={clouds.data ?? []}
            mutation={login}
            error={clouds.error}
            intro={(selected) => (
              <p className="mt-1 text-sm text-muted">
                {trx("Use your OpenStack account{v}.", { v: selected ? tr(" on {name}", { name: selected.name }) : "" })}
              </p>
            )}
          />
          <LanguagePicker className="mx-auto mt-8 max-w-60" />
          {version.data && <p className="mt-4 text-center font-mono text-xs text-muted">rassvet v{version.data}</p>}
        </div>
      </main>
    </div>
  );
}

/**
 * Cloud, method and credentials. Used by the sign-in page and by "Sign in to another cloud"
 * (`mutation` is then `useAddCloud`), so both work the same way.
 */
export function SignInForm({
  clouds: list,
  mutation,
  error,
  intro,
  submitLabel = tr("Sign in"),
}: {
  clouds: CloudInfo[];
  mutation: { mutate: (req: LoginRequest) => void; isPending: boolean; error: Error | null };
  error?: Error | null;
  intro?: (selected: CloudInfo | undefined) => ReactNode;
  submitLabel?: string;
}) {
  const [method, setMethod] = useState<Method>("password");
  const [cloud, setCloud] = useState("");
  const [domain, setDomain] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [credId, setCredId] = useState("");
  const [credSecret, setCredSecret] = useState("");

  const selected = list.find((c) => c.id === cloud) ?? list[0];
  useEffect(() => {
    if (!cloud && list[0]) setCloud(list[0].id);
  }, [cloud, list]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    mutation.mutate(
      method === "password"
        ? { method, cloud: selected.id, domain: domain || undefined, username, password }
        : { method, cloud: selected.id, id: credId, secret: credSecret },
    );
  }

  return (
    <>
      {intro?.(selected)}

      <div role="tablist" className={cn("grid grid-cols-2 rounded-lg bg-ink/5 p-1 text-sm", intro && "mt-7")}>
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
            onClick={() => setMethod(m)}
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
        {list.length > 1 && (
          <Field label={tr("Cloud")}>
            {(id) => (
              <Picker id={id} value={selected?.id ?? ""} onChange={setCloud} options={list.map((c) => ({ value: c.id, label: c.name, icon: "server" }))} />
            )}
          </Field>
        )}

        {method === "password" ? (
          <>
            <Field label={tr("Domain")}>
              {(id) => (
                <Input
                  id={id}
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
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
                  onChange={(e) => setUsername(e.target.value)}
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

        <ErrorNotice error={mutation.error ?? error} />

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

export function Wordmark({ className, textClassName }: { className?: string; textClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 text-lg font-semibold tracking-tight", className)}>
      <img src="/logo.svg" alt="" className="size-7" />
      <span className={textClassName}>rassvet</span>
    </span>
  );
}

/* ------------------------------------------------------------------ rack */

const UNITS = 14;
const LEDS = 6;

/** Deterministic pseudo-random so the rack looks the same on every visit. */
function rand(seed: number) {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function RackPanel() {
  const units = useMemo(
    () =>
      Array.from({ length: UNITS }, (_, u) => ({
        bays: 4 + Math.floor(rand(u + 1) * 5),
        tall: rand(u + 50) > 0.8,
        leds: Array.from({ length: LEDS }, (_, l) => {
          const r = rand(u * 31 + l + 7);
          return {
            color: r > 0.93 ? "bg-led-amber" : r > 0.2 ? "bg-cable-bright" : "bg-rack-line",
            blink: r > 0.62 && r <= 0.93,
            speed: 0.9 + rand(u * 13 + l) * 2.4,
            delay: (u * 70 + l * 25) / 1000,
          };
        }),
      })),
    [],
  );

  return (
    <aside className="relative hidden overflow-hidden bg-rack text-rack-ink lg:flex lg:flex-col">
      <div className="relative z-10 p-10">
        <Wordmark className="text-white" />
      </div>

      <div className="flex flex-1 items-center justify-center px-10">
        <div className="w-full max-w-[520px] rounded-xl border border-rack-line bg-rack-2 p-3 shadow-2xl shadow-black/40">
          <div className="space-y-1.5">
            {units.map((unit, u) => (
              <div
                key={u}
                className={cn(
                  "flex items-center gap-3 rounded-[5px] border border-rack-line bg-rack px-3",
                  unit.tall ? "h-12" : "h-7",
                )}
              >
                <span className="w-5 text-right font-mono text-[10px] text-rack-dim/70 tabular-nums">
                  {UNITS - u}
                </span>
                <div className="flex flex-1 gap-1">
                  {Array.from({ length: unit.bays }, (_, b) => (
                    <span key={b} className="h-2.5 flex-1 rounded-[2px] bg-rack-line/70" />
                  ))}
                </div>
                <div className="flex gap-1.5">
                  {unit.leds.map((led, l) => (
                    <span
                      key={l}
                      className={cn("size-1.5 rounded-full", led.color, led.blink ? "led-blink" : "led")}
                      style={
                        {
                          animationDelay: led.blink
                            ? `${led.delay}s, ${led.delay + 1.4}s`
                            : `${led.delay}s`,
                          "--blink": `${led.speed}s`,
                        } as CSSProperties
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="relative z-10 max-w-md p-10">
        <p className="text-2xl leading-snug font-medium text-white">
          {tr("Run your OpenStack cloud from one place.")}
        </p>
        <p className="mt-3 text-sm text-rack-dim">
          {tr("Compute, images, networks, volumes and secrets across every project and region you have access to.")}
        </p>
      </div>
    </aside>
  );
}
