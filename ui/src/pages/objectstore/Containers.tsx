/**
 * Object storage containers of the project's account (Swift API: OpenStack Swift or Ceph
 * RGW): usage, create (access, storage policy, versioning), settings (ACLs, versioning,
 * quotas, metadata) and delete (optionally with everything in it).
 */
import { useNewParam } from "@/lib/useTab";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { KeyValueEditor, type KvRow, fromRows, kvError, toRows } from "@/components/KeyValueEditor";
import { Picker } from "@/components/Picker";
import { Badge, Button, Card, ErrorNotice, Field, Icon, Input, PageHeader, Switch, Tabs } from "@/components/ui";
import { fmtBytes, fmtDate } from "@/lib/format";
import { type ContainerMeta, type SwiftContainer, type SwiftInfo, isPublic, swift, useContainerMeta, useSwiftContainers, useSwiftInfo } from "@/lib/swift";
import { cn } from "@/lib/utils";
import { tr, trx } from "@/lib/i18n";

const PUBLIC_ACL = ".r:*,.rlistings";
const GiB = 1024 ** 3;

export function useRefreshSwift() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["object-store"] });
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {sub && <div className="mt-1.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function UsageStats({ info }: { info?: SwiftInfo }) {
  const a = info?.account;
  const quota = a?.quota_bytes ?? null;
  const pct = quota ? Math.min(100, Math.round(((a?.bytes ?? 0) / quota) * 100)) : 0;
  return (
    <div className="mb-5 grid gap-3 sm:grid-cols-3">
      <Stat label={tr("Containers")} value={a?.containers != null ? a.containers.toLocaleString() : "—"} />
      <Stat label={tr("Objects")} value={a?.objects != null ? a.objects.toLocaleString() : "—"} />
      <Stat
        label={tr("Used")}
        value={fmtBytes(a?.bytes ?? null) ?? "—"}
        sub={
          quota ? (
            <>
              <div className="h-1.5 overflow-hidden rounded-full bg-ink/8">
                <div className={cn("h-full rounded-full", pct >= 90 ? "bg-led-red" : pct >= 75 ? "bg-led-amber" : "bg-cable")} style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-1">{tr("{pct}% of the {quota} quota", { pct, quota: fmtBytes(quota) ?? "" })}</p>
            </>
          ) : (
            tr("No account quota")
          )
        }
      />
    </div>
  );
}

export default function ObjectContainers() {
  const info = useSwiftInfo();
  const containers = useSwiftContainers();
  const navigate = useNavigate();
  const refresh = useRefreshSwift();
  const [creating, setCreating] = useState(false);
  useNewParam(setCreating);
  const [settings, setSettings] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SwiftContainer | null>(null);

  const columns: Column<SwiftContainer>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (c) => (
        <Link to={`/object-store/containers/${encodeURIComponent(c.name)}`} className="inline-flex max-w-full items-center gap-2 font-medium text-cable hover:underline">
          <Icon name="archive" className="size-4 shrink-0 text-muted" />
          <span className="truncate">{c.name}</span>
        </Link>
      ),
      value: (c) => c.name,
    },
    { key: "count", header: tr("Objects"), width: "8rem", cell: (c) => c.count.toLocaleString(), value: (c) => c.count },
    { key: "bytes", header: tr("Size"), width: "8rem", cell: (c) => fmtBytes(c.bytes), value: (c) => c.bytes, csv: (c) => c.bytes },
    { key: "modified", header: tr("Last modified"), width: "11rem", hideBelow: "md", cell: (c) => (c.last_modified ? fmtDate(c.last_modified) : "—"), value: (c) => c.last_modified ?? "" },
  ];

  return (
    <>
      <PageHeader
        title={tr("Object storage")}
        description={tr("Containers of objects (files) in this project's object storage account. Make a container public to serve its objects over plain HTTP, or share single objects with temporary links.")}
        actions={
          <>
            <Link to="/identity/ec2-credentials" className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-panel px-3.5 text-sm font-medium hover:bg-surface" title={tr("Access keys for S3 tools (aws, s3cmd, rclone)")}>
              <Icon name="key" />
              {tr("S3 credentials")}
            </Link>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              {tr("Create container")}
            </Button>
          </>
        }
      />
      <ErrorNotice error={info.error ?? containers.error} className="mb-4" />
      <UsageStats info={info.data} />
      <DataTable
        rows={containers.data}
        columns={columns}
        rowKey={(c) => c.name}
        loading={containers.isPending}
        tableId="object-containers"
        noun={tr("containers")}
        rowLabel={(c) => c.name}
        filterPlaceholder={tr("Filter containers")}
        empty={tr("No containers yet. Create one to start uploading files.")}
        onRefresh={refresh}
        refreshing={containers.isFetching || info.isFetching}
        onBulkDone={refresh}
        rowActions={(c) => [
          { label: tr("Open"), icon: "folder", onSelect: () => navigate(`/object-store/containers/${encodeURIComponent(c.name)}`) },
          { label: tr("Settings"), icon: "settings", onSelect: () => setSettings(c.name) },
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
            body: tr("Only empty containers are deleted here; open a container to delete its objects, or delete one container at a time with its contents."),
            check: (c) => (c.count > 0 ? tr("Not empty ({n} objects)", { n: c.count.toLocaleString() }) : true),
            run: (c) => swift.remove(c.name),
          },
        ]}
      />
      {creating && <CreateContainerDialog info={info.data} onClose={() => setCreating(false)} onDone={(n) => navigate(`/object-store/containers/${encodeURIComponent(n)}`)} />}
      {settings && <ContainerSettingsDialog name={settings} onClose={() => setSettings(null)} />}
      {deleting && <DeleteContainerDialog container={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

export function DeleteContainerDialog({ container, onClose, onDone }: { container: { name: string; count: number }; onClose: () => void; onDone?: () => void }) {
  const qc = useQueryClient();
  // Only the lists: the deleted container's own queries would refetch into 404s.
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["object-store", "containers"] });
    qc.invalidateQueries({ queryKey: ["object-store", "info"] });
  };
  const [everything, setEverything] = useState(false);
  const [typed, setTyped] = useState("");
  const needsAll = container.count > 0;
  return (
    <ActionDialog<{ deleted_objects: number }>
      onClose={onClose}
      danger
      title={tr("Delete container {name}?", { name: container.name })}
      submitLabel={tr("Delete container")}
      canSubmit={!needsAll || (everything && typed === container.name)}
      done={(r) => (r?.deleted_objects ? tr("Container and {n} objects deleted", { n: r.deleted_objects.toLocaleString() }) : tr("Container deleted"))}
      onDone={() => {
        refresh();
        onDone?.();
      }}
      run={() => swift.remove(container.name, needsAll)}
    >
      {needsAll ? (
        <>
          <p className="text-sm">{trx("It still holds {n} objects. Swift only deletes empty containers, so Rassvet deletes every object first.", { n: <strong>{container.count.toLocaleString()}</strong> })}</p>
          <Switch checked={everything} onChange={setEverything} label={tr("Delete every object in it")} hint={tr("This can't be undone; versioned copies in another container are kept.")} />
          {everything && (
            <Field label={tr("Type {name} to confirm", { name: container.name })}>
              {(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="font-mono text-[13px]" />}
            </Field>
          )}
        </>
      ) : (
        <p className="text-sm">{tr("The container is empty.")}</p>
      )}
    </ActionDialog>
  );
}

function policyOptions(info?: SwiftInfo) {
  return (info?.capabilities?.swift?.policies ?? []).map((p) => ({ value: p.name, label: p.name, description: [p.default && tr("default"), p.aliases && p.aliases !== p.name && p.aliases].filter(Boolean).join(" · ") || undefined }));
}

function CreateContainerDialog({ info, onClose, onDone }: { info?: SwiftInfo; onClose: () => void; onDone: (name: string) => void }) {
  const refresh = useRefreshSwift();
  const [name, setName] = useState("");
  const [pub, setPub] = useState(false);
  const [policy, setPolicy] = useState("");
  const [versions, setVersions] = useState(false);
  const [archive, setArchive] = useState("");
  const policies = policyOptions(info);
  const versioning = !info?.capabilities || "versioned_writes" in (info.capabilities ?? {}) || "object_versioning" in (info.capabilities ?? {});
  const n = name.trim();
  const nameError = n.includes("/") ? tr("Container names can't contain “/”") : n.length > 256 ? tr("At most 256 characters") : null;
  const archiveName = archive.trim() || `${n}-versions`;
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Create container")}
      submitLabel={tr("Create container")}
      canSubmit={!!n && !nameError && (!versions || archiveName !== n)}
      done={tr("Container {name} created", { name: n })}
      onDone={() => {
        refresh();
        onDone(n);
      }}
      run={() => swift.create(n, { public: pub, ...(policy ? { storage_policy: policy } : {}), ...(versions ? { history_location: archiveName } : {}) })}
    >
      <Field label={tr("Name")} hint={nameError ?? undefined}>
        {(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("backups")} className={cn(nameError && "border-led-red")} />}
      </Field>
      <Switch checked={pub} onChange={setPub} label={tr("Public")} hint={tr("Anyone with the URL can read objects and list the container, without a token.")} />
      {policies.length > 1 && (
        <Field label={tr("Storage policy")} hint={tr("Where and how the data is stored (replicas, erasure coding, SSD…). Can't be changed later.")}>
          {(id) => <Picker id={id} value={policy} onChange={setPolicy} options={[{ value: "", label: tr("Cloud default") }, ...policies]} />}
        </Field>
      )}
      {versioning && (
        <>
          <Switch checked={versions} onChange={setVersions} label={tr("Keep old versions")} hint={tr("Overwritten and deleted objects are copied to an archive container first.")} />
          {versions && (
            <Field label={tr("Archive container")} hint={tr("Created if it doesn't exist.")}>
              {(id) => <Input id={id} value={archive} onChange={(e) => setArchive(e.target.value)} placeholder={n ? `${n}-versions` : tr("backups-versions")} />}
            </Field>
          )}
        </>
      )}
    </ActionDialog>
  );
}

const SETTINGS_TABS = ["access", "versions", "quota", "metadata"] as const;

export function ContainerSettingsDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const meta = useContainerMeta(name);
  return meta.data ? <SettingsForm meta={meta.data} onClose={onClose} /> : (
    <ActionDialog onClose={onClose} title={tr("Settings of {name}", { name })} submitLabel={tr("Save")} canSubmit={false} run={async () => undefined}>
      <ErrorNotice error={meta.error} />
      {!meta.error && <p className="text-sm text-muted">{tr("Loading…")}</p>}
    </ActionDialog>
  );
}

function SettingsForm({ meta, onClose }: { meta: ContainerMeta; onClose: () => void }) {
  const refresh = useRefreshSwift();
  const [tab, setTab] = useState<(typeof SETTINGS_TABS)[number]>("access");
  const [pub, setPub] = useState(isPublic(meta.read_acl));
  const [readAcl, setReadAcl] = useState(meta.read_acl ?? "");
  const [writeAcl, setWriteAcl] = useState(meta.write_acl ?? "");
  const [advanced, setAdvanced] = useState(!!meta.read_acl && meta.read_acl !== PUBLIC_ACL);
  const [versions, setVersions] = useState(meta.history_location ?? meta.versions_location ?? "");
  const [qBytes, setQBytes] = useState(meta.quota_bytes != null ? String(+(meta.quota_bytes / GiB).toFixed(3)) : "");
  const [qCount, setQCount] = useState(meta.quota_count != null ? String(meta.quota_count) : "");
  const [rows, setRows] = useState<KvRow[]>(toRows(meta.metadata));
  const kvErr = kvError(rows);
  const keyErr = rows.some((r) => r.key.trim() && !/^[A-Za-z0-9_-]+$/.test(r.key.trim())) ? tr("Keys may contain letters, digits, “-” and “_” only") : null;
  const numErr = [qBytes, qCount].some((v) => v.trim() !== "" && !(Number(v) >= 0)) ? tr("Quotas must be positive numbers") : null;

  const body = () => {
    const b: Record<string, unknown> = {};
    const read = advanced ? readAcl.trim() : pub ? PUBLIC_ACL : "";
    if (read !== (meta.read_acl ?? "")) b.read_acl = read || null;
    if (writeAcl.trim() !== (meta.write_acl ?? "")) b.write_acl = writeAcl.trim() || null;
    if (versions.trim() !== (meta.history_location ?? meta.versions_location ?? "")) b.history_location = versions.trim() || null;
    const qb = qBytes.trim() === "" ? null : Math.round(Number(qBytes) * GiB);
    if (qb !== meta.quota_bytes) b.quota_bytes = qb;
    const qc = qCount.trim() === "" ? null : Math.round(Number(qCount));
    if (qc !== meta.quota_count) b.quota_count = qc;
    const after = fromRows(rows);
    const md: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(after)) if (meta.metadata[k] !== v) md[k] = v;
    for (const k of Object.keys(meta.metadata)) if (!(k in after)) md[k] = null;
    if (Object.keys(md).length) b.metadata = md;
    return b;
  };

  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={tr("Settings of {name}", { name: meta.name })}
      submitLabel={tr("Save")}
      canSubmit={!kvErr && !keyErr && !numErr && versions.trim() !== meta.name}
      done={tr("Container settings saved")}
      onDone={refresh}
      run={() => swift.update(meta.name, body())}
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "access", label: tr("Access") },
          { id: "versions", label: tr("Versioning") },
          { id: "quota", label: tr("Quota") },
          { id: "metadata", label: tr("Metadata") },
        ]}
      />
      {tab === "access" && (
        <div className="space-y-4">
          {!advanced && <Switch checked={pub} onChange={setPub} label={tr("Public")} hint={tr("Anyone with the URL can read objects and list the container, without a token.")} />}
          <Switch checked={advanced} onChange={setAdvanced} label={tr("Edit the ACLs directly")} hint={tr("Swift ACL syntax: .r:* (anyone), .rlistings, <project>:<user>, <project>:*, .r:<referrer>.")} />
          {advanced && (
            <Field label={tr("Read ACL")}>
              {(id) => <Input id={id} value={readAcl} onChange={(e) => setReadAcl(e.target.value)} placeholder=".r:*,.rlistings" className="font-mono text-[13px]" />}
            </Field>
          )}
          <Field label={tr("Write ACL")} hint={tr("Other projects or users that may upload and delete, e.g. 5b3f…:* for a whole project.")}>
            {(id) => <Input id={id} value={writeAcl} onChange={(e) => setWriteAcl(e.target.value)} placeholder={tr("project-id:*")} className="font-mono text-[13px]" />}
          </Field>
        </div>
      )}
      {tab === "versions" && (
        <Field label={tr("Archive container")} hint={tr("Empty turns versioning off (archived versions are kept). Created if it doesn't exist.")}>
          {(id) => <Input id={id} value={versions} onChange={(e) => setVersions(e.target.value)} placeholder={`${meta.name}-versions`} />}
        </Field>
      )}
      {tab === "quota" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("Size quota (GiB)")} hint={tr("Uploads beyond it are refused. Empty = none.")}>
            {(id) => <Input id={id} type="number" min={0} step="any" value={qBytes} onChange={(e) => setQBytes(e.target.value)} placeholder={tr("No limit")} />}
          </Field>
          <Field label={tr("Object count quota")}>{(id) => <Input id={id} type="number" min={0} value={qCount} onChange={(e) => setQCount(e.target.value)} placeholder={tr("No limit")} />}</Field>
        </div>
      )}
      {tab === "metadata" && (
        <>
          <KeyValueEditor rows={rows} onChange={setRows} keyPlaceholder={tr("key")} valuePlaceholder={tr("value")} empty={tr("No metadata.")} />
          {(kvErr || keyErr) && <p className="text-xs text-led-red">{kvErr ?? keyErr}</p>}
        </>
      )}
      {numErr && <p className="text-xs text-led-red">{numErr}</p>}
      <Card title={tr("Container")} className="mt-1">
        <p className="text-sm text-muted">
          {tr("{n} objects, {size}", { n: (meta.objects ?? 0).toLocaleString(), size: fmtBytes(meta.bytes ?? 0) ?? "" })}
          {meta.storage_policy && ` · ${tr("policy {name}", { name: meta.storage_policy })}`}
          {isPublic(meta.read_acl) && (
            <>
              {" "}
              <Badge>{tr("public")}</Badge>
            </>
          )}
        </p>
      </Card>
    </ActionDialog>
  );
}
