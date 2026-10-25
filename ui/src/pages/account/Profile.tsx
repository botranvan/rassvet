/** The signed-in user's own account: Keystone record, session, projects and roles. */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/components/Link";
import { Badge, Card, Detail, ErrorNotice, Icon, Mono, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDate, isPast } from "@/lib/format";
import { age } from "@/lib/os";
import { useSession } from "@/lib/session";
import { tr } from "@/lib/i18n";

interface Me {
  id: string;
  name: string;
  domain_id?: string | null;
  email?: string | null;
  description?: string | null;
  enabled?: boolean;
  default_project_id?: string | null;
  password_expires_at?: string | null;
  options?: Record<string, unknown>;
  [k: string]: unknown;
}

export default function Profile() {
  const session = useSession().data!;
  const me = useQuery({ queryKey: ["identity", "me"], queryFn: () => api.get<{ user: Me; partial?: boolean }>("/identity/me") });
  const u = me.data?.user;
  const projectName = (id?: string | null) => (id ? (session.projects.find((p) => p.id === id)?.name ?? id) : "");
  const extras = Object.entries(u ?? {}).filter(
    ([k, v]) => !["id", "name", "domain_id", "email", "description", "enabled", "default_project_id", "password_expires_at", "options", "links"].includes(k) && (typeof v === "string" || typeof v === "number"),
  );
  return (
    <>
      <PageHeader title={tr("My profile")} description={tr("Your OpenStack account as Keystone knows it. Ask a cloud administrator to change your name, email or project access.")} />
      <ErrorNotice error={me.error} className="mb-4" />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card title={tr("Account")}>
          <dl>
            <Detail label={tr("User name")}>{u?.name ?? session.user.name}</Detail>
            <Detail label="ID">
              <Mono>{u?.id ?? session.user.id}</Mono>
            </Detail>
            <Detail label={tr("Domain")}>{session.user.domain?.name ?? u?.domain_id ?? "—"}</Detail>
            <Detail label={tr("Email")}>{u?.email || <span className="text-muted">{tr("Not set")}</span>}</Detail>
            <Detail label={tr("Description")} wrap>
              {u?.description || <span className="text-muted">—</span>}
            </Detail>
            {extras.map(([k, v]) => (
              <Detail key={k} label={k}>
                {String(v)}
              </Detail>
            ))}
            <Detail label={tr("Default project")}>{u?.default_project_id ? projectName(u.default_project_id) : <span className="text-muted">{tr("None")}</span>}</Detail>
            {u?.enabled !== undefined && <Detail label={tr("Status")}>{u.enabled ? tr("Enabled") : tr("Disabled")}</Detail>}
            <Detail label={tr("Password expires")}>
              {u?.password_expires_at ? (
                <span className={isPast(u.password_expires_at) ? "text-led-red" : ""}>{fmtDate(u.password_expires_at)}</span>
              ) : (
                <span className="text-muted">{tr("Never")}</span>
              )}
            </Detail>
          </dl>
          {me.data?.partial && <p className="mt-3 text-xs text-muted">{tr("Keystone's policy doesn't let you read your full record; showing what the sign-in token says.")}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/account/password" className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-panel px-3.5 text-sm font-medium hover:bg-surface">
              <Icon name="key" />
              {tr("Change password")}
            </Link>
            <Link to="/identity/application-credentials" className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-panel px-3.5 text-sm font-medium hover:bg-surface">
              <Icon name="key-square" />
              {tr("Application credentials")}
            </Link>
            <Link to="/identity/api-access" className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-panel px-3.5 text-sm font-medium hover:bg-surface">
              <Icon name="terminal" />
              {tr("API access")}
            </Link>
          </div>
        </Card>
        <div className="space-y-6">
          <Card title={tr("This session")}>
            <dl>
              <Detail label={tr("Cloud")}>{session.cloud.name}</Detail>
              <Detail label={tr("Project")}>{session.project?.name ?? "—"}</Detail>
              <Detail label={tr("Region")}>{session.region ?? "—"}</Detail>
              <Detail label={tr("Roles")} wrap>
                <span className="flex flex-wrap gap-1">
                  {session.roles.map((r) => (
                    <Badge key={r.id} tone={r.name === "admin" ? "warn" : "accent"}>
                      {r.name}
                    </Badge>
                  ))}
                </span>
              </Detail>
              <Detail label={tr("Token expires")}>
                {fmtDate(session.expires_at)} <span className="text-muted">({tr("in {v}", { v: age(new Date(2 * Date.now() - new Date(session.expires_at).getTime()).toISOString()) })})</span>
              </Detail>
            </dl>
          </Card>
          <Card flush title={tr("Projects ({n})", { n: session.projects.length })}>
            <ul>
              {session.projects.map((p) => (
                <li key={p.id} className="flex items-center gap-3 border-b border-line px-5 py-2.5 text-sm last:border-0">
                  <Icon name="folder" className="text-muted" />
                  <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                  {p.domain?.name && <span className="text-xs text-muted">{p.domain.name}</span>}
                  {p.id === session.project?.id && <Badge tone="accent">{tr("current")}</Badge>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
