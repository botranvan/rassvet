/** Admin: Cinder services (scheduler, volume, backup) and the capacity of each storage pool. */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Badge, Card, ErrorNotice, Field, Input, PageHeader, StatusDot } from "@/components/ui";
import { type CinderService, type Pool, capacityGb } from "@/lib/cinder";
import { fmtDate } from "@/lib/format";
import { os, useInvalidate } from "@/lib/os";
import { cn } from "@/lib/utils";
import { tr, trx } from "@/lib/i18n";

/** What disabling each kind of Cinder service stops. */
const DISABLE_EFFECT: Record<string, string> = {
  "cinder-volume": tr("The scheduler stops placing new volumes on this backend. Existing volumes keep working (attach, detach, snapshots, delete)."),
  "cinder-backup": tr("New backups and restores are no longer sent to this backup service. Existing backups stay where they are."),
  "cinder-scheduler": tr("This scheduler stops taking requests; other schedulers keep working. Disable it only when another one is up."),
};
const effect = (s: CinderService) => DISABLE_EFFECT[s.binary] ?? tr("Cinder stops sending new work to this service.");

/** Cinder's service actions are by host + binary: PUT os-services/{enable|disable|disable-log-reason}. */
const setService = (s: CinderService, enable: boolean, reason?: string) =>
  enable
    ? os.put("volume", "os-services/enable", { host: s.host, binary: s.binary })
    : reason
      ? os.put("volume", "os-services/disable-log-reason", { host: s.host, binary: s.binary, disabled_reason: reason })
      : os.put("volume", "os-services/disable", { host: s.host, binary: s.binary });

const tib = (gb: number) => (gb >= 1024 ? `${+(gb / 1024).toFixed(1)} TiB` : `${Math.round(gb)} GiB`);

export default function Backends() {
  const services = useQuery({ queryKey: ["os", "volume", "os-services"], queryFn: () => os.get<{ services: CinderService[] }>("volume", "os-services").then((r) => r.services) });
  const pools = useQuery({
    queryKey: ["os", "volume", "pools"],
    queryFn: () => os.get<{ pools: Pool[] }>("volume", "scheduler-stats/get_pools", { detail: "True" }).then((r) => r.pools),
  });
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "enable" | "disable"; s: CinderService } | null>(null);
  const close = () => setOpen(null);
  const down = services.data?.filter((s) => s.state === "down" && s.status === "enabled").length ?? 0;
  const svcState = (s: CinderService) => (s.status === "disabled" ? tr("disabled") : tr(s.state));
  const columns: Column<CinderService>[] = [
    { key: "binary", header: tr("Service"), width: "10rem", cell: (s) => <span className="font-medium">{s.binary}</span>, value: (s) => s.binary },
    { key: "host", header: tr("Host"), mono: true, cell: (s) => s.host, value: (s) => s.host },
    {
      key: "state",
      header: tr("State"),
      width: "8rem",
      cell: (s) => <StatusDot status={s.status === "disabled" ? "off" : s.state === "up" ? "ok" : "error"} label={svcState(s)} />,
      value: svcState,
    },
    { key: "zone", header: tr("Zone"), width: "6.5rem", hideBelow: "lg", cell: (s) => s.zone, value: (s) => s.zone },
    { key: "updated", header: tr("Last report"), width: "9.5rem", hideBelow: "md", cell: (s) => fmtDate(s.updated_at), value: (s) => s.updated_at ?? "" },
    { key: "reason", header: tr("Disabled reason"), width: "12rem", hideBelow: "xl", cell: (s) => <span className="block truncate text-muted" title={s.disabled_reason || undefined}>{s.disabled_reason || "—"}</span>, csv: (s) => s.disabled_reason ?? "", value: (s) => s.disabled_reason ?? "" },
  ];
  return (
    <>
      <PageHeader
        title={tr("Storage backends")}
        description={down ? tr("{down} enabled Cinder service{v} down.", { down, v: down === 1 ? tr(" is") : tr("s are") }) : tr("Cinder services and the free capacity the scheduler sees in each pool. Disable a service (e.g. a backend under maintenance) to stop new work going to it.")}
      />
      <ErrorNotice error={pools.error} className="mb-4" />
      <div className="mb-8 grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {pools.isPending && <p className="text-sm text-muted">{tr("Loading pools…")}</p>}
        {pools.data?.map((p) => <PoolCard key={p.name} p={p} />)}
        {pools.data?.length === 0 && <p className="text-sm text-muted">{tr("The scheduler reports no pools.")}</p>}
      </div>
      <h2 className="mb-3 text-base font-semibold">{tr("Services")}</h2>
      <ErrorNotice error={services.error} className="mb-4" />
      <DataTable
        rows={services.data}
        columns={columns}
        rowKey={(s) => `${s.binary}@${s.host}`}
        loading={services.isPending}
        tableId="admin-cinder-services"
        noun={tr("services")}
        rowLabel={(s) => `${s.binary} on ${s.host}`}
        filterPlaceholder={tr("Filter by service, host, zone or state")}
        onRefresh={() => {
          services.refetch();
          pools.refetch();
        }}
        refreshing={services.isFetching || pools.isFetching}
        onBulkDone={() => invalidate("volume")}
        rowActions={(s) => [
          s.status === "enabled"
            ? { label: tr("Disable service"), icon: "ban", onSelect: () => setOpen({ kind: "disable", s }) }
            : { label: tr("Enable service"), icon: "play", onSelect: () => setOpen({ kind: "enable", s }) },
        ]}
        bulkActions={[
          {
            id: "enable",
            label: tr("Enable"),
            icon: "play",
            title: tr("Enable services?"),
            past: tr("enabled"),
            body: tr("Cinder sends new work to these services again."),
            check: (s) => (s.status === "enabled" ? tr("Already enabled") : true),
            run: (s) => setService(s, true),
          },
          {
            id: "disable",
            label: tr("Disable"),
            icon: "ban",
            danger: true,
            title: tr("Disable services?"),
            past: tr("disabled"),
            body: tr("Cinder stops sending new work to these services (new volumes, backups…). Existing volumes keep working."),
            check: (s) => (s.status === "disabled" ? tr("Already disabled") : s.binary === "cinder-scheduler" && !otherSchedulerUp(services.data ?? [], s) ? tr("The last scheduler that is up") : true),
            run: (s) => setService(s, false, "Disabled from Rassvet"),
          },
        ]}
      />
      {open?.kind === "disable" && <DisableServiceDialog s={open.s} all={services.data ?? []} onClose={close} />}
      {open?.kind === "enable" && (
        <ActionDialog
          onClose={close}
          title={tr("Enable {binary} on {host}?", { binary: open.s.binary, host: open.s.host })}
          submitLabel={tr("Enable")}
          done={tr("Service enabled")}
          refresh={["volume"]}
          run={() => setService(open.s, true)}
        >
          <p className="text-sm">{trx("Cinder sends new work to this service again{v}.", { v: open.s.binary === "cinder-volume" ? tr(" and the scheduler may place new volumes on this backend") : "" })}</p>
          {open.s.disabled_reason && (
            <p className="text-sm text-muted">
              {tr("It was disabled because:")}{" "}<span className="text-ink">{open.s.disabled_reason}</span>
            </p>
          )}
        </ActionDialog>
      )}
    </>
  );
}

const otherSchedulerUp = (all: CinderService[], s: CinderService) =>
  all.some((x) => x.binary === "cinder-scheduler" && x.host !== s.host && x.status === "enabled" && x.state === "up");

function DisableServiceDialog({ s, all, onClose }: { s: CinderService; all: CinderService[]; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const lastScheduler = s.binary === "cinder-scheduler" && !otherSchedulerUp(all, s);
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Disable {binary} on {host}?", { binary: s.binary, host: s.host })}
      submitLabel={tr("Disable")}
      done={tr("Service disabled")}
      refresh={["volume"]}
      run={() => setService(s, false, reason.trim() || undefined)}
    >
      <p className="text-sm">{effect(s)}</p>
      {lastScheduler && <p className="text-sm text-led-amber">{tr("No other cinder-scheduler is up: while this one is disabled, new volume requests aren't scheduled.")}</p>}
      <Field label={tr("Reason")} hint={tr("Optional; shown to other admins, e.g. “Ceph pool maintenance until 18:00”.")}>
        {(id) => <Input id={id} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} />}
      </Field>
    </ActionDialog>
  );
}

function PoolCard({ p }: { p: Pool }) {
  const c = p.capabilities;
  const total = capacityGb(c.total_capacity_gb);
  const free = capacityGb(c.free_capacity_gb);
  const used = total != null && free != null ? total - free : null;
  const pct = total && used != null ? Math.round((used / total) * 100) : null;
  const ratio = Number(c.max_over_subscription_ratio ?? 1);
  return (
    <Card
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{c.volume_backend_name ?? p.name}</span>
          {c.storage_protocol && <Badge>{c.storage_protocol}</Badge>}
        </span>
      }
    >
      <p className="mb-3 truncate font-mono text-xs text-muted" title={p.name}>
        {p.name}
      </p>
      {pct != null && total != null && free != null ? (
        <>
          <div className="mb-1.5 flex items-baseline justify-between text-sm">
            <span>
              <span className="font-semibold tabular-nums">{tib(free)}</span> <span className="text-muted">{trx("free of {tib}", { tib: tib(total) })}</span>
            </span>
            <span className="tabular-nums text-muted">{trx("{pct}% used", { pct })}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-ink/8" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={tr("Pool usage")}>
            <div className={cn("h-full rounded-full", pct >= 90 ? "bg-led-red" : pct >= 75 ? "bg-led-amber" : "bg-cable")} style={{ width: `${pct}%` }} />
          </div>
        </>
      ) : (
        <p className="text-sm text-muted">{trx("The driver reports capacity as “{String}”.", { String: String(c.total_capacity_gb ?? "unknown") })}</p>
      )}
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">{tr("Provisioned")}</dt>
        <dd className="text-right tabular-nums">{c.provisioned_capacity_gb != null ? tib(c.provisioned_capacity_gb) : "—"}</dd>
        <dt className="text-muted">{tr("Over-subscription")}</dt>
        <dd className="text-right tabular-nums">{Number.isFinite(ratio) ? `${ratio}×` : String(c.max_over_subscription_ratio)}</dd>
        <dt className="text-muted">{tr("Reserved")}</dt>
        <dd className="text-right tabular-nums">{c.reserved_percentage ?? 0}%</dd>
        <dt className="text-muted">{tr("Driver")}</dt>
        <dd className="truncate text-right" title={`${c.vendor_name ?? ""} ${c.driver_version ?? ""}`}>
          {c.driver_version ?? "—"}
        </dd>
      </dl>
      <div className="mt-3 flex flex-wrap gap-1">
        {c.thin_provisioning_support && <Badge tone="accent">{tr("thin")}</Badge>}
        {c.thick_provisioning_support && <Badge>{tr("thick")}</Badge>}
        {c.multiattach && <Badge>{tr("multi-attach")}</Badge>}
      </div>
    </Card>
  );
}
