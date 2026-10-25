/**
 * One volume type, for admins: name and visibility, extra specs, project access for
 * private types, QoS association and encryption.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { KeyValueEditor, fromRows, kvError, sameKv, saveKv, toRows } from "@/components/KeyValueEditor";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Badge, Button, Card, Detail, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Switch, Tabs, Textarea } from "@/components/ui";
import { EXTRA_SPEC_KEYS, type Encryption, useQosSpecs } from "@/lib/cinder";
import { useProjects } from "@/lib/identity";
import { type VolumeType, os, useInvalidate, useOsGet } from "@/lib/os";
import { useTab } from "@/lib/useTab";
import { tr } from "@/lib/i18n";

const TABS = ["overview", "specs", "access", "qos", "encryption"] as const;
const isPublic = (t: VolumeType) => t.is_public ?? t["os-volume-type-access:is_public"] ?? true;

export default function VolumeTypeDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const type = useOsGet<VolumeType>("volume", `types/${id}`, (r: { volume_type: VolumeType }) => r.volume_type);
  const [tab, setTab] = useTab(TABS, "overview");
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const t = type.data;
  return (
    <>
      <Link to="/admin/storage/volume-types" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Volume types")}
      </Link>
      <PageHeader
        title={t?.name ?? tr("Volume type")}
        description={t ? t.description || (isPublic(t) ? tr("Public volume type") : tr("Private volume type")) : undefined}
        actions={
          t && (
            <>
              <Button onClick={() => setEditing(true)}>
                <Icon name="edit" />
                {tr("Edit")}
              </Button>
              <Button variant="danger" onClick={() => setDeleting(true)}>
                <Icon name="trash" />
                {tr("Delete")}
              </Button>
            </>
          )
        }
      />
      <ErrorNotice error={type.error} className="mb-4" />
      {t && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "specs", label: tr("Extra specs ({length})", { length: Object.keys(t.extra_specs ?? {}).length }) },
              { id: "access", label: tr("Project access") },
              { id: "qos", label: tr("QoS") },
              { id: "encryption", label: tr("Encryption") },
            ]}
          />
          {tab === "overview" && <Overview t={t} />}
          {tab === "specs" && <ExtraSpecs t={t} />}
          {tab === "access" && <Access t={t} />}
          {tab === "qos" && <QosTab t={t} />}
          {tab === "encryption" && <EncryptionTab t={t} />}
        </>
      )}
      {t && editing && <EditTypeDialog t={t} onClose={() => setEditing(false)} />}
      {t && deleting && (
        <ActionDialog
          onClose={() => setDeleting(false)}
          danger
          title={tr("Delete volume type {name}?", { name: t.name })}
          submitLabel={tr("Delete volume type")}
          done={tr("Volume type {name} deleted", { name: t.name })}
          refresh={["volume"]}
          onDone={() => navigate("/admin/storage/volume-types")}
          run={() => os.del("volume", `types/${t.id}`)}
        >
          <p className="text-sm">{tr("Cinder refuses while volumes still use the type, and the cloud's default type can't be deleted.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function Overview({ t }: { t: VolumeType }) {
  const qos = useQosSpecs();
  const q = qos.data?.find((x) => x.id === t.qos_specs_id);
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Card title={tr("Details")}>
        <dl>
          <Detail label={tr("Name")}>{t.name}</Detail>
          <Detail label="ID">
            <Mono>{t.id}</Mono>
          </Detail>
          {t.description && (
            <Detail label={tr("Description")} wrap>
              {t.description}
            </Detail>
          )}
          <Detail label={tr("Visibility")}>{isPublic(t) ? tr("Public") : <Badge tone="warn">{tr("private")}</Badge>}</Detail>
          <Detail label={tr("QoS specs")}>{q ? q.name : t.qos_specs_id ? <Mono>{t.qos_specs_id}</Mono> : tr("None")}</Detail>
        </dl>
      </Card>
      <Card title={tr("Extra specs")}>
        <dl>
          {Object.entries(t.extra_specs ?? {}).map(([k, v]) => (
            <Detail key={k} label={k}>
              <Mono>{v}</Mono>
            </Detail>
          ))}
          {Object.keys(t.extra_specs ?? {}).length === 0 && <p className="text-sm text-muted">{tr("None. Volumes of this type can land on any backend.")}</p>}
        </dl>
      </Card>
    </div>
  );
}

function EditTypeDialog({ t, onClose }: { t: VolumeType; onClose: () => void }) {
  const [name, setName] = useState(t.name);
  const [description, setDescription] = useState(t.description ?? "");
  const [pub, setPub] = useState(isPublic(t));
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit {name}", { name: t.name })}
      submitLabel={tr("Save")}
      canSubmit={!!name.trim()}
      done={tr("Volume type updated")}
      refresh={["volume"]}
      run={() => os.put("volume", `types/${t.id}`, { volume_type: { name: name.trim(), description, is_public: pub } })}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Switch checked={pub} onChange={setPub} label={tr("Public")} hint={tr("Private types are offered only to projects given access.")} />
    </ActionDialog>
  );
}

function ExtraSpecs({ t }: { t: VolumeType }) {
  const before = t.extra_specs ?? {};
  const [rows, setRows] = useState(() => toRows(before));
  const toast = useToast();
  const invalidate = useInvalidate();
  const err = kvError(rows);
  const save = useMutation({
    mutationFn: () =>
      saveKv(
        before,
        fromRows(rows),
        (changed) => os.post("volume", `types/${t.id}/extra_specs`, { extra_specs: changed }),
        (keys) => Promise.all(keys.map((k) => os.del("volume", `types/${t.id}/extra_specs/${k}`))),
      ),
    onSuccess: () => {
      toast(tr("Extra specs saved"));
      invalidate("volume");
    },
  });
  const dirty = !sameKv(fromRows(rows), before);
  return (
    <Card
      title={tr("Extra specs")}
      actions={
        <>
          <Button onClick={() => setRows(toRows(before))} disabled={!dirty}>
            {tr("Reset")}
          </Button>
          <Button variant="primary" busy={save.isPending} disabled={!dirty || !!err} onClick={() => save.mutate()}>
            {tr("Save")}
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-muted">
        {tr("The scheduler matches these against backend capabilities; drivers read their own keys. Use")}{" "}<code className="font-mono">{tr("<is> True")}</code>{" "}{tr("for boolean capabilities.")}
      </p>
      <KeyValueEditor rows={rows} onChange={setRows} suggestions={EXTRA_SPEC_KEYS} addLabel={tr("Add spec")} empty={tr("No extra specs.")} />
      {err && <p className="mt-2 text-sm text-led-red">{err}</p>}
      <ErrorNotice error={save.error} className="mt-3" />
    </Card>
  );
}

function Access({ t }: { t: VolumeType }) {
  const projects = useProjects(true);
  const access = useQuery({
    queryKey: ["os", "volume", "types", t.id, "access"],
    queryFn: () => os.get<{ volume_type_access: { project_id: string }[] }>("volume", `types/${t.id}/os-volume-type-access`).then((r) => r.volume_type_access),
    enabled: !isPublic(t),
  });
  const [project, setProject] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const toast = useToast();
  const invalidate = useInvalidate();
  const add = useMutation({
    mutationFn: () => os.action("volume", `types/${t.id}`, { addProjectAccess: { project } }),
    onSuccess: () => {
      toast(tr("Access granted"));
      setProject("");
      invalidate("volume");
    },
  });
  if (isPublic(t)) return <Card title={tr("Project access")}><p className="text-sm text-muted">{tr("This type is public, so every project can use it. Make it private (Edit) to limit it to chosen projects.")}</p></Card>;
  const has = new Set(access.data?.map((a) => a.project_id));
  const name = (p: string) => projects.data?.find((x) => x.id === p)?.name ?? p;
  const rows = (access.data ?? []).map((a) => ({ id: a.project_id }));
  const cols: Column<{ id: string }>[] = [
    { key: "name", header: tr("Project"), cell: (r) => <span className="font-medium">{name(r.id)}</span>, value: (r) => name(r.id) },
    { key: "id", header: "ID", mono: true, hideBelow: "md", cell: (r) => r.id, value: (r) => r.id },
  ];
  return (
    <div className="space-y-4">
      <Card title={tr("Grant access")}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-60 flex-1">
            <Picker
              aria-label={tr("Project")}
              value={project}
              onChange={setProject}
              searchable
              loading={projects.isPending}
              placeholder={tr("Choose a project")}
              options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name, icon: "folder", disabled: has.has(p.id) ? tr("Already has access") : false }))}
            />
          </div>
          <Button variant="primary" disabled={!project} busy={add.isPending} onClick={() => add.mutate()}>
            <Icon name="plus" />
            {tr("Grant")}
          </Button>
        </div>
        <ErrorNotice error={add.error} className="mt-3" />
      </Card>
      <DataTable
        rows={access.data ? rows : undefined}
        columns={cols}
        rowKey={(r) => r.id}
        loading={access.isPending}
        noun={tr("projects")}
        empty={tr("No project can use this private type yet.")}
        onRefresh={() => access.refetch()}
        refreshing={access.isFetching}
        rowActions={(r) => [{ label: tr("Revoke access"), icon: "x", danger: true, onSelect: () => setRemoving(r.id) }]}
      />
      {removing && (
        <ActionDialog
          onClose={() => setRemoving(null)}
          danger
          title={tr("Revoke access for {name}?", { name: name(removing) })}
          submitLabel={tr("Revoke")}
          done={tr("Access revoked")}
          refresh={["volume"]}
          run={() => os.action("volume", `types/${t.id}`, { removeProjectAccess: { project: removing } })}
        >
          <p className="text-sm">{tr("Existing volumes of this type in the project keep working; new ones can't be created.")}</p>
        </ActionDialog>
      )}
    </div>
  );
}

function QosTab({ t }: { t: VolumeType }) {
  const qos = useQosSpecs();
  const [choice, setChoice] = useState(t.qos_specs_id ?? "");
  const toast = useToast();
  const invalidate = useInvalidate();
  const m = useMutation({
    mutationFn: async () => {
      if (t.qos_specs_id) await os.get("volume", `qos-specs/${t.qos_specs_id}/disassociate`, { vol_type_id: t.id });
      if (choice) await os.get("volume", `qos-specs/${choice}/associate`, { vol_type_id: t.id });
    },
    onSuccess: () => {
      toast(choice ? tr("QoS specs associated") : tr("QoS specs removed"));
      invalidate("volume");
    },
  });
  const current = qos.data?.find((q) => q.id === t.qos_specs_id);
  const chosen = qos.data?.find((q) => q.id === choice);
  return (
    <Card title={tr("Quality of service")}>
      <p className="mb-4 text-sm text-muted">
        {tr("Volumes of this type get the limits of the associated QoS specs. Front-end specs are applied by Nova on the hypervisor, back-end specs by the storage driver. Changes reach attached volumes on their next attach.")}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-60 flex-1">
          <Field label={tr("QoS specs")}>
            {(id) => (
              <Picker
                id={id}
                value={choice}
                onChange={setChoice}
                loading={qos.isPending}
                options={[
                  { value: "", label: tr("None") },
                  ...(qos.data ?? []).map((q) => ({ value: q.id, label: q.name, icon: "gauge", meta: q.consumer, description: Object.entries(q.specs).map(([k, v]) => `${k}=${v}`).join(", ") })),
                ]}
              />
            )}
          </Field>
        </div>
        <Button variant="primary" disabled={choice === (t.qos_specs_id ?? "")} busy={m.isPending} onClick={() => m.mutate()}>
          {tr("Save")}
        </Button>
      </div>
      {(chosen ?? current) && (
        <dl className="mt-4">
          {Object.entries((chosen ?? current)!.specs).map(([k, v]) => (
            <Detail key={k} label={k}>
              <Mono>{v}</Mono>
            </Detail>
          ))}
        </dl>
      )}
      <ErrorNotice error={m.error} className="mt-3" />
      <p className="mt-4 text-sm">
        <Link to="/admin/storage/qos" className="text-cable hover:underline">
          {tr("Manage QoS specs")}
        </Link>
      </p>
    </Card>
  );
}

const PROVIDERS = [
  { value: "luks", label: tr("luks"), description: tr("LUKS (dm-crypt), recommended") },
  { value: "plain", label: tr("plain"), description: tr("Plain dm-crypt") },
];
const CIPHERS = ["aes-xts-plain64", "aes-cbc-essiv"];

function EncryptionTab({ t }: { t: VolumeType }) {
  const enc = useQuery({
    queryKey: ["os", "volume", "types", t.id, "encryption"],
    queryFn: () => os.get<Encryption>("volume", `types/${t.id}/encryption`),
  });
  const [provider, setProvider] = useState("luks");
  const [cipher, setCipher] = useState("aes-xts-plain64");
  const [keySize, setKeySize] = useState("256");
  const [location, setLocation] = useState<"front-end" | "back-end">("front-end");
  const [removing, setRemoving] = useState(false);
  const toast = useToast();
  const invalidate = useInvalidate();
  const create = useMutation({
    mutationFn: () =>
      os.post("volume", `types/${t.id}/encryption`, { encryption: { provider, cipher, key_size: Number(keySize), control_location: location } }),
    onSuccess: () => {
      toast(tr("Encryption enabled for the type"));
      invalidate("volume");
    },
  });
  const e = enc.data;
  if (enc.isPending) return <Card title={tr("Encryption")}><p className="text-sm text-muted">{tr("Loading…")}</p></Card>;
  if (e?.provider)
    return (
      <Card
        title={tr("Encryption")}
        actions={
          <Button variant="danger" onClick={() => setRemoving(true)}>
            <Icon name="trash" />
            {tr("Remove encryption")}
          </Button>
        }
      >
        <p className="mb-3 text-sm text-muted">{tr("New volumes of this type are encrypted with a key from Barbican.")}</p>
        <dl>
          <Detail label={tr("Provider")}>{e.provider}</Detail>
          <Detail label={tr("Cipher")}>{e.cipher ?? "—"}</Detail>
          <Detail label={tr("Key size")}>{e.key_size ? tr("{key_size} bits", { key_size: e.key_size }) : "—"}</Detail>
          <Detail label={tr("Control location")}>{e.control_location}</Detail>
        </dl>
        {removing && (
          <ActionDialog
            onClose={() => setRemoving(false)}
            danger
            title={tr("Remove encryption?")}
            submitLabel={tr("Remove encryption")}
            done={tr("Encryption removed")}
            refresh={["volume"]}
            run={() => os.del("volume", `types/${t.id}/encryption/${e.encryption_id}`)}
          >
            <p className="text-sm">{tr("Cinder only allows this while no volumes use the type.")}</p>
          </ActionDialog>
        )}
      </Card>
    );
  return (
    <Card title={tr("Encryption")}>
      <ErrorNotice error={enc.error} className="mb-3" />
      <p className="mb-4 text-sm text-muted">{tr("Not encrypted. Encryption can only be added while no volumes use the type; keys are created in Barbican for each volume.")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Provider")}>{(id) => <Picker id={id} value={provider} onChange={setProvider} options={PROVIDERS} />}</Field>
        <Field label={tr("Cipher")}>{(id) => <Picker id={id} value={cipher} onChange={setCipher} options={CIPHERS.map((c) => ({ value: c, label: c }))} />}</Field>
        <Field label={tr("Key size")}>{(id) => <Picker id={id} value={keySize} onChange={setKeySize} options={["128", "256", "512"].map((k) => ({ value: k, label: tr("{k} bits", { k }) }))} />}</Field>
        <Field label={tr("Control location")} hint={tr("Front-end: Nova encrypts on the hypervisor. Back-end: the storage does it.")}>
          {(id) => (
            <Picker
              id={id}
              value={location}
              onChange={(v) => setLocation(v as "front-end" | "back-end")}
              options={[
                { value: "front-end", label: tr("front-end") },
                { value: "back-end", label: tr("back-end") },
              ]}
            />
          )}
        </Field>
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" busy={create.isPending} onClick={() => create.mutate()}>
          <Icon name="lock" />
          {tr("Enable encryption")}
        </Button>
      </div>
      <ErrorNotice error={create.error} className="mt-3" />
    </Card>
  );
}
