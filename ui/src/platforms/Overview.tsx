import { Button, Card, Detail, ErrorNotice, Icon, PageHeader } from "@/components/ui";
import { locale, tr } from "@/lib/i18n";
import { type SessionInfo, usePlatformSummary } from "@/lib/session";
import { platformInfo } from ".";

/** Home page of a vCenter, ESXi or VCF cloud: what it is and how much it holds. */
export default function PlatformOverview({ session }: { session: SessionInfo }) {
  const summary = usePlatformSummary(session);
  const info = platformInfo(session.platform);
  const data = summary.data;
  const expires = new Date(session.expires_at);

  return (
    <>
      <PageHeader
        title={session.cloud.name}
        description={tr("Signed in as {user} on {cloud} ({platform}).", {
          user: session.user.name,
          cloud: session.cloud.name,
          platform: info.label,
        })}
        actions={
          <Button onClick={() => summary.refetch()} busy={summary.isFetching}>
            <Icon name="refresh" className="size-4" />
            {tr("Refresh")}
          </Button>
        }
      />

      <ErrorNotice error={summary.error} className="mb-6" />

      {data && data.stats.length > 0 && (
        <section className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.stats.map((s) => (
            <div key={s.id} className="rounded-lg border border-line bg-panel px-5 py-4">
              <p className="text-sm text-muted">{tr(s.label)}</p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">{s.value.toLocaleString(locale)}</p>
              {s.detail && <p className="mt-1 truncate text-xs text-muted" title={s.detail}>{s.detail}</p>}
            </div>
          ))}
        </section>
      )}

      {summary.isPending && <p className="mb-6 text-sm text-muted">{tr("Loading…")}</p>}

      <section className="grid items-start gap-6 lg:grid-cols-[2fr_1fr]">
        <Card title={tr("Endpoint")}>
          <dl>
            <Detail label={tr("Platform")}>
              <span className="inline-flex items-center gap-2">
                <Icon name={info.icon} className="size-4 text-muted" />
                {info.label}
              </span>
            </Detail>
            <Detail label={tr("Product")}>{data?.product?.name ?? "—"}</Detail>
            <Detail label={tr("Version")}>{data?.product?.version ?? "—"}</Detail>
            <Detail label={tr("Build")}>{data?.product?.build ?? "—"}</Detail>
          </dl>
        </Card>

        <Card title={tr("Session")}>
          <dl>
            <Detail label={tr("User")}>{session.user.name}</Detail>
            <Detail label={tr("Signed in until")}>
              {expires.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
            </Detail>
          </dl>
        </Card>
      </section>

      {data && (data.warnings.length > 0 || data.notes.length > 0) && (
        <ul className="mt-6 space-y-2 text-sm">
          {data.warnings.map((w) => (
            <li key={w} className="flex gap-2 rounded-md border border-led-amber/40 bg-led-amber/10 px-3 py-2">
              <Icon name="warning" className="mt-0.5 size-4 shrink-0 text-[#9a6412] dark:text-led-amber" />
              <span className="min-w-0 break-words">{w}</span>
            </li>
          ))}
          {data.notes.map((n) => (
            <li key={n} className="flex gap-2 rounded-md border border-line bg-surface px-3 py-2 text-muted">
              <Icon name="info" className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
