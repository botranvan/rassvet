/** Admin: Keystone domains and regions (through the gateway's identity rules). */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Picker } from "@/components/Picker";
import { Badge, Button, ErrorNotice, Field, Icon, Input, PageHeader, Switch, Textarea } from "@/components/ui";
import { os, useInvalidate, useOsList } from "@/lib/os";
import { useSession } from "@/lib/session";
import { Enabled } from "./shared";
import { tr, trx } from "@/lib/i18n";

interface KsDomain {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
}

/** Domain changes also refresh the identity pages' cached domain lists. */
function useRefreshIdentity() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return () => {
    invalidate("identity");
    qc.invalidateQueries({ queryKey: ["identity"] });
  };
}

export function Domains() {
  const domains = useOsList<KsDomain>("identity", "domains", "domains");
  const session = useSession().data!;
  const refresh = useRefreshIdentity();
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "toggle" | "delete"; d: KsDomain } | null>(null);
  const close = () => setOpen(null);
  const mine = (d: KsDomain) => d.id === session.user.domain?.id || d.id === session.project?.domain?.id;
  const columns: Column<KsDomain>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (d) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <span className="truncate font-medium">{d.name}</span>
          {d.id === "default" && <Badge>{tr("default")}</Badge>}
          {mine(d) && <Badge tone="accent">{tr("yours")}</Badge>}
        </span>
      ),
      value: (d) => d.name,
    },
    { key: "enabled", header: tr("Status"), width: "7.5rem", cell: (d) => <Enabled enabled={d.enabled} />, value: (d) => (d.enabled ? "enabled" : "disabled") },
    { key: "description", header: tr("Description"), hideBelow: "md", cell: (d) => <span className="text-muted">{d.description || "—"}</span>, value: (d) => d.description ?? "" },
    { key: "id", header: "ID", width: "17rem", mono: true, hideBelow: "lg", cell: (d) => d.id, value: (d) => d.id },
  ];
  return (
    <>
      <PageHeader
        title={tr("Domains")}
        description={tr("Top-level containers for users, groups and projects. Each domain can have its own identity backend (SQL, LDAP or a federated identity provider).")}
        actions={
          <Button variant="primary" onClick={() => setOpen({ kind: "create" })}>
            <Icon name="plus" />
            {tr("Create domain")}
          </Button>
        }
      />
      <ErrorNotice error={domains.error} className="mb-4" />
      <DataTable
        rows={domains.data}
        columns={columns}
        rowKey={(d) => d.id}
        loading={domains.isPending}
        tableId="admin-domains"
        noun={tr("domains")}
        rowLabel={(d) => d.name}
        onRefresh={() => domains.refetch()}
        refreshing={domains.isFetching}
        rowActions={(d) => [
          { label: tr("Edit domain"), icon: "edit", onSelect: () => setOpen({ kind: "edit", d }) },
          {
            label: d.enabled ? tr("Disable domain") : tr("Enable domain"),
            icon: d.enabled ? "lock" : "lock-open",
            disabled: d.enabled && (mine(d) || d.id === "default") ? (d.id === "default" ? tr("The default domain") : tr("You're signed in through it")) : false,
            onSelect: () => setOpen({ kind: "toggle", d }),
          },
          "-",
          { label: tr("Delete domain"), icon: "trash", danger: true, disabled: d.id === "default" ? tr("The default domain") : mine(d) ? tr("You're signed in through it") : false, onSelect: () => setOpen({ kind: "delete", d }) },
        ]}
      />
      {open?.kind === "create" && <DomainDialog onClose={close} onDone={refresh} />}
      {open?.kind === "edit" && <DomainDialog d={open.d} onClose={close} onDone={refresh} />}
      {open?.kind === "toggle" && (
        <ActionDialog
          onClose={close}
          danger={open.d.enabled}
          title={tr("{v} domain {name}?", { v: open.d.enabled ? tr("Disable") : tr("Enable"), name: open.d.name })}
          submitLabel={open.d.enabled ? tr("Disable") : tr("Enable")}
          done={tr("Domain {v}", { v: open.d.enabled ? tr("disabled") : tr("enabled") })}
          onDone={refresh}
          run={() => os.patch("identity", `domains/${open.d.id}`, { domain: { enabled: !open.d.enabled } })}
        >
          <p className="text-sm">{open.d.enabled ? tr("Its users can't sign in and their tokens stop working until it's enabled again.") : tr("Its users can sign in again.")}</p>
        </ActionDialog>
      )}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete domain {name}?", { name: open.d.name })}
          submitLabel={tr("Delete domain")}
          done={tr("Domain deleted")}
          onDone={refresh}
          run={async () => {
            // Keystone only deletes disabled domains.
            if (open.d.enabled) await os.patch("identity", `domains/${open.d.id}`, { domain: { enabled: false } });
            return os.del("identity", `domains/${open.d.id}`);
          }}
        >
          <p className="text-sm">
            {trx("{v}Keystone deletes its users, groups and projects with it. This can't be undone.", { v: open.d.enabled ? tr("It's disabled first (Keystone requires that), then deleted. ") : "" })}
          </p>
        </ActionDialog>
      )}
    </>
  );
}

function DomainDialog({ d, onClose, onDone }: { d?: KsDomain; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(d?.name ?? "");
  const [description, setDescription] = useState(d?.description ?? "");
  const [enabled, setEnabled] = useState(d?.enabled ?? true);
  return (
    <ActionDialog
      onClose={onClose}
      title={d ? tr("Edit {name}", { name: d.name }) : tr("Create domain")}
      submitLabel={d ? tr("Save") : tr("Create domain")}
      canSubmit={!!name.trim()}
      done={d ? tr("Domain updated") : tr("Domain {name} created", { name })}
      onDone={onDone}
      run={() => {
        const body = { domain: { name: name.trim(), description, enabled } };
        return d ? os.patch("identity", `domains/${d.id}`, body) : os.post("identity", "domains", body);
      }}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("corp-ldap")} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Switch checked={enabled} onChange={setEnabled} label={tr("Enabled")} />
    </ActionDialog>
  );
}

// =========================================================================== regions

interface Region {
  id: string;
  description?: string;
  parent_region_id?: string | null;
}

export function Regions() {
  const regions = useOsList<Region>("identity", "regions", "regions");
  const session = useSession().data!;
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "delete"; r: Region } | null>(null);
  const close = () => setOpen(null);
  const children = (r: Region) => regions.data?.filter((x) => x.parent_region_id === r.id).length ?? 0;
  const columns: Column<Region>[] = [
    {
      key: "id",
      header: tr("Region"),
      cell: (r) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <span className="truncate font-medium">{r.id}</span>
          {r.id === session.region && <Badge tone="accent">{tr("current")}</Badge>}
        </span>
      ),
      value: (r) => r.id,
    },
    { key: "parent", header: tr("Parent"), width: "10rem", hideBelow: "sm", cell: (r) => r.parent_region_id || <span className="text-muted">—</span>, value: (r) => r.parent_region_id ?? "" },
    { key: "description", header: tr("Description"), hideBelow: "md", cell: (r) => <span className="text-muted">{r.description || "—"}</span>, value: (r) => r.description ?? "" },
  ];
  return (
    <>
      <PageHeader
        title={tr("Regions")}
        description={tr("Regions group service endpoints, usually one per data centre. Endpoints in the catalog point at a region; sub-regions can nest under a parent.")}
        actions={
          <Button variant="primary" onClick={() => setOpen({ kind: "create" })}>
            <Icon name="plus" />
            {tr("Create region")}
          </Button>
        }
      />
      <ErrorNotice error={regions.error} className="mb-4" />
      <DataTable
        rows={regions.data}
        columns={columns}
        rowKey={(r) => r.id}
        loading={regions.isPending}
        tableId="admin-regions"
        noun={tr("regions")}
        rowLabel={(r) => r.id}
        onRefresh={() => regions.refetch()}
        refreshing={regions.isFetching}
        rowActions={(r) => [
          { label: tr("Edit region"), icon: "edit", onSelect: () => setOpen({ kind: "edit", r }) },
          "-",
          {
            label: tr("Delete region"),
            icon: "trash",
            danger: true,
            disabled: children(r) ? tr("It has sub-regions") : r.id === session.region ? tr("You're using it") : false,
            onSelect: () => setOpen({ kind: "delete", r }),
          },
        ]}
      />
      {open?.kind === "create" && <RegionDialog regions={regions.data ?? []} onClose={close} />}
      {open?.kind === "edit" && <RegionDialog r={open.r} regions={regions.data ?? []} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete region {id}?", { id: open.r.id })}
          submitLabel={tr("Delete region")}
          done={tr("Region deleted")}
          refresh={["identity"]}
          run={() => os.del("identity", `regions/${open.r.id}`)}
        >
          <p className="text-sm">{tr("Keystone refuses while endpoints or sub-regions still reference it.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function RegionDialog({ r, regions, onClose }: { r?: Region; regions: Region[]; onClose: () => void }) {
  const [id, setId] = useState(r?.id ?? "");
  const [description, setDescription] = useState(r?.description ?? "");
  const [parent, setParent] = useState(r?.parent_region_id ?? "");
  const validId = /^[A-Za-z0-9._-]{1,255}$/.test(id.trim());
  return (
    <ActionDialog
      onClose={onClose}
      title={r ? tr("Edit {id}", { id: r.id }) : tr("Create region")}
      submitLabel={r ? tr("Save") : tr("Create region")}
      canSubmit={validId}
      done={r ? tr("Region updated") : tr("Region {id} created", { id })}
      refresh={["identity"]}
      run={() => {
        const body = { region: { description, parent_region_id: parent || null } };
        return r ? os.patch("identity", `regions/${r.id}`, body) : os.post("identity", "regions", { region: { id: id.trim(), ...body.region } });
      }}
    >
      <Field label={tr("Region ID")} hint={r ? tr("The ID can't change.") : tr("Letters, digits, dot, dash and underscore, e.g. HN-DC2.")}>
        {(i) => <Input id={i} autoFocus={!r} disabled={!!r} value={id} onChange={(e) => setId(e.target.value)} className="font-mono text-[13px]" />}
      </Field>
      <Field label={tr("Parent region")}>
        {(i) => (
          <Picker
            id={i}
            value={parent}
            onChange={setParent}
            options={[{ value: "", label: tr("None (top level)") }, ...regions.filter((x) => x.id !== r?.id).map((x) => ({ value: x.id, label: x.id, description: x.description }))]}
          />
        )}
      </Field>
      <Field label={tr("Description")}>{(i) => <Textarea id={i} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}
