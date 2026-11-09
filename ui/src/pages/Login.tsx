import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { ErrorNotice, Icon } from "@/components/ui";
import { type CloudInfo, type Platform, useClouds, useLogin, useServerVersion } from "@/lib/session";
import { useDocumentTitle } from "@/lib/title";
import { cn } from "@/lib/utils";
import { LanguagePicker } from "@/components/LanguagePicker";
import { tr, trx } from "@/lib/i18n";
import { PLATFORMS, platformInfo } from "@/platforms";
import { PlatformPicker } from "@/platforms/PlatformPicker";
import type { PlatformSignInProps } from "@/platforms/types";
import OpenStackSignInForm from "@/platforms/openstack/SignInForm";
import VsphereSignInForm from "@/platforms/vsphere/SignInForm";
import VcfSignInForm from "@/platforms/vcf/SignInForm";

export default function Login() {
  const clouds = useClouds();
  const version = useServerVersion();
  const login = useLogin();
  // Before sign-in, the title is the cloud picked in the form.
  const [picked, setPicked] = useState<CloudInfo | undefined>();
  useDocumentTitle(picked?.name);

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
            onCloudChange={setPicked}
            intro={(selected, platform) => (
              <p className="mt-1 text-sm text-muted">
                {platform
                  ? trx("Use your {platform} account{v}.", {
                      platform: platformInfo(platform).label,
                      v: selected ? tr(" on {name}", { name: selected.name }) : "",
                    })
                  : tr("Choose the kind of cloud to sign in to.")}
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
 * Sign-in in two steps: the cloud platform (OpenStack, vCenter, ESXi, VCF; skipped when only
 * one is configured), then that platform's own form (`platforms/<platform>/SignInForm.tsx`).
 * Used by the sign-in page and by "Sign in to another cloud" (`mutation` is then
 * `useAddCloud`), so both work the same way.
 */
export function SignInForm({
  clouds: list,
  mutation,
  error,
  intro,
  submitLabel = tr("Sign in"),
  onCloudChange,
}: {
  clouds: CloudInfo[];
  mutation: PlatformSignInProps["mutation"] & { reset?: () => void };
  error?: Error | null;
  intro?: (selected: CloudInfo | undefined, platform: Platform | undefined) => ReactNode;
  submitLabel?: string;
  /** Told which cloud is picked (the sign-in page shows it as the tab's title). */
  onCloudChange?: (cloud: CloudInfo | undefined) => void;
}) {
  const offered = PLATFORMS.filter((p) => list.some((c) => c.platform === p.id));
  const [chosen, setChosen] = useState<Platform | undefined>();
  const platform = chosen ?? (offered.length === 1 ? offered[0].id : undefined);
  const [picked, setPicked] = useState<CloudInfo | undefined>();
  const pick = (c: CloudInfo | undefined) => {
    setPicked(c);
    onCloudChange?.(c);
  };
  useEffect(() => {
    if (!platform) pick(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);
  /** Another platform: the previous one's error doesn't apply. */
  const choose = (p: Platform | undefined) => {
    mutation.reset?.();
    setChosen(p);
  };

  const props: PlatformSignInProps = {
    clouds: list.filter((c) => c.platform === platform),
    mutation,
    error,
    submitLabel,
    onCloudChange: pick,
  };
  const info = platform && platformInfo(platform);

  return (
    <>
      {intro?.(platform ? picked : undefined, platform)}

      {!platform || !info ? (
        <div className={cn(intro && "mt-7")}>
          <p className="mb-3 text-sm font-medium">{tr("Cloud platform")}</p>
          {offered.length > 0 ? (
            <PlatformPicker clouds={list} onPick={choose} />
          ) : (
            !error && <p className="text-sm text-muted">{tr("Loading…")}</p>
          )}
          <ErrorNotice error={error} className="mt-4" />
        </div>
      ) : (
        <>
          {offered.length > 1 && (
            <button
              type="button"
              onClick={() => choose(undefined)}
              className={cn(
                "inline-flex max-w-full items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-sm hover:border-cable/50 hover:bg-surface",
                intro && "mt-6",
              )}
              title={tr("Choose another cloud platform")}
            >
              <Icon name="arrow-left" className="size-4 shrink-0 text-muted" />
              <Icon name={info.icon} className="size-4 shrink-0 text-muted" />
              <span className="truncate font-medium">{info.label}</span>
              <span className="shrink-0 text-muted">· {tr("Change")}</span>
            </button>
          )}
          {platform === "openstack" ? (
            <OpenStackSignInForm key={platform} {...props} />
          ) : platform === "vcf" ? (
            <VcfSignInForm key={platform} {...props} />
          ) : (
            <VsphereSignInForm key={platform} {...props} platform={platform} />
          )}
        </>
      )}
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
          {tr("Run your OpenStack and VMware clouds from one place.")}
        </p>
        <p className="mt-3 text-sm text-rack-dim">
          {tr("OpenStack, VMware vCenter, ESXi and VMware Cloud Foundation: sign in to each and switch between them without signing in again.")}
        </p>
      </div>
    </aside>
  );
}
