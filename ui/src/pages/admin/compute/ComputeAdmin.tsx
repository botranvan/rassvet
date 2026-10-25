/** Admin: Nova compute services and host aggregates. */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { KeyValueEditor, type KvRow, fromRows, kvError, toRows } from "@/components/KeyValueEditor";
import { MultiPicker } from "@/components/Picker";
import { Badge, Button, ErrorNotice, Field, Icon, Input, PageHeader, StatusDot } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { os, useInvalidate, useOsList } from "@/lib/os";
import { tr, trx } from "@/lib/i18n";

// =========================================================================== services

export interface ComputeService {
  id: string | number;
  binary: string;
  host: string;
  zone: string;
  status: "enabled" | "disabled";
  state: "up" | "down";
  updated_at?: string | null;
  disabled_reason?: string | null;
  forced_down?: boolean;
}

export const useComputeServices = (q?: Record<string, string>) => useOsList<ComputeService>("compute", "os-services", "services", q);

const svcState = (s: ComputeService) => (s.forced_down ? tr("forced down") : s.state === "down" ? tr("down") : s.status === "disabled" ? tr("disabled") : tr("up"));

export function ComputeServices() {
  const services = useComputeServices();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "disable" | "enable" | "force" | "unforce" | "delete"; s: ComputeService } | null>(null);
  const close = () => setOpen(null);
  const down = services.data?.filter((s) => s.state === "down" && s.status === "enabled").length ?? 0;
  const columns: Column<ComputeService>[] = [
    { key: "binary", header: tr("Service"), width: "10rem", cell: (s) => <span className="font-medium">{s.binary}</span>, value: (s) => s.binary },
    { key: "host", header: tr("Host"), cell: (s) => s.host, value: (s) => s.host },
    {
      key: "state",
      header: tr("State"),
      width: "9rem",
      cell: (s) => <StatusDot status={s.forced_down || s.state === "down" ? "error" : s.status === "disabled" ? "warn" : "ok"} label={svcState(s)} />,
      value: svcState,
    },
    { key: "zone", header: tr("Zone"), width: "7rem", hideBelow: "md", cell: (s) => s.zone, value: (s) => s.zone },
    { key: "updated", header: tr("Last report"), width: "9.5rem", hideBelow: "lg", cell: (s) => fmtDate(s.updated_at), value: (s) => s.updated_at ?? "" },
    { key: "reason", header: tr("Disabled reason"), hideBelow: "xl", cell: (s) => <span className="text-muted">{s.disabled_reason || "—"}</span>, value: (s) => s.disabled_reason ?? "" },
  ];
  const put = (s: ComputeService, body: object) => os.put("compute", `os-services/${s.id}`, body);
  return (
    <>
      <PageHeader
        title={tr("Compute services")}
        description={
          down
            ? tr("{down} enabled service{v} down. Disable a compute host to stop scheduling new instances to it; force it down before evacuating its instances.", { down, v: down === 1 ? tr(" is") : tr("s are") })
            : tr("Nova services per host. Disable a compute host to stop scheduling new instances to it (maintenance); running instances keep running.")
        }
      />
      <ErrorNotice error={services.error} className="mb-4" />
      <DataTable
        rows={services.data}
        columns={columns}
        rowKey={(s) => String(s.id)}
        loading={services.isPending}
        tableId="admin-compute-services"
        noun={tr("services")}
        rowLabel={(s) => `${s.binary} on ${s.host}`}
        filterPlaceholder={tr("Filter by service, host, zone or state")}
        onRefresh={() => services.refetch()}
        refreshing={services.isFetching}
        onBulkDone={() => invalidate("compute")}
        rowActions={(s) => [
          s.status === "enabled"
            ? { label: tr("Disable"), icon: "ban", onSelect: () => setOpen({ kind: "disable", s }) }
            : { label: tr("Enable"), icon: "play", onSelect: () => setOpen({ kind: "enable", s }) },
          s.binary === "nova-compute" &&
            (s.forced_down
              ? { label: tr("Clear forced down"), icon: "rotate-ccw", onSelect: () => setOpen({ kind: "unforce", s }) }
              : { label: tr("Force down"), icon: "power", onSelect: () => setOpen({ kind: "force", s }) }),
          "-",
          { label: tr("Delete service"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", s }) },
        ]}
        bulkActions={[
          {
            id: "enable",
            label: tr("Enable"),
            icon: "play",
            title: tr("Enable services?"),
            past: tr("enabled"),
            check: (s) => (s.status === "enabled" ? tr("Already enabled") : true),
            run: (s) => put(s, { status: "enabled" }),
          },
          {
            id: "disable",
            label: tr("Disable"),
            icon: "ban",
            title: tr("Disable services?"),
            past: tr("disabled"),
            body: tr("The scheduler stops placing new instances on these hosts. Running instances aren't touched."),
            check: (s) => (s.status === "disabled" ? tr("Already disabled") : true),
            run: (s) => put(s, { status: "disabled", disabled_reason: "Disabled from Rassvet" }),
          },
        ]}
      />
      {open?.kind === "disable" && <DisableDialog s={open.s} onClose={close} />}
      {open?.kind === "enable" && (
        <ActionDialog onClose={close} title={tr("Enable {binary} on {host}?", { binary: open.s.binary, host: open.s.host })} submitLabel={tr("Enable")} done={tr("Service enabled")} refresh={["compute"]} run={() => put(open.s, { status: "enabled" })}>
          <p className="text-sm">{tr("The scheduler may place new instances on this host again.")}</p>
        </ActionDialog>
      )}
      {(open?.kind === "force" || open?.kind === "unforce") && (
        <ActionDialog
          onClose={close}
          danger={open.kind === "force"}
          title={open.kind === "force" ? tr("Force {host} down?", { host: open.s.host }) : tr("Clear forced down on {host}?", { host: open.s.host })}
          submitLabel={open.kind === "force" ? tr("Force down") : tr("Clear")}
          done={open.kind === "force" ? tr("Host forced down") : tr("Forced down cleared")}
          refresh={["compute"]}
          run={() => put(open.s, { forced_down: open.kind === "force" })}
        >
          <p className="text-sm">
            {open.kind === "force"
              ? tr("Tells Nova the host is dead without waiting for the service timeout, so its instances can be evacuated right away. Only do this when the host is really down (fenced), or instances may run twice.")
              : tr("Nova trusts the service's heartbeat again. Do this once the host is repaired and nova-compute is running.")}
          </p>
        </ActionDialog>
      )}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete {binary} on {host}?", { binary: open.s.binary, host: open.s.host })}
          submitLabel={tr("Delete service")}
          done={tr("Service deleted")}
          refresh={["compute"]}
          run={() => os.del("compute", `os-services/${open.s.id}`)}
        >
          <p className="text-sm">
            {tr("For hosts that are gone for good. Nova refuses while the host still has instances; deleting a compute service also removes its resource provider in Placement. A running service registers itself again.")}
          </p>
        </ActionDialog>
      )}
    </>
  );
}

function DisableDialog({ s, onClose }: { s: ComputeService; onClose: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Disable {binary} on {host}?", { binary: s.binary, host: s.host })}
      submitLabel={tr("Disable")}
      done={tr("Service disabled")}
      refresh={["compute"]}
      run={() => os.put("compute", `os-services/${s.id}`, { status: "disabled", disabled_reason: reason.trim() || undefined })}
    >
      <p className="text-sm">{tr("The scheduler stops placing new instances here; running instances keep running.")}</p>
      <Field label={tr("Reason")} hint={tr("Shown to other admins, e.g. “Kernel upgrade, back at 18:00”.")}>
        {(id) => <Input id={id} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} />}
      </Field>
    </ActionDialog>
  );
}

// =========================================================================== aggregates

export interface Aggregate {
  id: number;
  uuid?: string;
  name: string;
  availability_zone: string | null;
  hosts: string[];
  metadata: Record<string, string>;
  created_at?: string;
}

const AGG_KEYS = [
  { key: "filter_tenant_id", hint: tr("Only these projects (comma-separated IDs) — AggregateMultiTenancyIsolation / tenant isolation") },
  { key: "pinned", hint: tr("Match flavors with aggregate_instance_extra_specs:pinned"), values: ["true", "false"] },
  { key: "ssd", hint: tr("Match flavors with aggregate_instance_extra_specs:ssd"), values: ["true"] },
  { key: "cpu_allocation_ratio", hint: tr("Overcommit for hosts in this aggregate (AggregateCoreFilter)") },
  { key: "ram_allocation_ratio", hint: tr("Overcommit for hosts in this aggregate (AggregateRamFilter)") },
  { key: "max_instances_per_host", hint: tr("AggregateNumInstancesFilter") },
];

export function Aggregates() {
  const aggs = useQuery({ queryKey: ["os", "compute", "os-aggregates"], queryFn: () => os.get<{ aggregates: Aggregate[] }>("compute", "os-aggregates").then((r) => r.aggregates) });
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "hosts" | "meta" | "delete"; a: Aggregate } | null>(null);
  const close = () => setOpen(null);
  const meta = (a: Aggregate) =>
    Object.entries(a.metadata ?? {})
      .filter(([k]) => k !== "availability_zone")
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
  const columns: Column<Aggregate>[] = [
    { key: "name", header: tr("Name"), cell: (a) => <span className="font-medium">{a.name}</span>, value: (a) => a.name },
    { key: "az", header: tr("Availability zone"), width: "10rem", cell: (a) => (a.availability_zone ? <Badge tone="accent">{a.availability_zone}</Badge> : <span className="text-muted">—</span>), value: (a) => a.availability_zone ?? "", wrap: true },
    { key: "hosts", header: tr("Hosts"), hideBelow: "md", cell: (a) => (a.hosts.length ? a.hosts.join(", ") : <span className="text-muted">{tr("None")}</span>), value: (a) => a.hosts.join(", ") },
    { key: "meta", header: tr("Metadata"), hideBelow: "lg", mono: true, cell: meta, value: meta },
  ];
  return (
    <>
      <PageHeader
        title={tr("Host aggregates")}
        description={tr("Groups of compute hosts. Give an aggregate an availability zone to offer it to users, or metadata that flavors match (aggregate_instance_extra_specs) to steer instances onto special hardware.")}
        actions={
          <Button variant="primary" onClick={() => setOpen({ kind: "create" })}>
            <Icon name="plus" />
            {tr("Create aggregate")}
          </Button>
        }
      />
      <ErrorNotice error={aggs.error} className="mb-4" />
      <DataTable
        rows={aggs.data}
        columns={columns}
        rowKey={(a) => String(a.id)}
        loading={aggs.isPending}
        tableId="admin-aggregates"
        noun={tr("aggregates")}
        rowLabel={(a) => a.name}
        onRefresh={() => aggs.refetch()}
        refreshing={aggs.isFetching}
        onBulkDone={() => invalidate("compute")}
        rowActions={(a) => [
          { label: tr("Manage hosts"), icon: "server", onSelect: () => setOpen({ kind: "hosts", a }) },
          { label: tr("Edit metadata"), icon: "tags", onSelect: () => setOpen({ kind: "meta", a }) },
          { label: tr("Edit aggregate"), icon: "edit", onSelect: () => setOpen({ kind: "edit", a }) },
          "-",
          { label: tr("Delete aggregate"), icon: "trash", danger: true, disabled: a.hosts.length ? tr("Remove its hosts first") : false, onSelect: () => setOpen({ kind: "delete", a }) },
        ]}
      />
      {open?.kind === "create" && <AggregateDialog onClose={close} />}
      {open?.kind === "edit" && <AggregateDialog a={open.a} onClose={close} />}
      {open?.kind === "hosts" && <HostsDialog a={open.a} onClose={close} />}
      {open?.kind === "meta" && <MetadataDialog a={open.a} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete aggregate {name}?", { name: open.a.name })}
          submitLabel={tr("Delete")}
          done={tr("Aggregate deleted")}
          refresh={["compute"]}
          run={() => os.del("compute", `os-aggregates/${open.a.id}`)}
        >
          <p className="text-sm">{trx("Hosts and instances are not affected{v}.", { v: open.a.availability_zone ? tr("; the zone {availability_zone} disappears if no other aggregate has it", { availability_zone: open.a.availability_zone }) : "" })}</p>
        </ActionDialog>
      )}
    </>
  );
}

function AggregateDialog({ a, onClose }: { a?: Aggregate; onClose: () => void }) {
  const [name, setName] = useState(a?.name ?? "");
  const [az, setAz] = useState(a?.availability_zone ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      title={a ? tr("Edit {name}", { name: a.name }) : tr("Create host aggregate")}
      submitLabel={a ? tr("Save") : tr("Create")}
      canSubmit={!!name.trim()}
      done={a ? tr("Aggregate updated") : tr("Aggregate {name} created", { name })}
      refresh={["compute"]}
      run={() => {
        const body = { aggregate: { name: name.trim(), availability_zone: az.trim() || null } };
        return a ? os.put("compute", `os-aggregates/${a.id}`, body) : os.post("compute", "os-aggregates", body);
      }}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("gpu-nodes")} />}</Field>
      <Field label={tr("Availability zone")} hint={tr("Optional. Users see it when launching; a host can be in only one zone.")}>
        {(id) => <Input id={id} value={az} onChange={(e) => setAz(e.target.value)} placeholder={tr("az2")} />}
      </Field>
    </ActionDialog>
  );
}

function HostsDialog({ a, onClose }: { a: Aggregate; onClose: () => void }) {
  const computes = useComputeServices({ binary: "nova-compute" });
  const [hosts, setHosts] = useState(a.hosts);
  const add = hosts.filter((h) => !a.hosts.includes(h));
  const remove = a.hosts.filter((h) => !hosts.includes(h));
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Hosts in {name}", { name: a.name })}
      description={a.availability_zone ? tr("Hosts added here move to zone {availability_zone}. Nova refuses a host already in another zone.", { availability_zone: a.availability_zone }) : undefined}
      submitLabel={tr("Save{v}", { v: add.length || remove.length ? ` (+${add.length} −${remove.length})` : "" })}
      canSubmit={add.length + remove.length > 0}
      done={tr("Hosts updated")}
      refresh={["compute"]}
      run={async () => {
        for (const host of add) await os.action("compute", `os-aggregates/${a.id}`, { add_host: { host } });
        for (const host of remove) await os.action("compute", `os-aggregates/${a.id}`, { remove_host: { host } });
      }}
    >
      <Field label={tr("Compute hosts")}>
        {(id) => (
          <MultiPicker
            id={id}
            values={hosts}
            onChange={setHosts}
            searchable
            loading={computes.isPending}
            placeholder={tr("No hosts")}
            options={(computes.data ?? []).map((s) => ({
              value: s.host,
              label: s.host,
              icon: "server",
              description: `${s.zone} · ${svcState(s)}`,
            }))}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

function MetadataDialog({ a, onClose }: { a: Aggregate; onClose: () => void }) {
  const before = Object.fromEntries(Object.entries(a.metadata ?? {}).filter(([k]) => k !== "availability_zone"));
  const [rows, setRows] = useState<KvRow[]>(() => toRows(before));
  const err = kvError(rows);
  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={tr("Metadata of {name}", { name: a.name })}
      description={tr("Flavors with aggregate_instance_extra_specs:<key>=<value> land only on hosts of aggregates with that metadata.")}
      submitLabel={tr("Save")}
      canSubmit={!err}
      done={tr("Metadata saved")}
      refresh={["compute"]}
      run={() => {
        const after = fromRows(rows);
        // set_metadata merges; keys set to null are removed.
        const metadata: Record<string, string | null> = { ...after };
        for (const k of Object.keys(before)) if (!(k in after)) metadata[k] = null;
        return os.action("compute", `os-aggregates/${a.id}`, { set_metadata: { metadata } });
      }}
    >
      <KeyValueEditor rows={rows} onChange={setRows} suggestions={AGG_KEYS} addLabel={tr("Add metadata")} empty={tr("No metadata.")} />
      {err && <p className="text-sm text-led-red">{err}</p>}
    </ActionDialog>
  );
}
