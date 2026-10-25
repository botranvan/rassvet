/**
 * Volume transfers: hand a volume to another project. The owner creates a transfer and
 * passes its ID and auth key to someone in the receiving project, who accepts it there.
 */
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { CopyButton, downloadText } from "@/components/CodeBlock";
import { type Column, DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { Button, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Switch } from "@/components/ui";
import { type Transfer, useTransfers } from "@/lib/cinder";
import { fmtDate } from "@/lib/format";
import { type Volume, os, useInvalidate, useVolumes } from "@/lib/os";
import { useSession } from "@/lib/session";
import { tr } from "@/lib/i18n";

export default function Transfers() {
  const transfers = useTransfers();
  const volumes = useVolumes();
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const [accepting, setAccepting] = useState(false);
  const [cancel, setCancel] = useState<Transfer | null>(null);
  const volName = useMemo(() => {
    const m = new Map(volumes.data?.map((v) => [v.id, v.name || v.id]));
    return (id: string) => m.get(id) ?? id;
  }, [volumes.data]);

  const columns: Column<Transfer>[] = [
    { key: "name", header: tr("Name"), cell: (t) => <span className="font-medium">{t.name || "—"}</span>, value: (t) => t.name ?? "" },
    {
      key: "volume",
      header: tr("Volume"),
      cell: (t) => (
        <Link to={`/storage/volumes/${t.volume_id}`} className="text-cable hover:underline">
          {volName(t.volume_id)}
        </Link>
      ),
      value: (t) => volName(t.volume_id),
    },
    { key: "id", header: tr("Transfer ID"), mono: true, hideBelow: "lg", cell: (t) => t.id, value: (t) => t.id },
    { key: "snapshots", header: tr("Snapshots"), width: "7rem", hideBelow: "xl", cell: (t) => (t.no_snapshots ? tr("Left behind") : tr("Included")), value: (t) => (t.no_snapshots ? 0 : 1) },
    { key: "created", header: tr("Created"), width: "11.5rem", hideBelow: "md", cell: (t) => fmtDate(t.created_at), value: (t) => t.created_at },
  ];

  return (
    <>
      <PageHeader
        title={tr("Volume transfers")}
        description={tr("Volumes from this project waiting to be accepted by another project. The receiving project needs the transfer ID and the auth key, which is shown only when the transfer is created.")}
        actions={
          <Button variant="primary" onClick={() => setAccepting(true)}>
            <Icon name="inbox" />
            {tr("Accept transfer")}
          </Button>
        }
      />
      <ErrorNotice error={transfers.error} className="mb-4" />
      <DataTable
        rows={transfers.data}
        columns={columns}
        rowKey={(t) => t.id}
        loading={transfers.isPending}
        tableId="transfers"
        noun={tr("transfers")}
        rowLabel={(t) => t.name || t.id}
        empty={tr("No pending transfers. Start one from a volume's ⋮ menu with “Transfer to another project”.")}
        onRefresh={() => transfers.refetch()}
        refreshing={transfers.isFetching}
        onBulkDone={() => invalidate("volume")}
        rowActions={(t) => [
          { label: tr("Open volume"), icon: "eye", onSelect: () => navigate(`/storage/volumes/${t.volume_id}`) },
          "-",
          { label: tr("Cancel transfer"), icon: "x", danger: true, onSelect: () => setCancel(t) },
        ]}
        bulkActions={[
          {
            id: "cancel",
            label: tr("Cancel"),
            icon: "x",
            danger: true,
            title: tr("Cancel transfers?"),
            past: tr("cancelled"),
            body: tr("The volumes stay in this project and become available again."),
            run: (t) => os.del("volume", `volume-transfers/${t.id}`),
          },
        ]}
      />
      {accepting && <AcceptTransferDialog onClose={() => setAccepting(false)} />}
      {cancel && (
        <ActionDialog
          onClose={() => setCancel(null)}
          danger
          title={tr("Cancel transfer of {volName}?", { volName: volName(cancel.volume_id) })}
          submitLabel={tr("Cancel transfer")}
          done={tr("Transfer cancelled")}
          refresh={["volume"]}
          run={() => os.del("volume", `volume-transfers/${cancel.id}`)}
        >
          <p className="text-sm">{tr("The volume stays in this project and becomes available again. The auth key stops working.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

/** Accept a volume transfer into the current project. */
export function AcceptTransferDialog({ onClose }: { onClose: () => void }) {
  const session = useSession().data!;
  const navigate = useNavigate();
  const [id, setId] = useState("");
  const [key, setKey] = useState("");
  return (
    <ActionDialog<{ transfer: { volume_id: string; name?: string } }>
      onClose={onClose}
      title={tr("Accept volume transfer")}
      description={tr("The volume moves into {v} and counts against its quota.", { v: session.project?.name ?? tr("this project") })}
      submitLabel={tr("Accept transfer")}
      canSubmit={!!id.trim() && !!key.trim()}
      done={tr("Volume transferred into this project")}
      refresh={["volume"]}
      onDone={(r) => navigate(`/storage/volumes/${r.transfer.volume_id}`)}
      run={() => os.post("volume", `volume-transfers/${id.trim()}/accept`, { accept: { auth_key: key.trim() } })}
    >
      <Field label={tr("Transfer ID")}>{(i) => <Input id={i} autoFocus value={id} onChange={(e) => setId(e.target.value)} className="font-mono text-[13px]" placeholder={tr("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")} />}</Field>
      <Field label={tr("Auth key")}>{(i) => <Input id={i} value={key} onChange={(e) => setKey(e.target.value)} className="font-mono text-[13px]" autoComplete="off" />}</Field>
    </ActionDialog>
  );
}

/** Start a transfer of one volume; then show the ID and auth key once. */
export function CreateTransferDialog({ volume, onClose }: { volume: Volume; onClose: () => void }) {
  const [name, setName] = useState(volume.name ? `${volume.name}-transfer` : "");
  const [noSnapshots, setNoSnapshots] = useState(false);
  const [created, setCreated] = useState<Transfer | null>(null);
  // ActionDialog closes itself after success; keep this component open to show the key.
  const succeeded = useRef(false);
  if (created) return <TransferCreated transfer={created} volume={volume} onClose={onClose} />;
  return (
    <ActionDialog<{ transfer: Transfer }>
      onClose={() => succeeded.current || onClose()}
      title={tr("Transfer {v}", { v: volume.name || volume.id })}
      description={tr("The volume is locked (awaiting-transfer) until another project accepts it or you cancel. It must be detached.")}
      submitLabel={tr("Create transfer")}
      refresh={["volume"]}
      onDone={(r) => {
        succeeded.current = true;
        setCreated(r.transfer);
      }}
      run={() => os.post("volume", "volume-transfers", { transfer: { volume_id: volume.id, name: name.trim() || undefined, no_snapshots: noSnapshots } })}
    >
      <Field label={tr("Transfer name")}>{(i) => <Input id={i} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Switch checked={noSnapshots} onChange={setNoSnapshots} label={tr("Leave snapshots behind")} hint={tr("By default the volume's snapshots move with it.")} />
    </ActionDialog>
  );
}

function TransferCreated({ transfer, volume, onClose }: { transfer: Transfer; volume: Volume; onClose: () => void }) {
  const text = tr("Volume: {v}\nTransfer ID: {id}\nAuth key: {v2}\n", { v: volume.name || volume.id, id: transfer.id, v2: transfer.auth_key ?? "" });
  return (
    <Dialog
      open
      onClose={onClose}
      title={tr("Transfer created")}
      description={tr("Send both values to someone in the receiving project. The auth key can't be shown again.")}
      footer={
        <>
          <Button onClick={() => downloadText(`transfer-${transfer.id.slice(0, 8)}.txt`, text)}>
            <Icon name="download" />
            {tr("Download")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {tr("Done")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 rounded-lg border border-led-amber/40 bg-led-amber/8 p-4 text-sm">
        <div className="grid gap-1">
          <span className="text-muted">{tr("Transfer ID")}</span>
          <div className="flex flex-wrap items-center gap-3">
            <Mono className="break-all">{transfer.id}</Mono>
            <CopyButton text={transfer.id} label={tr("Copy ID")} className="h-8" />
          </div>
        </div>
        <div className="grid gap-1">
          <span className="text-muted">{tr("Auth key")}</span>
          <div className="flex flex-wrap items-center gap-3">
            <Mono className="break-all">{transfer.auth_key}</Mono>
            <CopyButton text={transfer.auth_key ?? ""} label={tr("Copy key")} className="h-8" />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
