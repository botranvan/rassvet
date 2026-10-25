import { useState } from "react";
import { Picker } from "@/components/Picker";
import { Link, useNavigate } from "@/components/Link";
import { useQueryClient } from "@tanstack/react-query";
import { type BulkAction, type Column, DataTable } from "@/components/DataTable";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { Button, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Switch, Textarea } from "@/components/ui";
import {
  type User,
  useCreateUser,
  useDomains,
  useProjects,
  useRoles,
  useSetProjectRoles,
  useUpdateUser,
  useIdentitySearch,
} from "@/lib/identity";
import { Enabled, useDomainName } from "./shared";
import { tr, trx } from "@/lib/i18n";

export default function Users() {
  const projects = useProjects();
  const domains = useDomains();
  const domainName = useDomainName();
  const [domain, setDomain] = useState("");
  const [search, setSearch] = useState("");
  // Keystone filters by name and domain itself; large backends never send every user.
  // Small backends: everything is loaded, so the filter matches any column (name, email, ID…).
  // When Keystone truncates the list (list_limit), names are searched on the server instead.
  const whole = useIdentitySearch<User>("users", { domain_id: domain });
  const serverSearch = !!whole.data?.truncated;
  const users = useIdentitySearch<User>("users", { q: serverSearch ? search : "", domain_id: domain });
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const projectName = (id?: string | null) => (id ? (projects.data?.find((p) => p.id === id)?.name ?? id) : "");

  const rows = users.data?.rows;
  const me = useSession().data?.user.id;
  const qc = useQueryClient();
  const path = (u: User) => `/identity/admin/users/${encodeURIComponent(u.id)}`;
  const bulk: BulkAction<User>[] = [
    {
      id: "enable",
      label: tr("Enable"),
      icon: "lock-open",
      title: tr("Enable users?"),
      past: tr("enabled"),
      check: (u) => (u.enabled ? tr("Already enabled") : true),
      run: (u) => api.patch(path(u), { enabled: true }),
    },
    {
      id: "disable",
      label: tr("Disable"),
      icon: "lock",
      title: tr("Disable users?"),
      past: tr("disabled"),
      body: tr("Disabled users can't sign in and their tokens stop working. Their resources stay in place."),
      check: (u) => (u.id === me ? tr("That's you") : u.enabled ? true : tr("Already disabled")),
      run: (u) => api.patch(path(u), { enabled: false }),
    },
    {
      id: "delete",
      label: tr("Delete"),
      icon: "trash",
      danger: true,
      title: tr("Delete users?"),
      past: tr("deleted"),
      body: tr("Users, their role assignments and application credentials are deleted. Resources they created stay in their projects. This can't be undone."),
      check: (u) => (u.id === me ? tr("You can't delete yourself") : true),
      run: (u) => api.del(path(u)),
    },
  ];
  const columns: Column<User>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (u) => (
        <Link to={u.id} className="font-medium text-cable hover:underline">
          {u.name}
        </Link>
      ),
      value: (u) => u.name,
    },
    { key: "domain", width: "8rem", hideBelow: "md", header: tr("Domain"), cell: (u) => domainName(u.domain_id), value: (u) => domainName(u.domain_id) },
    { key: "email", hideBelow: "lg", header: tr("Email"), cell: (u) => u.email, value: (u) => u.email ?? "" },
    {
      key: "project", width: "10rem", hideBelow: "xl",
      header: tr("Default project"),
      cell: (u) => projectName(u.default_project_id),
      value: (u) => projectName(u.default_project_id),
    },
    { key: "enabled", width: "7.5rem", header: tr("Status"), cell: (u) => <Enabled enabled={u.enabled} />, value: (u) => (u.enabled ? 1 : 0), csv: (u) => (u.enabled ? "Enabled" : "Disabled") },
    { key: "id", width: "10rem", hideBelow: "2xl", header: "ID", cell: (u) => <Mono>{u.id}</Mono>, value: (u) => u.id },
  ];

  return (
    <>
      <PageHeader
        title={tr("Users")}
        description={tr("Accounts that can sign in to the cloud. Users from LDAP or federated domains are managed by their identity provider.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="user-plus" />
            {tr("Create user")}
          </Button>
        }
      />
      <ErrorNotice error={users.error} className="mb-4" />
      {users.data?.truncated && (
        <p className="mb-4 rounded-md border border-led-amber/40 bg-led-amber/8 px-4 py-2.5 text-sm">
          {trx("Keystone returned only the first {length} users (its", { length: users.data.rows.length })}{" "}<code className="font-mono">list_limit</code>{tr("). Search by name to find others.")}
        </p>
      )}
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(u) => u.id}
        loading={users.isPending}
        tableId="admin-users"
        noun={tr("users")}
        rowLabel={(u) => u.name}
        bulkActions={bulk}
        onRefresh={() => users.refetch()}
        refreshing={users.isFetching}
        onSearch={serverSearch ? setSearch : undefined}
        onBulkDone={() => qc.invalidateQueries({ queryKey: ["identity"] })}
        filterPlaceholder={serverSearch ? tr("Search user names on the server") : tr("Filter by any column")}
        empty={tr("No users in this domain.")}
        toolbar={
          (domains.data?.length ?? 0) > 1 && (
            <Picker
              aria-label={tr("Domain")}
              size="sm"
              className="h-9 w-44"
              value={domain}
              onChange={setDomain}
              options={[{ value: "", label: tr("All domains") }, ...(domains.data ?? []).map((d) => ({ value: d.id, label: d.name }))]}
            />
          )
        }
      />
      <UserDialog open={creating} onClose={() => setCreating(false)} onSaved={(u) => navigate(u.id)} />
    </>
  );
}

/** Create a user (optionally adding them to a project), or edit one when `user` is given. */
export function UserDialog({
  open,
  onClose,
  user,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  user?: User;
  onSaved?: (u: User) => void;
}) {
  const domains = useDomains();
  const projects = useProjects();
  const roles = useRoles();
  const create = useCreateUser();
  const update = useUpdateUser();
  const assign = useSetProjectRoles();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [description, setDescription] = useState(user?.description ?? "");
  const [enabled, setEnabled] = useState(user?.enabled ?? true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [domainId, setDomainId] = useState("");
  const [projectId, setProjectId] = useState(user?.default_project_id ?? "");
  const [roleId, setRoleId] = useState("");
  const domain = user?.domain_id ?? (domainId || domains.data?.find((d) => d.id === "default")?.id || domains.data?.[0]?.id || "");
  const role = roleId || roles.data?.find((r) => r.name === "member")?.id || "";
  const mismatch = !user && confirm.length > 0 && password !== confirm;
  const domainProjects = (projects.data ?? []).filter((p) => !p.is_domain && p.domain_id === domain);
  const busy = create.isPending || update.isPending || assign.isPending;

  function close() {
    create.reset();
    update.reset();
    assign.reset();
    if (!user) {
      setName("");
      setEmail("");
      setDescription("");
      setPassword("");
      setConfirm("");
      setProjectId("");
      setEnabled(true);
    }
    onClose();
  }

  function submit() {
    if (mismatch) return;
    const common = {
      name: name.trim(),
      email: email.trim() || undefined,
      description: description || undefined,
      enabled,
    };
    if (user) {
      update.mutate(
        { id: user.id, ...common, default_project_id: projectId },
        {
          onSuccess: (u) => {
            toast(tr("User {name} updated", { name: u.name }));
            onSaved?.(u);
            close();
          },
        },
      );
      return;
    }
    create.mutate(
      { ...common, domain_id: domain, password: password || undefined, default_project_id: projectId || undefined },
      {
        onSuccess: (u) => {
          const finish = () => {
            toast(tr("User {name} created", { name: u.name }));
            onSaved?.(u);
            close();
          };
          if (projectId && role) {
            assign.mutate({ projectId, userId: u.id, grant: [role] }, { onSuccess: finish });
          } else finish();
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={user ? tr("Edit user") : tr("Create user")}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={close}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || mismatch}>
            {user ? tr("Save changes") : tr("Create user")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Username")}>
          {(id) => <Input id={id} required autoFocus value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />}
        </Field>
        <Field label={tr("Email")}>
          {(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
      </div>
      {!user && (
        <>
          <Field label={tr("Domain")}>
            {(id) => (
              <Picker
                id={id}
                value={domain}
                onChange={(v) => {
                  setDomainId(v);
                  setProjectId("");
                }}
                options={(domains.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("Password")}>
              {(id) => (
                <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              )}
            </Field>
            <Field label={tr("Confirm password")} hint={mismatch ? <span className="text-led-red">{tr("Doesn't match.")}</span> : undefined}>
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  value={confirm}
                  aria-invalid={mismatch}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                />
              )}
            </Field>
          </div>
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={user ? tr("Default project") : tr("Project")}
          hint={user ? tr("Used when the user signs in without choosing a project.") : tr("Optional. Also becomes their default project.")}
        >
          {(id) => (
            <Picker
              id={id}
              value={projectId}
              onChange={setProjectId}
              options={[{ value: "", label: tr("None") }, ...domainProjects.map((p) => ({ value: p.id, label: p.name, description: p.description || undefined }))]}
            />
          )}
        </Field>
        {!user && projectId && (
          <Field label={tr("Role in project")}>
            {(id) => (
              <Picker id={id} value={role} onChange={setRoleId} options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name }))} />
            )}
          </Field>
        )}
      </div>
      <Field label={tr("Description")}>
        {(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <Switch checked={enabled} onChange={setEnabled} label={tr("Enabled")} hint={tr("Disabled users can't sign in and their tokens stop working.")} />
      <ErrorNotice error={create.error ?? update.error ?? assign.error} />
    </Dialog>
  );
}
