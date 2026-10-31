/** Reverse DNS (PTR records) of the project's floating IPs, kept by Designate in its managed reverse zones. */
import { useState } from "react";
import {
  ActionDialog,
  type Column,
  DataTable,
  ErrorNotice,
  Field,
  Input,
  type MenuEntry,
  Mono,
  PageHeader,
  StatusDot,
  tr,
  useFloatingIps,
  useInvalidate,
  useSession,
} from "@rassvet/sdk";
import { DNS, type ReversePtr, dns, dnsStatus, dot, reverseName, statusText, undot, useReverse } from "./api";

interface Row {
  /** `<region>:<floating IP id>`, the id Designate uses. */
  id: string;
  address: string;
  fixed?: string | null;
  ptr?: ReversePtr;
}

export default function Reverse() {
  const region = useSession().data?.region ?? "";
  const fips = useFloatingIps();
  const ptrs = useReverse();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "set" | "unset"; r: Row } | null>(null);
  const close = () => setOpen(null);

  const byId = new Map((ptrs.data ?? []).map((p) => [p.id.slice(p.id.indexOf(":") + 1), p]));
  const rows: Row[] | undefined =
    fips.data &&
    fips.data.map((f) => {
      const ptr = byId.get(f.id);
      return { id: ptr?.id ?? `${region}:${f.id}`, address: f.floating_ip_address, fixed: f.fixed_ip_address, ptr };
    });
  const columns: Column<Row>[] = [
    { key: "address", header: tr("Floating IP"), width: "10rem", mono: true, cell: (r) => r.address, value: (r) => r.address },
    {
      key: "ptr",
      header: tr("PTR record"),
      cell: (r) => (r.ptr?.ptrdname ? <Mono>{undot(r.ptr.ptrdname)}</Mono> : <span className="text-muted">{tr("Not set")}</span>),
      value: (r) => r.ptr?.ptrdname ?? "",
    },
    { key: "ttl", header: "TTL", width: "6rem", hideBelow: "md", className: "text-right", cell: (r) => r.ptr?.ttl ?? "—", value: (r) => r.ptr?.ttl ?? 0 },
    {
      key: "status",
      header: tr("Status"),
      width: "9rem",
      hideBelow: "md",
      cell: (r) => (r.ptr?.ptrdname ? <StatusDot status={dnsStatus(r.ptr.status)} label={statusText(r.ptr)} /> : "—"),
      value: (r) => r.ptr?.status ?? "",
    },
    { key: "fixed", header: tr("Attached to"), width: "10rem", hideBelow: "lg", mono: true, cell: (r) => r.fixed || "—", value: (r) => r.fixed ?? "" },
    { key: "description", header: tr("Description"), hideBelow: "xl", cell: (r) => r.ptr?.description || "—", value: (r) => r.ptr?.description ?? "" },
  ];
  const items = (r: Row): MenuEntry[] => [
    { label: r.ptr?.ptrdname ? tr("Change PTR record") : tr("Set PTR record"), icon: "edit", onSelect: () => setOpen({ kind: "set", r }) },
    { label: tr("Unset PTR record"), icon: "trash", danger: true, disabled: !r.ptr?.ptrdname && tr("Not set"), onSelect: () => setOpen({ kind: "unset", r }) },
  ];
  return (
    <>
      <PageHeader
        title={tr("Reverse DNS")}
        description={tr("The name a floating IP resolves back to (its PTR record), e.g. for mail servers. Designate publishes it in the cloud's reverse zones; only the project holding the address can set it.")}
      />
      <ErrorNotice error={fips.error ?? ptrs.error} className="mb-4" />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={fips.isPending || ptrs.isPending}
        tableId="designate-reverse"
        noun={tr("floating IPs")}
        rowLabel={(r) => r.address}
        onRefresh={() => {
          fips.refetch();
          ptrs.refetch();
        }}
        refreshing={fips.isFetching || ptrs.isFetching}
        onBulkDone={() => invalidate(DNS)}
        empty={tr("The project has no floating IPs.")}
        filterPlaceholder={tr("Filter by address or name")}
        rowActions={items}
        bulkActions={[
          {
            id: "unset",
            label: tr("Unset"),
            icon: "trash",
            danger: true,
            title: tr("Unset PTR records?"),
            past: tr("unset"),
            check: (r) => (r.ptr?.ptrdname ? true : tr("Not set")),
            run: (r) => dns.patch(`reverse/floatingips/${r.id}`, { ptrdname: null }),
          },
        ]}
      />
      {open?.kind === "set" && <PtrDialog row={open.r} onClose={close} />}
      {open?.kind === "unset" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Unset the PTR record of {ip}?", { ip: open.r.address })}
          submitLabel={tr("Unset")}
          done={tr("PTR record unset")}
          refresh={[DNS]}
          run={() => dns.patch(`reverse/floatingips/${open.r.id}`, { ptrdname: null })}
        >
          <p className="text-sm">{tr("The address resolves back to the cloud's default name again.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function PtrDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const [name, setName] = useState(undot(row.ptr?.ptrdname));
  const [ttl, setTtl] = useState(row.ptr?.ttl ? String(row.ptr.ttl) : "");
  const [description, setDescription] = useState(row.ptr?.description ?? "");
  const problem =
    (!/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)+\.?$/.test(name.trim()) && tr("Enter a fully qualified name, e.g. mail.example.org")) ||
    (ttl.trim() !== "" && !/^\d+$/.test(ttl.trim()) && tr("The TTL is a whole number of seconds"));
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("PTR record of {ip}", { ip: row.address })}
      description={
        <>
          {tr("Published as")} <Mono>{reverseName(row.address)}</Mono>. {tr("Mail servers usually also check that the name resolves to this address (an A record).")}
        </>
      }
      submitLabel={tr("Save")}
      canSubmit={!problem}
      done={tr("PTR record saved")}
      refresh={[DNS]}
      run={() => dns.patch(`reverse/floatingips/${row.id}`, { ptrdname: dot(name), ...(ttl.trim() ? { ttl: Number(ttl) } : {}), ...(description.trim() ? { description: description.trim() } : {}) })}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus className="font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="mail.example.org" />}</Field>
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <Field label="TTL">{(id) => <Input id={id} inputMode="numeric" value={ttl} onChange={(e) => setTtl(e.target.value)} />}</Field>
        <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      </div>
    </ActionDialog>
  );
}
