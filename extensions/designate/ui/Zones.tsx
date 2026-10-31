/** DNS zones (project and admin view) with their imports, exports and transfers, and the zone dialogs. */
import { useRef, useState } from "react";
import {
  ActionDialog,
  Badge,
  Button,
  type Column,
  CopyButton,
  DataTable,
  Dialog,
  ErrorNotice,
  Field,
  Icon,
  Input,
  Link,
  type MenuEntry,
  Mono,
  PageHeader,
  Picker,
  StatusDot,
  Tabs,
  Textarea,
  age,
  downloadText,
  fmtDate,
  tr,
  useInvalidate,
  useNavigate,
  useNewParam,
  useProjects,
  useSession,
  useTab,
} from "@rassvet/sdk";
import {
  BASE,
  DNS,
  type TransferRequest,
  type Zone,
  type ZoneExport,
  type ZoneImport,
  dns,
  dnsStatus,
  dot,
  exportFile,
  importZone,
  statusText,
  undot,
  useAll,
  useExports,
  useImports,
  useTransferRequests,
  useZones,
  zoneName,
} from "./api";

const TABS = ["zones", "imports", "exports", "transfers"] as const;

export default function Zones() {
  const { admin } = useAll();
  const [tab, setTab] = useTab(TABS, "zones");
  const [open, setOpen] = useState<"create" | "import" | "accept" | null>(null);
  useNewParam(() => setOpen("create"));
  const close = () => setOpen(null);
  return (
    <>
      <PageHeader
        title={admin ? tr("All DNS zones") : tr("DNS zones")}
        description={tr("Zones are domains whose records Designate publishes on its name servers. Point the domain's NS records at them at your registrar.")}
        actions={
          <>
            <Button onClick={() => setOpen("accept")}>
              <Icon name="inbox" />
              {tr("Accept transfer")}
            </Button>
            <Button onClick={() => setOpen("import")}>
              <Icon name="upload" />
              {tr("Import zone")}
            </Button>
            <Button variant="primary" onClick={() => setOpen("create")}>
              <Icon name="plus" />
              {tr("Create zone")}
            </Button>
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { id: "zones", label: tr("Zones") },
          { id: "imports", label: tr("Imports") },
          { id: "exports", label: tr("Exports") },
          { id: "transfers", label: tr("Transfer requests") },
        ]}
      />
      {tab === "zones" && <ZoneList />}
      {tab === "imports" && <Imports />}
      {tab === "exports" && <Exports />}
      {tab === "transfers" && <Transfers />}
      {open === "create" && <ZoneDialog onClose={close} />}
      {open === "import" && <ImportDialog onClose={close} onDone={() => setTab("imports")} />}
      {open === "accept" && <AcceptDialog onClose={close} />}
    </>
  );
}

// =========================================================================== zones

const ZoneStatus = ({ z }: { z: { status?: string; action?: string } }) => <StatusDot status={dnsStatus(z.status)} label={statusText(z)} />;

function ZoneList() {
  const { admin } = useAll();
  const zones = useZones();
  const projects = useProjects(admin);
  const invalidate = useInvalidate();
  const actions = useZoneActions();
  const projectName = (id?: string) => (id ? (projects.data?.find((p) => p.id === id)?.name ?? id) : "");
  const columns: Column<Zone>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (z) => (
        <div className="min-w-0">
          <Link to={`${admin ? "/admin" : ""}${BASE}/zones/${z.id}`} className="truncate font-medium text-cable hover:underline">
            {zoneName(z)}
          </Link>
          {z.description && <p className="truncate text-xs text-muted">{z.description}</p>}
        </div>
      ),
      value: (z) => `${z.name} ${z.id} ${z.description ?? ""}`,
      csv: (z) => z.name,
    },
    ...(admin
      ? [{ key: "project", header: tr("Project"), width: "9rem", hideBelow: "md" as const, cell: (z: Zone) => projectName(z.project_id), value: (z: Zone) => projectName(z.project_id) }]
      : []),
    {
      key: "type",
      header: tr("Type"),
      width: "9rem",
      wrap: true,
      cell: (z) => (
        <span className="flex flex-wrap gap-1">
          {z.type === "SECONDARY" ? <Badge tone="accent">{tr("Secondary")}</Badge> : <Badge>{tr("Primary")}</Badge>}
          {z.shared && <Badge tone="warn">{tr("Shared")}</Badge>}
        </span>
      ),
      value: (z) => z.type,
    },
    { key: "status", header: tr("Status"), width: "10rem", cell: (z) => <ZoneStatus z={z} />, value: (z) => statusText(z) },
    { key: "email", header: tr("Email"), width: "12rem", hideBelow: "lg", cell: (z) => z.email || "—", value: (z) => z.email ?? "" },
    { key: "ttl", header: "TTL", width: "6rem", hideBelow: "lg", className: "text-right", cell: (z) => z.ttl ?? "—", value: (z) => z.ttl ?? 0 },
    { key: "serial", header: tr("Serial"), width: "8rem", hideBelow: "xl", mono: true, cell: (z) => z.serial ?? "—", value: (z) => z.serial ?? 0 },
    { key: "age", header: tr("Age"), width: "7rem", hideBelow: "xl", cell: (z) => <span title={fmtDate(z.created_at) ?? ""}>{age(z.created_at)}</span>, value: (z) => z.created_at ?? "" },
  ];
  return (
    <>
      <ErrorNotice error={zones.error} className="mb-4" />
      <DataTable
        rows={zones.data}
        columns={columns}
        rowKey={(z) => z.id}
        loading={zones.isPending}
        tableId={admin ? "designate-admin-zones" : "designate-zones"}
        noun={tr("zones")}
        rowLabel={(z) => zoneName(z)}
        onRefresh={() => zones.refetch()}
        refreshing={zones.isFetching}
        onBulkDone={() => invalidate(DNS)}
        empty={tr("No zones yet. Create one for a domain you own, or import a zone file.")}
        filterPlaceholder={tr("Filter by name or description")}
        rowActions={(z) => actions.items(z, "list")}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete zones?"),
            past: tr("deleted"),
            body: tr("Every record set in these zones is deleted with them and the name servers stop answering for them."),
            check: (z) => (z.action === "DELETE" ? tr("Already being deleted") : true),
            run: (z) => dns.del(`zones/${z.id}`, admin),
          },
        ]}
      />
      {actions.dialogs}
    </>
  );
}

/** The zone menu (list and detail page) and its dialogs. */
export function useZoneActions({ onDeleted }: { onDeleted?: () => void } = {}) {
  const { admin } = useAll();
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ kind: "edit" | "delete" | "export" | "transfer" | "abandon" | "xfr"; z: Zone } | null>(null);
  const close = () => setOpen(null);
  const items = (z: Zone, where: "list" | "detail"): MenuEntry[] => {
    const deleting = z.action === "DELETE" && tr("Being deleted");
    return [
      where === "list" && { label: tr("Open"), icon: "external-link", onSelect: () => navigate(`${admin ? "/admin" : ""}${BASE}/zones/${z.id}`) },
      { label: tr("Edit zone"), icon: "edit", disabled: deleting, onSelect: () => setOpen({ kind: "edit", z }) },
      z.type === "SECONDARY" && { label: tr("Transfer from primaries now"), icon: "refresh", disabled: deleting, onSelect: () => setOpen({ kind: "xfr", z }) },
      "-",
      { label: tr("Export zone file"), icon: "file-down", disabled: deleting, onSelect: () => setOpen({ kind: "export", z }) },
      { label: tr("Transfer to another project"), icon: "send", disabled: deleting || (z.type === "SECONDARY" && tr("Secondary zones can't be transferred")), onSelect: () => setOpen({ kind: "transfer", z }) },
      "-",
      admin && { label: tr("Abandon zone"), icon: "unlink", danger: true, onSelect: () => setOpen({ kind: "abandon", z }) },
      { label: tr("Delete zone"), icon: "trash", danger: true, disabled: deleting, onSelect: () => setOpen({ kind: "delete", z }) },
    ];
  };
  const z = open?.z;
  const dialogs = (
    <>
      {open?.kind === "edit" && z && <ZoneDialog zone={z} onClose={close} />}
      {open?.kind === "export" && z && <ExportDialog zone={z} onClose={close} />}
      {open?.kind === "transfer" && z && <TransferDialog zone={z} onClose={close} />}
      {open?.kind === "xfr" && z && (
        <ActionDialog
          onClose={close}
          title={tr("Transfer {name} now?", { name: zoneName(z) })}
          submitLabel={tr("Transfer")}
          done={tr("Zone transfer requested")}
          refresh={[DNS]}
          run={() => dns.post(`zones/${z.id}/tasks/xfr`, {}, admin)}
        >
          <p className="text-sm">{tr("Designate asks the primary servers for the zone right away instead of waiting for the refresh interval.")}</p>
        </ActionDialog>
      )}
      {open?.kind === "delete" && z && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete {name}?", { name: zoneName(z) })}
          submitLabel={tr("Delete zone")}
          done={tr("Zone deleted")}
          refresh={[DNS]}
          onDone={onDeleted}
          run={() => dns.del(`zones/${z.id}`, admin)}
        >
          <p className="text-sm">{tr("Every record set in the zone is deleted with it and the name servers stop answering for it.")}</p>
        </ActionDialog>
      )}
      {open?.kind === "abandon" && z && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Abandon {name}?", { name: zoneName(z) })}
          submitLabel={tr("Abandon zone")}
          done={tr("Zone abandoned")}
          refresh={[DNS]}
          onDone={onDeleted}
          run={() => dns.post(`zones/${z.id}/tasks/abandon`, {}, true)}
        >
          <p className="text-sm">
            {tr("The zone is removed from Designate's database only: it stays on the DNS servers, which Designate no longer updates. Use it to clean up a zone the backends no longer have.")}
          </p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs, openDialog: (z: Zone, kind: "edit" | "export" | "transfer") => setOpen({ kind, z }) };
}

const TTL_HINT = tr("Seconds resolvers may cache the answers. Empty: the cloud's default.");
const ttlProblem = (v: string) => v.trim() !== "" && !/^\d+$/.test(v.trim()) && tr("The TTL is a whole number of seconds");

/** Create a zone, or edit `zone` (email, TTL, description; the primaries of a secondary zone). */
export function ZoneDialog({ zone, onClose }: { zone?: Zone; onClose: () => void }) {
  const session = useSession().data;
  const { admin } = useAll();
  const navigate = useNavigate();
  const projects = useProjects(admin);
  const [name, setName] = useState(zone ? undot(zone.name) : "");
  const [type, setType] = useState<Zone["type"]>(zone?.type ?? "PRIMARY");
  const [email, setEmail] = useState(zone?.email ?? (session?.user.name.includes("@") ? session.user.name : ""));
  const [ttl, setTtl] = useState(zone?.ttl ? String(zone.ttl) : "");
  const [description, setDescription] = useState(zone?.description ?? "");
  const [masters, setMasters] = useState((zone?.masters ?? []).join("\n"));
  const [project, setProject] = useState("");
  const primaries = masters
    .split(/[\s,]+/)
    .map((m) => m.trim())
    .filter(Boolean);
  const problem =
    (!zone && !/^[a-zA-Z0-9_.-]+\.?$/.test(name.trim()) && tr("Enter a domain name, e.g. example.org")) ||
    (!zone && !name.trim().replace(/\.$/, "").includes(".") && tr("Designate needs at least two labels, e.g. example.org")) ||
    (type === "PRIMARY" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) && tr("Enter the zone's contact email")) ||
    (type === "SECONDARY" && !primaries.length && tr("Enter the primary servers' addresses")) ||
    ttlProblem(ttl);
  const run = () => {
    const body: Record<string, unknown> = { description: description.trim() || null };
    if (ttl.trim()) body.ttl = Number(ttl);
    if (type === "PRIMARY") body.email = email.trim();
    else body.masters = primaries;
    if (zone) return dns.patch<Zone>(`zones/${zone.id}`, body, admin);
    return dns.post<Zone>("zones", { ...body, name: dot(name), type }, false, project ? { sudo_project_id: project } : undefined);
  };
  return (
    <ActionDialog<Zone>
      onClose={onClose}
      size="md"
      title={zone ? tr("Edit {name}", { name: zoneName(zone) }) : tr("Create zone")}
      description={!zone && tr("Designate creates the SOA and NS records; add your own records once the zone is active.")}
      submitLabel={zone ? tr("Save") : tr("Create zone")}
      canSubmit={!problem}
      done={(z) => (zone ? tr("Zone updated") : tr("Zone {name} created", { name: zoneName(z) }))}
      refresh={[DNS]}
      onDone={(z) => !zone && z?.id && navigate(`${admin ? "/admin" : ""}${BASE}/zones/${z.id}`)}
      run={run}
    >
      {!zone && (
        <>
          <Field label={tr("Domain name")} hint={tr("The zone's fully qualified name; the trailing dot is added for you.")}>
            {(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="example.org" />}
          </Field>
          <Field label={tr("Type")}>
            {(id) => (
              <Picker
                id={id}
                value={type}
                onChange={(v) => setType(v as Zone["type"])}
                options={[
                  { value: "PRIMARY", label: tr("Primary"), description: tr("Records are managed here") },
                  { value: "SECONDARY", label: tr("Secondary"), description: tr("Copied from other primary servers by zone transfer") },
                ]}
              />
            )}
          </Field>
        </>
      )}
      {type === "PRIMARY" ? (
        <Field label={tr("Email")} hint={tr("Contact of the zone, published in its SOA record.")}>
          {(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="hostmaster@example.org" />}
        </Field>
      ) : (
        <Field label={tr("Primary servers")} hint={tr("IP addresses (optionally :port) that serve the zone, one per line. They must allow zone transfers to Designate.")}>
          {(id) => <Textarea id={id} rows={3} className="font-mono" value={masters} onChange={(e) => setMasters(e.target.value)} placeholder="192.0.2.53" />}
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="TTL" hint={TTL_HINT}>
          {(id) => <Input id={id} inputMode="numeric" value={ttl} onChange={(e) => setTtl(e.target.value)} placeholder="3600" />}
        </Field>
        {!zone && admin && (
          <Field label={tr("Project")} hint={tr("Create the zone for another project.")}>
            {(id) => (
              <Picker
                id={id}
                value={project}
                onChange={setProject}
                loading={projects.isPending}
                options={[{ value: "", label: tr("This project") }, ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name, description: p.id }))]}
              />
            )}
          </Field>
        )}
      </div>
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

// =========================================================================== imports

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { admin } = useAll();
  const projects = useProjects(admin);
  const [text, setText] = useState("");
  const [project, setProject] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const load = (f?: File) => {
    if (!f) return;
    if (f.size > 1024 * 1024) return setFileError(tr("Zone files are limited to 1 MiB"));
    setFileError(null);
    f.text().then(setText);
  };
  return (
    <ActionDialog<ZoneImport>
      onClose={onClose}
      size="lg"
      title={tr("Import zone")}
      description={tr("A zone file in BIND format with $ORIGIN, an SOA and NS records. Designate replaces the NS records with its own name servers.")}
      submitLabel={tr("Import")}
      canSubmit={!!text.trim()}
      done={tr("Import started")}
      refresh={[DNS]}
      onDone={onDone}
      run={() => importZone(text, project || undefined)}
    >
      <Field label={tr("Zone file")}>
        {(id) => (
          <>
            <input
              type="file"
              accept=".zone,.txt,.db,text/plain,text/dns"
              className="mb-2 block text-sm"
              onChange={(e) => load(e.target.files?.[0])}
              aria-label={tr("Choose a file")}
            />
            <Textarea
              id={id}
              rows={14}
              className="font-mono text-xs"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"$ORIGIN example.org.\n$TTL 3600\n@ IN SOA ns1.example.org. hostmaster.example.org. 1 3600 600 86400 3600\n@ IN NS ns1.example.org.\nwww IN A 203.0.113.10"}
            />
          </>
        )}
      </Field>
      {fileError && <p className="text-sm text-led-red">{fileError}</p>}
      {admin && (
        <Field label={tr("Project")} hint={tr("Import the zone into another project.")}>
          {(id) => (
            <Picker
              id={id}
              value={project}
              onChange={setProject}
              loading={projects.isPending}
              options={[{ value: "", label: tr("This project") }, ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name, description: p.id }))]}
            />
          )}
        </Field>
      )}
    </ActionDialog>
  );
}

function Imports() {
  const { admin } = useAll();
  const imports = useImports();
  const zones = useZones();
  const invalidate = useInvalidate();
  const zoneLink = (id?: string | null) => {
    if (!id) return "—";
    const z = zones.data?.find((x) => x.id === id);
    return (
      <Link to={`${admin ? "/admin" : ""}${BASE}/zones/${id}`} className="text-cable hover:underline">
        {z ? zoneName(z) : id}
      </Link>
    );
  };
  const columns: Column<ZoneImport>[] = [
    { key: "id", header: "ID", width: "10rem", mono: true, cell: (i) => i.id.slice(0, 13), value: (i) => i.id },
    { key: "status", header: tr("Status"), width: "9rem", cell: (i) => <StatusDot status={dnsStatus(i.status)} label={statusText(i)} />, value: (i) => i.status },
    { key: "zone", header: tr("Zone"), width: "14rem", cell: (i) => zoneLink(i.zone_id), value: (i) => i.zone_id ?? "" },
    { key: "message", header: tr("Message"), cell: (i) => i.message || "—", value: (i) => i.message ?? "" },
    { key: "age", header: tr("Age"), width: "7rem", hideBelow: "md", cell: (i) => <span title={fmtDate(i.created_at) ?? ""}>{age(i.created_at)}</span>, value: (i) => i.created_at ?? "" },
  ];
  return (
    <>
      <p className="mb-4 text-sm text-muted">{tr("Each import is a task: it creates the zone and its records, or says why it couldn't.")}</p>
      <ErrorNotice error={imports.error} className="mb-4" />
      <DataTable
        rows={imports.data}
        columns={columns}
        rowKey={(i) => i.id}
        loading={imports.isPending}
        tableId="designate-imports"
        noun={tr("imports")}
        rowLabel={(i) => i.id}
        onRefresh={() => imports.refetch()}
        refreshing={imports.isFetching}
        onBulkDone={() => invalidate(DNS)}
        empty={tr("No zone imports.")}
        rowActions={(i) => [{ label: tr("Delete import record"), icon: "trash", danger: true, onSelect: () => dns.del(`zones/tasks/imports/${i.id}`, admin).then(() => invalidate(DNS)) }]}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete import records?"),
            body: tr("Only the task records are deleted; imported zones stay."),
            past: tr("deleted"),
            run: (i) => dns.del(`zones/tasks/imports/${i.id}`, admin),
          },
        ]}
      />
    </>
  );
}

// =========================================================================== exports

function ExportDialog({ zone, onClose }: { zone: Zone; onClose: () => void }) {
  const { admin } = useAll();
  const [, setTab] = useTab(TABS, "zones");
  const navigate = useNavigate();
  return (
    <ActionDialog<ZoneExport>
      onClose={onClose}
      title={tr("Export {name}?", { name: zoneName(zone) })}
      submitLabel={tr("Export")}
      done={tr("Export started; download it from the Exports tab when it is complete")}
      refresh={[DNS]}
      onDone={() => (location.pathname.endsWith("/zones") ? setTab("exports") : navigate(`${admin ? "/admin" : ""}${BASE}/zones?tab=exports`))}
      run={() => dns.post<ZoneExport>(`zones/${zone.id}/tasks/export`, {}, admin)}
    >
      <p className="text-sm">{tr("Designate writes the zone's records to a BIND zone file, which you can download once the export is complete.")}</p>
    </ActionDialog>
  );
}

function Exports() {
  const { admin } = useAll();
  const exports = useExports();
  const zones = useZones();
  const invalidate = useInvalidate();
  const [error, setError] = useState<unknown>(null);
  const name = (id: string) => zoneName(zones.data?.find((z) => z.id === id), id);
  const download = (e: ZoneExport) => {
    setError(null);
    exportFile(e.id)
      .then((r) => downloadText(`${name(e.zone_id)}.zone`, r.zonefile, "text/dns"))
      .catch(setError);
  };
  const columns: Column<ZoneExport>[] = [
    { key: "zone", header: tr("Zone"), cell: (e) => name(e.zone_id), value: (e) => name(e.zone_id) },
    { key: "status", header: tr("Status"), width: "9rem", cell: (e) => <StatusDot status={dnsStatus(e.status)} label={statusText(e)} />, value: (e) => e.status },
    { key: "message", header: tr("Message"), hideBelow: "md", cell: (e) => e.message || "—", value: (e) => e.message ?? "" },
    { key: "age", header: tr("Age"), width: "7rem", hideBelow: "md", cell: (e) => <span title={fmtDate(e.created_at) ?? ""}>{age(e.created_at)}</span>, value: (e) => e.created_at ?? "" },
    {
      key: "download",
      header: "",
      width: "8rem",
      wrap: true,
      cell: (e) =>
        e.status === "COMPLETE" && (
          <Button className="h-8" onClick={() => download(e)}>
            <Icon name="download" />
            {tr("Download")}
          </Button>
        ),
    },
  ];
  return (
    <>
      <p className="mb-4 text-sm text-muted">{tr("Export a zone from its menu on the Zones tab.")}</p>
      <ErrorNotice error={exports.error ?? error} className="mb-4" />
      <DataTable
        rows={exports.data}
        columns={columns}
        rowKey={(e) => e.id}
        loading={exports.isPending}
        tableId="designate-exports"
        noun={tr("exports")}
        rowLabel={(e) => name(e.zone_id)}
        onRefresh={() => exports.refetch()}
        refreshing={exports.isFetching}
        onBulkDone={() => invalidate(DNS)}
        empty={tr("No zone exports.")}
        rowActions={(e) => [
          { label: tr("Download zone file"), icon: "download", disabled: e.status !== "COMPLETE" && tr("Not complete"), onSelect: () => download(e) },
          "-",
          { label: tr("Delete export"), icon: "trash", danger: true, onSelect: () => dns.del(`zones/tasks/exports/${e.id}`, admin).then(() => invalidate(DNS)) },
        ]}
        bulkActions={[{ id: "delete", label: tr("Delete"), icon: "trash", danger: true, title: tr("Delete exports?"), past: tr("deleted"), run: (e) => dns.del(`zones/tasks/exports/${e.id}`, admin) }]}
      />
    </>
  );
}

// =========================================================================== transfers

/** Offer a zone to another project: makes a request whose id and key the other project accepts. */
function TransferDialog({ zone, onClose }: { zone: Zone; onClose: () => void }) {
  const { admin } = useAll();
  const [target, setTarget] = useState("");
  const [description, setDescription] = useState("");
  const [made, setMade] = useState<TransferRequest | null>(null);
  // ActionDialog closes itself after success: keep the dialog open to show the key instead.
  const done = useRef(false);
  if (made) return <TransferKey request={made} onClose={onClose} />;
  return (
    <ActionDialog<TransferRequest>
      onClose={() => !done.current && onClose()}
      size="md"
      title={tr("Transfer {name}", { name: zoneName(zone) })}
      description={tr("The other project accepts the transfer with the request's ID and key. The zone and its records move; it stays in this project until then.")}
      submitLabel={tr("Create transfer request")}
      canSubmit={!target.trim() || /^[a-zA-Z0-9-]+$/.test(target.trim())}
      done={tr("Transfer request created")}
      refresh={[DNS]}
      onDone={(r) => {
        done.current = true;
        setMade(r);
      }}
      run={() => dns.post<TransferRequest>(`zones/${zone.id}/tasks/transfer_requests`, { target_project_id: target.trim() || undefined, description: description.trim() || undefined }, admin)}
    >
      <Field label={tr("Target project ID")} hint={tr("Only this project may accept. Empty: any project that has the key.")}>
        {(id) => <Input id={id} className="font-mono" value={target} onChange={(e) => setTarget(e.target.value)} />}
      </Field>
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

function TransferKey({ request, onClose }: { request: TransferRequest; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title={tr("Transfer request for {name}", { name: undot(request.zone_name) })}>
      <p className="mb-3 text-sm">{tr("Send both values to the other project; they accept with “Accept transfer” on their DNS zones page.")}</p>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-muted">{tr("Request ID")}</dt>
          <dd className="flex items-center gap-2">
            <Mono>{request.id}</Mono>
            <CopyButton text={request.id} />
          </dd>
        </div>
        <div>
          <dt className="text-muted">{tr("Key")}</dt>
          <dd className="flex items-center gap-2">
            <Mono>{request.key ?? "—"}</Mono>
            {request.key && <CopyButton text={request.key} />}
          </dd>
        </div>
      </dl>
      <div className="mt-5 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          {tr("Done")}
        </Button>
      </div>
    </Dialog>
  );
}

function AcceptDialog({ onClose }: { onClose: () => void }) {
  const [id, setId] = useState("");
  const [key, setKey] = useState("");
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Accept zone transfer")}
      description={tr("Move a zone another project offered into this project. Its owner gives you the request ID and key.")}
      submitLabel={tr("Accept")}
      canSubmit={/^[a-zA-Z0-9-]+$/.test(id.trim()) && !!key.trim()}
      done={tr("Transfer accepted")}
      refresh={[DNS]}
      run={() => dns.post("zones/tasks/transfer_accepts", { zone_transfer_request_id: id.trim(), key: key.trim() })}
    >
      <Field label={tr("Request ID")}>{(i) => <Input id={i} autoFocus className="font-mono" value={id} onChange={(e) => setId(e.target.value)} />}</Field>
      <Field label={tr("Key")}>{(i) => <Input id={i} className="font-mono" value={key} onChange={(e) => setKey(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

function Transfers() {
  const { admin } = useAll();
  const session = useSession().data;
  const requests = useTransferRequests();
  const invalidate = useInvalidate();
  const [show, setShow] = useState<TransferRequest | null>(null);
  const mine = (t: TransferRequest) => admin || !t.project_id || t.project_id === session?.project?.id;
  const columns: Column<TransferRequest>[] = [
    { key: "zone", header: tr("Zone"), cell: (t) => undot(t.zone_name) || t.zone_id, value: (t) => t.zone_name ?? t.zone_id },
    {
      key: "direction",
      header: tr("Direction"),
      width: "8rem",
      wrap: true,
      cell: (t) => (mine(t) ? <Badge>{tr("Outgoing")}</Badge> : <Badge tone="accent">{tr("Incoming")}</Badge>),
      value: (t) => (mine(t) ? "out" : "in"),
    },
    { key: "target", header: tr("Target project"), width: "14rem", hideBelow: "md", mono: true, cell: (t) => t.target_project_id || tr("Any"), value: (t) => t.target_project_id ?? "" },
    { key: "status", header: tr("Status"), width: "8rem", cell: (t) => <StatusDot status={dnsStatus(t.status)} label={statusText(t)} />, value: (t) => t.status },
    { key: "description", header: tr("Description"), hideBelow: "lg", cell: (t) => t.description || "—", value: (t) => t.description ?? "" },
    { key: "age", header: tr("Age"), width: "7rem", hideBelow: "xl", cell: (t) => <span title={fmtDate(t.created_at) ?? ""}>{age(t.created_at)}</span>, value: (t) => t.created_at ?? "" },
  ];
  return (
    <>
      <p className="mb-4 text-sm text-muted">{tr("Requests this project made to move its zones, and requests addressed to it. Create one from a zone's menu.")}</p>
      <ErrorNotice error={requests.error} className="mb-4" />
      <DataTable
        rows={requests.data}
        columns={columns}
        rowKey={(t) => t.id}
        loading={requests.isPending}
        tableId="designate-transfers"
        noun={tr("transfer requests")}
        rowLabel={(t) => undot(t.zone_name) || t.id}
        onRefresh={() => requests.refetch()}
        refreshing={requests.isFetching}
        onBulkDone={() => invalidate(DNS)}
        empty={tr("No transfer requests.")}
        rowActions={(t) => [
          { label: tr("Show ID and key"), icon: "key", onSelect: () => setShow(t) },
          "-",
          { label: tr("Cancel transfer"), icon: "trash", danger: true, disabled: !mine(t) && tr("Made by another project"), onSelect: () => dns.del(`zones/tasks/transfer_requests/${t.id}`, admin).then(() => invalidate(DNS)) },
        ]}
        bulkActions={[
          {
            id: "delete",
            label: tr("Cancel"),
            icon: "trash",
            danger: true,
            title: tr("Cancel transfer requests?"),
            past: tr("cancelled"),
            check: (t) => (mine(t) ? true : tr("Made by another project")),
            run: (t) => dns.del(`zones/tasks/transfer_requests/${t.id}`, admin),
          },
        ]}
      />
      {show && <TransferKey request={show} onClose={() => setShow(null)} />}
    </>
  );
}
