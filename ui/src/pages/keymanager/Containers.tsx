/**
 * Barbican secret containers: named groups of secret references. "certificate" containers
 * (certificate + private key [+ passphrase, intermediates]) are what Octavia's TLS listeners
 * take; "rsa" holds a key pair; "generic" any set of secrets.
 */
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { CopyButton, copyText } from "@/components/CodeBlock";
import { type Column, DataTable } from "@/components/DataTable";
import { ActionMenu } from "@/components/Menu";
import { Picker } from "@/components/Picker";
import { Badge, Button, Card, Detail, ErrorNotice, Field, Icon, Input, Mono, PageHeader, StatusDot, Tabs, Textarea } from "@/components/ui";
import { type Secret, type SecretContainer, type SecretType, refId, secretTypeLabel, statusOf, useAllSecrets, useContainer, useOffsetPaged } from "@/lib/barbican";
import { filters, text } from "@/lib/filters";
import { fmtDate } from "@/lib/format";
import { age, os, useInvalidate } from "@/lib/os";
import { useSession } from "@/lib/session";
import { useTab } from "@/lib/useTab";
import { cn } from "@/lib/utils";
import { AclCard } from "./acl";
import { payloadFields } from "./Secrets";
import { tr } from "@/lib/i18n";

const cName = (c: Pick<SecretContainer, "name" | "id">) => c.name || c.id;

const TYPES: { value: SecretContainer["type"]; label: string; description: string }[] = [
  { value: "certificate", label: tr("Certificate"), description: tr("TLS certificate with its private key, for Octavia listeners") },
  { value: "rsa", label: tr("RSA key pair"), description: tr("Public and private key, optional passphrase") },
  { value: "generic", label: tr("Generic"), description: tr("Any secrets, each under a name you choose") },
];
const typeLabel = (t: string) => TYPES.find((x) => x.value === t)?.label ?? t;

/** Named slots of the typed containers: [slot, label, required]. */
const SLOTS: Record<"certificate" | "rsa", [string, string, boolean][]> = {
  certificate: [
    ["certificate", tr("Certificate"), true],
    ["private_key", tr("Private key"), false],
    ["private_key_passphrase", tr("Private key passphrase"), false],
    ["intermediates", tr("Intermediate certificates"), false],
  ],
  rsa: [
    ["public_key", tr("Public key"), true],
    ["private_key", tr("Private key"), true],
    ["private_key_passphrase", tr("Private key passphrase"), false],
  ],
};
/** Secret types that fit a slot (others still selectable, listed after). */
const SLOT_TYPES: Record<string, string[]> = {
  certificate: ["certificate", "opaque"],
  intermediates: ["certificate", "opaque"],
  private_key: ["private", "opaque"],
  public_key: ["public", "opaque"],
  private_key_passphrase: ["passphrase", "opaque"],
};

export default function SecretContainers() {
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<SecretContainer | null>(null);
  const list = useOffsetPaged<SecretContainer>("containers", "container_ref", {
    filters: filters(text("name", tr("Name"), "name", tr("Exact name")), { key: "type", label: tr("Type"), param: "type", options: TYPES.map((t) => ({ value: t.value, label: t.label })) }),
    sort: { name: "name", created: "created" },
    defaultSort: { key: "created", dir: -1 },
  });
  const columns: Column<SecretContainer>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <Link to={`/key-manager/containers/${c.id}`} className="truncate font-medium text-cable hover:underline">
            {cName(c)}
          </Link>
          <span className="truncate font-mono text-xs text-muted">{c.id}</span>
        </span>
      ),
      value: (c) => c.name ?? "",
    },
    { key: "type", header: tr("Type"), width: "9rem", cell: (c) => typeLabel(c.type), value: (c) => c.type },
    { key: "secrets", header: tr("Secrets"), hideBelow: "md", cell: (c) => c.secret_refs.map((r) => r.name).join(", ") || <span className="text-muted">{tr("none")}</span>, value: (c) => c.secret_refs.map((r) => r.name).join(", ") },
    {
      key: "consumers",
      header: tr("Used by"),
      width: "8rem",
      hideBelow: "lg",
      cell: (c) => (c.consumers?.length ? <Badge tone="accent">{tr("{n} consumer(s)", { n: c.consumers.length })}</Badge> : <span className="text-muted">{tr("unused")}</span>),
      value: (c) => c.consumers?.length ?? 0,
    },
    { key: "created", header: tr("Created"), width: "9rem", hideBelow: "sm", cell: (c) => <span title={fmtDate(c.created) ?? ""}>{age(c.created)}</span>, value: (c) => c.created },
    { key: "status", header: tr("Status"), width: "8.5rem", hideBelow: "xl", cell: (c) => <StatusDot status={statusOf(c.status)} label={c.status.toLowerCase()} />, value: (c) => c.status },
  ];
  return (
    <>
      <PageHeader
        title={tr("Secret containers")}
        description={tr("Groups of secrets referenced as one: a certificate with its key for a TLS load balancer listener, an RSA key pair, or any named set. Deleting a container keeps its secrets.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Create container")}
          </Button>
        }
      />
      <ErrorNotice error={list.query.error} className="mb-4" />
      <DataTable
        rows={list.rows}
        remote={list.remote}
        columns={columns}
        rowKey={(c) => c.id}
        loading={list.query.isPending}
        tableId="secret-containers"
        noun={tr("containers")}
        rowLabel={cName}
        empty={tr("No secret containers in this project.")}
        onRefresh={() => list.query.refetch()}
        refreshing={list.query.isFetching}
        onBulkDone={() => invalidate("key-manager")}
        rowActions={(c) => [
          { label: tr("View details"), icon: "eye", onSelect: () => navigate(`/key-manager/containers/${c.id}`) },
          { label: tr("Copy container reference"), icon: "copy", onSelect: () => copyText(c.container_ref) },
          "-",
          { label: tr("Delete container"), icon: "trash", danger: true, onSelect: () => setDeleting(c) },
        ]}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete containers?"),
            past: tr("deleted"),
            body: tr("Only the containers go; their secrets are kept."),
            check: (c) => (c.consumers?.length ? tr("In use by {n} consumer(s)", { n: c.consumers.length }) : true),
            run: (c) => os.del("key-manager", `containers/${c.id}`),
          },
        ]}
      />
      {creating && <CreateContainerDialog onClose={() => setCreating(false)} />}
      {deleting && <DeleteContainerDialog container={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

function DeleteContainerDialog({ container, onClose, onDone }: { container: SecretContainer; onClose: () => void; onDone?: () => void }) {
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Delete container {name}?", { name: cName(container) })}
      submitLabel={tr("Delete container")}
      done={tr("Container deleted")}
      refresh={["key-manager"]}
      onDone={onDone}
      run={() => os.del("key-manager", `containers/${container.id}`)}
    >
      <p className="text-sm">{tr("Its secrets are kept.")}</p>
      {!!container.consumers?.length && (
        <p className="mt-2 text-sm text-led-red">{tr("{n} consumer(s) still use it (e.g. a load balancer listener); they will fail to load the certificate.", { n: container.consumers.length })}</p>
      )}
    </ActionDialog>
  );
}

function secretOptions(secrets: (Secret & { id: string })[] | undefined, slot?: string) {
  const fit = slot ? SLOT_TYPES[slot] ?? [] : [];
  return (secrets ?? [])
    .slice()
    .sort((a, b) => Number(fit.includes(b.secret_type)) - Number(fit.includes(a.secret_type)))
    .map((s) => ({
      value: s.secret_ref,
      label: s.name || s.id,
      icon: "lock-keyhole",
      description: `${secretTypeLabel(s.secret_type)}${s.content_types ? "" : ` · ${tr("no payload")}`}`,
      group: slot ? (fit.includes(s.secret_type) ? tr("Matching type") : tr("Other secrets")) : undefined,
    }));
}

/** Where a slot's secret comes from: one already stored, or content pasted here (stored on submit). */
type Source = { mode: "existing" | "paste"; ref: string; text: string };
const EMPTY: Source = { mode: "existing", ref: "", text: "" };
const filled = (s?: Source) => !!s && (s.mode === "existing" ? !!s.ref : s.text.trim() !== "");
/** Secret type a pasted slot is stored as. */
const SLOT_SECRET_TYPE: Record<string, SecretType> = {
  certificate: "certificate",
  intermediates: "certificate",
  private_key: "private",
  public_key: "public",
  private_key_passphrase: "passphrase",
};
const PASTE_HINT: Record<string, string> = {
  certificate: "-----BEGIN CERTIFICATE-----\n…",
  intermediates: "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\n…",
  private_key: "-----BEGIN PRIVATE KEY-----\n…",
  public_key: "-----BEGIN PUBLIC KEY-----\n…",
};

function SecretSource({
  id,
  value,
  onChange,
  slot,
  secrets,
  clearable,
}: {
  id?: string;
  value: Source;
  onChange: (s: Source) => void;
  slot?: string;
  secrets: ReturnType<typeof useAllSecrets>;
  clearable?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div role="radiogroup" className="inline-flex rounded-md border border-line p-0.5 text-xs">
        {(["existing", "paste"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={value.mode === m}
            onClick={() => onChange({ ...value, mode: m })}
            className={cn("rounded px-2 py-0.5", value.mode === m ? "bg-surface font-medium text-ink" : "text-muted hover:text-ink")}
          >
            {m === "existing" ? tr("Existing secret") : tr("Paste content")}
          </button>
        ))}
      </div>
      {value.mode === "existing" ? (
        <Picker
          id={id}
          aria-label={tr("Secret")}
          value={value.ref}
          onChange={(v) => onChange({ ...value, ref: v })}
          clearable={clearable}
          searchable
          loading={secrets.isPending}
          placeholder={tr("Choose a secret")}
          options={secretOptions(secrets.data, slot)}
          emptyText={tr("No secrets yet. Paste the content instead.")}
        />
      ) : slot === "private_key_passphrase" ? (
        <Input id={id} type="password" autoComplete="off" value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} placeholder={tr("The passphrase")} />
      ) : (
        <Textarea
          id={id}
          aria-label={tr("Secret content")}
          rows={slot ? 6 : 3}
          value={value.text}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
          placeholder={(slot && PASTE_HINT[slot]) || tr("The secret value")}
          className="font-mono text-[12.5px]"
          spellCheck={false}
          autoComplete="off"
        />
      )}
    </div>
  );
}

function CreateContainerDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const secrets = useAllSecrets();
  const [name, setName] = useState("");
  const [type, setType] = useState<SecretContainer["type"]>("certificate");
  const [slots, setSlots] = useState<Record<string, Source>>({});
  const [generic, setGeneric] = useState<{ name: string; src: Source }[]>([{ name: "", src: EMPTY }]);
  const entries: { name: string; src: Source; secretType: SecretType }[] =
    type === "generic"
      ? generic
          .filter((g) => filled(g.src))
          .map((g) => ({
            name: g.name.trim() || (g.src.mode === "existing" && secrets.data?.find((s) => s.secret_ref === g.src.ref)?.name) || "secret",
            src: g.src,
            secretType: "opaque",
          }))
      : SLOTS[type].filter(([k]) => filled(slots[k])).map(([k]) => ({ name: k, src: slots[k], secretType: SLOT_SECRET_TYPE[k] }));
  const missing = type === "generic" ? false : SLOTS[type].some(([k, , req]) => req && !filled(slots[k]));
  const dupNames = type === "generic" && new Set(entries.map((r) => r.name)).size !== entries.length;
  const pasted = entries.filter((e) => e.src.mode === "paste").length;
  const run = async () => {
    // Pasted content is stored as new secrets first; if anything fails they're deleted again.
    const created: string[] = [];
    try {
      const base = name.trim() || "container";
      const refs: { name: string; secret_ref: string }[] = [];
      for (const e of entries) {
        if (e.src.mode === "existing") {
          refs.push({ name: e.name, secret_ref: e.src.ref });
          continue;
        }
        const s = await os.post<{ secret_ref: string }>("key-manager", "secrets", {
          name: `${base}-${e.name}`,
          secret_type: e.secretType,
          ...payloadFields(e.secretType, "text", e.src.text, false, null).body,
        });
        created.push(s.secret_ref);
        refs.push({ name: e.name, secret_ref: s.secret_ref });
      }
      return await os.post<{ container_ref: string }>("key-manager", "containers", { name: name.trim() || undefined, type, secret_refs: refs });
    } catch (err) {
      await Promise.allSettled(created.map((ref) => os.del("key-manager", `secrets/${refId(ref)}`)));
      throw err;
    }
  };
  return (
    <ActionDialog<{ container_ref: string }>
      onClose={onClose}
      size="md"
      title={tr("Create secret container")}
      description={pasted ? tr("Pasted content is stored as {n} new secret(s), named after the container.", { n: pasted }) : undefined}
      submitLabel={tr("Create container")}
      canSubmit={!missing && !dupNames && (type !== "generic" || entries.length > 0)}
      done={tr("Container created")}
      refresh={["key-manager"]}
      onDone={(r) => navigate(`/key-manager/containers/${refId(r.container_ref)}`)}
      run={run}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("www-example-com")} />}</Field>
        <Field label={tr("Type")}>
          {(id) => (
            <Picker
              id={id}
              value={type}
              onChange={(t) => {
                setType(t as SecretContainer["type"]);
                setSlots({});
              }}
              options={TYPES}
            />
          )}
        </Field>
      </div>
      {type === "generic" ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{tr("Secrets")}</p>
          {generic.map((g, i) => (
            <div key={i} className="flex items-start gap-2">
              <Input aria-label={tr("Name in the container")} value={g.name} onChange={(e) => setGeneric((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder={tr("name")} className="mt-7 w-36" />
              <div className="min-w-0 flex-1">
                <SecretSource value={g.src} onChange={(src) => setGeneric((l) => l.map((x, j) => (j === i ? { ...x, src } : x)))} secrets={secrets} />
              </div>
              <Button aria-label={tr("Remove")} className="mt-7 h-9 px-2" onClick={() => setGeneric((l) => (l.length > 1 ? l.filter((_, j) => j !== i) : [{ name: "", src: EMPTY }]))}>
                <Icon name="x" />
              </Button>
            </div>
          ))}
          <Button className="h-8" onClick={() => setGeneric((l) => [...l, { name: "", src: EMPTY }])}>
            <Icon name="plus" />
            {tr("Add a secret")}
          </Button>
          {dupNames && <p className="text-xs text-led-red">{tr("Each secret needs a different name.")}</p>}
        </div>
      ) : (
        SLOTS[type].map(([k, label, req]) => (
          <Field key={k} label={req ? label : `${label} ${tr("(optional)")}`}>
            {(id) => <SecretSource id={id} value={slots[k] ?? EMPTY} onChange={(v) => setSlots((s) => ({ ...s, [k]: v }))} slot={k} secrets={secrets} clearable={!req} />}
          </Field>
        ))
      )}
    </ActionDialog>
  );
}

// =========================================================================== detail

const TABS = ["overview", "access"] as const;

export function SecretContainerDetail() {
  const { id = "" } = useParams();
  const session = useSession().data!;
  const navigate = useNavigate();
  const container = useContainer(id);
  const secrets = useAllSecrets();
  const [tab, setTab] = useTab(TABS, "overview");
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ name: string; secret_ref: string } | null>(null);
  const c = container.data;
  const byRef = useMemo(() => new Map(secrets.data?.map((s) => [s.secret_ref, s])), [secrets.data]);
  const owner = !!c && (c.creator_id === session.user.id || session.is_admin || !c.creator_id);
  type Ref = { name: string; secret_ref: string };
  const cols: Column<Ref>[] = [
    { key: "slot", header: tr("Name in container"), width: "14rem", cell: (r) => <span className="font-mono text-[13px]">{r.name}</span>, value: (r) => r.name },
    {
      key: "secret",
      header: tr("Secret"),
      cell: (r) => (
        <Link to={`/key-manager/secrets/${refId(r.secret_ref)}`} className="text-cable hover:underline">
          {byRef.get(r.secret_ref)?.name || refId(r.secret_ref)}
        </Link>
      ),
      value: (r) => byRef.get(r.secret_ref)?.name ?? refId(r.secret_ref),
    },
    { key: "type", header: tr("Type"), width: "9rem", hideBelow: "md", cell: (r) => (byRef.get(r.secret_ref) ? secretTypeLabel(byRef.get(r.secret_ref)!.secret_type) : "—"), value: (r) => byRef.get(r.secret_ref)?.secret_type ?? "" },
  ];
  return (
    <>
      <Link to="/key-manager/containers" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Secret containers")}
      </Link>
      <PageHeader
        title={c ? cName(c) : tr("Secret container")}
        description={c ? typeLabel(c.type) : undefined}
        actions={
          c && (
            <ActionMenu
              variant="button"
              items={() => [
                { label: tr("Copy container reference"), icon: "copy", onSelect: () => copyText(c.container_ref) },
                "-",
                { label: tr("Delete container"), icon: "trash", danger: true, onSelect: () => setDeleting(true) },
              ]}
            />
          )
        }
      />
      <ErrorNotice error={container.error} className="mb-4" />
      {c && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "access", label: tr("Access control") },
            ]}
          />
          {tab === "overview" && (
            <div className="space-y-6">
              <div className="grid items-start gap-6 lg:grid-cols-2">
                <Card title={tr("Details")}>
                  <dl>
                    <Detail label={tr("Name")}>{c.name || <span className="text-muted">{tr("(no name)")}</span>}</Detail>
                    <Detail label={tr("Reference")}>
                      <span className="flex min-w-0 items-center gap-2">
                        <Mono className="truncate">{c.container_ref}</Mono>
                        <CopyButton text={c.container_ref} label="" className="h-7 px-2" />
                      </span>
                    </Detail>
                    <Detail label={tr("Type")}>{typeLabel(c.type)}</Detail>
                    <Detail label={tr("Status")}>
                      <StatusDot status={statusOf(c.status)} label={c.status.toLowerCase()} />
                    </Detail>
                    <Detail label={tr("Created")}>{fmtDate(c.created)}</Detail>
                  </dl>
                </Card>
                <Card title={tr("Consumers")}>
                  {c.consumers?.length ? (
                    <ul className="space-y-2 text-sm">
                      {c.consumers.map((x) => (
                        <li key={`${x.name}|${x.URL}`}>
                          <span className="font-medium">{x.name}</span>
                          <Mono className="block truncate text-muted">{x.URL}</Mono>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted">{tr("No service has registered as using this container.")}</p>
                  )}
                </Card>
              </div>
              <DataTable
                rows={c.secret_refs}
                columns={cols}
                rowKey={(r) => `${r.name}|${r.secret_ref}`}
                noun={tr("secrets")}
                empty={tr("No secrets in this container.")}
                onRefresh={() => container.refetch()}
                refreshing={container.isFetching}
                toolbar={
                  c.type === "generic" && (
                    <Button className="h-9" onClick={() => setAdding(true)}>
                      <Icon name="plus" />
                      {tr("Add a secret")}
                    </Button>
                  )
                }
                rowActions={
                  c.type === "generic"
                    ? (r) => [{ label: tr("Remove from container"), icon: "x", danger: true, onSelect: () => setRemoving(r) }]
                    : undefined
                }
              />
              {c.type !== "generic" && <p className="text-xs text-muted">{tr("Certificate and RSA containers can't be changed; create a new container to replace a secret.")}</p>}
            </div>
          )}
          {tab === "access" && <AclCard kind="containers" id={c.id} owner={owner} />}
        </>
      )}
      {c && deleting && <DeleteContainerDialog container={c} onClose={() => setDeleting(false)} onDone={() => navigate("/key-manager/containers")} />}
      {c && adding && <AddSecretDialog container={c} onClose={() => setAdding(false)} />}
      {c && removing && (
        <ActionDialog
          onClose={() => setRemoving(null)}
          danger
          title={tr("Remove {name} from the container?", { name: removing.name })}
          submitLabel={tr("Remove")}
          done={tr("Secret removed from the container")}
          refresh={["key-manager"]}
          run={() => os.del("key-manager", `containers/${c.id}/secrets`, undefined, removing)}
        >
          <p className="text-sm">{tr("The secret itself is kept.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function AddSecretDialog({ container, onClose }: { container: SecretContainer; onClose: () => void }) {
  const secrets = useAllSecrets();
  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const taken = container.secret_refs.some((r) => r.name === name.trim());
  const auto = secrets.data?.find((s) => s.secret_ref === ref)?.name ?? "";
  const finalName = name.trim() || auto || "secret";
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Add a secret to {name}", { name: cName(container) })}
      submitLabel={tr("Add secret")}
      canSubmit={!!ref && !taken}
      done={tr("Secret added")}
      refresh={["key-manager"]}
      run={() => os.post("key-manager", `containers/${container.id}/secrets`, { name: finalName, secret_ref: ref })}
    >
      <Field label={tr("Secret")}>
        {(id) => <Picker id={id} value={ref} onChange={setRef} searchable loading={secrets.isPending} placeholder={tr("Choose a secret")} options={secretOptions(secrets.data)} />}
      </Field>
      <Field label={tr("Name in the container")} hint={taken ? tr("That name is already used in this container.") : tr("Defaults to the secret's name.")}>
        {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={auto || tr("name")} />}
      </Field>
    </ActionDialog>
  );
}
