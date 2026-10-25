/** Admin: Cinder QoS specs (IOPS and throughput limits) and the volume types they apply to. */
import { useMutation, useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { KeyValueEditor, type KvRow, fromRows, kvError, saveKv, toRows } from "@/components/KeyValueEditor";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Badge, Button, ErrorNotice, Field, Icon, Input, PageHeader } from "@/components/ui";
import { QOS_KEYS, type QosAssociation, type QosSpec, useQosAssociations, useQosSpecs } from "@/lib/cinder";
import { os, useInvalidate, useOsList, type VolumeType } from "@/lib/os";
import { tr } from "@/lib/i18n";

const CONSUMERS = [
  { value: "front-end", label: tr("front-end"), description: tr("Enforced by Nova (libvirt) on the hypervisor") },
  { value: "back-end", label: tr("back-end"), description: tr("Enforced by the storage driver") },
  { value: "both", label: tr("both"), description: tr("Passed to Nova and to the driver") },
];

const specText = (q: QosSpec) =>
  Object.entries(q.specs)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

export default function QosSpecs() {
  const qos = useQosSpecs();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "types" | "delete"; q: QosSpec } | null>(null);
  const close = () => setOpen(null);
  const assoc = useQueries({
    queries: (qos.data ?? []).map((q) => ({
      queryKey: ["os", "volume", "qos-specs", q.id, "associations"],
      queryFn: () => os.get<{ qos_associations: QosAssociation[] }>("volume", `qos-specs/${q.id}/associations`).then((r) => r.qos_associations),
    })),
  });
  const typesOf = (q: QosSpec) => assoc[(qos.data ?? []).indexOf(q)]?.data;
  const typesText = (q: QosSpec) => typesOf(q)?.map((a) => a.name).join(", ") ?? "";

  const columns: Column<QosSpec>[] = [
    { key: "name", header: tr("Name"), cell: (q) => <span className="font-medium">{q.name}</span>, value: (q) => q.name },
    { key: "consumer", header: tr("Consumer"), width: "7.5rem", cell: (q) => <Badge tone={q.consumer === "front-end" ? "accent" : "neutral"}>{q.consumer}</Badge>, value: (q) => q.consumer, wrap: true },
    { key: "specs", header: tr("Specs"), mono: true, cell: specText, value: specText },
    {
      key: "types",
      header: tr("Volume types"),
      hideBelow: "md",
      cell: (q) => {
        const t = typesOf(q);
        return t === undefined ? "…" : t.length ? typesText(q) : <span className="text-muted">{tr("None")}</span>;
      },
      value: typesText,
    },
  ];

  return (
    <>
      <PageHeader
        title={tr("QoS specs")}
        description={tr("Named sets of I/O limits. Associate them with volume types; every volume of those types gets the limits.")}
        actions={
          <Button variant="primary" onClick={() => setOpen({ kind: "create" })}>
            <Icon name="plus" />
            {tr("Create QoS specs")}
          </Button>
        }
      />
      <ErrorNotice error={qos.error} className="mb-4" />
      <DataTable
        rows={qos.data}
        columns={columns}
        rowKey={(q) => q.id}
        loading={qos.isPending}
        tableId="admin-qos"
        noun={tr("QoS specs")}
        rowLabel={(q) => q.name}
        empty={tr("No QoS specs.")}
        onRefresh={() => qos.refetch()}
        refreshing={qos.isFetching}
        onBulkDone={() => invalidate("volume")}
        rowActions={(q) => [
          { label: tr("Edit specs"), icon: "edit", onSelect: () => setOpen({ kind: "edit", q }) },
          { label: tr("Volume types"), icon: "tags", onSelect: () => setOpen({ kind: "types", q }) },
          "-",
          { label: tr("Delete QoS specs"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", q }) },
        ]}
      />
      {open?.kind === "create" && <QosDialog onClose={close} />}
      {open?.kind === "edit" && <QosDialog q={open.q} onClose={close} />}
      {open?.kind === "types" && <AssociationsDialog q={open.q} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete QoS specs {name}?", { name: open.q.name })}
          submitLabel={tr("Delete")}
          done={tr("QoS specs {name} deleted", { name: open.q.name })}
          refresh={["volume"]}
          run={() => os.del("volume", `qos-specs/${open.q.id}`, { force: typesOf(open.q)?.length ? "True" : undefined })}
        >
          <p className="text-sm">
            {typesOf(open.q)?.length
              ? tr("It is associated with {typesText}; those types lose their limits.", { typesText: typesText(open.q) })
              : tr("No volume type uses it.")}
          </p>
        </ActionDialog>
      )}
    </>
  );
}

/** Create QoS specs, or edit the consumer and keys of existing ones. */
function QosDialog({ q, onClose }: { q?: QosSpec; onClose: () => void }) {
  const [name, setName] = useState(q?.name ?? "");
  const [consumer, setConsumer] = useState<string>(q?.consumer ?? "back-end");
  const [rows, setRows] = useState<KvRow[]>(() => (q ? toRows(q.specs) : [{ key: "total_iops_sec", value: "" }]));
  const err = kvError(rows);
  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={q ? tr("Edit {name}", { name: q.name }) : tr("Create QoS specs")}
      submitLabel={q ? tr("Save") : tr("Create")}
      canSubmit={!!name.trim() && !err}
      done={q ? tr("QoS specs saved") : tr("QoS specs {name} created", { name })}
      refresh={["volume"]}
      run={async () => {
        const specs = fromRows(rows);
        if (!q) return os.post("volume", "qos-specs", { qos_specs: { name: name.trim(), consumer, ...specs } });
        if (consumer !== q.consumer) await os.put("volume", `qos-specs/${q.id}`, { qos_specs: { consumer } });
        return saveKv(
          q.specs,
          specs,
          (changed) => os.put("volume", `qos-specs/${q.id}`, { qos_specs: changed }),
          (keys) => os.put("volume", `qos-specs/${q.id}/delete_keys`, { keys }),
        );
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus={!q} disabled={!!q} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("gold-iops")} />}</Field>
        <Field label={tr("Consumer")}>{(id) => <Picker id={id} value={consumer} onChange={setConsumer} options={CONSUMERS} />}</Field>
      </div>
      <Field label={tr("Limits")}>{() => <KeyValueEditor rows={rows} onChange={setRows} suggestions={QOS_KEYS} addLabel={tr("Add limit")} empty={tr("No limits.")} />}</Field>
      {err && <p className="text-sm text-led-red">{err}</p>}
    </ActionDialog>
  );
}

function AssociationsDialog({ q, onClose }: { q: QosSpec; onClose: () => void }) {
  const assoc = useQosAssociations(q.id);
  const types = useOsList<VolumeType>("volume", "types", "volume_types", { is_public: "None" });
  const qos = useQosSpecs();
  const [type, setType] = useState("");
  const toast = useToast();
  const invalidate = useInvalidate();
  const change = useMutation({
    mutationFn: ({ typeId, on }: { typeId: string; on: boolean }) => os.get("volume", `qos-specs/${q.id}/${on ? "associate" : "disassociate"}`, { vol_type_id: typeId }),
    onSuccess: (_, v) => {
      toast(v.on ? tr("Associated") : tr("Disassociated"));
      setType("");
      invalidate("volume");
    },
  });
  const linked = new Set(assoc.data?.map((a) => a.id));
  const otherName = (id?: string | null) => qos.data?.find((x) => x.id === id)?.name ?? id;
  return (
    <ActionDialog onClose={onClose} size="md" title={tr("Volume types using {name}", { name: q.name })} submitLabel={tr("Done")} run={async () => undefined}>
      <ul className="divide-y divide-line rounded-md border border-line">
        {(assoc.data ?? []).map((a) => (
          <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <Icon name="tags" className="text-muted" />
            <Link to={`/admin/storage/volume-types/${a.id}?tab=qos`} className="min-w-0 flex-1 truncate text-cable hover:underline">
              {a.name}
            </Link>
            <Button type="button" variant="ghost" className="h-8" onClick={() => change.mutate({ typeId: a.id, on: false })}>
              {tr("Disassociate")}
            </Button>
          </li>
        ))}
        {assoc.data?.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">{tr("No volume type uses these specs.")}</li>}
        {assoc.isPending && <li className="px-3 py-4 text-center text-sm text-muted">{tr("Loading…")}</li>}
      </ul>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <Picker
            aria-label={tr("Volume type")}
            value={type}
            onChange={setType}
            loading={types.isPending}
            placeholder={tr("Associate a volume type")}
            options={(types.data ?? []).map((t) => ({
              value: t.id,
              label: t.name,
              icon: "tags",
              disabled: linked.has(t.id) ? tr("Already associated") : t.qos_specs_id ? tr("Uses {otherName}", { otherName: otherName(t.qos_specs_id) }) : false,
            }))}
          />
        </div>
        <Button type="button" disabled={!type} busy={change.isPending} onClick={() => change.mutate({ typeId: type, on: true })}>
          {tr("Associate")}
        </Button>
      </div>
      <ErrorNotice error={change.error} />
    </ActionDialog>
  );
}
