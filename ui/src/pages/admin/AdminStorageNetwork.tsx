import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { Badge, Button, ErrorNotice, Field, Icon, Input, PageHeader, Switch } from "@/components/ui";
import { type VolumeType, os, useInvalidate, useOsList } from "@/lib/os";
import { tr } from "@/lib/i18n";

export function VolumeTypes() {
  // is_public=None lists private types too (admins only).
  const types = useOsList<VolumeType>("volume", "types", "volume_types", { is_public: "None" });
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<VolumeType | null>(null);
  const specs = (t: VolumeType) => Object.entries(t.extra_specs ?? {}).map(([k, v]) => `${k}=${v}`).join(", ");
  const columns: Column<VolumeType>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (t) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <Link to={`/admin/storage/volume-types/${t.id}`} className="truncate font-medium text-cable hover:underline">
            {t.name}
          </Link>
          {t.is_public === false && <Badge tone="warn">{tr("private")}</Badge>}
        </span>
      ),
      value: (t) => t.name,
    },
    { key: "description", header: tr("Description"), hideBelow: "md", cell: (t) => <span className="text-muted">{t.description}</span>, value: (t) => t.description ?? "" },
    { key: "specs", header: tr("Extra specs"), hideBelow: "lg", mono: true, cell: specs, value: specs },
  ];
  return (
    <>
      <PageHeader
        title={tr("Volume types")}
        description={tr("Classes of block storage users can choose, mapped to Cinder backends through extra specs.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Create volume type")}
          </Button>
        }
      />
      <ErrorNotice error={types.error} className="mb-4" />
      <DataTable
        rows={types.data}
        columns={columns}
        rowKey={(t) => t.id}
        loading={types.isPending}
        tableId="admin-volume-types"
        noun={tr("volume types")}
        rowLabel={(t) => t.name}
        onRefresh={() => types.refetch()}
        refreshing={types.isFetching}
        onBulkDone={() => invalidate("volume")}
        rowActions={(x) => [
          { label: tr("Manage"), icon: "settings", onSelect: () => navigate(`/admin/storage/volume-types/${x.id}`) },
          { label: tr("Extra specs"), icon: "tags", onSelect: () => navigate(`/admin/storage/volume-types/${x.id}?tab=specs`) },
          { label: tr("QoS"), icon: "gauge", onSelect: () => navigate(`/admin/storage/volume-types/${x.id}?tab=qos`) },
          { label: tr("Encryption"), icon: "lock", onSelect: () => navigate(`/admin/storage/volume-types/${x.id}?tab=encryption`) },
          x.is_public === false && { label: tr("Project access"), icon: "users", onSelect: () => navigate(`/admin/storage/volume-types/${x.id}?tab=access`) },
          "-",
          { label: tr("Delete volume type"), icon: "trash", danger: true, onSelect: () => setDeleting(x) },
        ]}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete volume types?"),
            past: tr("deleted"),
            body: tr("Cinder refuses while volumes still use a type, and the cloud's default type can't be deleted."),
            run: (t) => os.del("volume", `types/${t.id}`),
          },
        ]}
      />
      <CreateTypeDialog open={creating} onClose={() => setCreating(false)} />
      {deleting && (
        <ActionDialog
          onClose={() => setDeleting(null)}
          danger
          title={tr("Delete volume type {name}?", { name: deleting.name })}
          submitLabel={tr("Delete volume type")}
          done={tr("Volume type {name} deleted", { name: deleting.name })}
          refresh={["volume"]}
          run={() => os.del("volume", `types/${deleting.id}`)}
        >
          <p className="text-sm">{tr("Cinder refuses while volumes still use the type.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function CreateTypeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [backend, setBackend] = useState("");
  const [isPublic, setPublic] = useState(true);
  const invalidate = useInvalidate();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () =>
      os.post<{ volume_type: VolumeType }>("volume", "types", {
        volume_type: {
          name: name.trim(),
          description: description || undefined,
          "os-volume-type-access:is_public": isPublic,
          extra_specs: backend.trim() ? { volume_backend_name: backend.trim() } : undefined,
        },
      }),
    onSuccess: (r) => {
      toast(tr("Volume type {name} created", { name: r.volume_type.name }));
      invalidate("volume");
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={() => {
        m.reset();
        onClose();
      }}
      size="sm"
      title={tr("Create volume type")}
      onSubmit={() => m.mutate()}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!name.trim()}>
            {tr("Create")}
          </Button>
        </>
      }
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("ssd")} />}</Field>
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Field label={tr("Backend name")} hint={tr("Sets volume_backend_name so volumes of this type land on that Cinder backend. Optional.")}>
        {(id) => <Input id={id} value={backend} onChange={(e) => setBackend(e.target.value)} className="font-mono text-[13px]" placeholder={tr("ceph-ssd")} />}
      </Field>
      <Switch checked={isPublic} onChange={setPublic} label={tr("Public")} />
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}
