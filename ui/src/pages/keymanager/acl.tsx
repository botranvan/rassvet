/**
 * Barbican ACLs, shared by secrets and secret containers: who besides the project's
 * members may read the object ("read" is the only operation Barbican's ACLs cover), and
 * whether project members keep access ("project-access": false = only the listed users
 * and the creator).
 */
import { useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { Badge, Button, Card, Detail, ErrorNotice, Icon, Switch } from "@/components/ui";
import { TagInput } from "@/components/TagInput";
import { useUsers } from "@/lib/identity";
import { useAcl } from "@/lib/barbican";
import { fmtDate } from "@/lib/format";
import { os } from "@/lib/os";
import { useSession } from "@/lib/session";
import { tr } from "@/lib/i18n";

export function AclCard({ kind, id, owner }: { kind: "secrets" | "containers"; id: string; owner: boolean }) {
  const session = useSession().data!;
  const acl = useAcl(kind, id);
  const users = useUsers(session.is_admin);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const read = acl.data?.read;
  const projectAccess = read?.["project-access"] ?? true;
  const list = read?.users ?? [];
  const userName = (uid: string) => (uid === session.user.id ? tr("{name} (you)", { name: session.user.name }) : (users.data?.find((u) => u.id === uid)?.name ?? uid));
  return (
    <Card
      title={tr("Access control (ACL)")}
      actions={
        owner && (
          <span className="flex gap-2">
            {(list.length > 0 || !projectAccess) && (
              <Button className="h-8" onClick={() => setRemoving(true)}>
                {tr("Reset")}
              </Button>
            )}
            <Button className="h-8" onClick={() => setEditing(true)}>
              <Icon name="edit" />
              {tr("Edit")}
            </Button>
          </span>
        )
      }
    >
      <ErrorNotice error={acl.error} className="mb-3" />
      <dl>
        <Detail label={tr("Project members")}>{projectAccess ? tr("Can read") : tr("No access (only the users below and the creator)")}</Detail>
        <Detail label={tr("Users with read access")}>
          {list.length ? (
            <span className="flex flex-wrap gap-1">
              {list.map((u) => (
                <Badge key={u}>{userName(u)}</Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted">{tr("None")}</span>
          )}
        </Detail>
        {read?.updated && <Detail label={tr("Updated")}>{fmtDate(read.updated)}</Detail>}
      </dl>
      <p className="mt-3 text-xs text-muted">{tr("Users listed here can read the payload even from other projects, e.g. a service user (Octavia, Magnum) that needs your certificate.")}</p>
      {editing && <AclDialog kind={kind} id={id} users={list} projectAccess={projectAccess} onClose={() => setEditing(false)} />}
      {removing && (
        <ActionDialog
          onClose={() => setRemoving(false)}
          title={tr("Reset the ACL?")}
          submitLabel={tr("Reset")}
          done={tr("ACL reset")}
          refresh={["key-manager"]}
          run={() => os.del("key-manager", `${kind}/${id}/acl`)}
        >
          <p className="text-sm">{tr("Listed users lose access; project members get read access again.")}</p>
        </ActionDialog>
      )}
    </Card>
  );
}

function AclDialog({ kind, id, users: initial, projectAccess, onClose }: { kind: "secrets" | "containers"; id: string; users: string[]; projectAccess: boolean; onClose: () => void }) {
  const session = useSession().data!;
  const all = useUsers(session.is_admin);
  const [users, setUsers] = useState(initial);
  const [project, setProject] = useState(projectAccess);
  const suggestions = [session.user.id, ...(all.data ?? []).map((u) => u.id)].filter((u, i, a) => a.indexOf(u) === i).slice(0, 40);
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Edit access control")}
      submitLabel={tr("Save")}
      done={tr("ACL updated")}
      refresh={["key-manager"]}
      run={() => os.put("key-manager", `${kind}/${id}/acl`, { read: { users, "project-access": project } })}
    >
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{tr("Users with read access (user IDs)")}</p>
        <TagInput value={users} onChange={setUsers} maxLength={64} placeholder={tr("Paste a user ID and press Enter")} suggestions={suggestions} />
        {session.is_admin && all.data && (
          <p className="text-xs text-muted">
            {users
              .map((u) => all.data.find((x) => x.id === u)?.name)
              .filter(Boolean)
              .join(", ")}
          </p>
        )}
      </div>
      <Switch checked={project} onChange={setProject} label={tr("Project members can read")} hint={tr("Turn off to keep the secret private to its creator and the users listed above.")} />
    </ActionDialog>
  );
}
