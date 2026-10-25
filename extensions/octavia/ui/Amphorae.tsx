/** Admin: amphorae (the service VMs running HAProxy for the amphora provider). */
import { useState } from "react";
import {
  ActionDialog,
  type Column,
  DataTable,
  Detail,
  Dialog,
  ErrorNotice,
  Link,
  Mono,
  PageHeader,
  StatusDot,
  type Status,
  fmtBytes,
  fmtDate,
  os,
  tr,
  useInvalidate,
  useOsGet,
  useOsList,
} from "@rassvet/sdk";
import { type Amphora, BASE, LB, type Stats, fmtCount, lbName, statusText, useLoadBalancers } from "./api";

const BUSY = /^PENDING_|^BOOTING$/;

function ampStatus(s: string): Status {
  if (s === "ALLOCATED" || s === "READY") return "ok";
  if (BUSY.test(s)) return "warn";
  if (s === "ERROR") return "error";
  return "off";
}

export function AmphoraTable({ loadbalancerId }: { loadbalancerId?: string }) {
  const amps = useOsList<Amphora>(LB, "octavia/amphorae", "amphorae", loadbalancerId ? { loadbalancer_id: loadbalancerId } : undefined, {
    poll: (rows) => rows.some((a) => BUSY.test(a.status)),
  });
  const lbs = useLoadBalancers(undefined, !loadbalancerId);
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "failover" | "config" | "delete" | "stats"; a: Amphora } | null>(null);
  const close = () => setOpen(null);
  const lbOf = (id: string | null) => (id ? lbs.data?.find((l) => l.id === id) : undefined);
  const expiring = (a: Amphora) => !!a.cert_expiration && new Date(a.cert_expiration).getTime() - Date.now() < 30 * 864e5;

  const cols: Column<Amphora>[] = [
    { key: "id", header: "ID", width: "10rem", cell: (a) => <Mono>{a.id.slice(0, 13)}</Mono>, value: (a) => a.id },
    ...(loadbalancerId
      ? []
      : [
          {
            key: "lb",
            header: tr("Load balancer"),
            cell: (a: Amphora) =>
              a.loadbalancer_id ? (
                <Link to={`${BASE}/load-balancers/${a.loadbalancer_id}`} className="text-cable hover:underline">
                  {lbOf(a.loadbalancer_id) ? lbName(lbOf(a.loadbalancer_id)!) : a.loadbalancer_id.slice(0, 13)}
                </Link>
              ) : (
                <span className="text-muted">{tr("spare")}</span>
              ),
            value: (a: Amphora) => (a.loadbalancer_id ? (lbOf(a.loadbalancer_id)?.name ?? a.loadbalancer_id) : ""),
          },
        ]),
    { key: "role", header: tr("Role"), width: "7.5rem", cell: (a) => a.role ?? "—", value: (a) => a.role ?? "" },
    { key: "status", header: tr("Status"), width: "9rem", cell: (a) => <StatusDot status={ampStatus(a.status)} label={statusText(a.status)} />, value: (a) => a.status },
    { key: "mgmt", header: tr("Management IP"), width: "9.5rem", mono: true, hideBelow: "md", cell: (a) => a.lb_network_ip ?? "", value: (a) => a.lb_network_ip ?? "" },
    { key: "vrrp", header: tr("VRRP IP"), width: "9rem", mono: true, hideBelow: "lg", cell: (a) => a.vrrp_ip ?? "", value: (a) => a.vrrp_ip ?? "" },
    {
      key: "compute",
      header: tr("Instance"),
      width: "9rem",
      hideBelow: "xl",
      cell: (a) =>
        a.compute_id ? (
          <Link to={`/admin/compute/instances/${a.compute_id}`} className="font-mono text-[12.5px] text-cable hover:underline">
            {a.compute_id.slice(0, 13)}
          </Link>
        ) : (
          ""
        ),
      value: (a) => a.compute_id ?? "",
    },
    {
      key: "cert",
      header: tr("Certificate expires"),
      width: "10rem",
      hideBelow: "2xl",
      cell: (a) => <span className={expiring(a) ? "text-led-red" : undefined}>{fmtDate(a.cert_expiration, false) ?? "—"}</span>,
      value: (a) => a.cert_expiration ?? "",
    },
  ];
  return (
    <>
      <ErrorNotice error={amps.error} className="mb-4" />
      <DataTable
        rows={amps.data}
        columns={cols}
        rowKey={(a) => a.id}
        loading={amps.isPending}
        tableId={loadbalancerId ? "octavia-lb-amphorae" : "octavia-amphorae"}
        noun={tr("amphorae")}
        rowLabel={(a) => a.id.slice(0, 13)}
        empty={loadbalancerId ? tr("No amphorae: this load balancer's provider doesn't use them.") : tr("No amphorae in this region.")}
        onRefresh={() => amps.refetch()}
        refreshing={amps.isFetching}
        onBulkDone={() => invalidate(LB)}
        rowActions={(a) => [
          { label: tr("Statistics"), icon: "chart-bar", disabled: a.loadbalancer_id ? false : tr("Not serving a load balancer"), onSelect: () => setOpen({ kind: "stats", a }) },
          { label: tr("Push configuration"), icon: "upload", disabled: a.status === "ALLOCATED" ? false : tr("Only allocated amphorae"), onSelect: () => setOpen({ kind: "config", a }) },
          { label: tr("Failover"), icon: "refresh", disabled: BUSY.test(a.status) ? tr("Busy ({status})", { status: statusText(a.status) }) : false, onSelect: () => setOpen({ kind: "failover", a }) },
          "-",
          {
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            disabled: a.status === "ERROR" || a.status === "READY" ? false : tr("Only amphorae in ERROR or READY"),
            onSelect: () => setOpen({ kind: "delete", a }),
          },
        ]}
        bulkActions={[
          {
            id: "failover",
            label: tr("Failover"),
            icon: "refresh",
            title: tr("Fail over amphorae?"),
            past: tr("failed over"),
            body: tr("Each amphora is replaced by a new one built from the current image. Use it to roll out a new amphora image or to rotate certificates."),
            check: (a) => (BUSY.test(a.status) ? tr("Busy ({status})", { status: statusText(a.status) }) : true),
            run: (a) => os.put(LB, `octavia/amphorae/${a.id}/failover`),
          },
        ]}
      />
      {open?.kind === "failover" && (
        <ActionDialog onClose={close} title={tr("Fail over amphora {id}?", { id: open.a.id.slice(0, 13) })} submitLabel={tr("Failover")} done={tr("Failover started")} refresh={[LB]} run={() => os.put(LB, `octavia/amphorae/${open.a.id}/failover`)}>
          <p className="text-sm">{tr("Octavia builds a replacement amphora and deletes this one. In an active/standby pair the other amphora keeps serving meanwhile.")}</p>
        </ActionDialog>
      )}
      {open?.kind === "config" && (
        <ActionDialog onClose={close} title={tr("Push configuration to {id}?", { id: open.a.id.slice(0, 13) })} submitLabel={tr("Push")} done={tr("Configuration update requested")} run={() => os.put(LB, `octavia/amphorae/${open.a.id}/config`)}>
          <p className="text-sm">{tr("The amphora agent reloads its configuration from the controller (e.g. after changing [amphora_agent] settings).")}</p>
        </ActionDialog>
      )}
      {open?.kind === "delete" && (
        <ActionDialog onClose={close} danger title={tr("Delete amphora {id}?", { id: open.a.id.slice(0, 13) })} submitLabel={tr("Delete")} done={tr("Amphora deleted")} refresh={[LB]} run={() => os.del(LB, `octavia/amphorae/${open.a.id}`)}>
          <p className="text-sm">{tr("Removes the amphora record and its instance. Only amphorae in ERROR or spare (READY) state can be deleted.")}</p>
        </ActionDialog>
      )}
      {open?.kind === "stats" && <AmphoraStats a={open.a} onClose={close} />}
    </>
  );
}

function AmphoraStats({ a, onClose }: { a: Amphora; onClose: () => void }) {
  const q = useOsGet<(Stats & { listener_id: string })[]>(LB, `octavia/amphorae/${a.id}/stats`, (r: { amphora_stats: (Stats & { listener_id: string })[] }) => r.amphora_stats);
  return (
    <Dialog open onClose={onClose} title={tr("Statistics of amphora {id}", { id: a.id.slice(0, 13) })} size="md">
      <ErrorNotice error={q.error} />
      {q.data?.length === 0 && <p className="text-sm text-muted">{tr("No listeners on this amphora.")}</p>}
      {q.data?.map((s) => (
        <div key={s.listener_id} className="mb-3 rounded-md border border-line px-4 py-2">
          <p className="mb-1 text-xs text-muted">
            {tr("Listener")} <Mono>{s.listener_id.slice(0, 13)}</Mono>
          </p>
          <dl>
            <Detail label={tr("Active connections")}>{fmtCount(s.active_connections)}</Detail>
            <Detail label={tr("Total connections")}>{fmtCount(s.total_connections)}</Detail>
            <Detail label={tr("Bytes in / out")}>{`${fmtBytes(s.bytes_in)} / ${fmtBytes(s.bytes_out)}`}</Detail>
            <Detail label={tr("Request errors")}>{fmtCount(s.request_errors)}</Detail>
          </dl>
        </div>
      ))}
    </Dialog>
  );
}

export default function Amphorae() {
  return (
    <>
      <PageHeader
        title={tr("Amphorae")}
        description={tr("Service instances running HAProxy for amphora-provider load balancers: one per load balancer, or a MASTER/BACKUP pair with active/standby flavors. Fail them over to roll out a new image or recover from errors.")}
      />
      <AmphoraTable />
    </>
  );
}
