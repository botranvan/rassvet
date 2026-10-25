import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type Column, DataTable } from "@/components/DataTable";
import { api } from "@/lib/api";
import { ConfirmDialog, Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { Badge, Button, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Textarea } from "@/components/ui";
import { type Role, useCreateRole, useDeleteRole, useRoles, useUpdateRole } from "@/lib/identity";
import { useDomainName } from "./shared";
import { tr } from "@/lib/i18n";

/** Roles that OpenStack services rely on by default; deleting them breaks default policies. */
const BUILTIN = new Set(["admin", "member", "reader", "service", "manager"]);

export default function Roles() {
  const roles = useRoles();
  const domainName = useDomainName();
  const [editing, setEditing] = useState<Role | null | "new">(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const del = useDeleteRole();
  const qc = useQueryClient();
  const toast = useToast();

  const columns: Column<Role>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          <span className="font-medium">{r.name}</span>
          {BUILTIN.has(r.name) && <Badge>{tr("default")}</Badge>}
        </span>
      ),
      value: (r) => r.name,
    },
    { key: "description", hideBelow: "md", header: tr("Description"), cell: (r) => <span className="text-muted">{r.description}</span>, value: (r) => r.description ?? "" },
    {
      key: "domain", width: "8rem", hideBelow: "lg",
      header: tr("Scope"),
      cell: (r) => (r.domain_id ? tr("Domain {domainName}", { domainName: domainName(r.domain_id) }) : tr("Global")),
      value: (r) => r.domain_id ?? "",
    },
    { key: "id", width: "10rem", hideBelow: "xl", header: "ID", cell: (r) => <Mono>{r.id}</Mono>, value: (r) => r.id },
    {
      key: "actions", width: "5.5rem",
      header: "",
      wrap: true,
      className: "w-20 text-right",
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <button onClick={() => setEditing(r)} aria-label={tr("Edit {name}", { name: r.name })} className="rounded-md p-1.5 text-muted hover:bg-ink/5 hover:text-ink">
            <Icon name="pencil" />
          </button>
          <button
            onClick={() => setDeleting(r)}
            aria-label={tr("Delete {name}", { name: r.name })}
            className="rounded-md p-1.5 text-muted hover:bg-led-red/10 hover:text-led-red"
          >
            <Icon name="trash" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={tr("Roles")}
        description={tr("Roles are granted to users on projects. What each role allows is decided by each service's policy.")}
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Icon name="plus" />
            {tr("Create role")}
          </Button>
        }
      />
      <ErrorNotice error={roles.error} className="mb-4" />
      <DataTable
        rows={roles.data}
        columns={columns}
        rowKey={(r) => r.id}
        loading={roles.isPending}
        filterPlaceholder={tr("Filter roles")}
        empty={tr("No roles.")}
        tableId="admin-roles"
        noun={tr("roles")}
        rowLabel={(r) => r.name}
        onRefresh={() => roles.refetch()}
        refreshing={roles.isFetching}
        onBulkDone={() => qc.invalidateQueries({ queryKey: ["identity"] })}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete roles?"),
            past: tr("deleted"),
            body: tr("Every assignment of these roles is removed, in all projects."),
            check: (r) => (BUILTIN.has(r.name) ? tr("Default role used by OpenStack policies; delete it from its own page") : true),
            run: (r) => api.del(`/identity/admin/roles/${encodeURIComponent(r.id)}`),
          },
        ]}
      />

      {editing && (
        <RoleDialog key={editing === "new" ? "new" : editing.id} role={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => {
          del.reset();
          setDeleting(null);
        }}
        title={tr("Delete role?")}
        confirmLabel={tr("Delete role")}
        busy={del.isPending}
        error={del.error}
        onConfirm={() =>
          deleting &&
          del.mutate(deleting.id, {
            onSuccess: () => {
              toast(tr("Role {name} deleted", { name: deleting.name }));
              setDeleting(null);
            },
          })
        }
      >
        {tr("Every assignment of")}{" "}<strong className="font-medium">{deleting?.name}</strong>{" "}{tr("is removed, in all projects.")}
        {deleting && BUILTIN.has(deleting.name) && (
          <p className="mt-3 rounded-md bg-led-amber/12 px-3 py-2">
            {tr("OpenStack's default policies use this role. Deleting it can lock users out of services.")}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

function RoleDialog({ role, onClose }: { role?: Role; onClose: () => void }) {
  const create = useCreateRole();
  const update = useUpdateRole();
  const toast = useToast();
  const m = role ? update : create;
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const done = (r: Role) => {
    toast(role ? tr("Role {name} updated", { name: r.name }) : tr("Role {name} created", { name: r.name }));
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={role ? tr("Edit role") : tr("Create role")}
      onSubmit={() =>
        role
          ? update.mutate({ id: role.id, name: name.trim(), description }, { onSuccess: done })
          : create.mutate({ name: name.trim(), description: description || undefined }, { onSuccess: done })
      }
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!name.trim()}>
            {role ? tr("Save changes") : tr("Create role")}
          </Button>
        </>
      }
    >
      <Field label={tr("Name")} hint={role && BUILTIN.has(role.name) ? tr("Renaming a default role breaks policies that refer to it.") : undefined}>
        {(id) => <Input id={id} required autoFocus value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label={tr("Description")}>
        {(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}
