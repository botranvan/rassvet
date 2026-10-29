import { Link } from "@/components/Link";
import { Badge, Icon, PageHeader, StatusDot } from "@/components/ui";
import { gib, quotaPct, useComputeLimits, useNetworkQuota, useVolumeLimits } from "@/lib/os";
import { cn } from "@/lib/utils";
import { type SessionInfo, useNav } from "@/lib/session";
import { locale, tr, trx } from "@/lib/i18n";

/** Services the dashboard manages (core and through extensions), with every catalog type that maps to them. */
const CORE: { name: string; project: string; types: string[]; icon: string }[] = [
  { name: "Identity", project: "Keystone", types: ["identity"], icon: "fingerprint" },
  { name: "Compute", project: "Nova", types: ["compute"], icon: "server" },
  { name: "Images", project: "Glance", types: ["image"], icon: "disc-3" },
  { name: "Placement", project: "Placement", types: ["placement"], icon: "gauge" },
  { name: "Networking", project: "Neutron", types: ["network"], icon: "network" },
  { name: "Block storage", project: "Cinder", types: ["block-storage", "volumev3", "volume"], icon: "hard-drive" },
  { name: "Key manager", project: "Barbican", types: ["key-manager"], icon: "lock-keyhole" },
  { name: "Object storage", project: "Swift", types: ["object-store"], icon: "archive" },
  // Managed through extensions.
  { name: "Load balancing", project: "Octavia", types: ["load-balancer"], icon: "split" },
  { name: "Kubernetes", project: "Magnum", types: ["container-infra"], icon: "container" },
];

export default function Overview({ session }: { session: SessionInfo }) {
  const nav = useNav(true);
  const has = (types: string[]) => types.some((t) => session.services.includes(t));
  const expires = new Date(session.expires_at);

  return (
    <>
      <PageHeader
        title={session.project?.name ?? tr("Overview")}
        description={tr("Signed in as {name} on {name2}{v}.", { name: session.user.name, name2: session.cloud.name, v: session.region ? tr(", region {region}", { region: session.region }) : "" })}
      />

      <QuotaUsage session={session} />

      <section className="grid items-start gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="rounded-lg border border-line bg-panel">
          <h2 className="border-b border-line px-5 py-3 text-sm font-semibold">{tr("Services in this region")}</h2>
          <ul className="grid sm:grid-cols-2">
            {CORE.map((s) => {
              const up = has(s.types);
              return (
                <li key={s.name} className="flex items-center gap-3 border-b border-line px-5 py-3.5 sm:odd:border-r">
                  <Icon name={s.icon} className="text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={tr(s.name)}>
                      {tr(s.name)}
                    </p>
                    <p className="truncate text-xs text-muted">{s.project}</p>
                  </div>
                  <span className="shrink-0 text-xs whitespace-nowrap text-muted">
                    <StatusDot status={up ? "ok" : "off"} label={up ? tr("Available") : tr("Not deployed")} />
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="space-y-6">
          <dl className="rounded-lg border border-line bg-panel px-5 py-4 text-sm">
            <h2 className="mb-3 font-semibold">{tr("Session")}</h2>
            <Row label={tr("Project ID")}>
              <code className="font-mono text-[12.5px] select-all">{session.project?.id ?? "—"}</code>
            </Row>
            <Row label={tr("Roles")}>{session.roles.length ? tr("{length} in this project", { length: session.roles.length }) : "—"}</Row>
            <Row label={tr("Token expires")}>
              {expires.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
            </Row>
          </dl>

          <RolesCard session={session} />

          <div className="rounded-lg border border-line bg-panel px-5 py-4 text-sm">
            <h2 className="mb-3 font-semibold">{tr("Extensions")}</h2>
            {nav.data?.extensions.length ? (
              <ul className="space-y-2.5">
                {nav.data.extensions.map((e) => (
                  <li key={e.id}>
                    <p className="font-medium">
                      {e.name} <span className="font-normal text-muted">v{e.version}</span>
                    </p>
                    <p className="text-xs text-muted">{e.description}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">
                {tr("No extension services were found in this region's catalog.")}
              </p>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

/** What the common Keystone roles allow, shown on hover. */
const ROLE_HELP: Record<string, string> = {
  admin: tr("Full control, including cloud-wide admin APIs"),
  manager: tr("Manage the project (users' roles, some quotas) without being admin"),
  member: tr("Create and change resources in the project"),
  reader: tr("Read-only access to the project"),
  observer: tr("Read-only access (legacy name)"),
  creator: tr("Create secrets and other key-manager objects (Barbican)"),
  service: tr("Used by OpenStack services talking to each other"),
  "heat_stack_owner": tr("Owns Heat stacks"),
  "load-balancer_member": tr("Create and change load balancers (Octavia)"),
  "load-balancer_observer": tr("View load balancers (Octavia)"),
  "load-balancer_admin": tr("Administer all load balancers (Octavia)"),
  "load-balancer_global_observer": tr("View every project's load balancers (Octavia)"),
};

/** Strongest roles first, then the rest alphabetically. */
const ROLE_ORDER = ["admin", "manager", "member", "reader"];

function RolesCard({ session }: { session: SessionInfo }) {
  const roles = [...session.roles].sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(a.name.toLowerCase());
    const ib = ROLE_ORDER.indexOf(b.name.toLowerCase());
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
  });
  return (
    <div className="rounded-lg border border-line bg-panel px-5 py-4 text-sm">
      <h2 className="mb-1 font-semibold">{tr("Your roles")}</h2>
      <p className="mb-3 text-xs text-muted">{trx("In {v}. Hover a role for what it allows.", { v: session.project?.name ?? tr("this project") })}</p>
      {roles.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {roles.map((r) => (
            <li key={r.id} title={ROLE_HELP[r.name.toLowerCase()] ?? r.name}>
              <Badge tone={r.name.toLowerCase() === "admin" ? "warn" : ROLE_ORDER.includes(r.name.toLowerCase()) ? "accent" : "neutral"}><span>{r.name}</span></Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">{tr("No roles in this project.")}</p>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-2 last:border-0">
      <dt className="shrink-0 whitespace-nowrap text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

/** Quota usage for the current project across Nova, Cinder and Neutron. */
function QuotaUsage({ session }: { session: SessionInfo }) {
  const has = (t: string[]) => t.some((x) => session.services.includes(x));
  const compute = useComputeLimits();
  const volume = useVolumeLimits();
  const network = useNetworkQuota(has(["network"]) ? session.project?.id : undefined);
  const c = has(["compute"]) ? compute.data : undefined;
  const v = has(["block-storage", "volumev3", "volume"]) ? volume.data : undefined;
  const n = network.data;
  const items: { label: string; used: number; max: number; fmt?: (x: number) => string; to: string }[] = [
    ...(c
      ? [
          { label: tr("Instances"), used: c.totalInstancesUsed, max: c.maxTotalInstances, to: "/compute/instances" },
          { label: tr("vCPUs"), used: c.totalCoresUsed, max: c.maxTotalCores, to: "/compute/instances" },
          { label: "RAM", used: c.totalRAMUsed, max: c.maxTotalRAMSize, fmt: gib, to: "/compute/instances" },
        ]
      : []),
    ...(v
      ? [
          { label: tr("Volumes"), used: v.totalVolumesUsed, max: v.maxTotalVolumes, to: "/storage/volumes" },
          { label: tr("Volume storage"), used: v.totalGigabytesUsed, max: v.maxTotalVolumeGigabytes, fmt: (x: number) => `${x} GiB`, to: "/storage/volumes" },
          { label: tr("Volume snapshots"), used: v.totalSnapshotsUsed, max: v.maxTotalSnapshots, to: "/storage/snapshots" },
        ]
      : []),
    ...(n
      ? [
          { label: tr("Floating IPs"), used: n.floatingip?.used ?? 0, max: n.floatingip?.limit ?? -1, to: "/network/floating-ips" },
          { label: tr("Networks"), used: n.network?.used ?? 0, max: n.network?.limit ?? -1, to: "/network/networks" },
          { label: tr("Routers"), used: n.router?.used ?? 0, max: n.router?.limit ?? -1, to: "/network/routers" },
          { label: tr("Security groups"), used: n.security_group?.used ?? 0, max: n.security_group?.limit ?? -1, to: "/network/security-groups" },
          { label: tr("Ports"), used: n.port?.used ?? 0, max: n.port?.limit ?? -1, to: "/network/networks" },
        ]
      : []),
  ];
  if (!items.length) return null;
  return (
    <section className="mb-6 rounded-lg border border-line bg-panel">
      <h2 className="border-b border-line px-5 py-3 text-sm font-semibold">{tr("Quota usage")}</h2>
      <ul className="grid gap-x-8 gap-y-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map((i) => {
          const pct = quotaPct(i.used, i.max);
          const f = i.fmt ?? String;
          return (
            <li key={i.label}>
              <Link to={i.to} className="group block">
                <p className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate group-hover:text-cable">{i.label}</span>
                  <span className="shrink-0 text-xs text-muted tabular-nums">
                    {trx("{f} of {v}", { f: f(i.used), v: i.max < 0 ? tr("unlimited") : f(i.max) })}
                  </span>
                </p>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink/8">
                  <div
                    className={cn("h-full rounded-full", pct >= 90 ? "bg-led-red" : pct >= 75 ? "bg-led-amber" : "bg-cable")}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
