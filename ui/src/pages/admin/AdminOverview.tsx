import { type ReactNode, useMemo, useState } from "react";
import { Link, useNavigate } from "@/components/Link";
import { Badge, Button, Card, ErrorNotice, Icon, PageHeader } from "@/components/ui";
import { fmtBytes, plural } from "@/lib/format";
import { useAdminCatalog, useDomains, useProjects, useRoles, useUsers } from "@/lib/identity";
import { useImages } from "@/lib/image";
import { useOsList } from "@/lib/os";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { CreateImageDialog } from "../images/ImageDialogs";
import { Meter, totals, useCapacity } from "./compute/Capacity";
import { ProjectDialog } from "./identity/Projects";
import { UserDialog } from "./identity/Users";
import { tr, trx } from "@/lib/i18n";

/** One clickable summary line: icon, label, short context, count on the right. */
function Row({
  to,
  icon,
  label,
  note,
  count,
  tone,
}: {
  to: string;
  icon: string;
  label: string;
  note?: ReactNode;
  count?: number | string;
  tone?: "warn";
}) {
  return (
    <li className="border-b border-line last:border-0">
      <Link to={to} className="flex min-w-0 items-center gap-3 px-5 py-3 hover:bg-surface/60">
        <Icon name={icon} className={cn("text-muted", tone === "warn" && "text-led-amber")} />
        <span className="shrink-0 font-medium">{label}</span>
        {note && <span className="min-w-0 truncate text-sm text-muted">{note}</span>}
        <span
          className={cn(
            "ml-auto shrink-0 pl-2 text-lg font-semibold tabular-nums",
            tone === "warn" && "text-[#9a6412] dark:text-led-amber",
          )}
        >
          {count ?? "…"}
        </span>
      </Link>
    </li>
  );
}

interface SvcState {
  /** Nova / Cinder services */
  state?: "up" | "down";
  status?: "enabled" | "disabled";
  /** Neutron agents */
  alive?: boolean;
  admin_state_up?: boolean;
  binary?: string;
  agent_type?: string;
  host: string;
}

/** Health of the control plane: Nova services, Neutron agents, Cinder services. */
function ServicesCard() {
  const session = useSession().data!;
  const has = (t: string[]) => t.some((x) => session.services.includes(x));
  const nova = useOsList<SvcState>("compute", "os-services", "services", undefined, { enabled: has(["compute"]) });
  const neutron = useOsList<SvcState>("network", "agents", "agents", undefined, { enabled: has(["network"]) });
  const cinder = useOsList<SvcState>("volume", "os-services", "services", undefined, { enabled: has(["block-storage", "volumev3", "volume"]) });
  const sum = (rows: SvcState[] | undefined, isUp: (s: SvcState) => boolean, isOn: (s: SvcState) => boolean, name: (s: SvcState) => string) => {
    if (!rows) return { count: undefined, note: undefined, warn: false };
    const down = rows.filter((s) => isOn(s) && !isUp(s));
    const off = rows.filter((s) => !isOn(s)).length;
    const up = rows.length - down.length - off;
    return {
      count: `${up}/${rows.length}`,
      note: [
        down.length ? tr("{n} down: {list}", { n: down.length, list: down.slice(0, 3).map((s) => `${name(s)}@${s.host}`).join(", ") + (down.length > 3 ? "…" : "") }) : tr("all up"),
        off ? tr("{n} disabled", { n: off }) : null,
      ]
        .filter(Boolean)
        .join(", "),
      warn: down.length > 0,
    };
  };
  const n = sum(nova.data, (s) => s.state === "up", (s) => s.status !== "disabled", (s) => s.binary ?? "");
  const q = sum(neutron.data, (s) => !!s.alive, (s) => s.admin_state_up !== false, (s) => s.agent_type ?? "");
  const c = sum(cinder.data, (s) => s.state === "up", (s) => s.status !== "disabled", (s) => s.binary ?? "");
  return (
    <Card title={tr("Service status")} flush>
      <ErrorNotice error={nova.error ?? neutron.error ?? cinder.error} className="m-4" />
      <ul>
        {has(["compute"]) && <Row to="compute/services" icon="server" label={tr("Compute services")} count={n.count} note={n.note} tone={n.warn ? "warn" : undefined} />}
        {has(["network"]) && <Row to="network/agents" icon="network" label={tr("Network agents")} count={q.count} note={q.note} tone={q.warn ? "warn" : undefined} />}
        {has(["block-storage", "volumev3", "volume"]) && <Row to="storage/backends" icon="hard-drive" label={tr("Block storage services")} count={c.count} note={c.note} tone={c.warn ? "warn" : undefined} />}
        <Row to="compute/availability-zones" icon="map-pin" label={tr("Availability zones")} count="›" />
      </ul>
    </Card>
  );
}

export default function AdminOverview() {
  const session = useSession().data!;
  const hasImage = session.services.includes("image");
  const projects = useProjects();
  const users = useUsers();
  const roles = useRoles();
  const domains = useDomains();
  const catalog = useAdminCatalog();
  const images = useImages("all", {}, hasImage);
  const hasPlacement = session.services.includes("placement");
  const capacity = useCapacity(hasPlacement);
  const cap = totals(capacity.data);
  const navigate = useNavigate();
  const [creating, setCreating] = useState<"project" | "user" | "image" | null>(null);

  const realProjects = projects.data?.filter((p) => !p.is_domain);
  const disabledProjects = realProjects?.filter((p) => !p.enabled).length ?? 0;
  const disabledUsers = users.data?.filter((u) => !u.enabled).length ?? 0;
  const domainCount = domains.data?.length ?? 0;

  const img = useMemo(() => {
    const list = images.data?.images ?? [];
    const by = (v: string) => list.filter((i) => i.visibility === v).length;
    const attention = list.filter((i) => ["killed", "queued", "deactivated"].includes(i.status));
    return {
      total: images.data ? `${list.length}${images.data.truncated ? "+" : ""}` : undefined,
      bytes: list.reduce((n, i) => n + (i.size ?? 0), 0),
      public: by("public"),
      shared: by("shared") + by("community"),
      private: by("private"),
      attention,
    };
  }, [images.data]);

  /** Services with at least one endpoint in each region. */
  const regions = useMemo(() => {
    if (!catalog.data) return [];
    const svc = new Map(catalog.data.services.map((s) => [s.id, s]));
    return catalog.data.regions.map((r) => {
      const eps = catalog.data.endpoints.filter((e) => e.region_id === r.id);
      const names = [...new Set(eps.map((e) => svc.get(e.service_id)?.name || svc.get(e.service_id)?.type || e.service_id))].sort();
      const disabled = eps.filter((e) => !e.enabled || svc.get(e.service_id)?.enabled === false).length;
      return { id: r.id, description: r.description, names, endpoints: eps.length, disabled };
    });
  }, [catalog.data]);

  const attentionNote = img.attention.length
    ? Object.entries(
        img.attention.reduce<Record<string, number>>((m, i) => ((m[i.status] = (m[i.status] ?? 0) + 1), m), {}),
      )
        .map(([s, n]) => `${n} ${s}`)
        .join(", ")
    : "none";

  return (
    <>
      <PageHeader
        title={tr("Cloud administration")}
        description={tr("Changes here affect every project on {name}.", { name: session.cloud.name })}
        actions={
          <>
            <Button onClick={() => setCreating("project")}>
              <Icon name="plus" />
              {tr("Project")}
            </Button>
            <Button onClick={() => setCreating("user")}>
              <Icon name="user-plus" />
              {tr("User")}
            </Button>
            {hasImage && (
              <Button onClick={() => setCreating("image")}>
                <Icon name="upload" />
                {tr("Image")}
              </Button>
            )}
          </>
        }
      />
      <ErrorNotice error={projects.error ?? users.error ?? catalog.error ?? images.error} className="mb-4" />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card title={tr("Identity")} flush>
          <ul>
            <Row
              to="identity/projects"
              icon="folder-tree"
              label={tr("Projects")}
              count={realProjects?.length}
              note={[
                domainCount > 1 ? `across ${plural(domainCount, tr("domain"))}` : null,
                disabledProjects ? `${disabledProjects} disabled` : null,
              ]
                .filter(Boolean)
                .join(", ")}
            />
            <Row to="identity/users" icon="users" label={tr("Users")} count={users.data?.length} note={disabledUsers ? tr("{disabledUsers} disabled", { disabledUsers }) : undefined} />
            <Row to="identity/roles" icon="badge-check" label={tr("Roles")} count={roles.data?.length} />
            <Row
              to="identity/endpoints"
              icon="plug"
              label={tr("Services")}
              count={catalog.data?.services.length}
              note={catalog.data && tr("{length} in {length2}", { length: plural(catalog.data.endpoints.length, tr("endpoint")), length2: plural(catalog.data.regions.length, tr("region")) })}
            />
          </ul>
        </Card>

        {hasImage && (
          <Card title={tr("Images")} flush>
            <ul>
              <Row
                to="compute/images"
                icon="disc-3"
                label={tr("All images")}
                count={img.total}
                note={images.data && tr("{bytes} stored", { bytes: fmtBytes(img.bytes) })}
              />
              <Row to="compute/images" icon="globe" label={tr("Public")} count={images.data ? img.public : undefined} />
              <Row to="compute/images" icon="users-round" label={tr("Shared and community")} count={images.data ? img.shared : undefined} />
              <Row to="compute/images" icon="lock" label={tr("Private")} count={images.data ? img.private : undefined} />
              <Row
                to="compute/images"
                icon="warning"
                label={tr("Need attention")}
                note={images.data && attentionNote}
                count={images.data ? img.attention.length : undefined}
                tone={img.attention.length ? "warn" : undefined}
              />
            </ul>
          </Card>
        )}

        {hasPlacement && (
          <Card title={tr("Compute capacity")} className="lg:col-span-2">
            <ErrorNotice error={capacity.error} />
            <div className="grid gap-5 sm:grid-cols-3">
              {(["VCPU", "MEMORY_MB", "DISK_GB"] as const).map((rc) => (
                <Link key={rc} to="compute/hypervisors" className="block rounded-md hover:bg-surface/60">
                  <p className="mb-1 text-sm font-medium">{rc === "VCPU" ? tr("vCPUs") : rc === "MEMORY_MB" ? tr("Memory") : tr("Local disk")}</p>
                  {cap[rc] ? (
                    <Meter rc={rc} used={cap[rc].used} capacity={cap[rc].cap} />
                  ) : (
                    <p className="text-xs text-muted">{capacity.isPending ? tr("Loading…") : tr("No inventory reported")}</p>
                  )}
                </Link>
              ))}
            </div>
            {capacity.data && (
              <p className="mt-3 text-xs text-muted">
                {trx("Allocated by Placement across {length}, after allocation ratios.", { length: plural(capacity.data.length, tr("resource provider")) })}
              </p>
            )}
          </Card>
        )}

        <ServicesCard />

        <Card title={tr("Regions{v}", { v: catalog.data ? ` (${catalog.data.regions.length})` : "" })} flush className="lg:col-span-2">
          <ul>
            {regions.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-5 py-3 last:border-0">
                <div className="w-44 min-w-0">
                  <p className="truncate font-medium" title={r.id}>
                    <Icon name="map-pin" className="mr-1.5 inline size-3.5 text-muted" />
                    {r.id}
                    {r.id === session.region && <span className="ml-2 text-xs font-normal text-muted">{tr("current")}</span>}
                  </p>
                  {r.description && (
                    <p className="truncate text-xs text-muted" title={r.description}>
                      {r.description}
                    </p>
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                  {r.names.map((n) => (
                    <Badge key={n}>{n}</Badge>
                  ))}
                </div>
                <span className="shrink-0 text-sm text-muted tabular-nums">
                  {plural(r.endpoints, tr("endpoint"))}
                  {r.disabled > 0 && <span className="text-[#9a6412] dark:text-led-amber">{trx(", {disabled} disabled", { disabled: r.disabled })}</span>}
                </span>
              </li>
            ))}
            {catalog.data && regions.length === 0 && (
              <li className="px-5 py-6 text-center text-sm text-muted">{tr("Keystone has no regions registered.")}</li>
            )}
          </ul>
        </Card>
      </div>

      <ProjectDialog
        key={`p${creating}`}
        open={creating === "project"}
        onClose={() => setCreating(null)}
        onSaved={(p) => navigate(`identity/projects/${p.id}`)}
      />
      <UserDialog
        key={`u${creating}`}
        open={creating === "user"}
        onClose={() => setCreating(null)}
        onSaved={(u) => navigate(`identity/users/${u.id}`)}
      />
      {hasImage && (
        <CreateImageDialog open={creating === "image"} onClose={() => setCreating(null)} detailBase="/admin/compute/images" />
      )}
    </>
  );
}
