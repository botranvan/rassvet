/**
 * Admin: Glance metadata definitions (the catalog behind the image, flavor and instance
 * metadata editors): namespaces, their properties, objects and resource type associations.
 * Glance's own policy decides who may change them (admins by default).
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { ActionDialog } from "@/components/ActionDialog";
import { CopyButton } from "@/components/CodeBlock";
import { type Column, DataTable } from "@/components/DataTable";
import { Link, useNavigate } from "@/components/Link";
import { MultiPicker, Picker } from "@/components/Picker";
import { ActionMenu } from "@/components/Menu";
import { Badge, Button, Card, Detail, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Switch, Tabs, Textarea } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { os, useInvalidate, useOsGet } from "@/lib/os";
import { useTab } from "@/lib/useTab";
import { tr } from "@/lib/i18n";

interface Association {
  name: string;
  prefix?: string;
  properties_target?: string;
  created_at?: string;
}
interface Namespace {
  namespace: string;
  display_name?: string;
  description?: string;
  visibility: "public" | "private";
  protected: boolean;
  owner?: string;
  resource_type_associations?: Association[];
  properties?: Record<string, Record<string, unknown>>;
  objects?: { name: string; description?: string; required?: string[]; properties?: Record<string, unknown> }[];
  created_at?: string;
  updated_at?: string;
}

const enc = encodeURIComponent;
const nsPath = (ns: string) => `metadefs/namespaces/${ns}`;
const SAMPLE = `{
  "namespace": "MyCompany::Backup",
  "display_name": "Backup policy",
  "description": "How often the instance is backed up",
  "visibility": "public",
  "protected": false,
  "resource_type_associations": [{ "name": "OS::Nova::Server", "properties_target": "metadata" }],
  "properties": {
    "backup_schedule": { "title": "Schedule", "type": "string", "enum": ["daily", "weekly"], "default": "daily" }
  }
}`;

/** Refresh the gateway lists and the metadata editors' catalogs. */
function useRefresh() {
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  return () => {
    invalidate("image");
    qc.invalidateQueries({ queryKey: ["image", "metadefs"] });
  };
}

const parse = (s: string): [Record<string, unknown> | null, string | null] => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? [v, null] : [null, tr("Must be a JSON object")];
  } catch (e) {
    return [null, (e as Error).message];
  }
};

const useNamespaces = () =>
  useOsGet<Namespace[]>("image", "metadefs/namespaces", (r: { namespaces: Namespace[] }) => r.namespaces, { q: { limit: 1000 } });
const useResourceTypes = () =>
  useOsGet<{ name: string }[]>("image", "metadefs/resource_types", (r: { resource_types: { name: string }[] }) => r.resource_types);

// =========================================================================== list

export default function Metadefs() {
  const namespaces = useNamespaces();
  const navigate = useNavigate();
  const refresh = useRefresh();
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "delete"; ns: Namespace } | null>(null);
  const close = () => setOpen(null);
  const types = (n: Namespace) => (n.resource_type_associations ?? []).map((a) => a.name).join(", ");
  const columns: Column<Namespace>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (n) => (
        <div className="min-w-0">
          <Link to={`/admin/compute/metadata-definitions/${enc(n.namespace)}`} className="block truncate font-medium text-cable hover:underline">
            {n.display_name || n.namespace}
          </Link>
          <p className="truncate font-mono text-[11.5px] text-muted">{n.namespace}</p>
        </div>
      ),
      value: (n) => `${n.display_name ?? ""} ${n.namespace} ${n.description ?? ""}`,
      csv: (n) => n.namespace,
    },
    { key: "types", header: tr("Resource types"), hideBelow: "md", wrap: true, cell: (n) => <span className="font-mono text-[12px]">{types(n) || "—"}</span>, value: types },
    {
      key: "visibility",
      header: tr("Visibility"),
      width: "8rem",
      cell: (n) => (
        <span className="inline-flex items-center gap-1.5">
          {n.visibility}
          {n.protected && <Icon name="lock" className="size-3.5 text-muted" />}
        </span>
      ),
      value: (n) => `${n.visibility}${n.protected ? " protected" : ""}`,
    },
    { key: "updated", header: tr("Updated"), width: "9rem", hideBelow: "lg", cell: (n) => fmtDate(n.updated_at ?? n.created_at, false), value: (n) => n.updated_at ?? n.created_at ?? "" },
  ];
  return (
    <>
      <PageHeader
        title={tr("Metadata definitions")}
        description={tr("The catalog of known metadata keys (hardware properties, scheduler hints, software…) that image, flavor and instance metadata editors offer, grouped in namespaces and tied to resource types.")}
        actions={
          <Button variant="primary" onClick={() => setOpen({ kind: "create" })}>
            <Icon name="plus" />
            {tr("Create namespace")}
          </Button>
        }
      />
      <ErrorNotice error={namespaces.error} className="mb-4" />
      <DataTable
        rows={namespaces.data}
        columns={columns}
        rowKey={(n) => n.namespace}
        loading={namespaces.isPending}
        tableId="admin-metadefs"
        noun={tr("namespaces")}
        rowLabel={(n) => n.namespace}
        onRefresh={() => namespaces.refetch()}
        refreshing={namespaces.isFetching}
        onBulkDone={refresh}
        rowActions={(n) => [
          { label: tr("View details"), icon: "eye", onSelect: () => navigate(`/admin/compute/metadata-definitions/${enc(n.namespace)}`) },
          { label: tr("Edit namespace"), icon: "edit", onSelect: () => setOpen({ kind: "edit", ns: n }) },
          "-",
          { label: tr("Delete namespace"), icon: "trash", danger: true, disabled: n.protected ? tr("Protected; turn protection off first") : false, onSelect: () => setOpen({ kind: "delete", ns: n }) },
        ]}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete namespaces?"),
            past: tr("deleted"),
            body: tr("Their properties and objects disappear from the metadata editors. Metadata already set on images and instances is kept."),
            check: (n) => (n.protected ? tr("Protected") : true),
            run: (n) => os.del("image", nsPath(n.namespace)),
          },
        ]}
      />
      {open?.kind === "create" && <CreateNamespaceDialog onClose={close} onDone={(ns) => navigate(`/admin/compute/metadata-definitions/${enc(ns)}`)} />}
      {open?.kind === "edit" && <EditNamespaceDialog ns={open.ns} onClose={close} />}
      {open?.kind === "delete" && <DeleteNamespaceDialog ns={open.ns} onClose={close} />}
    </>
  );
}

function CreateNamespaceDialog({ onClose, onDone }: { onClose: () => void; onDone: (ns: string) => void }) {
  const refresh = useRefresh();
  const types = useResourceTypes();
  const [mode, setMode] = useState<"form" | "json">("form");
  const [namespace, setNamespace] = useState("");
  const [display, setDisplay] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("public");
  const [prot, setProt] = useState(false);
  const [rts, setRts] = useState<string[]>([]);
  const [json, setJson] = useState(SAMPLE);
  const [obj, err] = parse(json);
  const body = (): Record<string, unknown> =>
    mode === "json"
      ? obj!
      : {
          namespace: namespace.trim(),
          display_name: display.trim() || undefined,
          description: description || undefined,
          visibility,
          protected: prot,
          resource_type_associations: rts.map((name) => ({ name })),
        };
  return (
    <ActionDialog<{ namespace: string }>
      onClose={onClose}
      size="lg"
      title={tr("Create namespace")}
      description={tr("Start empty and add properties afterwards, or import a complete definition (Glance's JSON format, as in /etc/glance/metadefs).")}
      submitLabel={tr("Create namespace")}
      canSubmit={mode === "json" ? !!obj && typeof obj.namespace === "string" : !!namespace.trim()}
      done={(r) => tr("Namespace {ns} created", { ns: r.namespace })}
      onDone={(r) => {
        refresh();
        onDone(r.namespace);
      }}
      run={() => os.post<{ namespace: string }>("image", "metadefs/namespaces", body())}
    >
      <Tabs
        value={mode}
        onChange={setMode}
        tabs={[
          { id: "form", label: tr("Form") },
          { id: "json", label: tr("Import JSON") },
        ]}
      />
      {mode === "form" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("Namespace")} hint={tr("Unique, e.g. MyCompany::Backup. Can't be changed later.")}>
              {(id) => <Input id={id} autoFocus value={namespace} onChange={(e) => setNamespace(e.target.value)} className="font-mono text-[13px]" />}
            </Field>
            <Field label={tr("Display name")}>{(id) => <Input id={id} value={display} onChange={(e) => setDisplay(e.target.value)} />}</Field>
          </div>
          <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
          <Field label={tr("Resource types")} hint={tr("Where the editors offer these keys: OS::Glance::Image (images), OS::Nova::Flavor (flavor extra specs), OS::Nova::Server (instance metadata), OS::Cinder::Volume…")}>
            {(id) => <MultiPicker id={id} values={rts} onChange={setRts} loading={types.isPending} options={(types.data ?? []).map((t) => ({ value: t.name, label: t.name }))} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("Visibility")}>
              {(id) => (
                <Picker
                  id={id}
                  value={visibility}
                  onChange={setVisibility}
                  options={[
                    { value: "public", label: tr("Public"), description: tr("Every project sees it") },
                    { value: "private", label: tr("Private"), description: tr("Only the owning project") },
                  ]}
                />
              )}
            </Field>
            <div className="pt-6">
              <Switch checked={prot} onChange={setProt} label={tr("Protected")} hint={tr("Can't be deleted until unprotected.")} />
            </div>
          </div>
        </>
      ) : (
        <Field label={tr("Definition (JSON)")} hint={err ?? undefined}>
          {(id) => <Textarea id={id} rows={14} spellCheck={false} className={`font-mono text-[12.5px] ${err ? "border-led-red" : ""}`} value={json} onChange={(e) => setJson(e.target.value)} />}
        </Field>
      )}
    </ActionDialog>
  );
}

function EditNamespaceDialog({ ns, onClose }: { ns: Namespace; onClose: () => void }) {
  const refresh = useRefresh();
  const [display, setDisplay] = useState(ns.display_name ?? "");
  const [description, setDescription] = useState(ns.description ?? "");
  const [visibility, setVisibility] = useState(ns.visibility);
  const [prot, setProt] = useState(ns.protected);
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit {name}", { name: ns.display_name || ns.namespace })}
      submitLabel={tr("Save")}
      done={tr("Namespace updated")}
      onDone={refresh}
      run={() => os.put("image", nsPath(ns.namespace), { namespace: ns.namespace, display_name: display.trim(), description, visibility, protected: prot })}
    >
      <Field label={tr("Namespace")}>{() => <Mono>{ns.namespace}</Mono>}</Field>
      <Field label={tr("Display name")}>{(id) => <Input id={id} autoFocus value={display} onChange={(e) => setDisplay(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Field label={tr("Visibility")}>
        {(id) => (
          <Picker
            id={id}
            value={visibility}
            onChange={(v) => setVisibility(v as Namespace["visibility"])}
            options={[
              { value: "public", label: tr("Public") },
              { value: "private", label: tr("Private") },
            ]}
          />
        )}
      </Field>
      <Switch checked={prot} onChange={setProt} label={tr("Protected")} hint={tr("Can't be deleted until unprotected.")} />
    </ActionDialog>
  );
}

function DeleteNamespaceDialog({ ns, onClose, onDone }: { ns: Namespace; onClose: () => void; onDone?: () => void }) {
  const refresh = useRefresh();
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Delete {name}?", { name: ns.display_name || ns.namespace })}
      submitLabel={tr("Delete namespace")}
      done={tr("Namespace deleted")}
      onDone={() => {
        refresh();
        onDone?.();
      }}
      run={() => os.del("image", nsPath(ns.namespace))}
    >
      <p className="text-sm">{tr("Its properties and objects disappear from the metadata editors. Metadata already set on images and instances is kept.")}</p>
    </ActionDialog>
  );
}

// =========================================================================== detail

const TABS = ["overview", "properties", "objects", "types"] as const;

type Prop = { name: string } & Record<string, unknown>;

export function MetadefDetail() {
  const { ns: raw = "" } = useParams();
  const ns = decodeURIComponent(raw);
  const navigate = useNavigate();
  const q = useOsGet<Namespace>("image", nsPath(ns), (r: Namespace) => r);
  const types = useResourceTypes();
  const refresh = useRefresh();
  const [tab, setTab] = useTab(TABS, "overview");
  const [open, setOpen] = useState<
    | { kind: "edit" | "delete" | "assoc" }
    | { kind: "prop"; p?: Prop }
    | { kind: "delprop"; p: Prop }
    | { kind: "object"; o?: NonNullable<Namespace["objects"]>[number] }
    | { kind: "delobject"; name: string }
    | { kind: "unassoc"; a: Association }
    | null
  >(null);
  const close = () => setOpen(null);
  const n = q.data;
  const props: Prop[] = Object.entries(n?.properties ?? {})
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const json = n ? JSON.stringify(n, null, 2) : "";
  const propCols: Column<Prop>[] = [
    { key: "name", header: tr("Key"), mono: true, cell: (p) => p.name, value: (p) => p.name },
    { key: "title", header: tr("Title"), hideBelow: "sm", cell: (p) => String(p.title ?? ""), value: (p) => String(p.title ?? "") },
    { key: "type", header: tr("Type"), width: "7rem", cell: (p) => String(p.type ?? ""), value: (p) => String(p.type ?? "") },
    {
      key: "values",
      header: tr("Allowed values"),
      hideBelow: "lg",
      mono: true,
      cell: (p) => (Array.isArray(p.enum) ? (p.enum as unknown[]).join(", ") : p.pattern ? `/${String(p.pattern)}/` : "—"),
      value: (p) => (Array.isArray(p.enum) ? (p.enum as unknown[]).join(", ") : ""),
    },
    { key: "default", header: tr("Default"), width: "8rem", hideBelow: "xl", mono: true, cell: (p) => (p.default === undefined ? "—" : String(p.default)), value: (p) => String(p.default ?? "") },
  ];
  type Obj = NonNullable<Namespace["objects"]>[number];
  const objCols: Column<Obj>[] = [
    { key: "name", header: tr("Name"), cell: (o) => <span className="font-medium">{o.name}</span>, value: (o) => o.name },
    { key: "description", header: tr("Description"), hideBelow: "md", cell: (o) => <span className="text-muted">{o.description || "—"}</span>, value: (o) => o.description ?? "" },
    { key: "props", header: tr("Properties"), width: "7rem", className: "text-right", cell: (o) => Object.keys(o.properties ?? {}).length, value: (o) => Object.keys(o.properties ?? {}).length },
  ];
  const assocCols: Column<Association>[] = [
    { key: "name", header: tr("Resource type"), mono: true, cell: (a) => a.name, value: (a) => a.name },
    { key: "prefix", header: tr("Prefix"), width: "9rem", mono: true, cell: (a) => a.prefix || "—", value: (a) => a.prefix ?? "" },
    { key: "target", header: tr("Properties target"), width: "11rem", cell: (a) => a.properties_target || "—", value: (a) => a.properties_target ?? "" },
  ];
  return (
    <>
      <Link to="/admin/compute/metadata-definitions" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Metadata definitions")}
      </Link>
      <PageHeader
        title={n?.display_name || ns}
        description={n?.description}
        actions={
          n && (
            <ActionMenu
              variant="button"
              items={() => [
                { label: tr("Edit namespace"), icon: "edit", onSelect: () => setOpen({ kind: "edit" }) },
                { label: tr("Add property"), icon: "plus", onSelect: () => setOpen({ kind: "prop" }) },
                { label: tr("Add object"), icon: "plus", onSelect: () => setOpen({ kind: "object" }) },
                { label: tr("Associate resource type"), icon: "link", onSelect: () => setOpen({ kind: "assoc" }) },
                "-",
                { label: tr("Delete namespace"), icon: "trash", danger: true, disabled: n.protected ? tr("Protected; turn protection off first") : false, onSelect: () => setOpen({ kind: "delete" }) },
              ]}
            />
          )
        }
      />
      <ErrorNotice error={q.error} className="mb-4" />
      {n && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "properties", label: tr("Properties ({n})", { n: props.length }) },
              { id: "objects", label: tr("Objects ({n})", { n: n.objects?.length ?? 0 }) },
              { id: "types", label: tr("Resource types ({n})", { n: n.resource_type_associations?.length ?? 0 }) },
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 xl:grid-cols-[1fr_2fr]">
              <Card title={tr("Details")}>
                <dl>
                  <Detail label={tr("Namespace")}>
                    <Mono>{n.namespace}</Mono>
                  </Detail>
                  <Detail label={tr("Display name")}>{n.display_name || "—"}</Detail>
                  <Detail label={tr("Visibility")}>{n.visibility}</Detail>
                  <Detail label={tr("Protected")}>{n.protected ? tr("Yes") : tr("No")}</Detail>
                  {n.owner && (
                    <Detail label={tr("Owner")}>
                      <Mono>{n.owner}</Mono>
                    </Detail>
                  )}
                  <Detail label={tr("Created")}>{fmtDate(n.created_at)}</Detail>
                  <Detail label={tr("Updated")}>{fmtDate(n.updated_at)}</Detail>
                </dl>
              </Card>
              <Card
                title={tr("Definition (JSON)")}
                actions={
                  <>
                    <CopyButton className="h-8" text={json} />
                    <Button
                      className="h-8"
                      onClick={() => {
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
                        a.download = `${n.namespace.replace(/[^\w.-]+/g, "_")}.json`;
                        a.click();
                      }}
                    >
                      <Icon name="download" />
                      {tr("Download")}
                    </Button>
                  </>
                }
              >
                <pre className="max-h-[32rem] overflow-auto rounded-md border border-line bg-surface p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap">{json}</pre>
              </Card>
            </div>
          )}
          {tab === "properties" && (
            <>
              <div className="mb-3">
                <Button onClick={() => setOpen({ kind: "prop" })}>
                  <Icon name="plus" />
                  {tr("Add property")}
                </Button>
              </div>
              <DataTable
                rows={props}
                columns={propCols}
                rowKey={(p) => p.name}
                tableId="admin-metadef-properties"
                noun={tr("properties")}
                rowLabel={(p) => p.name}
                empty={tr("No properties yet.")}
                onRefresh={() => q.refetch()}
                refreshing={q.isFetching}
                rowActions={(p) => [
                  { label: tr("Edit property"), icon: "edit", onSelect: () => setOpen({ kind: "prop", p }) },
                  { label: tr("Delete property"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delprop", p }) },
                ]}
              />
            </>
          )}
          {tab === "objects" && (
            <>
              <div className="mb-3">
                <Button onClick={() => setOpen({ kind: "object" })}>
                  <Icon name="plus" />
                  {tr("Add object")}
                </Button>
              </div>
              <DataTable
                rows={n.objects ?? []}
                columns={objCols}
                rowKey={(o) => o.name}
                tableId="admin-metadef-objects"
                noun={tr("objects")}
                rowLabel={(o) => o.name}
                empty={tr("No objects. Objects group properties that belong together (e.g. CPU limits).")}
                onRefresh={() => q.refetch()}
                refreshing={q.isFetching}
                rowActions={(o) => [
                  { label: tr("Edit object"), icon: "edit", onSelect: () => setOpen({ kind: "object", o }) },
                  { label: tr("Delete object"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delobject", name: o.name }) },
                ]}
              />
            </>
          )}
          {tab === "types" && (
            <>
              <div className="mb-3">
                <Button onClick={() => setOpen({ kind: "assoc" })}>
                  <Icon name="plus" />
                  {tr("Associate resource type")}
                </Button>
              </div>
              <DataTable
                rows={n.resource_type_associations ?? []}
                columns={assocCols}
                rowKey={(a) => a.name}
                tableId="admin-metadef-types"
                noun={tr("resource types")}
                rowLabel={(a) => a.name}
                empty={tr("Not associated with any resource type: no metadata editor offers these keys.")}
                onRefresh={() => q.refetch()}
                refreshing={q.isFetching}
                rowActions={(a) => [{ label: tr("Remove association"), icon: "unlink", danger: true, onSelect: () => setOpen({ kind: "unassoc", a }) }]}
              />
            </>
          )}
        </>
      )}
      {n && open?.kind === "edit" && <EditNamespaceDialog ns={n} onClose={close} />}
      {n && open?.kind === "delete" && <DeleteNamespaceDialog ns={n} onClose={close} onDone={() => navigate("/admin/compute/metadata-definitions")} />}
      {n && open?.kind === "prop" && <JsonItemDialog kind="property" ns={n.namespace} item={open.p} onClose={close} />}
      {n && open?.kind === "object" && <JsonItemDialog kind="object" ns={n.namespace} item={open.o as Prop | undefined} onClose={close} />}
      {n && open?.kind === "delprop" && (
        <ActionDialog onClose={close} danger title={tr("Delete property {name}?", { name: open.p.name })} submitLabel={tr("Delete")} done={tr("Property deleted")} onDone={refresh} run={() => os.del("image", `${nsPath(n.namespace)}/properties/${open.p.name}`)}>
          <p className="text-sm">{tr("Values already set on images or instances are kept; the editors just stop offering the key.")}</p>
        </ActionDialog>
      )}
      {n && open?.kind === "delobject" && (
        <ActionDialog onClose={close} danger title={tr("Delete object {name}?", { name: open.name })} submitLabel={tr("Delete")} done={tr("Object deleted")} onDone={refresh} run={() => os.del("image", `${nsPath(n.namespace)}/objects/${open.name}`)}>
          <p className="text-sm">{tr("Values already set on images or instances are kept.")}</p>
        </ActionDialog>
      )}
      {n && open?.kind === "assoc" && <AssociateDialog ns={n} types={(types.data ?? []).map((t) => t.name)} onClose={close} />}
      {n && open?.kind === "unassoc" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Remove {type} from this namespace?", { type: open.a.name })}
          submitLabel={tr("Remove")}
          done={tr("Association removed")}
          onDone={refresh}
          run={() => os.del("image", `${nsPath(n.namespace)}/resource_types/${open.a.name}`)}
        >
          <p className="text-sm">{tr("Editors for this resource type stop offering the namespace's keys.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

/** Add or edit a property or object as JSON (title, type, enum, default… as Glance stores them). */
function JsonItemDialog({ kind, ns, item, onClose }: { kind: "property" | "object"; ns: string; item?: Prop; onClose: () => void }) {
  const refresh = useRefresh();
  const edit = !!item;
  const [name, setName] = useState(item?.name ?? "");
  const initial = item
    ? (() => {
        const { name: _n, ...rest } = item;
        void _n;
        return rest;
      })()
    : kind === "property"
      ? { title: "", type: "string", description: "" }
      : { description: "", required: [], properties: {} };
  const [text, setText] = useState(JSON.stringify(initial, null, 2));
  const [obj, err] = parse(text);
  const coll = kind === "property" ? "properties" : "objects";
  const valid = !!name.trim() && !!obj && (kind === "object" || (typeof obj.title === "string" && typeof obj.type === "string"));
  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={edit ? (kind === "property" ? tr("Edit property {name}", { name: item.name }) : tr("Edit object {name}", { name: item.name })) : kind === "property" ? tr("Add property") : tr("Add object")}
      description={
        kind === "property"
          ? tr("JSON schema of the value: title and type (string, integer, number, boolean, array) are required; enum, default, minimum/maximum, pattern and description are optional.")
          : tr("An object groups properties: description, required (list of keys) and properties (key → schema).")
      }
      submitLabel={edit ? tr("Save") : tr("Add")}
      canSubmit={valid}
      done={edit ? tr("Saved") : tr("Added")}
      onDone={refresh}
      run={() =>
        edit
          ? os.put("image", `${nsPath(ns)}/${coll}/${item.name}`, { ...obj, name: name.trim() })
          : os.post("image", `${nsPath(ns)}/${coll}`, { ...obj, name: name.trim() })
      }
    >
      <Field label={kind === "property" ? tr("Key") : tr("Name")} hint={edit ? tr("Renaming keeps the definition but changes the key the editors use.") : undefined}>
        {(id) => <Input id={id} autoFocus={!edit} value={name} onChange={(e) => setName(e.target.value)} className="font-mono text-[13px]" placeholder={kind === "property" ? "hw_vif_model" : "CPU Limits"} />}
      </Field>
      <Field label={tr("Definition (JSON)")} hint={err ?? (obj && kind === "property" && !valid ? tr("title and type are required") : undefined)}>
        {(id) => <Textarea id={id} rows={12} spellCheck={false} className={`font-mono text-[12.5px] ${err ? "border-led-red" : ""}`} value={text} onChange={(e) => setText(e.target.value)} />}
      </Field>
    </ActionDialog>
  );
}

function AssociateDialog({ ns, types, onClose }: { ns: Namespace; types: string[]; onClose: () => void }) {
  const refresh = useRefresh();
  const have = new Set((ns.resource_type_associations ?? []).map((a) => a.name));
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [target, setTarget] = useState("");
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Associate a resource type")}
      description={tr("The namespace's keys are offered when editing metadata of that kind of resource.")}
      submitLabel={tr("Associate")}
      canSubmit={!!name}
      done={tr("Resource type associated")}
      onDone={refresh}
      run={() => os.post("image", `${nsPath(ns.namespace)}/resource_types`, { name, prefix: prefix || undefined, properties_target: target || undefined })}
    >
      <Field label={tr("Resource type")}>
        {(id) => <Picker id={id} value={name} onChange={setName} searchable placeholder={tr("Choose")} options={types.map((t) => ({ value: t, label: t, disabled: have.has(t) ? tr("Already associated") : false }))} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Prefix")} hint={tr("Added before every key for this type, e.g. hw: for flavors.")}>
          {(id) => <Input id={id} value={prefix} onChange={(e) => setPrefix(e.target.value)} className="font-mono text-[13px]" />}
        </Field>
        <Field label={tr("Properties target")} hint={tr("Sub-resource, e.g. metadata or scheduler_hints for instances, image for volumes.")}>
          {(id) => <Input id={id} value={target} onChange={(e) => setTarget(e.target.value)} className="font-mono text-[13px]" />}
        </Field>
      </div>
      {name && (
        <p className="text-xs text-muted">
          <Badge>{name}</Badge> {prefix && <code className="font-mono">{prefix}…</code>}
        </p>
      )}
    </ActionDialog>
  );
}
