/**
 * Admin: Keystone federation (external identity / SSO) — identity providers and their
 * protocols, mapping rules, and service providers (Keystone-to-Keystone).
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Picker } from "@/components/Picker";
import { Badge, Button, Card, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Switch, Tabs, Textarea } from "@/components/ui";
import { useDomains } from "@/lib/identity";
import { os, useOsList } from "@/lib/os";
import { useTab } from "@/lib/useTab";
import { Enabled } from "./shared";
import { tr, trx } from "@/lib/i18n";

interface Idp {
  id: string;
  description?: string | null;
  enabled: boolean;
  domain_id?: string | null;
  remote_ids: string[];
  authorization_ttl?: number | null;
}
interface Protocol {
  id: string;
  mapping_id: string;
  remote_id_attribute?: string | null;
}
interface Mapping {
  id: string;
  schema_version?: string;
  rules: unknown[];
}
interface ServiceProvider {
  id: string;
  description?: string | null;
  enabled: boolean;
  auth_url: string;
  sp_url: string;
  relay_state_prefix?: string;
}
interface Group {
  id: string;
  name: string;
  domain_id: string;
}

const F = "OS-FEDERATION";
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TABS = ["providers", "mappings", "service-providers"] as const;

export default function Federation() {
  const [tab, setTab] = useTab(TABS, "providers");
  return (
    <>
      <PageHeader
        title={tr("Federation (SSO)")}
        description={tr("Let users sign in through an external identity provider (Keycloak, Azure AD / Entra ID, ADFS, Okta…) over OpenID Connect or SAML. An identity provider has one protocol per sign-in method; each protocol uses a mapping that turns the provider's claims into a Keystone user and groups (and so roles in projects).")}
      />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { id: "providers", label: tr("Identity providers") },
          { id: "mappings", label: tr("Mappings") },
          { id: "service-providers", label: tr("Service providers (K2K)") },
        ]}
      />
      {tab === "providers" && <Providers />}
      {tab === "mappings" && <Mappings />}
      {tab === "service-providers" && <ServiceProviders />}
    </>
  );
}

// =========================================================================== identity providers

function Providers() {
  const idps = useOsList<Idp>("identity", `${F}/identity_providers`, "identity_providers");
  const domains = useDomains();
  const domainName = (id?: string | null) => (id ? (domains.data?.find((d) => d.id === id)?.name ?? id) : "—");
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "protocols" | "delete"; i: Idp } | null>(null);
  const close = () => setOpen(null);
  const columns: Column<Idp>[] = [
    { key: "id", header: tr("Identity provider"), cell: (i) => <span className="font-medium">{i.id}</span>, value: (i) => i.id },
    { key: "enabled", header: tr("Status"), width: "7.5rem", cell: (i) => <Enabled enabled={i.enabled} />, value: (i) => (i.enabled ? "enabled" : "disabled") },
    { key: "remote", header: tr("Remote IDs"), hideBelow: "md", mono: true, cell: (i) => i.remote_ids.join(", ") || "—", value: (i) => i.remote_ids.join(", ") },
    { key: "domain", header: tr("Users' domain"), width: "10rem", hideBelow: "lg", cell: (i) => domainName(i.domain_id), value: (i) => domainName(i.domain_id) },
    { key: "description", header: tr("Description"), hideBelow: "xl", cell: (i) => <span className="text-muted">{i.description || "—"}</span>, value: (i) => i.description ?? "" },
  ];
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => setOpen({ kind: "create" })}>
          <Icon name="plus" />
          {tr("Add identity provider")}
        </Button>
        <p className="text-sm text-muted">{tr("Keystone also needs the matching Apache module (mod_auth_openidc or mod_shib) and the trusted dashboard set in keystone.conf.")}</p>
      </div>
      <ErrorNotice error={idps.error} className="mb-4" />
      <DataTable
        rows={idps.data}
        columns={columns}
        rowKey={(i) => i.id}
        loading={idps.isPending}
        tableId="admin-idps"
        noun={tr("identity providers")}
        rowLabel={(i) => i.id}
        empty={tr("No identity providers. Users can only sign in with Keystone passwords or application credentials.")}
        onRefresh={() => idps.refetch()}
        refreshing={idps.isFetching}
        rowActions={(i) => [
          { label: tr("Protocols"), icon: "plug", onSelect: () => setOpen({ kind: "protocols", i }) },
          { label: tr("Edit"), icon: "edit", onSelect: () => setOpen({ kind: "edit", i }) },
          "-",
          { label: tr("Delete"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", i }) },
        ]}
      />
      {open?.kind === "create" && <IdpDialog onClose={close} />}
      {open?.kind === "edit" && <IdpDialog i={open.i} onClose={close} />}
      {open?.kind === "protocols" && <ProtocolsDialog idp={open.i} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete identity provider {id}?", { id: open.i.id })}
          submitLabel={tr("Delete")}
          done={tr("Identity provider deleted")}
          refresh={["identity"]}
          run={() => os.del("identity", `${F}/identity_providers/${open.i.id}`)}
        >
          <p className="text-sm">{tr("Its protocols are deleted too and federated users can no longer sign in through it. Their shadow users and role assignments stay.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function IdpDialog({ i, onClose }: { i?: Idp; onClose: () => void }) {
  const domains = useDomains();
  const [id, setId] = useState(i?.id ?? "");
  const [description, setDescription] = useState(i?.description ?? "");
  const [remote, setRemote] = useState((i?.remote_ids ?? []).join("\n"));
  const [domain, setDomain] = useState(i?.domain_id ?? "");
  const [enabled, setEnabled] = useState(i?.enabled ?? true);
  const [ttl, setTtl] = useState(i?.authorization_ttl != null ? String(i.authorization_ttl) : "");
  const remoteIds = remote
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={i ? tr("Edit {id}", { id: i.id }) : tr("Add identity provider")}
      submitLabel={i ? tr("Save") : tr("Add")}
      canSubmit={ID_RE.test(id.trim())}
      done={i ? tr("Identity provider updated") : tr("Identity provider {id} added", { id })}
      refresh={["identity"]}
      run={() => {
        const body = {
          identity_provider: {
            description: description || null,
            remote_ids: remoteIds,
            enabled,
            ...(ttl ? { authorization_ttl: Number(ttl) } : {}),
            ...(!i && domain ? { domain_id: domain } : {}),
          },
        };
        return i ? os.patch("identity", `${F}/identity_providers/${i.id}`, body) : os.put("identity", `${F}/identity_providers/${id.trim()}`, body);
      }}
    >
      <Field label="ID" hint={i ? tr("The ID can't change.") : tr("Short name used in URLs, e.g. keycloak.")}>
        {(x) => <Input id={x} autoFocus={!i} disabled={!!i} value={id} onChange={(e) => setId(e.target.value)} className="font-mono text-[13px]" />}
      </Field>
      <Field label={tr("Remote IDs")} hint={tr("One per line: the OIDC issuer URL or SAML entity ID the provider sends. Keystone matches it against the protocol's remote ID attribute.")}>
        {(x) => <Textarea id={x} rows={3} value={remote} onChange={(e) => setRemote(e.target.value)} className="font-mono text-[13px]" placeholder="https://sso.example.com/realms/corp" />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Domain for its users")} hint={i ? tr("Set when the provider is created.") : tr("Optional; Keystone creates one when empty.")}>
          {(x) => (
            <Picker
              id={x}
              value={domain}
              onChange={setDomain}
              disabled={!!i}
              options={[{ value: "", label: tr("Create automatically") }, ...(domains.data ?? []).map((d) => ({ value: d.id, label: d.name }))]}
            />
          )}
        </Field>
        <Field label={tr("Authorization TTL (minutes)")} hint={tr("How long group memberships from the last sign-in count for app credentials and trusts.")}>
          {(x) => <Input id={x} type="number" min={0} value={ttl} onChange={(e) => setTtl(e.target.value)} />}
        </Field>
      </div>
      <Field label={tr("Description")}>{(x) => <Input id={x} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Switch checked={enabled} onChange={setEnabled} label={tr("Enabled")} />
    </ActionDialog>
  );
}

const PROTOCOL_HINTS: Record<string, string> = {
  openid: tr("OpenID Connect (mod_auth_openidc) — remote ID attribute usually HTTP_OIDC_ISS"),
  saml2: tr("SAML 2.0 (mod_shib / mod_auth_mellon) — remote ID attribute usually Shib-Identity-Provider"),
  mapped: tr("Generic mapped plugin (any Apache auth module)"),
  x509: tr("Client TLS certificates"),
};

function ProtocolsDialog({ idp, onClose }: { idp: Idp; onClose: () => void }) {
  const protocols = useOsList<Protocol>("identity", `${F}/identity_providers/${idp.id}/protocols`, "protocols");
  const mappings = useOsList<Mapping>("identity", `${F}/mappings`, "mappings");
  const [edit, setEdit] = useState<Protocol | "new" | null>(null);
  const [del, setDel] = useState<Protocol | null>(null);
  return (
    <ActionDialog onClose={onClose} size="lg" title={tr("Protocols of {id}", { id: idp.id })} description={tr("One protocol per way of signing in. Each picks the mapping that turns the provider's claims into Keystone users and groups.")} submitLabel={tr("Done")} run={async () => undefined}>
      <ul className="divide-y divide-line rounded-md border border-line">
        {(protocols.data ?? []).map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
            <Badge tone="accent">{p.id}</Badge>
            <span className="min-w-0 flex-1 truncate">
              {tr("mapping")}{" "}<Mono>{p.mapping_id}</Mono>
              {p.remote_id_attribute && (
                <span className="text-muted">
                  {tr("· attribute")}{" "}<Mono>{p.remote_id_attribute}</Mono>
                </span>
              )}
            </span>
            <Button type="button" variant="ghost" className="h-8" onClick={() => setEdit(p)}>
              {tr("Edit")}
            </Button>
            <Button type="button" variant="ghost" className="h-8 text-led-red" onClick={() => setDel(p)}>
              {tr("Delete")}
            </Button>
          </li>
        ))}
        {protocols.data?.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">{tr("No protocols yet; nobody can sign in through this provider.")}</li>}
        {protocols.isPending && <li className="px-3 py-4 text-center text-sm text-muted">{tr("Loading…")}</li>}
      </ul>
      <div>
        <Button type="button" onClick={() => setEdit("new")} disabled={!mappings.data?.length}>
          <Icon name="plus" />
          {tr("Add protocol")}
        </Button>
        {mappings.data?.length === 0 && <p className="mt-2 text-xs text-muted">{tr("Create a mapping first (Mappings tab).")}</p>}
      </div>
      <ErrorNotice error={protocols.error} />
      {edit && <ProtocolDialog idp={idp} p={edit === "new" ? undefined : edit} mappings={mappings.data ?? []} onClose={() => setEdit(null)} />}
      {del && (
        <ActionDialog
          onClose={() => setDel(null)}
          danger
          title={tr("Delete protocol {id}?", { id: del.id })}
          submitLabel={tr("Delete")}
          done={tr("Protocol deleted")}
          refresh={["identity"]}
          run={() => os.del("identity", `${F}/identity_providers/${idp.id}/protocols/${del.id}`)}
        >
          <p className="text-sm">{trx("Users can no longer sign in to {id} with {id2}.", { id: idp.id, id2: del.id })}</p>
        </ActionDialog>
      )}
    </ActionDialog>
  );
}

function ProtocolDialog({ idp, p, mappings, onClose }: { idp: Idp; p?: Protocol; mappings: Mapping[]; onClose: () => void }) {
  const [id, setId] = useState(p?.id ?? "openid");
  const [mapping, setMapping] = useState(p?.mapping_id ?? mappings[0]?.id ?? "");
  const [attr, setAttr] = useState(p?.remote_id_attribute ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      title={p ? tr("Edit protocol {id}", { id: p.id }) : tr("Add a protocol to {id}", { id: idp.id })}
      submitLabel={p ? tr("Save") : tr("Add protocol")}
      canSubmit={ID_RE.test(id) && !!mapping}
      done={tr("Protocol saved")}
      refresh={["identity"]}
      run={() => {
        const body = { protocol: { mapping_id: mapping, ...(attr.trim() ? { remote_id_attribute: attr.trim() } : {}) } };
        const path = `${F}/identity_providers/${idp.id}/protocols/${p?.id ?? id}`;
        return p ? os.patch("identity", path, body) : os.put("identity", path, body);
      }}
    >
      <Field label={tr("Protocol")} hint={PROTOCOL_HINTS[id]}>
        {(x) =>
          p ? (
            <Input id={x} value={id} disabled className="font-mono text-[13px]" />
          ) : (
            <Picker
              id={x}
              value={id}
              onChange={setId}
              options={Object.keys(PROTOCOL_HINTS).map((k) => ({ value: k, label: k, description: PROTOCOL_HINTS[k] }))}
            />
          )
        }
      </Field>
      <Field label={tr("Mapping")}>{(x) => <Picker id={x} value={mapping} onChange={setMapping} options={mappings.map((m) => ({ value: m.id, label: m.id, meta: tr("{length} rules", { length: m.rules.length }) }))} />}</Field>
      <Field label={tr("Remote ID attribute")} hint={tr("Optional. Overrides keystone.conf's remote_id_attribute for this protocol.")}>
        {(x) => <Input id={x} value={attr} onChange={(e) => setAttr(e.target.value)} className="font-mono text-[13px]" placeholder={id === "saml2" ? tr("Shib-Identity-Provider") : "HTTP_OIDC_ISS"} />}
      </Field>
    </ActionDialog>
  );
}

// =========================================================================== mappings

const TEMPLATES: Record<string, { label: string; rules: unknown[] }> = {
  oidcGroup: {
    label: tr("OIDC: everyone into one group"),
    rules: [
      {
        local: [{ user: { name: "{0}", email: "{1}" } }, { group: { name: "federated-users", domain: { name: "Default" } } }],
        remote: [{ type: "OIDC-preferred_username" }, { type: "OIDC-email" }],
      },
    ],
  },
  oidcClaimGroups: {
    label: tr("OIDC: groups from the provider's 'groups' claim"),
    rules: [
      {
        local: [{ user: { name: "{0}" } }, { groups: "{1}", domain: { name: "Default" } }],
        remote: [{ type: "OIDC-preferred_username" }, { type: "OIDC-groups" }],
      },
    ],
  },
  samlAdmins: {
    label: tr("SAML: admins by group membership"),
    rules: [
      {
        local: [{ user: { name: "{0}" } }, { group: { name: "cloud-admins", domain: { name: "Default" } } }],
        remote: [{ type: "NameID" }, { type: "groups", any_one_of: ["OpenStack-Admins"] }],
      },
    ],
  },
  ephemeralProject: {
    label: tr("Auto-provision: a project per user with the member role"),
    rules: [
      {
        local: [{ user: { name: "{0}" }, projects: [{ name: "{0}-project", roles: [{ name: "member" }] }] }],
        remote: [{ type: "OIDC-preferred_username" }],
      },
    ],
  },
};

function Mappings() {
  const mappings = useOsList<Mapping>("identity", `${F}/mappings`, "mappings");
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "delete"; m: Mapping } | null>(null);
  const close = () => setOpen(null);
  const columns: Column<Mapping>[] = [
    { key: "id", header: tr("Mapping"), cell: (m) => <span className="font-medium">{m.id}</span>, value: (m) => m.id },
    { key: "rules", header: tr("Rules"), width: "6rem", className: "text-right", cell: (m) => m.rules.length, value: (m) => m.rules.length },
    { key: "schema", header: tr("Schema"), width: "7rem", hideBelow: "md", cell: (m) => m.schema_version ?? "1.0", value: (m) => m.schema_version ?? "" },
  ];
  return (
    <>
      <div className="mb-4">
        <Button variant="primary" onClick={() => setOpen({ kind: "create" })}>
          <Icon name="plus" />
          {tr("Create mapping")}
        </Button>
      </div>
      <ErrorNotice error={mappings.error} className="mb-4" />
      <DataTable
        rows={mappings.data}
        columns={columns}
        rowKey={(m) => m.id}
        loading={mappings.isPending}
        tableId="admin-mappings"
        noun={tr("mappings")}
        rowLabel={(m) => m.id}
        empty={tr("No mappings.")}
        onRefresh={() => mappings.refetch()}
        refreshing={mappings.isFetching}
        rowActions={(m) => [
          { label: tr("Edit rules"), icon: "edit", onSelect: () => setOpen({ kind: "edit", m }) },
          "-",
          { label: tr("Delete"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", m }) },
        ]}
      />
      {open?.kind === "create" && <MappingDialog onClose={close} />}
      {open?.kind === "edit" && <MappingDialog m={open.m} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete mapping {id}?", { id: open.m.id })}
          submitLabel={tr("Delete")}
          done={tr("Mapping deleted")}
          refresh={["identity"]}
          run={() => os.del("identity", `${F}/mappings/${open.m.id}`)}
        >
          <p className="text-sm">{tr("Keystone refuses while a protocol still uses it.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function MappingDialog({ m, onClose }: { m?: Mapping; onClose: () => void }) {
  const groups = useQuery({
    queryKey: ["os", "identity", "groups"],
    queryFn: () => os.get<{ groups: Group[] }>("identity", "groups").then((r) => r.groups),
  });
  const [id, setId] = useState(m?.id ?? "");
  const [text, setText] = useState(() => JSON.stringify(m?.rules ?? TEMPLATES.oidcGroup.rules, null, 2));
  const parsed = useMemo(() => {
    try {
      const v = JSON.parse(text);
      if (!Array.isArray(v)) return { error: tr("Rules must be a JSON array.") };
      const bad = v.findIndex((r) => !r || typeof r !== "object" || !Array.isArray(r.local) || !Array.isArray(r.remote));
      if (bad >= 0) return { error: tr("Rule {v} needs \"local\" and \"remote\" arrays.", { v: bad + 1 }) };
      return { rules: v as unknown[] };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [text]);
  return (
    <ActionDialog
      onClose={onClose}
      size="xl"
      title={m ? tr("Edit mapping {id}", { id: m.id }) : tr("Create mapping")}
      description={tr("Rules match the provider's attributes (remote) and say which Keystone user and groups they become (local). {0}, {1}… refer to the remote values in order.")}
      submitLabel={m ? tr("Save") : tr("Create mapping")}
      canSubmit={ID_RE.test(id.trim()) && !!parsed.rules}
      done={tr("Mapping saved")}
      refresh={["identity"]}
      run={() => {
        const body = { mapping: { rules: parsed.rules } };
        return m ? os.patch("identity", `${F}/mappings/${m.id}`, body) : os.put("identity", `${F}/mappings/${id.trim()}`, body);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="ID">{(x) => <Input id={x} autoFocus={!m} disabled={!!m} value={id} onChange={(e) => setId(e.target.value)} className="font-mono text-[13px]" placeholder={tr("keycloak-map")} />}</Field>
        <Field label={tr("Start from a template")}>
          {(x) => (
            <Picker
              id={x}
              value=""
              onChange={(k) => k && setText(JSON.stringify(TEMPLATES[k].rules, null, 2))}
              placeholder={tr("Choose a template…")}
              options={Object.entries(TEMPLATES).map(([k, t]) => ({ value: k, label: t.label }))}
            />
          )}
        </Field>
      </div>
      <Field label={tr("Rules (JSON)")}>
        {(x) => <Textarea id={x} rows={16} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[12.5px] leading-5" />}
      </Field>
      {parsed.error ? <p className="text-sm text-led-red">{parsed.error}</p> : <p className="text-xs text-muted">{trx("{length} rule(s), valid JSON.", { length: parsed.rules!.length })}</p>}
      {(groups.data?.length ?? 0) > 0 && (
        <Card title={tr("Groups you can map to")}>
          <ul className="flex flex-wrap gap-1.5">
            {groups.data!.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  title={tr("Insert {\"group\": {\"id\": \"{id}\"}}", { id: g.id })}
                  onClick={() => navigator.clipboard?.writeText(`{"group": {"id": "${g.id}"}}`)}
                  className="rounded-md border border-line px-2 py-1 text-xs hover:border-cable hover:text-cable"
                >
                  {g.name} <span className="font-mono text-muted">{g.id.slice(0, 8)}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">{tr("Click to copy a group rule. Give groups roles on projects in Projects → Members.")}</p>
        </Card>
      )}
    </ActionDialog>
  );
}

// =========================================================================== service providers

function ServiceProviders() {
  const sps = useOsList<ServiceProvider>("identity", `${F}/service_providers`, "service_providers");
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "delete"; s: ServiceProvider } | null>(null);
  const close = () => setOpen(null);
  const columns: Column<ServiceProvider>[] = [
    { key: "id", header: tr("Service provider"), cell: (s) => <span className="font-medium">{s.id}</span>, value: (s) => s.id },
    { key: "enabled", header: tr("Status"), width: "7.5rem", cell: (s) => <Enabled enabled={s.enabled} />, value: (s) => (s.enabled ? "enabled" : "disabled") },
    { key: "auth", header: tr("Auth URL"), hideBelow: "md", mono: true, cell: (s) => s.auth_url, value: (s) => s.auth_url },
    { key: "sp", header: tr("SP URL"), hideBelow: "lg", mono: true, cell: (s) => s.sp_url, value: (s) => s.sp_url },
  ];
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => setOpen({ kind: "create" })}>
          <Icon name="plus" />
          {tr("Add service provider")}
        </Button>
        <p className="text-sm text-muted">{tr("Other Keystones (clouds) your users can reach with their token from this cloud (Keystone-to-Keystone federation).")}</p>
      </div>
      <ErrorNotice error={sps.error} className="mb-4" />
      <DataTable
        rows={sps.data}
        columns={columns}
        rowKey={(s) => s.id}
        loading={sps.isPending}
        tableId="admin-sps"
        noun={tr("service providers")}
        rowLabel={(s) => s.id}
        empty={tr("No service providers.")}
        onRefresh={() => sps.refetch()}
        refreshing={sps.isFetching}
        rowActions={(s) => [
          { label: tr("Edit"), icon: "edit", onSelect: () => setOpen({ kind: "edit", s }) },
          "-",
          { label: tr("Delete"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", s }) },
        ]}
      />
      {open?.kind === "create" && <SpDialog onClose={close} />}
      {open?.kind === "edit" && <SpDialog s={open.s} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete service provider {id}?", { id: open.s.id })}
          submitLabel={tr("Delete")}
          done={tr("Service provider deleted")}
          refresh={["identity"]}
          run={() => os.del("identity", `${F}/service_providers/${open.s.id}`)}
        >
          <p className="text-sm">{tr("Users can no longer get tokens for that cloud from here.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function SpDialog({ s, onClose }: { s?: ServiceProvider; onClose: () => void }) {
  const [id, setId] = useState(s?.id ?? "");
  const [authUrl, setAuthUrl] = useState(s?.auth_url ?? "");
  const [spUrl, setSpUrl] = useState(s?.sp_url ?? "");
  const [relay, setRelay] = useState(s?.relay_state_prefix ?? "");
  const [description, setDescription] = useState(s?.description ?? "");
  const [enabled, setEnabled] = useState(s?.enabled ?? true);
  const urlOk = (u: string) => /^https?:\/\/\S+$/.test(u.trim());
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={s ? tr("Edit {id}", { id: s.id }) : tr("Add service provider")}
      submitLabel={s ? tr("Save") : tr("Add")}
      canSubmit={ID_RE.test(id.trim()) && urlOk(authUrl) && urlOk(spUrl)}
      done={tr("Service provider saved")}
      refresh={["identity"]}
      run={() => {
        const body = { service_provider: { auth_url: authUrl.trim(), sp_url: spUrl.trim(), description: description || null, enabled, ...(relay.trim() ? { relay_state_prefix: relay.trim() } : {}) } };
        return s ? os.patch("identity", `${F}/service_providers/${s.id}`, body) : os.put("identity", `${F}/service_providers/${id.trim()}`, body);
      }}
    >
      <Field label="ID">{(x) => <Input id={x} autoFocus={!s} disabled={!!s} value={id} onChange={(e) => setId(e.target.value)} className="font-mono text-[13px]" placeholder={tr("cloud-b")} />}</Field>
      <Field label={tr("Auth URL")} hint={tr("The remote Keystone's federated auth endpoint.")}>
        {(x) => <Input id={x} value={authUrl} onChange={(e) => setAuthUrl(e.target.value)} className="font-mono text-[13px]" placeholder="https://keystone.b.example/v3/OS-FEDERATION/identity_providers/cloud-a/protocols/saml2/auth" />}
      </Field>
      <Field label={tr("SP URL")} hint={tr("Its SAML ECP endpoint.")}>
        {(x) => <Input id={x} value={spUrl} onChange={(e) => setSpUrl(e.target.value)} className="font-mono text-[13px]" placeholder="https://keystone.b.example/Shibboleth.sso/SAML2/ECP" />}
      </Field>
      <Field label={tr("Relay state prefix")}>{(x) => <Input id={x} value={relay} onChange={(e) => setRelay(e.target.value)} placeholder="ss:mem:" />}</Field>
      <Field label={tr("Description")}>{(x) => <Input id={x} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Switch checked={enabled} onChange={setEnabled} label={tr("Enabled")} />
    </ActionDialog>
  );
}
