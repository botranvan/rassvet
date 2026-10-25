import { useState } from "react";
import { CodeBlock, CopyButton } from "@/components/CodeBlock";
import { useQueryClient } from "@tanstack/react-query";
import { type Column, DataTable } from "@/components/DataTable";
import { api } from "@/lib/api";
import { ConfirmDialog, Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import {
  Badge,
  Button,
  Checkbox,
  ErrorNotice,
  Field,
  Icon,
  Input,
  Mono,
  PageHeader,
  Switch,
  Tabs,
  Textarea,
} from "@/components/ui";
import { fmtDate, isPast } from "@/lib/format";
import {
  type AppCredential,
  cloudsYaml,
  openrc,
  useCliInfo,
  useCreateAppCred,
  useDeleteMyAppCred,
  useMyAppCreds,
} from "@/lib/identity";
import { useSession } from "@/lib/session";
import { tr } from "@/lib/i18n";

export default function AppCredentials() {
  const session = useSession().data!;
  const list = useMyAppCreds();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<AppCredential | null>(null);
  const [deleting, setDeleting] = useState<AppCredential | null>(null);
  const projectName = (id: string) => session.projects.find((p) => p.id === id)?.name ?? id;

  const columns: Column<AppCredential>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (r) => (
        <div>
          <p className="font-medium">{r.name}</p>
          {r.description && <p className="text-xs text-muted">{r.description}</p>}
        </div>
      ),
      value: (r) => r.name,
    },
    { key: "project", width: "9rem", hideBelow: "lg", header: tr("Project"), cell: (r) => projectName(r.project_id), value: (r) => projectName(r.project_id) },
    {
      key: "roles", width: "12rem", hideBelow: "md",
      header: tr("Roles"),
      wrap: true,
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.roles.map((x) => (
            <Badge key={x.id}>{x.name}</Badge>
          ))}
          {r.unrestricted && <Badge tone="warn">{tr("unrestricted")}</Badge>}
        </div>
      ),
      value: (r) => r.roles.map((x) => x.name).join(" "),
    },
    {
      key: "expires", width: "9rem", hideBelow: "sm",
      header: tr("Expires"),
      cell: (r) =>
        r.expires_at ? (
          <span className={isPast(r.expires_at) ? "text-led-red" : ""}>
            {isPast(r.expires_at) ? tr("Expired ") : ""}
            {fmtDate(r.expires_at)}
          </span>
        ) : (
          <span className="text-muted">{tr("Never")}</span>
        ),
      value: (r) => r.expires_at ?? "9999",
    },
    { key: "id", width: "10rem", hideBelow: "xl", header: "ID", cell: (r) => <Mono>{r.id}</Mono>, value: (r) => r.id },
    {
      key: "actions", width: "3.5rem",
      header: "",
      wrap: true,
      className: "w-12 text-right",
      cell: (r) => (
        <button
          onClick={() => setDeleting(r)}
          aria-label={tr("Delete {name}", { name: r.name })}
          className="rounded-md p-1.5 text-muted hover:bg-led-red/10 hover:text-led-red"
        >
          <Icon name="trash" />
        </button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={tr("Application credentials")}
        description={tr("Let scripts, CI jobs and tools act on a project without using your password. Each credential is bound to the project you create it in and can be revoked at any time.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)} disabled={!session.project}>
            <Icon name="plus" />
            {tr("Create credential")}
          </Button>
        }
      />
      <ErrorNotice error={list.error} className="mb-4" />
      <DataTable
        rows={list.data}
        columns={columns}
        rowKey={(r) => r.id}
        loading={list.isPending}
        tableId="app-credentials"
        noun={tr("application credentials")}
        rowLabel={(c) => c.name}
        onRefresh={() => list.refetch()}
        refreshing={list.isFetching}
        onBulkDone={() => qc.invalidateQueries({ queryKey: ["identity"] })}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete application credentials?"),
            past: tr("deleted"),
            body: tr("Anything using these credentials loses access immediately. This can't be undone."),
            run: (c) => api.del(`/identity/application-credentials/${encodeURIComponent(c.id)}`),
          },
        ]}
        filterPlaceholder={tr("Filter by name or role")}
        empty={tr("You have no application credentials yet.")}
      />

      <CreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(c) => {
          setCreating(false);
          setCreated(c);
        }}
      />
      <SecretDialog cred={created} onClose={() => setCreated(null)} />
      <DeleteDialog cred={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}

function CreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (c: AppCredential) => void;
}) {
  const session = useSession().data!;
  const create = useCreateAppCred();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [expires, setExpires] = useState("");
  const [roles, setRoles] = useState<string[] | null>(null);
  const [unrestricted, setUnrestricted] = useState(false);
  const selected = roles ?? session.roles.map((r) => r.name);

  function close() {
    create.reset();
    setName("");
    setDescription("");
    setExpires("");
    setRoles(null);
    setUnrestricted(false);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={tr("Create application credential")}
      description={<>{tr("For project")}{" "}<strong className="font-medium text-ink">{session.project?.name}</strong>.</>}
      onSubmit={() =>
        create.mutate(
          {
            name: name.trim(),
            description: description.trim() || undefined,
            expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString().replace(/\.\d+Z$/, "") : undefined,
            roles: selected,
            unrestricted,
          },
          {
            onSuccess: (c) => {
              onCreated(c);
              create.reset();
              setName("");
              setDescription("");
              setExpires("");
              setRoles(null);
              setUnrestricted(false);
            },
          },
        )
      }
      footer={
        <>
          <Button type="button" onClick={close}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={create.isPending} disabled={!name.trim() || selected.length === 0}>
            {tr("Create credential")}
          </Button>
        </>
      }
    >
      <Field label={tr("Name")}>
        {(id) => <Input id={id} required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("ci-deploy")} />}
      </Field>
      <Field label={tr("Description")}>
        {(id) => <Textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />}
      </Field>
      <Field label={tr("Expires on")} hint={tr("Leave empty for a credential that never expires.")}>
        {(id) => (
          <Input
            id={id}
            type="date"
            value={expires}
            min={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setExpires(e.target.value)}
            className="w-auto"
          />
        )}
      </Field>
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium">{tr("Roles")}</legend>
        {session.roles.map((r) => (
          <Checkbox
            key={r.id}
            checked={selected.includes(r.name)}
            onChange={(on) => setRoles(on ? [...selected, r.name] : selected.filter((x) => x !== r.name))}
          >
            {r.name}
          </Checkbox>
        ))}
        <p className="text-xs text-muted">{tr("Only roles you hold in this project can be delegated.")}</p>
      </fieldset>
      <Switch
        checked={unrestricted}
        onChange={setUnrestricted}
        label={tr("Unrestricted")}
        hint={tr("Allows this credential to create or delete other application credentials and trusts. Leave off unless a tool needs it.")}
      />
      <ErrorNotice error={create.error} />
    </Dialog>
  );
}

function SecretDialog({ cred, onClose }: { cred: AppCredential | null; onClose: () => void }) {
  const cli = useCliInfo();
  const [file, setFile] = useState<"clouds" | "openrc">("clouds");
  const toast = useToast();
  if (!cred?.secret) return null;
  const ac = { id: cred.id, secret: cred.secret, name: cred.name };
  const code = cli.data ? (file === "clouds" ? cloudsYaml(cli.data, ac) : openrc(cli.data, ac)) : "";
  const finish = () => {
    onClose();
    toast(tr("Application credential {name} created", { name: cred.name }));
  };
  return (
    <Dialog
      open
      onClose={finish}
      size="lg"
      title={tr("{name} is ready", { name: cred.name })}
      description={tr("Copy the secret now. Keystone does not store it in readable form, so it can't be shown again.")}
      footer={
        <Button variant="primary" onClick={finish}>
          {tr("I've saved the secret")}
        </Button>
      }
    >
      <div className="grid gap-3 rounded-lg border border-led-amber/40 bg-led-amber/8 p-4 text-sm">
        <div className="grid gap-1">
          <span className="text-muted">ID</span>
          <Mono>{cred.id}</Mono>
        </div>
        <div className="grid gap-1">
          <span className="text-muted">{tr("Secret")}</span>
          <div className="flex flex-wrap items-center gap-3">
            <Mono className="break-all">{cred.secret}</Mono>
            <CopyButton text={cred.secret} label={tr("Copy secret")} className="h-8" />
          </div>
        </div>
      </div>
      <Tabs
        value={file}
        onChange={setFile}
        tabs={[
          { id: "clouds", label: "clouds.yaml" },
          { id: "openrc", label: tr("OpenRC script") },
        ]}
      />
      {cli.data && <CodeBlock code={code} filename={file === "clouds" ? "clouds.yaml" : `${cred.name}-openrc.sh`} />}
    </Dialog>
  );
}

function DeleteDialog({ cred, onClose }: { cred: AppCredential | null; onClose: () => void }) {
  const del = useDeleteMyAppCred();
  const toast = useToast();
  return (
    <ConfirmDialog
      open={!!cred}
      onClose={() => {
        del.reset();
        onClose();
      }}
      title={tr("Delete application credential?")}
      confirmLabel={tr("Delete credential")}
      busy={del.isPending}
      error={del.error}
      onConfirm={() =>
        cred &&
        del.mutate(cred.id, {
          onSuccess: () => {
            toast(tr("Application credential {name} deleted", { name: cred.name }));
            onClose();
          },
        })
      }
    >
      {tr("Anything using")}{" "}<strong className="font-medium">{cred?.name}</strong>{" "}{tr("loses access immediately. This can't be undone.")}
    </ConfirmDialog>
  );
}
