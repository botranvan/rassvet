/**
 * Barbican secrets: list (one page at a time), create (text, file or empty), and a detail
 * page that reveals the payload on demand, edits user metadata and the ACL.
 */
import { useState } from "react";
import { useParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { CodeBlock, CopyButton, copyText } from "@/components/CodeBlock";
import { type Column, DataTable } from "@/components/DataTable";
import { KeyValueEditor, type KvRow, fromRows, kvError, toRows } from "@/components/KeyValueEditor";
import { ActionMenu, type MenuEntry } from "@/components/Menu";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Badge, Button, Card, Detail, ErrorNotice, Field, Icon, Input, Mono, PageHeader, StatusDot, Tabs, Textarea } from "@/components/ui";
import {
  SECRET_TYPES,
  type Secret,
  type SecretType,
  base64Text,
  fileBase64,
  refId,
  secretTypeLabel,
  statusOf,
  storePayload,
  textBase64,
  useOffsetPaged,
  usePayload,
  useSecret,
} from "@/lib/barbican";
import { filters, text } from "@/lib/filters";
import { age, os, useInvalidate, useOsGet } from "@/lib/os";
import { fmtDate } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useTab } from "@/lib/useTab";
import { cn } from "@/lib/utils";
import { AclCard } from "./acl";
import { tr, trx } from "@/lib/i18n";

const secretName = (s: Pick<Secret, "name" | "id">) => s.name || s.id;
const algoText = (s: Pick<Secret, "algorithm" | "bit_length" | "mode">) => [s.algorithm, s.bit_length && `${s.bit_length} bit`, s.mode].filter(Boolean).join(" · ");
const expired = (iso?: string | null) => !!iso && new Date(iso.endsWith("Z") ? iso : `${iso}Z`).getTime() < Date.now();

/** Max secret size in Barbican's default configuration. */
const DEFAULT_MAX = 10_000;

export default function Secrets() {
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Secret | null>(null);
  const secrets = useOffsetPaged<Secret>("secrets", "secret_ref", {
    filters: filters(
      text("name", tr("Name"), "name", tr("Exact name")),
      { key: "type", label: tr("Type"), param: "secret_type", options: SECRET_TYPES.map((t) => ({ value: t.value, label: t.label })) },
      text("alg", tr("Algorithm"), "alg", "aes"),
      { key: "acl", label: tr("Shared with me"), param: () => ({ acl_only: "true" }), options: [{ value: "1", label: tr("Only secrets shared with me by ACL") }] },
    ),
    sort: { name: "name", created: "created", expiration: "expiration", type: "secret_type" },
    defaultSort: { key: "created", dir: -1 },
  });

  const columns: Column<Secret>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (s) => (
        <span className="flex min-w-0 flex-col">
          <Link to={`/key-manager/secrets/${s.id}`} className="truncate font-medium text-cable hover:underline">
            {secretName(s)}
          </Link>
          <span className="truncate font-mono text-xs text-muted">{s.id}</span>
        </span>
      ),
      value: (s) => s.name ?? "",
    },
    { key: "type", header: tr("Type"), width: "9rem", cell: (s) => secretTypeLabel(s.secret_type), value: (s) => s.secret_type },
    { key: "algorithm", header: tr("Algorithm"), width: "11rem", hideBelow: "lg", cell: (s) => algoText(s) || <span className="text-muted">—</span>, value: algoText },
    {
      key: "payload",
      header: tr("Payload"),
      width: "11rem",
      hideBelow: "md",
      cell: (s) => (s.content_types ? <span className="font-mono text-[12.5px]">{s.content_types.default}</span> : <Badge tone="warn">{tr("empty")}</Badge>),
      value: (s) => s.content_types?.default ?? "",
    },
    {
      key: "expiration",
      header: tr("Expires"),
      width: "10rem",
      hideBelow: "xl",
      cell: (s) => (s.expiration ? <span className={cn(expired(s.expiration) && "text-led-red")}>{fmtDate(s.expiration, false)}</span> : <span className="text-muted">{tr("Never")}</span>),
      value: (s) => s.expiration ?? "",
    },
    { key: "created", header: tr("Created"), width: "9rem", hideBelow: "sm", cell: (s) => <span title={fmtDate(s.created) ?? ""}>{age(s.created)}</span>, value: (s) => s.created },
    { key: "status", header: tr("Status"), width: "8.5rem", hideBelow: "lg", cell: (s) => <StatusDot status={statusOf(s.status)} label={s.status.toLowerCase()} />, value: (s) => s.status },
  ];

  return (
    <>
      <PageHeader
        title={tr("Secrets")}
        description={tr("Keys, passwords, certificates and other sensitive data stored by Barbican. Payloads are only shown when you ask for them; services such as Octavia and Cinder read them by reference.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Store a secret")}
          </Button>
        }
      />
      <ErrorNotice error={secrets.query.error} className="mb-4" />
      <DataTable
        rows={secrets.rows}
        remote={secrets.remote}
        columns={columns}
        rowKey={(s) => s.id}
        loading={secrets.query.isPending}
        tableId="secrets"
        noun={tr("secrets")}
        rowLabel={secretName}
        empty={tr("No secrets in this project.")}
        onRefresh={() => secrets.query.refetch()}
        refreshing={secrets.query.isFetching}
        onBulkDone={() => invalidate("key-manager")}
        rowActions={(s): MenuEntry[] => [
          { label: tr("View details"), icon: "eye", onSelect: () => navigate(`/key-manager/secrets/${s.id}`) },
          { label: tr("Copy secret reference"), icon: "copy", onSelect: () => copyText(s.secret_ref) },
          "-",
          { label: tr("Delete secret"), icon: "trash", danger: true, onSelect: () => setDeleting(s) },
        ]}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete secrets?"),
            past: tr("deleted"),
            body: tr("The payloads are destroyed. Anything still using them (load balancer certificates, encrypted volumes) breaks."),
            run: (s) => os.del("key-manager", `secrets/${s.id}`),
          },
        ]}
      />
      {creating && <CreateSecretDialog onClose={() => setCreating(false)} />}
      {deleting && <DeleteSecretDialog secret={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

function DeleteSecretDialog({ secret, onClose, onDone }: { secret: Pick<Secret, "id" | "name">; onClose: () => void; onDone?: () => void }) {
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Delete secret {name}?", { name: secretName(secret) })}
      submitLabel={tr("Delete secret")}
      done={tr("Secret deleted")}
      refresh={["key-manager"]}
      onDone={onDone}
      run={() => os.del("key-manager", `secrets/${secret.id}`)}
    >
      <p className="text-sm">{tr("The payload is destroyed and can't be recovered. Anything still using it (load balancer certificates, encrypted volumes) breaks.")}</p>
    </ActionDialog>
  );
}

// =========================================================================== create

type PayloadMode = "text" | "file" | "none";

/** Text or file → the payload fields of a create request (or of a later PUT). */
export function payloadFields(type: SecretType, mode: PayloadMode, textValue: string, isBase64: boolean, fileB64: string | null) {
  if (mode === "none") return { body: {}, put: null };
  if (mode === "file") return { body: { payload: fileB64, payload_content_type: "application/octet-stream", payload_content_encoding: "base64" }, put: { payload: fileB64 ?? "", encoding: "base64" as const } };
  if (isBase64) {
    const p = textValue.replace(/\s+/g, "");
    return { body: { payload: p, payload_content_type: "application/octet-stream", payload_content_encoding: "base64" }, put: { payload: p, encoding: "base64" as const } };
  }
  // PEM material is stored as binary (what Octavia and other consumers expect).
  if (type === "certificate" || type === "private" || type === "public") {
    const p = textBase64(textValue);
    return { body: { payload: p, payload_content_type: "application/octet-stream", payload_content_encoding: "base64" }, put: { payload: p, encoding: "base64" as const } };
  }
  return { body: { payload: textValue, payload_content_type: "text/plain" }, put: { payload: textValue, encoding: "text" as const } };
}

function PayloadInput({
  type,
  mode,
  setMode,
  value,
  setValue,
  isBase64,
  setBase64,
  file,
  setFile,
  allowNone,
}: {
  type: SecretType;
  mode: PayloadMode;
  setMode: (m: PayloadMode) => void;
  value: string;
  setValue: (v: string) => void;
  isBase64: boolean;
  setBase64: (b: boolean) => void;
  file: { name: string; b64: string; size: number } | null;
  setFile: (f: { name: string; b64: string; size: number } | null) => void;
  allowNone?: boolean;
}) {
  const pem = type === "certificate" || type === "private" || type === "public";
  const b64Bad = mode === "text" && isBase64 && value.trim() !== "" && !/^[A-Za-z0-9+/=\s]+$/.test(value);
  return (
    <div className="space-y-3">
      <Tabs
        value={mode}
        onChange={setMode}
        tabs={[
          { id: "text", label: tr("Text") },
          { id: "file", label: tr("File") },
          ...(allowNone ? [{ id: "none" as const, label: tr("No payload yet") }] : []),
        ]}
      />
      {mode === "text" && (
        <>
          <Textarea
            aria-label={tr("Payload")}
            rows={pem ? 8 : 4}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={pem ? "-----BEGIN CERTIFICATE-----\n…" : type === "symmetric" ? tr("Base64-encoded key") : tr("The secret value")}
            className={cn("font-mono text-[12.5px]", b64Bad && "border-led-red")}
            spellCheck={false}
            autoComplete="off"
          />
          {!pem && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isBase64} onChange={(e) => setBase64(e.target.checked)} className="size-4 accent-cable" />
              {tr("The text is base64-encoded binary data")}
            </label>
          )}
          {b64Bad && <p className="text-xs text-led-red">{tr("That isn't valid base64.")}</p>}
        </>
      )}
      {mode === "file" && (
        <div className="space-y-1.5">
          <input
            type="file"
            aria-label={tr("Payload file")}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              setFile(f ? { name: f.name, size: f.size, b64: await fileBase64(f) } : null);
            }}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-panel file:px-3 file:py-1.5 file:text-sm hover:file:bg-surface"
          />
          {file && file.size > DEFAULT_MAX && <p className="text-xs text-led-amber">{tr("Larger than Barbican's default limit (10 kB); the cloud may refuse it.")}</p>}
          <p className="text-xs text-muted">{tr("Stored as binary (application/octet-stream), e.g. a PKCS#12 bundle or a DER key.")}</p>
        </div>
      )}
      {mode === "none" && <p className="text-sm text-muted">{tr("Creates the secret's metadata only; add the payload later from its page.")}</p>}
    </div>
  );
}

function CreateSecretDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [type, setType] = useState<SecretType>("opaque");
  const [mode, setMode] = useState<PayloadMode>("text");
  const [value, setValue] = useState("");
  const [isBase64, setBase64] = useState(false);
  const [file, setFile] = useState<{ name: string; b64: string; size: number } | null>(null);
  const [algorithm, setAlgorithm] = useState("");
  const [bits, setBits] = useState("");
  const [modeAlg, setModeAlg] = useState("");
  const [expires, setExpires] = useState("");
  const b64 = isBase64 || type === "symmetric";
  const ready = mode === "none" || (mode === "text" ? value.trim() !== "" : !!file);
  const fields = payloadFields(type, mode, value, b64, file?.b64 ?? null);
  const expiresOk = !expires || new Date(expires).getTime() > Date.now();
  return (
    <ActionDialog<{ secret_ref: string }>
      onClose={onClose}
      size="lg"
      title={tr("Store a secret")}
      description={tr("The payload is encrypted by Barbican's backend (database KEK, HSM or Vault, depending on the cloud).")}
      submitLabel={tr("Store secret")}
      canSubmit={ready && expiresOk}
      done={tr("Secret stored")}
      refresh={["key-manager"]}
      onDone={(r) => navigate(`/key-manager/secrets/${refId(r.secret_ref)}`)}
      run={() =>
        os.post("key-manager", "secrets", {
          name: name.trim() || undefined,
          secret_type: type,
          ...(algorithm.trim() ? { algorithm: algorithm.trim() } : {}),
          ...(bits.trim() ? { bit_length: Number(bits) } : {}),
          ...(modeAlg.trim() ? { mode: modeAlg.trim() } : {}),
          ...(expires ? { expiration: new Date(expires).toISOString() } : {}),
          ...fields.body,
        })
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("db-password")} />}</Field>
        <Field label={tr("Secret type")}>
          {(id) => (
            <Picker
              id={id}
              value={type}
              onChange={(t) => {
                setType(t as SecretType);
                if (t === "symmetric") setAlgorithm((a) => a || "aes");
              }}
              options={SECRET_TYPES.map((t) => ({ value: t.value, label: t.label, description: t.description }))}
            />
          )}
        </Field>
      </div>
      <Field label={tr("Payload")}>
        {() => <PayloadInput type={type} mode={mode} setMode={setMode} value={value} setValue={setValue} isBase64={b64} setBase64={setBase64} file={file} setFile={setFile} allowNone />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={tr("Algorithm")} hint={tr("Informational, e.g. aes, rsa.")}>
          {(id) => <Input id={id} value={algorithm} onChange={(e) => setAlgorithm(e.target.value)} placeholder="aes" />}
        </Field>
        <Field label={tr("Bit length")}>{(id) => <Input id={id} type="number" min={1} value={bits} onChange={(e) => setBits(e.target.value)} placeholder="256" />}</Field>
        <Field label={tr("Mode")}>{(id) => <Input id={id} value={modeAlg} onChange={(e) => setModeAlg(e.target.value)} placeholder="cbc" />}</Field>
      </div>
      <Field label={tr("Expires")} hint={expiresOk ? tr("Optional. Barbican refuses to return the payload after this time.") : tr("Must be in the future.")}>
        {(id) => <Input id={id} type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} className="w-64" />}
      </Field>
    </ActionDialog>
  );
}

function AddPayloadDialog({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  const [mode, setMode] = useState<PayloadMode>("text");
  const [value, setValue] = useState("");
  const [isBase64, setBase64] = useState(secret.secret_type === "symmetric");
  const [file, setFile] = useState<{ name: string; b64: string; size: number } | null>(null);
  const fields = payloadFields(secret.secret_type, mode, value, isBase64, file?.b64 ?? null);
  const ready = mode === "text" ? value.trim() !== "" : !!file;
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Add the payload of {name}", { name: secretName(secret) })}
      description={tr("A payload can be stored only once; Barbican never changes it afterwards.")}
      submitLabel={tr("Store payload")}
      canSubmit={ready}
      done={tr("Payload stored")}
      refresh={["key-manager"]}
      run={() => storePayload(secret.id, fields.put!.payload, fields.put!.encoding)}
    >
      <PayloadInput type={secret.secret_type} mode={mode} setMode={setMode} value={value} setValue={setValue} isBase64={isBase64} setBase64={setBase64} file={file} setFile={setFile} />
    </ActionDialog>
  );
}

// =========================================================================== detail

const TABS = ["overview", "metadata", "access"] as const;

export function SecretDetail() {
  const { id = "" } = useParams();
  const session = useSession().data!;
  const navigate = useNavigate();
  const secret = useSecret(id);
  const [tab, setTab] = useTab(TABS, "overview");
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState(false);
  const s = secret.data;
  const owner = !!s && (s.creator_id === session.user.id || session.is_admin || !s.creator_id);
  return (
    <>
      <Link to="/key-manager/secrets" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Secrets")}
      </Link>
      <PageHeader
        title={s ? secretName(s) : tr("Secret")}
        description={s ? `${secretTypeLabel(s.secret_type)}${algoText(s) ? ` · ${algoText(s)}` : ""}` : undefined}
        actions={
          s && (
            <ActionMenu
              variant="button"
              items={() => [
                { label: tr("Copy secret reference"), icon: "copy", onSelect: () => copyText(s.secret_ref) },
                !s.content_types && { label: tr("Add payload"), icon: "upload", onSelect: () => setAdding(true) },
                "-",
                { label: tr("Delete secret"), icon: "trash", danger: true, onSelect: () => setDeleting(true) },
              ]}
            />
          )
        }
      />
      <ErrorNotice error={secret.error} className="mb-4" />
      {s && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "metadata", label: tr("Metadata") },
              { id: "access", label: tr("Access control") },
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <Card title={tr("Details")}>
                <dl>
                  <Detail label={tr("Name")}>{s.name || <span className="text-muted">{tr("(no name)")}</span>}</Detail>
                  <Detail label={tr("Reference")}>
                    <span className="flex min-w-0 items-center gap-2">
                      <Mono className="truncate">{s.secret_ref}</Mono>
                      <CopyButton text={s.secret_ref} label="" className="h-7 px-2" />
                    </span>
                  </Detail>
                  <Detail label={tr("Type")}>{secretTypeLabel(s.secret_type)}</Detail>
                  <Detail label={tr("Algorithm")}>{algoText(s) || "—"}</Detail>
                  <Detail label={tr("Status")}>
                    <StatusDot status={statusOf(s.status)} label={s.status.toLowerCase()} />
                  </Detail>
                  <Detail label={tr("Expires")}>{s.expiration ? <span className={cn(expired(s.expiration) && "text-led-red")}>{fmtDate(s.expiration)}</span> : tr("Never")}</Detail>
                  <Detail label={tr("Created")}>{fmtDate(s.created)}</Detail>
                  {s.creator_id && (
                    <Detail label={tr("Creator")}>{s.creator_id === session.user.id ? tr("{name} (you)", { name: session.user.name }) : <Mono>{s.creator_id}</Mono>}</Detail>
                  )}
                </dl>
              </Card>
              <PayloadCard secret={s} onAdd={() => setAdding(true)} />
            </div>
          )}
          {tab === "metadata" && <SecretMetadata id={s.id} />}
          {tab === "access" && <AclCard kind="secrets" id={s.id} owner={owner} />}
        </>
      )}
      {s && deleting && <DeleteSecretDialog secret={s} onClose={() => setDeleting(false)} onDone={() => navigate("/key-manager/secrets")} />}
      {s && adding && <AddPayloadDialog secret={s} onClose={() => setAdding(false)} />}
    </>
  );
}

function PayloadCard({ secret, onAdd }: { secret: Secret; onAdd: () => void }) {
  const [shown, setShown] = useState(false);
  const [asText, setAsText] = useState(true);
  const payload = usePayload(secret.id, shown);
  const p = payload.data;
  const decoded = p?.encoding === "base64" ? base64Text(p.payload) : null;
  const view = !p ? "" : p.encoding === "text" ? p.payload : asText && decoded !== null ? decoded : p.payload;
  const download = () => {
    if (!p) return;
    const bytes = p.encoding === "text" ? new TextEncoder().encode(p.payload) : Uint8Array.from(atob(p.payload), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: p.content_type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${secretName(secret)}${p.encoding === "text" ? ".txt" : ".bin"}` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Card
      title={tr("Payload")}
      actions={
        secret.content_types &&
        (shown ? (
          <span className="flex gap-2">
            {p?.encoding === "base64" && (
              <Button className="h-8" onClick={download}>
                <Icon name="download" />
                {tr("Download")}
              </Button>
            )}
            <Button className="h-8" onClick={() => setShown(false)}>
              <Icon name="eye-off" />
              {tr("Hide")}
            </Button>
          </span>
        ) : (
          <Button className="h-8" onClick={() => setShown(true)}>
            <Icon name="eye" />
            {tr("Show payload")}
          </Button>
        ))
      }
    >
      {!secret.content_types ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">{tr("This secret has no payload yet.")}</p>
          <Button onClick={onAdd}>
            <Icon name="upload" />
            {tr("Add payload")}
          </Button>
        </div>
      ) : !shown ? (
        <p className="text-sm text-muted">{trx("Stored as {ct}. Reading it is logged by Barbican and Rassvet.", { ct: <Mono>{secret.content_types.default}</Mono> })}</p>
      ) : (
        <>
          <ErrorNotice error={payload.error} className="mb-3" />
          {payload.isPending && <p className="text-sm text-muted">{tr("Loading…")}</p>}
          {p && (
            <div className="space-y-2">
              {p.encoding === "base64" && decoded !== null && (
                <Tabs
                  value={asText ? "text" : "b64"}
                  onChange={(v) => setAsText(v === "text")}
                  tabs={[
                    { id: "text", label: tr("As text") },
                    { id: "b64", label: tr("Base64") },
                  ]}
                />
              )}
              <CodeBlock code={view} filename={p.encoding === "base64" && !(asText && decoded !== null) ? `${p.content_type} (base64)` : p.content_type} />
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function SecretMetadata({ id }: { id: string }) {
  const meta = useOsGet<Record<string, string>>("key-manager", `secrets/${id}/metadata`, (r: { metadata: Record<string, string> }) => r.metadata ?? {});
  const toast = useToast();
  const invalidate = useInvalidate();
  const [rows, setRows] = useState<KvRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const current = rows ?? toRows(meta.data);
  const err = kvError(current);
  return (
    <Card
      title={tr("User metadata")}
      actions={
        rows && (
          <span className="flex gap-2">
            <Button className="h-8" onClick={() => setRows(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              variant="primary"
              className="h-8"
              busy={busy}
              disabled={!!err}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await os.put("key-manager", `secrets/${id}/metadata`, { metadata: fromRows(current) });
                  toast(tr("Metadata saved"));
                  setRows(null);
                  invalidate("key-manager");
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {tr("Save")}
            </Button>
          </span>
        )
      }
    >
      <ErrorNotice error={meta.error ?? error} className="mb-3" />
      <KeyValueEditor rows={current} onChange={setRows} keyPlaceholder={tr("key")} valuePlaceholder={tr("value")} empty={tr("No metadata.")} />
      {err && <p className="mt-2 text-xs text-led-red">{err}</p>}
      <p className="mt-3 text-xs text-muted">{tr("Free-form labels stored next to the secret (not encrypted). Keys are lowercase.")}</p>
    </Card>
  );
}
