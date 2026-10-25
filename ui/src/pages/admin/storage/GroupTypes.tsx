/** Admin: group types, which decide what volume groups of that type can do. */
import { useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { KeyValueEditor, type KvRow, fromRows, kvError, saveKv, toRows } from "@/components/KeyValueEditor";
import { Badge, Button, ErrorNotice, Field, Icon, Input, PageHeader, Switch } from "@/components/ui";
import { GROUP_SPEC_KEYS, type GroupType, consistentSnapshots, reservedGroupType, useGroupTypes } from "@/lib/cinder";
import { os, useInvalidate } from "@/lib/os";
import { tr } from "@/lib/i18n";

const CG = "consistent_group_snapshot_enabled";

export default function GroupTypes() {
  const types = useGroupTypes();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "delete"; t: GroupType } | null>(null);
  const close = () => setOpen(null);
  const specs = (t: GroupType) =>
    Object.entries(t.group_specs ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
  const columns: Column<GroupType>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (t) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <span className="truncate font-medium">{t.name}</span>
          {t.is_public === false && <Badge tone="warn">{tr("private")}</Badge>}
          {reservedGroupType(t) && (
            <span title={tr("Cinder's type for consistency groups migrated to groups. The groups API refuses it, so it isn't offered when creating groups.")}>
              <Badge>{tr("reserved")}</Badge>
            </span>
          )}
        </span>
      ),
      value: (t) => t.name,
    },
    { key: "consistent", header: tr("Snapshots"), width: "8.5rem", cell: (t) => (consistentSnapshots(t) ? <Badge tone="accent">{tr("consistent")}</Badge> : tr("Per volume")), value: (t) => (consistentSnapshots(t) ? 1 : 0), wrap: true },
    { key: "description", header: tr("Description"), hideBelow: "md", cell: (t) => <span className="text-muted">{t.description || "—"}</span>, value: (t) => t.description ?? "" },
    { key: "specs", header: tr("Group specs"), hideBelow: "lg", mono: true, cell: specs, value: specs },
  ];
  return (
    <>
      <PageHeader
        title={tr("Group types")}
        description={tr("Templates for volume groups. The consistent_group_snapshot_enabled spec makes group snapshots crash-consistent across all volumes, on backends that support it.")}
        actions={
          <Button variant="primary" onClick={() => setOpen({ kind: "create" })}>
            <Icon name="plus" />
            {tr("Create group type")}
          </Button>
        }
      />
      <ErrorNotice error={types.error} className="mb-4" />
      <DataTable
        rows={types.data}
        columns={columns}
        rowKey={(t) => t.id}
        loading={types.isPending}
        tableId="admin-group-types"
        noun={tr("group types")}
        rowLabel={(t) => t.name}
        onRefresh={() => types.refetch()}
        refreshing={types.isFetching}
        onBulkDone={() => invalidate("volume")}
        rowActions={(t) => [
          { label: tr("Edit group type"), icon: "edit", onSelect: () => setOpen({ kind: "edit", t }) },
          "-",
          { label: tr("Delete group type"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", t }) },
        ]}
      />
      {open?.kind === "create" && <GroupTypeDialog onClose={close} />}
      {open?.kind === "edit" && <GroupTypeDialog t={open.t} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete group type {name}?", { name: open.t.name })}
          submitLabel={tr("Delete")}
          done={tr("Group type {name} deleted", { name: open.t.name })}
          refresh={["volume"]}
          run={() => os.del("volume", `group_types/${open.t.id}`)}
        >
          <p className="text-sm">{tr("Cinder refuses while groups of this type exist.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function GroupTypeDialog({ t, onClose }: { t?: GroupType; onClose: () => void }) {
  const [name, setName] = useState(t?.name ?? "");
  const [description, setDescription] = useState(t?.description ?? "");
  const [pub, setPub] = useState(t?.is_public ?? true);
  const [rows, setRows] = useState<KvRow[]>(() => toRows(t?.group_specs ?? { [CG]: "<is> True" }));
  const err = kvError(rows);
  const consistent = consistentSnapshots({ id: "", name: "", group_specs: fromRows(rows) });
  const setConsistent = (on: boolean) => {
    const rest = rows.filter((r) => r.key.trim() !== CG);
    setRows(on ? [...rest, { key: CG, value: "<is> True" }] : rest);
  };
  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={t ? tr("Edit {name}", { name: t.name }) : tr("Create group type")}
      submitLabel={t ? tr("Save") : tr("Create")}
      canSubmit={!!name.trim() && !err}
      done={t ? tr("Group type saved") : tr("Group type {name} created", { name })}
      refresh={["volume"]}
      run={async () => {
        const specs = fromRows(rows);
        if (!t) return os.post("volume", "group_types", { group_type: { name: name.trim(), description: description || undefined, is_public: pub, group_specs: specs } });
        await os.put("volume", `group_types/${t.id}`, { group_type: { name: name.trim(), description, is_public: pub } });
        return saveKv(
          t.group_specs ?? {},
          specs,
          (changed) => os.post("volume", `group_types/${t.id}/group_specs`, { group_specs: changed }),
          (keys) => Promise.all(keys.map((k) => os.del("volume", `group_types/${t.id}/group_specs/${k}`))),
        );
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      </div>
      <Switch checked={pub} onChange={setPub} label={tr("Public")} />
      <Switch checked={consistent} onChange={setConsistent} label={tr("Consistent group snapshots")} hint={tr("Sets {CG}=<is> True.", { CG })} />
      <Field label={tr("Group specs")}>{() => <KeyValueEditor rows={rows} onChange={setRows} suggestions={GROUP_SPEC_KEYS} addLabel={tr("Add spec")} empty={tr("No group specs.")} />}</Field>
      {err && <p className="text-sm text-led-red">{err}</p>}
    </ActionDialog>
  );
}
