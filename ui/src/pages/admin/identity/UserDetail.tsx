import { useState } from "react";
import { useParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { ConfirmDialog, Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { Badge, Button, Card, Detail, ErrorNotice, Field, Icon, Input, Mono, PageHeader } from "@/components/ui";
import { fmtDate, isPast } from "@/lib/format";
import {
  type AppCredential,
  groupAssignments,
  useDeleteUser,
  useDeleteUserAppCred,
  useProjects,
  useSetProjectRoles,
  useUpdateUser,
  useUser,
  useUserAppCreds,
  useUserAssignments,
} from "@/lib/identity";
import { useSession } from "@/lib/session";
import { AssignRolesDialog, Enabled, useDomainName } from "./shared";
import { UserDialog } from "./Users";
import { tr, trx } from "@/lib/i18n";
import { SystemRolesCard, UserGroupsCard } from "./Groups";

type Membership = { id: string; name: string; roles: string[] };

export default function UserDetail() {
  const { id = "" } = useParams();
  const user = useUser(id);
  const assignments = useUserAssignments(id);
  const appCreds = useUserAppCreds(id);
  const projects = useProjects();
  const domainName = useDomainName();
  const session = useSession().data!;
  const update = useUpdateUser();
  const setRoles = useSetProjectRoles();
  const del = useDeleteUser();
  const delCred = useDeleteUserAppCred();
  const toast = useToast();
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editMembership, setEditMembership] = useState<Membership | null>(null);
  const [removing, setRemoving] = useState<Membership | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [revokingCred, setRevokingCred] = useState<AppCredential | null>(null);

  const u = user.data;
  const self = u?.id === session.user.id;
  const memberships = groupAssignments(assignments.data, "project");
  const projectName = (pid?: string | null) => (pid ? (projects.data?.find((p) => p.id === pid)?.name ?? pid) : "");

  return (
    <>
      <Link to=".." relative="path" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Users")}
      </Link>
      <PageHeader
        title={u?.name ?? tr("User")}
        description={u?.description}
        actions={
          u && (
            <>
              <Button onClick={() => setEditing(true)}>
                <Icon name="pencil" />
                {tr("Edit")}
              </Button>
              <Button onClick={() => setResetting(true)}>
                <Icon name="key" />
                {tr("Reset password")}
              </Button>
              <Button
                busy={update.isPending}
                disabled={self}
                title={self ? tr("You can't disable your own account") : undefined}
                onClick={() =>
                  update.mutate(
                    { id: u.id, enabled: !u.enabled },
                    { onSuccess: (x) => toast(`${x.name} ${x.enabled ? tr("enabled") : tr("disabled")}`) },
                  )
                }
              >
                <Icon name={u.enabled ? "lock" : "lock-open"} />
                {u.enabled ? tr("Disable") : tr("Enable")}
              </Button>
              <Button onClick={() => setDeleting(true)} disabled={self} className="text-led-red">
                <Icon name="trash" />
                {tr("Delete")}
              </Button>
            </>
          )
        }
      />
      <ErrorNotice error={user.error ?? update.error} className="mb-4" />

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_2fr]">
        <Card title={tr("Details")}>
          {u && (
            <dl>
              <Detail label="ID">
                <Mono>{u.id}</Mono>
              </Detail>
              <Detail label={tr("Domain")}>{domainName(u.domain_id)}</Detail>
              <Detail label={tr("Email")}>{u.email || <span className="text-muted">{tr("Not set")}</span>}</Detail>
              <Detail label={tr("Default project")}>
                {u.default_project_id ? projectName(u.default_project_id) : <span className="text-muted">{tr("None")}</span>}
              </Detail>
              <Detail label={tr("Status")}>
                <Enabled enabled={u.enabled} />
              </Detail>
              {u.password_expires_at && (
                <Detail label={tr("Password expires")}>
                  <span className={isPast(u.password_expires_at) ? "text-led-red" : ""}>{fmtDate(u.password_expires_at)}</span>
                </Detail>
              )}
            </dl>
          )}
        </Card>

        <div className="space-y-6">
          <Card
            flush
            title={tr("Projects{v}", { v: assignments.data ? ` (${memberships.length})` : "" })}
            actions={
              <Button onClick={() => setAdding(true)} className="h-8">
                <Icon name="plus" />
                {tr("Add to project")}
              </Button>
            }
          >
            <ErrorNotice error={assignments.error ?? setRoles.error} className="m-4" />
            <ul>
              {memberships.map((m) => {
                const row = { id: m.key.id, name: m.key.name ?? m.key.id, roles: m.roles.map((r) => r.id) };
                return (
                  <li key={m.key.id} className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3 last:border-0">
                    <div className="w-52 min-w-0 shrink-0 [&>*]:block [&>*]:truncate">
                      <Link to={`/admin/identity/projects/${m.key.id}`} className="font-medium hover:text-cable">
                        {m.key.name}
                      </Link>
                      <p className="text-xs text-muted">{m.key.domain?.name}</p>
                    </div>
                    <div className="flex flex-1 flex-wrap gap-1.5">
                      {m.roles.map((r) => (
                        <Badge
                          key={r.id}
                          tone="accent"
                          removeLabel={tr("Remove role {name}", { name: r.name })}
                          onRemove={() =>
                            setRoles.mutate(
                              { projectId: m.key.id, userId: id, revoke: [r.id] },
                              { onSuccess: () => toast(tr("Removed {name} in {name2}", { name: r.name, name2: m.key.name })) },
                            )
                          }
                        >
                          {r.name}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setEditMembership(row)}
                        aria-label={tr("Edit roles in {name}", { name: row.name })}
                        className="rounded-md p-1.5 text-muted hover:bg-ink/5 hover:text-ink"
                      >
                        <Icon name="pencil" />
                      </button>
                      <button
                        onClick={() => setRemoving(row)}
                        aria-label={tr("Remove from {name}", { name: row.name })}
                        className="rounded-md p-1.5 text-muted hover:bg-led-red/10 hover:text-led-red"
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  </li>
                );
              })}
              {assignments.data && memberships.length === 0 && (
                <li className="px-5 py-10 text-center text-sm text-muted">
                  {tr("Not a member of any project. Add them to one so they can work in the cloud.")}
                </li>
              )}
            </ul>
          </Card>

          <UserGroupsCard userId={id} userName={u?.name ?? id} />
          <SystemRolesCard kind="users" id={id} />

          <Card flush title={tr("Application credentials{v}", { v: appCreds.data ? ` (${appCreds.data.length})` : "" })}>
            <ErrorNotice error={appCreds.error} className="m-4" />
            <ul>
              {appCreds.data?.map((c) => (
                <li key={c.id} className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-0">
                  <div className="min-w-0 flex-1 [&>p]:truncate">
                    <p className="font-medium" title={c.name}>
                      {c.name}
                    </p>
                    <p className="text-xs text-muted">
                      {projectName(c.project_id)}, {c.roles.map((r) => r.name).join(", ")}
                      {c.expires_at ? tr(", expires {expires_at}", { expires_at: fmtDate(c.expires_at, false) }) : ""}
                    </p>
                  </div>
                  {c.unrestricted && <Badge tone="warn">{tr("unrestricted")}</Badge>}
                  <button
                    onClick={() => setRevokingCred(c)}
                    aria-label={tr("Delete {name}", { name: c.name })}
                    className="rounded-md p-1.5 text-muted hover:bg-led-red/10 hover:text-led-red"
                  >
                    <Icon name="trash" />
                  </button>
                </li>
              ))}
              {appCreds.data?.length === 0 && (
                <li className="px-5 py-6 text-center text-sm text-muted">{tr("This user has no application credentials.")}</li>
              )}
            </ul>
          </Card>
        </div>
      </div>

      {u && <UserDialog key={u.id + String(editing)} open={editing} onClose={() => setEditing(false)} user={u} />}
      {u && <ResetPasswordDialog open={resetting} onClose={() => setResetting(false)} userId={u.id} userName={u.name} />}
      <AssignRolesDialog open={adding} onClose={() => setAdding(false)} userId={id} title={tr("Add {v} to a project", { v: u?.name ?? tr("user") })} />
      {editMembership && (
        <AssignRolesDialog
          open
          onClose={() => setEditMembership(null)}
          userId={id}
          projectId={editMembership.id}
          current={editMembership.roles}
          title={tr("Roles of {name} in {name2}", { name: u?.name, name2: editMembership.name })}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        onClose={() => {
          setRoles.reset();
          setRemoving(null);
        }}
        title={tr("Remove from project?")}
        confirmLabel={tr("Remove from project")}
        busy={setRoles.isPending}
        error={setRoles.error}
        onConfirm={() =>
          removing &&
          setRoles.mutate(
            { projectId: removing.id, userId: id, revoke: removing.roles },
            {
              onSuccess: () => {
                toast(tr("{name} removed from {name2}", { name: u?.name, name2: removing.name }));
                setRemoving(null);
              },
            },
          )
        }
      >
        {trx("{name} loses every role in", { name: u?.name })}{" "}<strong className="font-medium">{removing?.name}</strong>.
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        onClose={() => {
          del.reset();
          setDeleting(false);
        }}
        title={tr("Delete user?")}
        confirmLabel={tr("Delete user")}
        busy={del.isPending}
        error={del.error}
        onConfirm={() =>
          del.mutate(id, {
            onSuccess: () => {
              toast(tr("User {name} deleted", { name: u?.name }));
              navigate("/admin/identity/users");
            },
          })
        }
      >
        <strong className="font-medium">{u?.name}</strong>{tr(", their role assignments and application credentials are deleted. Resources they created stay in their projects. This can't be undone.")}
      </ConfirmDialog>
      <ConfirmDialog
        open={!!revokingCred}
        onClose={() => {
          delCred.reset();
          setRevokingCred(null);
        }}
        title={tr("Delete application credential?")}
        confirmLabel={tr("Delete credential")}
        busy={delCred.isPending}
        error={delCred.error}
        onConfirm={() =>
          revokingCred &&
          delCred.mutate(
            { userId: id, id: revokingCred.id },
            {
              onSuccess: () => {
                toast(tr("Application credential {name} deleted", { name: revokingCred.name }));
                setRevokingCred(null);
              },
            },
          )
        }
      >
        {tr("Anything using")}{" "}<strong className="font-medium">{revokingCred?.name}</strong>{" "}{tr("loses access immediately.")}
      </ConfirmDialog>
    </>
  );
}

function ResetPasswordDialog({
  open,
  onClose,
  userId,
  userName,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
  userName: string;
}) {
  const update = useUpdateUser();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && password !== confirm;
  function close() {
    update.reset();
    setPassword("");
    setConfirm("");
    onClose();
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title={tr("Reset password for {userName}", { userName })}
      description={tr("Their current sessions end and they sign in with the new password.")}
      onSubmit={() =>
        !mismatch &&
        update.mutate(
          { id: userId, password },
          {
            onSuccess: () => {
              toast(tr("Password for {userName} reset", { userName }));
              close();
            },
          },
        )
      }
      footer={
        <>
          <Button type="button" onClick={close}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={update.isPending} disabled={!password || mismatch}>
            {tr("Reset password")}
          </Button>
        </>
      }
    >
      <Field label={tr("New password")}>
        {(id) => (
          <Input id={id} type="password" required autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        )}
      </Field>
      <Field label={tr("Confirm new password")} hint={mismatch ? <span className="text-led-red">{tr("Doesn't match.")}</span> : undefined}>
        {(id) => (
          <Input id={id} type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        )}
      </Field>
      <ErrorNotice error={update.error} />
    </Dialog>
  );
}
