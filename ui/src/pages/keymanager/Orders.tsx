/**
 * Barbican orders: ask Barbican to generate a symmetric key ("key") or a key pair
 * ("asymmetric") inside its backend, so the key material never passes through a browser.
 * An order turns ACTIVE with a reference to the new secret (or RSA container).
 */
import { useState } from "react";
import { Link } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Picker } from "@/components/Picker";
import { Button, ErrorNotice, Field, Icon, Input, PageHeader, StatusDot } from "@/components/ui";
import { type Order, refId, statusOf, useOffsetPaged } from "@/lib/barbican";
import { fmtDate } from "@/lib/format";
import { age, os, useInvalidate } from "@/lib/os";
import { tr } from "@/lib/i18n";

const KEY_ALGS: Record<string, { bits: number[]; modes: string[] }> = {
  aes: { bits: [128, 192, 256], modes: ["cbc", "ctr", "gcm", "xts"] },
  hmacsha256: { bits: [256], modes: [] },
  hmacsha512: { bits: [512], modes: [] },
  "3des": { bits: [192], modes: ["cbc"] },
};
const ASYM_ALGS: Record<string, number[]> = { rsa: [2048, 3072, 4096], dsa: [2048, 3072], ec: [256, 384, 521] };

const algText = (o: Order) => [o.meta.algorithm, o.meta.bit_length && `${o.meta.bit_length} bit`, o.meta.mode].filter(Boolean).join(" · ");

export default function Orders() {
  const invalidate = useInvalidate();
  const [creating, setCreating] = useState(false);
  const orders = useOffsetPaged<Order>("orders", "order_ref", {
    poll: (rows) => rows.some((o) => o.status === "PENDING"),
  });
  const columns: Column<Order>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (o) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{o.meta.name || <span className="text-muted">{tr("(no name)")}</span>}</span>
          <span className="truncate font-mono text-xs text-muted">{o.id}</span>
        </span>
      ),
      value: (o) => o.meta.name ?? "",
    },
    { key: "type", header: tr("Type"), width: "8rem", cell: (o) => (o.type === "key" ? tr("Symmetric key") : o.type === "asymmetric" ? tr("Key pair") : o.type), value: (o) => o.type },
    { key: "alg", header: tr("Algorithm"), width: "11rem", hideBelow: "md", cell: algText, value: algText },
    {
      key: "status",
      header: tr("Status"),
      width: "12rem",
      cell: (o) => (
        <span className="flex min-w-0 flex-col">
          <StatusDot status={statusOf(o.status)} label={o.status.toLowerCase()} />
          {o.error_reason && (
            <span className="truncate pl-4 text-xs text-led-red" title={`${o.error_status_code ?? ""} ${o.error_reason}`}>
              {o.error_reason}
            </span>
          )}
        </span>
      ),
      value: (o) => `${o.status} ${o.error_reason ?? ""}`,
    },
    {
      key: "result",
      header: tr("Result"),
      width: "11rem",
      hideBelow: "sm",
      cell: (o) =>
        o.secret_ref ? (
          <Link to={`/key-manager/secrets/${refId(o.secret_ref)}`} className="text-cable hover:underline">
            {tr("View secret")}
          </Link>
        ) : o.container_ref ? (
          <Link to={`/key-manager/containers/${refId(o.container_ref)}`} className="text-cable hover:underline">
            {tr("View key pair")}
          </Link>
        ) : (
          <span className="text-muted">—</span>
        ),
      value: (o) => o.secret_ref ?? o.container_ref ?? "",
    },
    { key: "created", header: tr("Created"), width: "9rem", hideBelow: "lg", cell: (o) => <span title={fmtDate(o.created) ?? ""}>{age(o.created)}</span>, value: (o) => o.created },
  ];
  return (
    <>
      <PageHeader
        title={tr("Orders")}
        description={tr("Have Barbican generate a key or key pair in its backend. The result is a new secret (or an RSA container); deleting an order keeps what it created.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Generate a key")}
          </Button>
        }
      />
      <ErrorNotice error={orders.query.error} className="mb-4" />
      <DataTable
        rows={orders.rows}
        remote={orders.remote}
        columns={columns}
        rowKey={(o) => o.id}
        loading={orders.query.isPending}
        tableId="orders"
        noun={tr("orders")}
        rowLabel={(o) => o.meta.name || o.id}
        empty={tr("No orders yet.")}
        onRefresh={() => orders.query.refetch()}
        refreshing={orders.query.isFetching}
        onBulkDone={() => invalidate("key-manager")}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete orders?"),
            past: tr("deleted"),
            body: tr("Only the order records go; generated secrets and containers are kept."),
            run: (o) => os.del("key-manager", `orders/${o.id}`),
          },
        ]}
      />
      {creating && <OrderDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function OrderDialog({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<"key" | "asymmetric">("key");
  const [name, setName] = useState("");
  const [alg, setAlg] = useState("aes");
  const [bits, setBits] = useState("256");
  const [mode, setMode] = useState("cbc");
  const [passphrase, setPassphrase] = useState("");
  const [expires, setExpires] = useState("");
  const bitOptions = type === "key" ? (KEY_ALGS[alg]?.bits ?? []) : (ASYM_ALGS[alg] ?? []);
  const modes = type === "key" ? (KEY_ALGS[alg]?.modes ?? []) : [];
  const switchType = (t: "key" | "asymmetric") => {
    setType(t);
    const a = t === "key" ? "aes" : "rsa";
    setAlg(a);
    setBits(String(t === "key" ? 256 : 2048));
    setMode(t === "key" ? "cbc" : "");
  };
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Generate a key")}
      submitLabel={tr("Place order")}
      done={tr("Order placed; Barbican is generating the key")}
      refresh={["key-manager"]}
      run={() =>
        os.post("key-manager", "orders", {
          type,
          meta: {
            name: name.trim() || undefined,
            algorithm: alg,
            bit_length: Number(bits),
            ...(mode ? { mode } : {}),
            ...(type === "key" ? { payload_content_type: "application/octet-stream" } : {}),
            ...(type === "asymmetric" && passphrase ? { passphrase } : {}),
            ...(expires ? { expiration: new Date(expires).toISOString() } : {}),
          },
        })
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("What to generate")}>
          {(id) => (
            <Picker
              id={id}
              value={type}
              onChange={(t) => switchType(t as "key" | "asymmetric")}
              options={[
                { value: "key", label: tr("Symmetric key"), description: tr("Becomes a secret") },
                { value: "asymmetric", label: tr("Key pair"), description: tr("Becomes an RSA container with public and private key") },
              ]}
            />
          )}
        </Field>
        <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={type === "key" ? tr("volume-key") : tr("signing-key")} />}</Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={tr("Algorithm")}>
          {(id) => (
            <Picker
              id={id}
              value={alg}
              onChange={(a) => {
                setAlg(a);
                const b = type === "key" ? KEY_ALGS[a].bits : ASYM_ALGS[a];
                setBits(String(b[b.length - 1]));
                setMode(type === "key" ? (KEY_ALGS[a].modes[0] ?? "") : "");
              }}
              options={Object.keys(type === "key" ? KEY_ALGS : ASYM_ALGS).map((a) => ({ value: a, label: a.toUpperCase() }))}
            />
          )}
        </Field>
        <Field label={tr("Bit length")}>{(id) => <Picker id={id} value={bits} onChange={setBits} options={bitOptions.map((b) => ({ value: String(b), label: String(b) }))} />}</Field>
        {modes.length > 0 && <Field label={tr("Mode")}>{(id) => <Picker id={id} value={mode} onChange={setMode} options={modes.map((m) => ({ value: m, label: m.toUpperCase() }))} />}</Field>}
      </div>
      {type === "asymmetric" && (
        <Field label={tr("Private key passphrase (optional)")} hint={tr("Stored as a third secret in the container.")}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />}
        </Field>
      )}
      <Field label={tr("Expires")} hint={tr("Optional.")}>
        {(id) => <Input id={id} type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} className="w-64" />}
      </Field>
    </ActionDialog>
  );
}
