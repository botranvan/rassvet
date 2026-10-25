/** Admin: Octavia flavors, flavor profiles, availability zones, AZ profiles, providers and quotas. */
import { useState } from "react";
import {
  ActionDialog,
  Badge,
  Button,
  Card,
  type Column,
  DataTable,
  ErrorNotice,
  Field,
  Icon,
  Input,
  Mono,
  PageHeader,
  Picker,
  Switch,
  Tabs,
  Textarea,
  os,
  tr,
  useInvalidate,
  useOsGet,
  useOsList,
  useProjects,
  useTab,
} from "@rassvet/sdk";
import {
  type FlavorProfile,
  LB,
  type LbFlavor,
  type LbQuota,
  type LbZone,
  type Provider,
  type ZoneProfile,
  useFlavorsLb,
  useLoadBalancers,
  useProviders,
  useZonesLb,
} from "./api";

const TABS = ["flavors", "profiles", "zones", "zone-profiles", "providers", "quotas"] as const;

export default function Settings() {
  const [tab, setTab] = useTab(TABS, "flavors");
  return (
    <>
      <PageHeader
        title={tr("Load balancing")}
        description={tr("What users can choose when they create a load balancer (flavors and availability zones, backed by provider-specific profiles), and how many load balancer objects each project may have.")}
      />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { id: "flavors", label: tr("Flavors") },
          { id: "profiles", label: tr("Flavor profiles") },
          { id: "zones", label: tr("Availability zones") },
          { id: "zone-profiles", label: tr("Zone profiles") },
          { id: "providers", label: tr("Providers") },
          { id: "quotas", label: tr("Quotas") },
        ]}
      />
      {tab === "flavors" && <Flavors />}
      {tab === "profiles" && <Profiles kind="flavor" />}
      {tab === "zones" && <Zones />}
      {tab === "zone-profiles" && <Profiles kind="zone" />}
      {tab === "providers" && <Providers />}
      {tab === "quotas" && <Quotas />}
    </>
  );
}

const checkJson = (s: string) => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? null : tr("Must be a JSON object");
  } catch (e) {
    return (e as Error).message;
  }
};

// =========================================================================== flavors

function Flavors() {
  const flavors = useFlavorsLb();
  const profiles = useOsList<FlavorProfile>(LB, "lbaas/flavorprofiles", "flavorprofiles");
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "delete"; f: LbFlavor } | null>(null);
  const close = () => setOpen(null);
  const profile = (id: string) => profiles.data?.find((p) => p.id === id);
  const cols: Column<LbFlavor>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (f) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <span className="truncate font-medium">{f.name}</span>
          {!f.enabled && <Badge tone="warn">{tr("disabled")}</Badge>}
        </span>
      ),
      value: (f) => f.name,
    },
    { key: "description", header: tr("Description"), hideBelow: "md", cell: (f) => <span className="text-muted">{f.description || "—"}</span>, value: (f) => f.description ?? "" },
    { key: "profile", header: tr("Profile"), width: "12rem", cell: (f) => profile(f.flavor_profile_id)?.name ?? <Mono>{f.flavor_profile_id.slice(0, 8)}</Mono>, value: (f) => profile(f.flavor_profile_id)?.name ?? "" },
    { key: "provider", header: tr("Provider"), width: "8rem", hideBelow: "lg", cell: (f) => profile(f.flavor_profile_id)?.provider_name ?? "", value: (f) => profile(f.flavor_profile_id)?.provider_name ?? "" },
  ];
  return (
    <>
      <div className="mb-3">
        <Button variant="primary" onClick={() => setOpen({ kind: "create" })} disabled={!profiles.data?.length}>
          <Icon name="plus" />
          {tr("Create flavor")}
        </Button>
      </div>
      <ErrorNotice error={flavors.error ?? profiles.error} className="mb-4" />
      <DataTable
        rows={flavors.data}
        columns={cols}
        rowKey={(f) => f.id}
        loading={flavors.isPending}
        tableId="octavia-flavors"
        noun={tr("flavors")}
        rowLabel={(f) => f.name}
        empty={tr("No flavors: load balancers use the provider's defaults. Create a flavor profile first.")}
        onRefresh={() => flavors.refetch()}
        refreshing={flavors.isFetching}
        onBulkDone={() => invalidate(LB)}
        rowActions={(f) => [
          { label: tr("Edit flavor"), icon: "edit", onSelect: () => setOpen({ kind: "edit", f }) },
          f.enabled
            ? { label: tr("Disable"), icon: "ban", onSelect: () => os.put(LB, `lbaas/flavors/${f.id}`, { flavor: { enabled: false } }).then(() => invalidate(LB)) }
            : { label: tr("Enable"), icon: "play", onSelect: () => os.put(LB, `lbaas/flavors/${f.id}`, { flavor: { enabled: true } }).then(() => invalidate(LB)) },
          "-",
          { label: tr("Delete flavor"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", f }) },
        ]}
      />
      {open?.kind === "create" && <FlavorDialog profiles={profiles.data ?? []} onClose={close} />}
      {open?.kind === "edit" && <FlavorDialog f={open.f} profiles={profiles.data ?? []} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog onClose={close} danger title={tr("Delete flavor {name}?", { name: open.f.name })} submitLabel={tr("Delete")} done={tr("Flavor deleted")} refresh={[LB]} run={() => os.del(LB, `lbaas/flavors/${open.f.id}`)}>
          <p className="text-sm">{tr("Octavia refuses while load balancers use it; disable it instead to hide it from new load balancers.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function FlavorDialog({ f, profiles, onClose }: { f?: LbFlavor; profiles: FlavorProfile[]; onClose: () => void }) {
  const [name, setName] = useState(f?.name ?? "");
  const [description, setDescription] = useState(f?.description ?? "");
  const [profile, setProfile] = useState(f?.flavor_profile_id ?? profiles[0]?.id ?? "");
  const [enabled, setEnabled] = useState(f?.enabled ?? true);
  return (
    <ActionDialog
      onClose={onClose}
      title={f ? tr("Edit flavor {name}", { name: f.name }) : tr("Create flavor")}
      description={tr("A flavor is what users pick; its profile holds the provider settings (topology, compute flavor…).")}
      submitLabel={f ? tr("Save") : tr("Create flavor")}
      canSubmit={!!name.trim() && !!profile}
      done={f ? tr("Flavor updated") : tr("Flavor created")}
      refresh={[LB]}
      run={() =>
        f
          ? os.put(LB, `lbaas/flavors/${f.id}`, { flavor: { name: name.trim(), description, enabled } })
          : os.post(LB, "lbaas/flavors", { flavor: { name: name.trim(), description: description || undefined, flavor_profile_id: profile, enabled } })
      }
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="ha" />}</Field>
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Field label={tr("Flavor profile")} hint={f ? tr("Can't be changed after creation.") : undefined}>
        {(id) => <Picker id={id} value={profile} disabled={!!f} onChange={setProfile} options={profiles.map((p) => ({ value: p.id, label: p.name, description: `${p.provider_name} · ${p.flavor_data}` }))} />}
      </Field>
      <Switch checked={enabled} onChange={setEnabled} label={tr("Enabled")} hint={tr("Disabled flavors can't be chosen for new load balancers.")} />
    </ActionDialog>
  );
}

// =========================================================================== profiles

type AnyProfile = { id: string; name: string; provider_name: string; flavor_data?: string; availability_zone_data?: string };

function Profiles({ kind }: { kind: "flavor" | "zone" }) {
  const path = kind === "flavor" ? "lbaas/flavorprofiles" : "lbaas/availabilityzoneprofiles";
  const key = kind === "flavor" ? "flavorprofiles" : "availability_zone_profiles";
  const profiles = useOsList<AnyProfile>(LB, path, key);
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "delete"; p: AnyProfile } | null>(null);
  const close = () => setOpen(null);
  const data = (p: AnyProfile) => (kind === "flavor" ? p.flavor_data : p.availability_zone_data) ?? "";
  const cols: Column<AnyProfile>[] = [
    { key: "name", header: tr("Name"), width: "14rem", cell: (p) => <span className="font-medium">{p.name}</span>, value: (p) => p.name },
    { key: "provider", header: tr("Provider"), width: "8rem", cell: (p) => p.provider_name, value: (p) => p.provider_name },
    { key: "data", header: kind === "flavor" ? tr("Flavor data") : tr("Zone data"), mono: true, wrap: true, cell: data, value: data },
  ];
  return (
    <>
      <div className="mb-3">
        <Button variant="primary" onClick={() => setOpen({ kind: "create" })}>
          <Icon name="plus" />
          {kind === "flavor" ? tr("Create flavor profile") : tr("Create zone profile")}
        </Button>
      </div>
      <ErrorNotice error={profiles.error} className="mb-4" />
      <DataTable
        rows={profiles.data}
        columns={cols}
        rowKey={(p) => p.id}
        loading={profiles.isPending}
        tableId={`octavia-${kind}-profiles`}
        noun={tr("profiles")}
        rowLabel={(p) => p.name}
        empty={tr("No profiles yet.")}
        onRefresh={() => profiles.refetch()}
        refreshing={profiles.isFetching}
        onBulkDone={() => invalidate(LB)}
        rowActions={(p) => [
          { label: tr("Edit profile"), icon: "edit", onSelect: () => setOpen({ kind: "edit", p }) },
          "-",
          { label: tr("Delete profile"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", p }) },
        ]}
      />
      {open?.kind === "create" && <ProfileDialog kind={kind} onClose={close} />}
      {open?.kind === "edit" && <ProfileDialog kind={kind} p={open.p} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog onClose={close} danger title={tr("Delete profile {name}?", { name: open.p.name })} submitLabel={tr("Delete")} done={tr("Profile deleted")} refresh={[LB]} run={() => os.del(LB, `${path}/${open.p.id}`)}>
          <p className="text-sm">{tr("Octavia refuses while a flavor or availability zone uses it.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function ProfileDialog({ kind, p, onClose }: { kind: "flavor" | "zone"; p?: AnyProfile; onClose: () => void }) {
  const providers = useProviders();
  const [name, setName] = useState(p?.name ?? "");
  const [provider, setProvider] = useState(p?.provider_name ?? "amphora");
  const [data, setData] = useState(() => {
    const raw = (kind === "flavor" ? p?.flavor_data : p?.availability_zone_data) ?? "{}";
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  });
  const caps = useOsGet<{ name: string; description: string }[]>(
    LB,
    `lbaas/providers/${provider}/${kind === "flavor" ? "flavor_capabilities" : "availability_zone_capabilities"}`,
    (r: Record<string, { name: string; description: string }[]>) => r[kind === "flavor" ? "flavor_capabilities" : "availability_zone_capabilities"] ?? [],
    { enabled: !!provider },
  );
  const error = checkJson(data);
  const field = kind === "flavor" ? "flavor_data" : "availability_zone_data";
  const one = kind === "flavor" ? "flavorprofile" : "availability_zone_profile";
  const path = kind === "flavor" ? "lbaas/flavorprofiles" : "lbaas/availabilityzoneprofiles";
  const addKey = (k: string) => {
    try {
      const o = JSON.parse(data || "{}");
      if (!(k in o)) o[k] = "";
      setData(JSON.stringify(o, null, 2));
    } catch {
      /* fix the JSON first */
    }
  };
  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={p ? tr("Edit profile {name}", { name: p.name }) : kind === "flavor" ? tr("Create flavor profile") : tr("Create zone profile")}
      description={kind === "flavor" ? tr("Provider settings behind a flavor, as JSON (e.g. loadbalancer_topology, compute_flavor).") : tr("Provider settings behind an availability zone, as JSON (e.g. compute_zone, management_network).")}
      submitLabel={p ? tr("Save") : tr("Create profile")}
      canSubmit={!!name.trim() && !!provider && !error}
      done={p ? tr("Profile updated") : tr("Profile created")}
      refresh={[LB]}
      run={() => {
        const body = { name: name.trim(), provider_name: provider, [field]: JSON.stringify(JSON.parse(data)) };
        return p ? os.put(LB, `${path}/${p.id}`, { [one]: body }) : os.post(LB, path, { [one]: body });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={tr("Provider")}>
          {(id) => <Picker id={id} value={provider} onChange={setProvider} loading={providers.isPending} options={(providers.data ?? []).map((x) => ({ value: x.name, label: x.name, description: x.description }))} />}
        </Field>
      </div>
      <Field label={kind === "flavor" ? tr("Flavor data (JSON)") : tr("Zone data (JSON)")} hint={error ?? undefined}>
        {(id) => <Textarea id={id} rows={7} className={`font-mono text-[12.5px] ${error ? "border-led-red" : ""}`} value={data} onChange={(e) => setData(e.target.value)} spellCheck={false} />}
      </Field>
      {!!caps.data?.length && (
        <div>
          <p className="mb-1.5 text-sm font-medium">{tr("Capabilities of {provider}", { provider })}</p>
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-line p-2 text-xs">
            {caps.data.map((c) => (
              <li key={c.name} className="flex items-start gap-2">
                <button type="button" className="shrink-0 font-mono text-cable hover:underline" onClick={() => addKey(c.name)} title={tr("Add to the JSON")}>
                  {c.name}
                </button>
                <span className="text-muted">{c.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ActionDialog>
  );
}

// =========================================================================== zones

function Zones() {
  const zones = useZonesLb();
  const profiles = useOsList<ZoneProfile>(LB, "lbaas/availabilityzoneprofiles", "availability_zone_profiles");
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "delete"; z: LbZone } | null>(null);
  const close = () => setOpen(null);
  const profile = (id: string) => profiles.data?.find((p) => p.id === id);
  const cols: Column<LbZone>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (z) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <span className="truncate font-medium">{z.name}</span>
          {!z.enabled && <Badge tone="warn">{tr("disabled")}</Badge>}
        </span>
      ),
      value: (z) => z.name,
    },
    { key: "description", header: tr("Description"), hideBelow: "md", cell: (z) => <span className="text-muted">{z.description || "—"}</span>, value: (z) => z.description ?? "" },
    { key: "profile", header: tr("Profile"), width: "12rem", cell: (z) => profile(z.availability_zone_profile_id)?.name ?? "", value: (z) => profile(z.availability_zone_profile_id)?.name ?? "" },
    { key: "data", header: tr("Zone data"), hideBelow: "lg", mono: true, cell: (z) => profile(z.availability_zone_profile_id)?.availability_zone_data ?? "", value: (z) => profile(z.availability_zone_profile_id)?.availability_zone_data ?? "" },
  ];
  return (
    <>
      <div className="mb-3">
        <Button variant="primary" onClick={() => setOpen({ kind: "create" })} disabled={!profiles.data?.length}>
          <Icon name="plus" />
          {tr("Create availability zone")}
        </Button>
      </div>
      <ErrorNotice error={zones.error ?? profiles.error} className="mb-4" />
      <DataTable
        rows={zones.data}
        columns={cols}
        rowKey={(z) => z.name}
        loading={zones.isPending}
        tableId="octavia-zones"
        noun={tr("availability zones")}
        rowLabel={(z) => z.name}
        empty={tr("No load balancer availability zones. Create a zone profile first.")}
        onRefresh={() => zones.refetch()}
        refreshing={zones.isFetching}
        onBulkDone={() => invalidate(LB)}
        rowActions={(z) => [
          { label: tr("Edit availability zone"), icon: "edit", onSelect: () => setOpen({ kind: "edit", z }) },
          "-",
          { label: tr("Delete availability zone"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", z }) },
        ]}
      />
      {open?.kind === "create" && <ZoneDialog profiles={profiles.data ?? []} onClose={close} />}
      {open?.kind === "edit" && <ZoneDialog z={open.z} profiles={profiles.data ?? []} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog onClose={close} danger title={tr("Delete availability zone {name}?", { name: open.z.name })} submitLabel={tr("Delete")} done={tr("Availability zone deleted")} refresh={[LB]} run={() => os.del(LB, `lbaas/availabilityzones/${open.z.name}`)}>
          <p className="text-sm">{tr("Load balancers already in the zone keep running.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function ZoneDialog({ z, profiles, onClose }: { z?: LbZone; profiles: ZoneProfile[]; onClose: () => void }) {
  const [name, setName] = useState(z?.name ?? "");
  const [description, setDescription] = useState(z?.description ?? "");
  const [profile, setProfile] = useState(z?.availability_zone_profile_id ?? profiles[0]?.id ?? "");
  const [enabled, setEnabled] = useState(z?.enabled ?? true);
  return (
    <ActionDialog
      onClose={onClose}
      title={z ? tr("Edit availability zone {name}", { name: z.name }) : tr("Create availability zone")}
      submitLabel={z ? tr("Save") : tr("Create")}
      canSubmit={!!name.trim() && !!profile}
      done={z ? tr("Availability zone updated") : tr("Availability zone created")}
      refresh={[LB]}
      run={() =>
        z
          ? os.put(LB, `lbaas/availabilityzones/${z.name}`, { availability_zone: { description, enabled } })
          : os.post(LB, "lbaas/availabilityzones", { availability_zone: { name: name.trim(), description: description || undefined, availability_zone_profile_id: profile, enabled } })
      }
    >
      <Field label={tr("Name")} hint={z ? tr("Can't be changed after creation.") : undefined}>
        {(id) => <Input id={id} autoFocus={!z} disabled={!!z} value={name} onChange={(e) => setName(e.target.value)} placeholder="az-1" />}
      </Field>
      <Field label={tr("Description")}>{(id) => <Input id={id} autoFocus={!!z} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Field label={tr("Zone profile")} hint={z ? tr("Can't be changed after creation.") : undefined}>
        {(id) => <Picker id={id} value={profile} disabled={!!z} onChange={setProfile} options={profiles.map((p) => ({ value: p.id, label: p.name, description: `${p.provider_name} · ${p.availability_zone_data}` }))} />}
      </Field>
      <Switch checked={enabled} onChange={setEnabled} label={tr("Enabled")} />
    </ActionDialog>
  );
}

// =========================================================================== providers

function Providers() {
  const providers = useProviders();
  return (
    <>
      <ErrorNotice error={providers.error} className="mb-4" />
      <div className="grid gap-4 lg:grid-cols-2">
        {(providers.data ?? []).map((p) => (
          <ProviderCard key={p.name} p={p} />
        ))}
      </div>
    </>
  );
}

function ProviderCard({ p }: { p: Provider }) {
  const flavor = useOsGet<{ name: string; description: string }[]>(LB, `lbaas/providers/${p.name}/flavor_capabilities`, (r: { flavor_capabilities: { name: string; description: string }[] }) => r.flavor_capabilities);
  const zone = useOsGet<{ name: string; description: string }[]>(LB, `lbaas/providers/${p.name}/availability_zone_capabilities`, (r: { availability_zone_capabilities: { name: string; description: string }[] }) => r.availability_zone_capabilities);
  const list = (items?: { name: string; description: string }[]) =>
    items?.length ? (
      <ul className="space-y-1 text-xs">
        {items.map((c) => (
          <li key={c.name}>
            <Mono className="text-ink">{c.name}</Mono> <span className="text-muted">— {c.description}</span>
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-xs text-muted">{tr("None reported.")}</p>
    );
  return (
    <Card title={p.name}>
      <p className="mb-3 text-sm text-muted">{p.description}</p>
      <p className="mb-1 text-sm font-medium">{tr("Flavor capabilities")}</p>
      {flavor.error ? <p className="text-xs text-muted">{tr("Not supported by this provider.")}</p> : list(flavor.data)}
      <p className="mt-3 mb-1 text-sm font-medium">{tr("Availability zone capabilities")}</p>
      {zone.error ? <p className="text-xs text-muted">{tr("Not supported by this provider.")}</p> : list(zone.data)}
    </Card>
  );
}

// =========================================================================== quotas

const QUOTA_KEYS: { key: keyof LbQuota; label: string }[] = [
  { key: "load_balancer", label: tr("Load balancers") },
  { key: "listener", label: tr("Listeners") },
  { key: "pool", label: tr("Pools") },
  { key: "member", label: tr("Members") },
  { key: "health_monitor", label: tr("Health monitors") },
  { key: "l7policy", label: tr("L7 policies") },
  { key: "l7rule", label: tr("L7 rules") },
];

type QuotaRow = { project_id: string; name: string; custom: boolean; quota: LbQuota };

function Quotas() {
  const projects = useProjects();
  const quotas = useOsList<LbQuota & { project_id: string }>(LB, "lbaas/quotas", "quotas");
  const defaults = useOsGet<LbQuota>(LB, "lbaas/quotas/defaults", (r: { quota: LbQuota }) => r.quota);
  const lbs = useLoadBalancers();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "edit" | "reset"; r: QuotaRow } | null>(null);
  const close = () => setOpen(null);
  const rows: QuotaRow[] | undefined =
    projects.data && quotas.data && defaults.data
      ? projects.data
          .filter((p) => !p.is_domain)
          .map((p) => {
            const q = quotas.data!.find((x) => x.project_id === p.id);
            return { project_id: p.id, name: p.name, custom: !!q, quota: { ...defaults.data!, ...Object.fromEntries(Object.entries(q ?? {}).filter(([, v]) => v != null)) } as LbQuota };
          })
      : undefined;
  const used = (pid: string) => lbs.data?.filter((l) => l.project_id === pid).length ?? 0;
  const show = (v: number | null) => (v == null ? "—" : v < 0 ? "∞" : v);
  const cols: Column<QuotaRow>[] = [
    {
      key: "project",
      header: tr("Project"),
      cell: (r) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <span className="truncate font-medium">{r.name}</span>
          {r.custom && <Badge tone="accent">{tr("custom")}</Badge>}
        </span>
      ),
      value: (r) => r.name,
    },
    {
      key: "load_balancer",
      header: tr("Load balancers"),
      width: "9rem",
      className: "text-right",
      cell: (r) => `${used(r.project_id)} / ${show(r.quota.load_balancer)}`,
      value: (r) => r.quota.load_balancer ?? 0,
    },
    ...QUOTA_KEYS.slice(1).map(
      (k): Column<QuotaRow> => ({ key: k.key, header: k.label, width: "7.5rem", className: "text-right", hideBelow: "lg", cell: (r) => show(r.quota[k.key]), value: (r) => r.quota[k.key] ?? 0 }),
    ),
  ];
  return (
    <>
      <ErrorNotice error={quotas.error ?? defaults.error ?? projects.error} className="mb-4" />
      {defaults.data && (
        <p className="mb-3 text-sm text-muted">
          {tr("Defaults:")} {QUOTA_KEYS.map((k) => `${k.label} ${show(defaults.data![k.key])}`).join(" · ")}
        </p>
      )}
      <DataTable
        rows={rows}
        columns={cols}
        rowKey={(r) => r.project_id}
        loading={!rows && !quotas.error}
        tableId="octavia-quotas"
        noun={tr("projects")}
        rowLabel={(r) => r.name}
        onRefresh={() => quotas.refetch()}
        refreshing={quotas.isFetching}
        onBulkDone={() => invalidate(LB)}
        rowActions={(r) => [
          { label: tr("Edit quota"), icon: "edit", onSelect: () => setOpen({ kind: "edit", r }) },
          { label: tr("Reset to defaults"), icon: "rotate-ccw", disabled: r.custom ? false : tr("Already uses the defaults"), onSelect: () => setOpen({ kind: "reset", r }) },
        ]}
      />
      {open?.kind === "edit" && <QuotaDialog r={open.r} onClose={close} />}
      {open?.kind === "reset" && (
        <ActionDialog onClose={close} title={tr("Reset quota of {name}?", { name: open.r.name })} submitLabel={tr("Reset")} done={tr("Quota reset")} refresh={[LB]} run={() => os.del(LB, `lbaas/quotas/${open.r.project_id}`)}>
          <p className="text-sm">{tr("The project goes back to the cloud's default load balancer quotas.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function QuotaDialog({ r, onClose }: { r: QuotaRow; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(QUOTA_KEYS.map((k) => [k.key, String(r.quota[k.key] ?? -1)])));
  const ok = Object.values(values).every((v) => /^-?\d+$/.test(v.trim()) && Number(v) >= -1);
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Load balancer quota of {name}", { name: r.name })}
      description={tr("-1 = unlimited.")}
      submitLabel={tr("Save")}
      canSubmit={ok}
      done={tr("Quota updated")}
      refresh={[LB]}
      run={() => os.put(LB, `lbaas/quotas/${r.project_id}`, { quota: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)])) })}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {QUOTA_KEYS.map((k) => (
          <Field key={k.key} label={k.label}>
            {(id) => <Input id={id} type="number" min={-1} value={values[k.key]} onChange={(e) => setValues({ ...values, [k.key]: e.target.value })} />}
          </Field>
        ))}
      </div>
    </ActionDialog>
  );
}
