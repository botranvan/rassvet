/**
 * Export to Terraform: pick instances, volumes, networks, routers, security groups, floating
 * IPs, key pairs and (with the Magnum extension) Kubernetes clusters and templates of the project and get a main.tf for the OpenStack provider, with import
 * blocks that adopt the existing resources.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { CodeBlock } from "@/components/CodeBlock";
import { Badge, Card, Checkbox, ErrorNotice, Icon, Input, PageHeader, Switch } from "@/components/ui";
import { fmtBytes, localDate } from "@/lib/format";
import { useCliInfo } from "@/lib/identity";
import { useImages } from "@/lib/image";
import {
  type FloatingIp,
  type Keypair,
  type Network,
  type Port,
  type Router,
  type SecurityGroup,
  type Server,
  type Subnet,
  type Volume,
  serverIps,
  useKeypairs,
  useOsList,
} from "@/lib/os";
import { useNav, useSession } from "@/lib/session";
import { type TfCluster, type TfClusterTemplate, type TfKind, type TfSelection, emptySelection, generate, withDependencies } from "@/lib/terraform";
import { cn } from "@/lib/utils";
import { tr } from "@/lib/i18n";

interface Item {
  id: string;
  name: string;
  sub?: string;
}

function Section({
  kind,
  icon,
  title,
  items,
  loading,
  error,
  sel,
  auto,
  onToggle,
  onSet,
}: {
  kind: TfKind;
  icon: string;
  title: string;
  items: Item[] | undefined;
  loading: boolean;
  error: unknown;
  sel: Set<string>;
  /** Added as a dependency of something selected. */
  auto: Set<string>;
  onToggle: (kind: TfKind, id: string) => void;
  onSet: (kind: TfKind, ids: string[], on: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(true);
  const shown = (items ?? []).filter((i) => !q || `${i.name} ${i.sub ?? ""} ${i.id}`.toLowerCase().includes(q.toLowerCase()));
  const n = items?.filter((i) => sel.has(i.id)).length ?? 0;
  const extra = items?.filter((i) => !sel.has(i.id) && auto.has(i.id)).length ?? 0;
  return (
    <section className="rounded-lg border border-line bg-panel">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left">
        <Icon name={icon} className="size-4 text-muted" />
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-xs text-muted tabular-nums">{items ? items.length : "…"}</span>
        {n > 0 && <Badge tone="accent">{tr("{n} picked", { n })}</Badge>}
        {extra > 0 && <Badge>{tr("+{n} needed", { n: extra })}</Badge>}
        <Icon name={open ? "chevron-up" : "chevron-down"} className="ml-auto size-4 text-muted" />
      </button>
      {open && (
        <div className="border-t border-line px-4 pt-2.5 pb-3">
          <ErrorNotice error={error} className="mb-2" />
          {loading ? (
            <p className="py-2 text-sm text-muted">{tr("Loading…")}</p>
          ) : !items?.length ? (
            <p className="py-2 text-sm text-muted">{tr("None in this project.")}</p>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2">
                {items.length > 6 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("Filter")} className="h-8 text-sm" aria-label={tr("Filter {what}", { what: title })} />}
                <button type="button" className="shrink-0 text-xs font-medium text-cable hover:underline" onClick={() => onSet(kind, shown.map((i) => i.id), true)}>
                  {tr("All")}
                </button>
                <button type="button" className="shrink-0 text-xs font-medium text-muted hover:text-ink hover:underline" onClick={() => onSet(kind, shown.map((i) => i.id), false)}>
                  {tr("None")}
                </button>
              </div>
              <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                {shown.map((i) => (
                  <li key={i.id} className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 hover:bg-surface">
                    <Checkbox checked={sel.has(i.id)} onChange={() => onToggle(kind, i.id)}>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{i.name}</span>
                        {i.sub && <span className="truncate text-xs text-muted">{i.sub}</span>}
                      </span>
                    </Checkbox>
                    {!sel.has(i.id) && auto.has(i.id) && <span className="ml-auto shrink-0 text-xs text-muted">{tr("needed")}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

const KINDS: TfKind[] = ["servers", "volumes", "networks", "routers", "secgroups", "fips", "keypairs", "clustertemplates", "clusters"];

export default function Terraform() {
  const session = useSession().data;
  const pid = session?.project?.id ?? "";
  const cli = useCliInfo();
  const [params] = useSearchParams();
  const [sel, setSel] = useState<TfSelection>(() => {
    const s = emptySelection();
    for (const k of KINDS) for (const id of (params.get(k) ?? "").split(",").filter(Boolean)) s[k].add(id);
    return s;
  });
  const [deps, setDeps] = useState(true);
  // Off by default: import blocks are a choice (adopting existing resources), not a given.
  const [imports, setImports] = useState(params.get("import") === "1");
  const [lookups, setLookups] = useState(true);

  const mine = { project_id: pid };
  const on = !!pid;
  const servers = useOsList<Server>("compute", "servers/detail", "servers", undefined, { enabled: on });
  const volumes = useOsList<Volume>("volume", "volumes/detail", "volumes", undefined, { enabled: on });
  // All visible networks / subnets / ports: external networks name router gateways and pools.
  const networks = useOsList<Network>("network", "networks", "networks", undefined, { enabled: on });
  const subnets = useOsList<Subnet>("network", "subnets", "subnets", undefined, { enabled: on });
  const ports = useOsList<Port>("network", "ports", "ports", undefined, { enabled: on });
  const routers = useOsList<Router>("network", "routers", "routers", mine, { enabled: on });
  const sgs = useOsList<SecurityGroup>("network", "security-groups", "security_groups", mine, { enabled: on });
  const fips = useOsList<FloatingIp>("network", "floatingips", "floatingips", mine, { enabled: on });
  const keypairs = useKeypairs();
  // Magnum lists every project's clusters and templates to admins: keep this project's.
  const nav = useNav(true);
  const magnum = on && !!nav.data?.extensions.some((e) => e.id === "magnum");
  const mgTemplates = useOsList<TfClusterTemplate>("ext:magnum", "clustertemplates", "clustertemplates", undefined, { enabled: magnum });
  const mgClusters = useOsList<TfCluster>("ext:magnum", "clusters/detail", "clusters", undefined, { enabled: magnum });
  // Image names, so instances and volumes can find their image by name.
  const images = useImages("all", {}, on && lookups);
  const full = <T,>(q: { data?: T[]; partial?: boolean }) => (q.partial ? undefined : q.data);

  const input = useMemo(
    () => ({
      servers: full(servers) ?? [],
      volumes: full(volumes) ?? [],
      networks: full(networks) ?? [],
      subnets: full(subnets) ?? [],
      routers: full(routers) ?? [],
      ports: full(ports) ?? [],
      secgroups: full(sgs) ?? [],
      fips: full(fips) ?? [],
      keypairs: (keypairs.data ?? []) as Keypair[],
      images: images.data?.images,
      clustertemplates: mgTemplates.data,
      clusters: mgClusters.data?.filter((c) => c.project_id === pid),
    }),
    [servers, volumes, networks, subnets, routers, ports, sgs, fips, keypairs.data, images.data, mgTemplates.data, mgClusters.data, pid], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const effective = useMemo(() => (deps ? withDependencies(input, sel, pid) : sel), [deps, input, sel, pid]);
  const result = useMemo(
    () =>
      generate(input, effective, {
        imports,
        lookups: lookups ? "data" : "literal",
        project: session?.project?.name,
        region: session?.region,
        cloud: cli.data?.cloud_id,
        date: localDate(),
      }),
    [input, effective, imports, lookups, session?.project?.name, session?.region, cli.data?.cloud_id],
  );

  const toggle = (kind: TfKind, id: string) =>
    setSel((s) => {
      const next = { ...s, [kind]: new Set(s[kind]) };
      if (next[kind].has(id)) next[kind].delete(id);
      else next[kind].add(id);
      return next;
    });
  const setMany = (kind: TfKind, ids: string[], v: boolean) =>
    setSel((s) => {
      const next = { ...s, [kind]: new Set(s[kind]) };
      for (const id of ids) {
        if (v) next[kind].add(id);
        else next[kind].delete(id);
      }
      return next;
    });

  const netName = (id: string) => input.networks.find((n) => n.id === id)?.name ?? id.slice(0, 8);
  const items: Record<TfKind, Item[] | undefined> = {
    servers: full(servers)?.map((s) => ({ id: s.id, name: s.name, sub: [s.status, s.flavor.original_name, serverIps(s).filter((x) => !x.floating).map((x) => x.addr)[0]].filter(Boolean).join(" · ") })),
    volumes: full(volumes)?.map((v) => ({ id: v.id, name: v.name || v.id.slice(0, 13), sub: [fmtBytes(v.size * 1024 ** 3), v.status, v.volume_type].filter(Boolean).join(" · ") })),
    networks: full(networks)
      ?.filter((n) => n.project_id === pid && !n["router:external"])
      .map((n) => ({ id: n.id, name: n.name || n.id.slice(0, 13), sub: (full(subnets) ?? []).filter((s) => s.network_id === n.id).map((s) => s.cidr).join(", ") || tr("no subnets") })),
    routers: full(routers)?.map((r) => ({ id: r.id, name: r.name || r.id.slice(0, 13), sub: r.external_gateway_info ? tr("gateway to {net}", { net: netName(r.external_gateway_info.network_id) }) : tr("no gateway") })),
    secgroups: full(sgs)?.map((g) => ({ id: g.id, name: g.name, sub: tr("{n} rules", { n: g.security_group_rules?.length ?? 0 }) })),
    fips: full(fips)?.map((f) => ({ id: f.id, name: f.floating_ip_address, sub: f.fixed_ip_address ? `→ ${f.fixed_ip_address}` : tr("not associated") })),
    keypairs: keypairs.data?.map((k) => ({ id: k.name, name: k.name, sub: k.fingerprint })),
    clustertemplates: mgTemplates.data
      ?.filter((t) => t.project_id === pid)
      .map((t) => ({ id: t.uuid, name: t.name, sub: [t.coe, t.driver ?? "", t.network_driver].filter(Boolean).join(" · ") })),
    clusters: input.clusters?.map((c) => ({ id: c.uuid, name: c.name, sub: tr("{m} master(s), {n} worker(s)", { m: c.master_count, n: c.node_count }) })),
  };
  const sections: { kind: TfKind; icon: string; title: string; q: { isPending: boolean; error: unknown; partial?: boolean } }[] = [
    { kind: "servers", icon: "server", title: tr("Instances"), q: servers },
    { kind: "volumes", icon: "hard-drive", title: tr("Volumes"), q: volumes },
    { kind: "networks", icon: "network", title: tr("Networks (with subnets)"), q: { isPending: networks.isPending || subnets.isPending || !!networks.partial, error: networks.error ?? subnets.error } },
    { kind: "routers", icon: "router", title: tr("Routers (with interfaces)"), q: { isPending: routers.isPending || ports.isPending || !!ports.partial, error: routers.error ?? ports.error } },
    { kind: "secgroups", icon: "shield", title: tr("Security groups (with rules)"), q: sgs },
    { kind: "fips", icon: "globe", title: tr("Floating IPs"), q: fips },
    { kind: "keypairs", icon: "key-round", title: tr("Key pairs"), q: keypairs },
    ...(magnum
      ? [
          { kind: "clustertemplates" as const, icon: "file-code", title: tr("Kubernetes cluster templates"), q: mgTemplates },
          { kind: "clusters" as const, icon: "container", title: tr("Kubernetes clusters"), q: mgClusters },
        ]
      : []),
  ];
  const picked = KINDS.reduce((a, k) => a + sel[k].size, 0);
  const projectSlug = (session?.project?.name ?? "project").replace(/[^\w.-]+/g, "-");

  return (
    <>
      <PageHeader
        title={tr("Export to Terraform")}
        description={tr("Pick resources of this project and get Terraform (or OpenTofu) code for the OpenStack provider. With import blocks, terraform plan adopts the existing resources instead of creating copies, so you can manage what you built by hand as code.")}
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="space-y-3">
          {sections.map((s) => (
            <Section
              key={s.kind}
              kind={s.kind}
              icon={s.icon}
              title={s.title}
              items={items[s.kind]}
              loading={s.q.isPending || !!s.q.partial}
              error={s.q.error}
              sel={sel[s.kind]}
              auto={effective[s.kind]}
              onToggle={toggle}
              onSet={setMany}
            />
          ))}
        </div>
        <div className="space-y-3 lg:sticky lg:top-0">
          <Card>
            <div className="space-y-3">
              <Switch checked={imports} onChange={setImports} label={tr("Import blocks")} hint={tr("Adopt the existing resources (Terraform 1.5+, OpenTofu 1.6+). Off: apply creates new copies.")} />
              <Switch
                checked={lookups}
                onChange={setLookups}
                label={tr("Look up other resources by name")}
                hint={tr("What the code refers to but doesn't manage (external networks, images, shared subnets…) is read with data sources instead of fixed IDs; a variable holds the ID when a name isn't unique.")}
              />
              <Switch checked={deps} onChange={setDeps} label={tr("Add what they need")} hint={tr("An instance's key pair, security groups, project networks, volumes and floating IPs come along.")} />
            </div>
          </Card>
          {result.resources > 0 ? (
            <>
              <p className="text-sm text-muted">
                {tr("{n} resource(s) in main.tf.", { n: result.resources })} {imports && tr("Run terraform init, then terraform plan: it should list only imports.")}
              </p>
              {result.notes.length > 0 && (
                <ul className="space-y-1 rounded-md border border-led-amber/40 bg-led-amber/8 px-3 py-2 text-sm">
                  {result.notes.map((n) => (
                    <li key={n} className="flex gap-2">
                      <Icon name="warning" className="mt-0.5 size-4 shrink-0 text-led-amber" />
                      {n}
                    </li>
                  ))}
                </ul>
              )}
              <div className={cn("[&_pre]:max-h-[60vh]")}>
                <CodeBlock code={result.hcl} filename={`${projectSlug}-main.tf`} language="hcl" />
              </div>
            </>
          ) : (
            <Card>
              <p className="flex items-center gap-2 text-sm text-muted">
                <Icon name="file-code" className="size-4" />
                {picked ? tr("Nothing to export yet: the lists are still loading.") : tr("Pick resources on the left; the code appears here.")}
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
