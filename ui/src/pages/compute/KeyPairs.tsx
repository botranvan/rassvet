import { useMutation } from "@tanstack/react-query";
import { useNewParam } from "@/lib/useTab";
import { useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { CopyButton, downloadText } from "@/components/CodeBlock";
import { Picker } from "@/components/Picker";
import { type Column, DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { Button, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { type Keypair, os, useInvalidate, useKeypairs } from "@/lib/os";
import { tr, trx } from "@/lib/i18n";

export default function KeyPairs() {
  const keypairs = useKeypairs();
  const invalidate = useInvalidate();
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  useNewParam(setCreating);
  const [viewing, setViewing] = useState<Keypair | null>(null);
  const [deleting, setDeleting] = useState<Keypair | null>(null);

  const columns: Column<Keypair>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (k) => (
        <button onClick={() => setViewing(k)} className="truncate font-medium text-cable hover:underline">
          {k.name}
        </button>
      ),
      value: (k) => k.name,
    },
    { key: "type", header: tr("Type"), width: "6rem", hideBelow: "sm", cell: (k) => k.type ?? tr("ssh"), value: (k) => k.type ?? "ssh" },
    { key: "fingerprint", header: tr("Fingerprint"), hideBelow: "md", mono: true, cell: (k) => k.fingerprint, value: (k) => k.fingerprint },
  ];

  return (
    <>
      <PageHeader
        title={tr("Key pairs")}
        description={tr("Public SSH keys that Nova puts on new instances so you can log in. Key pairs belong to your user, in every project.")}
        actions={
          <>
            <Button onClick={() => setImporting(true)}>
              <Icon name="upload" />
              {tr("Import public key")}
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              {tr("Create key pair")}
            </Button>
          </>
        }
      />
      <ErrorNotice error={keypairs.error} className="mb-4" />
      <DataTable
        rows={keypairs.data}
        columns={columns}
        rowKey={(k) => k.name}
        loading={keypairs.isPending}
        tableId="keypairs"
        noun={tr("key pairs")}
        rowLabel={(k) => k.name}
        empty={tr("No key pairs yet. Import your public key to log in to new instances.")}
        onRefresh={() => keypairs.refetch()}
        refreshing={keypairs.isFetching}
        onBulkDone={() => invalidate("compute")}
        rowActions={(k) => [
          { label: tr("View public key"), icon: "eye", onSelect: () => setViewing(k) },
          { label: tr("Copy public key"), icon: "copy", onSelect: () => navigator.clipboard?.writeText(k.public_key) },
          "-",
          { label: tr("Delete key pair"), icon: "trash", danger: true, onSelect: () => setDeleting(k) },
        ]}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete key pairs?"),
            past: tr("deleted"),
            body: tr("Existing instances keep the key they were created with; new instances can't use these key pairs."),
            run: (k) => os.del("compute", `os-keypairs/${k.name}`),
          },
        ]}
      />
      <ImportKeypairDialog open={importing} onClose={() => setImporting(false)} />
      <CreateKeypairDialog open={creating} onClose={() => setCreating(false)} />
      {deleting && (
        <ActionDialog
          onClose={() => setDeleting(null)}
          danger
          title={tr("Delete key pair {name}?", { name: deleting.name })}
          submitLabel={tr("Delete key pair")}
          done={tr("Key pair {name} deleted", { name: deleting.name })}
          refresh={["compute"]}
          run={() => os.del("compute", `os-keypairs/${deleting.name}`)}
        >
          <p className="text-sm">{tr("Existing instances keep the key they were created with; new instances can't use it.")}</p>
        </ActionDialog>
      )}
      {viewing && (
        <Dialog open onClose={() => setViewing(null)} title={viewing.name} description={viewing.fingerprint} footer={<CopyButton text={viewing.public_key} label={tr("Copy public key")} />}>
          <pre className="max-h-64 overflow-auto rounded-md bg-surface p-3 font-mono text-[12px] break-all whitespace-pre-wrap">{viewing.public_key}</pre>
        </Dialog>
      )}
    </>
  );
}

export function ImportKeypairDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported?: (name: string) => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const invalidate = useInvalidate();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => os.post<{ keypair: Keypair }>("compute", "os-keypairs", { keypair: { name: name.trim(), public_key: key.trim(), type: "ssh" } }),
    onSuccess: (r) => {
      toast(tr("Key pair {name} imported", { name: r.keypair.name }));
      invalidate("compute");
      onImported?.(r.keypair.name);
      close();
    },
  });
  function close() {
    m.reset();
    setName("");
    setKey("");
    onClose();
  }
  const looksLikeKey = /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+|sk-\S+)\s+\S+/.test(key.trim());
  return (
    <Dialog
      open={open}
      onClose={close}
      title={tr("Import key pair")}
      description={
        <>
          {tr("Paste a public key. To create one, run")}{" "}<Mono className="rounded bg-surface px-1">ssh-keygen -t ed25519</Mono>{" "}{tr("and use the contents of")}{" "}<Mono>~/.ssh/id_ed25519.pub</Mono>{tr(". The private key never leaves your computer.")}
        </>
      }
      onSubmit={() => m.mutate()}
      footer={
        <>
          <Button type="button" onClick={close}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!name.trim() || !looksLikeKey}>
            {tr("Import key pair")}
          </Button>
        </>
      }
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("laptop")} />}</Field>
      <Field label={tr("Public key")} hint={key && !looksLikeKey ? <span className="text-led-red">{tr("That doesn't look like an OpenSSH public key.")}</span> : undefined}>
        {(id) => (
          <Textarea id={id} rows={5} value={key} onChange={(e) => setKey(e.target.value)} placeholder={tr("ssh-ed25519 AAAAC3Nz… user@host")} className="font-mono text-[12.5px]" />
        )}
      </Field>
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-cable hover:underline">
        <Icon name="upload" />
        {tr("Load a .pub file")}
        <input type="file" accept=".pub,text/plain" className="hidden" onChange={async (e) => e.target.files?.[0] && setKey((await e.target.files[0].text()).trim())} />
      </label>
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}

const ALGORITHMS = [
  { value: "ed25519", label: tr("Ed25519"), description: tr("Recommended: short, fast and secure. OpenSSH 6.5+ (2014).") },
  { value: "rsa-4096", label: tr("RSA 4096"), description: tr("For old systems and tools that don't support Ed25519.") },
  { value: "rsa-3072", label: tr("RSA 3072") },
];

interface Created {
  keypair: Keypair;
  private_key: string;
  fingerprint: string;
}

/**
 * Generate a key pair: Rassvet creates the key, Nova gets the public half, and the private
 * key is shown and downloaded once. Rassvet doesn't keep it.
 */
export function CreateKeypairDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (name: string) => void }) {
  const [name, setName] = useState("");
  const [algorithm, setAlgorithm] = useState("ed25519");
  const [result, setResult] = useState<Created | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();
  const filename = (n: string) => `${n.replace(/[^A-Za-z0-9._-]+/g, "_")}.pem`;
  const save = (r: Created) => downloadText(filename(r.keypair.name), r.private_key, "application/x-pem-file");
  const m = useMutation({
    mutationFn: () => api.post<Created>("/compute/keypairs", { name: name.trim(), algorithm }),
    onSuccess: (r) => {
      setResult(r);
      save(r);
      toast(tr("Key pair {name} created; private key downloaded", { name: r.keypair.name }));
      invalidate("compute");
      onCreated?.(r.keypair.name);
    },
  });
  function close() {
    m.reset();
    setName("");
    setResult(null);
    onClose();
  }
  const validName = /^[A-Za-z0-9 _.@-]{1,255}$/.test(name.trim());

  if (result)
    return (
      <Dialog
        open={open}
        onClose={close}
        size="lg"
        title={tr("Key pair {name} created", { name: result.keypair.name })}
        description={tr("Your browser downloaded the private key. Keep it safe: Rassvet doesn't store it and can't show it again.")}
        footer={
          <>
            <CopyButton text={result.private_key} label={tr("Copy private key")} />
            <Button onClick={() => save(result)}>
              <Icon name="download" />
              {tr("Download again")}
            </Button>
            <Button variant="primary" onClick={close}>
              {tr("Done")}
            </Button>
          </>
        }
      >
        <div className="flex items-start gap-2.5 rounded-lg border border-led-amber/40 bg-led-amber/10 px-3.5 py-2.5 text-sm">
          <Icon name="warning" className="mt-0.5 text-[#9a6412] dark:text-led-amber" />
          <span>
            {tr("This is the only copy. Close this dialog and the private key is gone; you'd need a new key pair and to update the instances using it.")}
          </span>
        </div>
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted">{tr("File")}</dt>
          <dd className="font-mono text-[13px]">{filename(result.keypair.name)}</dd>
          <dt className="text-muted">{tr("Fingerprint")}</dt>
          <dd className="truncate font-mono text-[13px]">{result.fingerprint}</dd>
          <dt className="text-muted">{tr("Use it")}</dt>
          <dd className="font-mono text-[13px] break-all">
            {trx("chmod 600 {filename} && ssh -i {filename} ubuntu@<instance-ip>", { filename: filename(result.keypair.name) })}
          </dd>
        </dl>
        <pre className="max-h-56 overflow-auto rounded-md bg-surface p-3 font-mono text-[11.5px] leading-snug break-all whitespace-pre-wrap">{result.private_key}</pre>
      </Dialog>
    );

  return (
    <Dialog
      open={open}
      onClose={close}
      title={tr("Create key pair")}
      description={tr("Rassvet generates the key, gives Nova the public half and hands you the private key as a download. It is not stored anywhere.")}
      onSubmit={() => m.mutate()}
      footer={
        <>
          <Button type="button" onClick={close}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!validName}>
            <Icon name="download" />
            {tr("Create and download")}
          </Button>
        </>
      }
    >
      <Field label={tr("Name")} hint={name && !validName ? tr("Letters, digits, spaces and . _ - @ only.") : undefined}>
        {(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("laptop-2026")} />}
      </Field>
      <Field label={tr("Key type")}>{(id) => <Picker id={id} value={algorithm} onChange={setAlgorithm} options={ALGORITHMS} />}</Field>
      {m.isPending && algorithm.startsWith("rsa") && <p className="text-xs text-muted">{tr("Generating an RSA key takes a few seconds…")}</p>}
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}
