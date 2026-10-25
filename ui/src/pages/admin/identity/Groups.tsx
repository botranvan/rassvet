/**
 * Keystone groups (admin): list, create/edit/delete, members, role assignments on projects
 * and on the system. Also the shared pieces used by the user and project pages: the user's
 * groups, a project's group roles and system role assignments.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Link, useNavigate } from "@/components/Link";
import { MultiPicker, Picker } from "@/components/Picker";
import { Badge, Button, Card, Detail, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Textarea } from "@/components/ui";
import { type RoleAssignment, type User, useDomains, useProjects, useRoles, useUsers } from "@/lib/identity";
import { os, useInvalidate, useOsGet, useOsList } from "@/lib/os";
import { useDomainName } from "./shared";
import { tr } from "@/lib/i18n";

export interface Group {
  id: string;
  name: string;
  description?: string;
  domain_id: string;
}

/** Refresh both the gateway's Keystone lists and the typed identity queries (assignments). */
function useRefreshIdentity() {
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  return () => {
    invalidate("identity");
    qc.invalidateQueries({ queryKey: ["identity"] });
  };
}

export const useGroups = () => useOsList<Group>("identity", "groups", "groups");

const useAssignments = (q: Record<string, string>, enabled = true) =>
  useOsGet<RoleAssignment[]>("identity", "role_assignments", (r: { role_assignments: RoleAssignment[] }) => r.role_assignments, {
    q: { include_names: "true", ...q },
    enabled,
  });

/** One row per project with the roles held there. */
function byProject(list?: RoleAssignment[]) {
  const m = new Map<string, { id: string; name: string; domain?: string; roles: { id: string; name: string }[] }>();
  for (const a of list ?? []) {
    const p = a.scope.project;
    if (!p) continue;
    const row = m.get(p.id) ?? { id: p.id, name: p.name ?? p.id, domain: p.domain?.name, roles: [] };
    row.roles.push({ id: a.role.id, name: a.role.name ?? a.role.id });
    m.set(p.id, row);
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// =========================================================================== list

export default function Groups() {
  const groups = useGroups();
  const domainName = useDomainName();
  const navigate = useNavigate();
  const refresh = useRefreshIdentity();
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "delete"; g: Group } | null>(null);
  const close = () => setOpen(null);
  const columns: Column<Group>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (g) => (
        <Link to={`/admin/identity/groups/${g.id}`} className="font-medium text-cable hover:underline">
          {g.name}
        </Link>
      ),
      value: (g) => g.name,
    },
    { key: "domain", header: tr("Domain"), width: "9rem", hideBelow: "md", cell: (g) => domainName(g.domain_id), value: (g) => domainName(g.domain_id) },
    { key: "description", header: tr("Description"), hideBelow: "lg", cell: (g) => <span className="text-muted">{g.description || "—"}</span>, value: (g) => g.description ?? "" },
    { key: "id", header: "ID", width: "10rem", hideBelow: "xl", cell: (g) => <Mono>{g.id}</Mono>, value: (g) => g.id },
  ];
  return (
    <>
      <PageHeader
        title={tr("Groups")}
        description={tr("Collections of users. Give a group a role on a project (or on the system) and every member gets it; federated users usually get their access this way.")}
        actions={
          <Button variant="primary" onClick={() => setOpen({ kind: "create" })}>
            <Icon name="plus" />
            {tr("Create group")}
          </Button>
        }
      />
      <ErrorNotice error={groups.error} className="mb-4" />
      <DataTable
        rows={groups.data}
        columns={columns}
        rowKey={(g) => g.id}
        loading={groups.isPending}
        tableId="admin-groups"
        noun={tr("groups")}
        rowLabel={(g) => g.name}
        empty={tr("No groups yet.")}
        onRefresh={() => groups.refetch()}
        refreshing={groups.isFetching}
        onBulkDone={refresh}
        rowActions={(g) => [
          { label: tr("View details"), icon: "eye", onSelect: () => navigate(`/admin/identity/groups/${g.id}`) },
          { label: tr("Edit group"), icon: "edit", onSelect: () => setOpen({ kind: "edit", g }) },
          "-",
          { label: tr("Delete group"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", g }) },
        ]}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete groups?"),
            past: tr("deleted"),
            body: tr("Members lose every role they had only through these groups. The users themselves are kept."),
            run: (g) => os.del("identity", `groups/${g.id}`),
          },
        ]}
      />
      {open?.kind === "create" && <GroupDialog onClose={close} onDone={(g) => navigate(`/admin/identity/groups/${g.id}`)} />}
      {open?.kind === "edit" && <GroupDialog group={open.g} onClose={close} />}
      {open?.kind === "delete" && <DeleteGroupDialog group={open.g} onClose={close} />}
    </>
  );
}

function GroupDialog({ group, onClose, onDone }: { group?: Group; onClose: () => void; onDone?: (g: Group) => void }) {
  const domains = useDomains();
  const refresh = useRefreshIdentity();
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [domain, setDomain] = useState("");
  const dom = domain || domains.data?.find((d) => d.id === "default")?.id || domains.data?.[0]?.id || "";
  return (
    <ActionDialog<{ group: Group }>
      onClose={onClose}
      title={group ? tr("Edit group {name}", { name: group.name }) : tr("Create group")}
      submitLabel={group ? tr("Save") : tr("Create group")}
      canSubmit={!!name.trim() && (!!group || !!dom)}
      done={group ? tr("Group updated") : tr("Group created")}
      onDone={(r) => {
        refresh();
        onDone?.(r.group);
      }}
      run={() =>
        group
          ? os.patch("identity", `groups/${group.id}`, { group: { name: name.trim(), description } })
          : os.post("identity", "groups", { group: { name: name.trim(), description: description || undefined, domain_id: dom } })
      }
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="ops-team" />}</Field>
      {!group && (domains.data?.length ?? 0) > 1 && (
        <Field label={tr("Domain")}>{(id) => <Picker id={id} value={dom} onChange={setDomain} options={(domains.data ?? []).map((d) => ({ value: d.id, label: d.name }))} />}</Field>
      )}
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

function DeleteGroupDialog({ group, onClose, onDone }: { group: Group; onClose: () => void; onDone?: () => void }) {
  const refresh = useRefreshIdentity();
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Delete group {name}?", { name: group.name })}
      submitLabel={tr("Delete group")}
      done={tr("Group {name} deleted", { name: group.name })}
      onDone={() => {
        refresh();
        onDone?.();
      }}
      run={() => os.del("identity", `groups/${group.id}`)}
    >
      <p className="text-sm">{tr("Members lose every role they had only through this group. The users themselves are kept.")}</p>
    </ActionDialog>
  );
}

// =========================================================================== detail

export function GroupDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const group = useOsGet<Group>("identity", `groups/${id}`, (r: { group: Group }) => r.group);
  const members = useOsList<User>("identity", `groups/${id}/users`, "users");
  const assignments = useAssignments({ "group.id": id });
  const domainName = useDomainName();
  const refresh = useRefreshIdentity();
  const [open, setOpen] = useState<
    | { kind: "edit" | "delete" | "members" }
    | { kind: "remove"; u: User }
    | { kind: "roles"; project?: { id: string; name: string; roles: string[] } }
    | { kind: "unassign"; project: { id: string; name: string; roles: string[] } }
    | null
  >(null);
  const close = () => setOpen(null);
  const g = group.data;
  const projects = byProject(assignments.data);
  const memberCols: Column<User>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (u) => (
        <Link to={`/admin/identity/users/${u.id}`} className="font-medium text-cable hover:underline">
          {u.name}
        </Link>
      ),
      value: (u) => u.name,
    },
    { key: "email", header: tr("Email"), hideBelow: "md", cell: (u) => u.email || <span className="text-muted">—</span>, value: (u) => u.email ?? "" },
    { key: "domain", header: tr("Domain"), width: "9rem", hideBelow: "lg", cell: (u) => domainName(u.domain_id), value: (u) => domainName(u.domain_id) },
  ];
  return (
    <>
      <Link to="/admin/identity/groups" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Groups")}
      </Link>
      <PageHeader
        title={g?.name ?? tr("Group")}
        description={g?.description}
        actions={
          g && (
            <>
              <Button onClick={() => setOpen({ kind: "edit" })}>
                <Icon name="pencil" />
                {tr("Edit")}
              </Button>
              <Button onClick={() => setOpen({ kind: "delete" })} className="text-led-red">
                <Icon name="trash" />
                {tr("Delete")}
              </Button>
            </>
          )
        }
      />
      <ErrorNotice error={group.error} className="mb-4" />
      {g && (
        <div className="grid items-start gap-6 lg:grid-cols-[1fr_2fr]">
          <div className="space-y-6">
            <Card title={tr("Details")}>
              <dl>
                <Detail label="ID">
                  <Mono>{g.id}</Mono>
                </Detail>
                <Detail label={tr("Domain")}>{domainName(g.domain_id)}</Detail>
                <Detail label={tr("Members")}>{members.data?.length ?? "…"}</Detail>
              </dl>
            </Card>
            <SystemRolesCard kind="groups" id={g.id} />
          </div>
          <div className="space-y-6">
            <Card
              flush
              title={tr("Project roles ({n})", { n: projects.length })}
              actions={
                <Button className="h-8" onClick={() => setOpen({ kind: "roles" })}>
                  <Icon name="plus" />
                  {tr("Add to project")}
                </Button>
              }
            >
              <ErrorNotice error={assignments.error} className="m-4" />
              <ProjectRoleRows
                rows={projects}
                empty={tr("The group has no role on any project yet.")}
                onEdit={(p) => setOpen({ kind: "roles", project: { id: p.id, name: p.name, roles: p.roles.map((r) => r.id) } })}
                onRemove={(p) => setOpen({ kind: "unassign", project: { id: p.id, name: p.name, roles: p.roles.map((r) => r.id) } })}
              />
            </Card>
            <div>
              <div className="mb-3 flex items-center gap-3">
                <h2 className="text-sm font-semibold">{tr("Members")}</h2>
                <Button className="ml-auto h-8" onClick={() => setOpen({ kind: "members" })}>
                  <Icon name="user-plus" />
                  {tr("Add members")}
                </Button>
              </div>
              <DataTable
                rows={members.data}
                columns={memberCols}
                rowKey={(u) => u.id}
                loading={members.isPending}
                tableId="admin-group-members"
                noun={tr("members")}
                rowLabel={(u) => u.name}
                empty={tr("No members yet.")}
                onRefresh={() => members.refetch()}
                refreshing={members.isFetching}
                onBulkDone={refresh}
                rowActions={(u) => [
                  { label: tr("Open user"), icon: "eye", onSelect: () => navigate(`/admin/identity/users/${u.id}`) },
                  "-",
                  { label: tr("Remove from group"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "remove", u }) },
                ]}
                bulkActions={[
                  {
                    id: "remove",
                    label: tr("Remove"),
                    icon: "trash",
                    danger: true,
                    title: tr("Remove members?"),
                    past: tr("removed"),
                    body: tr("They lose the roles they had through this group."),
                    run: (u) => os.del("identity", `groups/${id}/users/${u.id}`),
                  },
                ]}
              />
            </div>
          </div>
        </div>
      )}
      {g && open?.kind === "edit" && <GroupDialog group={g} onClose={close} />}
      {g && open?.kind === "delete" && <DeleteGroupDialog group={g} onClose={close} onDone={() => navigate("/admin/identity/groups")} />}
      {g && open?.kind === "members" && <AddMembersDialog group={g} current={members.data ?? []} onClose={close} />}
      {g && open?.kind === "remove" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Remove {user} from {group}?", { user: open.u.name, group: g.name })}
          submitLabel={tr("Remove")}
          done={tr("Removed from the group")}
          onDone={refresh}
          run={() => os.del("identity", `groups/${id}/users/${open.u.id}`)}
        >
          <p className="text-sm">{tr("They lose the roles they had through this group.")}</p>
        </ActionDialog>
      )}
      {g && open?.kind === "roles" && <GroupProjectRolesDialog groupId={g.id} groupName={g.name} project={open.project} onClose={close} />}
      {g && open?.kind === "unassign" && <UnassignGroupDialog groupId={g.id} groupName={g.name} project={open.project} onClose={close} />}
    </>
  );
}

function ProjectRoleRows({
  rows,
  empty,
  link = "project",
  onEdit,
  onRemove,
}: {
  rows: { id: string; name: string; domain?: string; roles: { id: string; name: string }[] }[];
  empty: string;
  link?: "project" | "group";
  onEdit: (r: { id: string; name: string; roles: { id: string; name: string }[] }) => void;
  onRemove: (r: { id: string; name: string; roles: { id: string; name: string }[] }) => void;
}) {
  return (
    <ul>
      {rows.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3 last:border-0">
          <div className="w-52 min-w-0 shrink-0 [&>*]:block [&>*]:truncate">
            <Link to={`/admin/identity/${link === "project" ? "projects" : "groups"}/${p.id}`} className="font-medium hover:text-cable">
              {p.name}
            </Link>
            {p.domain && <p className="text-xs text-muted">{p.domain}</p>}
          </div>
          <div className="flex flex-1 flex-wrap gap-1.5">
            {p.roles.map((r) => (
              <Badge key={r.id} tone="accent">
                {r.name}
              </Badge>
            ))}
          </div>
          <div className="flex gap-1">
            <button onClick={() => onEdit(p)} aria-label={tr("Edit roles in {name}", { name: p.name })} className="rounded-md p-1.5 text-muted hover:bg-ink/5 hover:text-ink">
              <Icon name="pencil" />
            </button>
            <button onClick={() => onRemove(p)} aria-label={tr("Remove from {name}", { name: p.name })} className="rounded-md p-1.5 text-muted hover:bg-led-red/10 hover:text-led-red">
              <Icon name="trash" />
            </button>
          </div>
        </li>
      ))}
      {rows.length === 0 && <li className="px-5 py-8 text-center text-sm text-muted">{empty}</li>}
    </ul>
  );
}

function AddMembersDialog({ group, current, onClose }: { group: Group; current: User[]; onClose: () => void }) {
  const users = useUsers();
  const refresh = useRefreshIdentity();
  const [picked, setPicked] = useState<string[]>([]);
  const has = new Set(current.map((u) => u.id));
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Add members to {name}", { name: group.name })}
      submitLabel={picked.length > 1 ? tr("Add {n} members", { n: picked.length }) : tr("Add member")}
      canSubmit={picked.length > 0}
      done={tr("Members added")}
      onDone={refresh}
      run={async () => {
        for (const u of picked) await os.put("identity", `groups/${group.id}/users/${u}`);
      }}
    >
      <Field label={tr("Users")} hint={tr("Users of other domains can join too.")}>
        {(id) => (
          <MultiPicker
            id={id}
            values={picked}
            onChange={setPicked}
            searchable
            loading={users.isPending}
            placeholder={tr("Choose users")}
            options={(users.data ?? [])
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((u) => ({ value: u.id, label: u.name, description: u.email, icon: "users", disabled: has.has(u.id) ? tr("Already a member") : false }))}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

/** Give a group roles on a project (or change them, with `project`). */
export function GroupProjectRolesDialog({
  groupId,
  groupName,
  project,
  projectId,
  onClose,
}: {
  groupId?: string;
  groupName?: string;
  /** Edit the roles on this project. */
  project?: { id: string; name: string; roles: string[] };
  /** Fixed project (from the project page); the group is picked. */
  projectId?: string;
  onClose: () => void;
}) {
  const roles = useRoles();
  const projects = useProjects(!project && !projectId);
  const groups = useGroups();
  const refresh = useRefreshIdentity();
  const [pid, setPid] = useState(project?.id ?? projectId ?? "");
  const [gid, setGid] = useState(groupId ?? "");
  const member = roles.data?.find((r) => r.name === "member")?.id;
  const [picked, setPicked] = useState<string[] | null>(project?.roles ?? null);
  const chosen = picked ?? (member ? [member] : []);
  const before = project?.roles ?? [];
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={project ? tr("Roles of {group} in {project}", { group: groupName ?? "", project: project.name }) : groupName ? tr("Add {group} to a project", { group: groupName }) : tr("Give a group access")}
      description={tr("Every member of the group gets these roles on the project.")}
      submitLabel={project ? tr("Save") : tr("Assign roles")}
      canSubmit={!!pid && !!gid && chosen.length > 0}
      done={tr("Roles updated")}
      onDone={refresh}
      run={async () => {
        for (const r of chosen.filter((r) => !before.includes(r))) await os.put("identity", `projects/${pid}/groups/${gid}/roles/${r}`);
        for (const r of before.filter((r) => !chosen.includes(r))) await os.del("identity", `projects/${pid}/groups/${gid}/roles/${r}`);
      }}
    >
      {!groupId && (
        <Field label={tr("Group")}>
          {(id) => (
            <Picker
              id={id}
              value={gid}
              onChange={setGid}
              searchable
              loading={groups.isPending}
              placeholder={tr("Choose a group")}
              options={(groups.data ?? []).map((g) => ({ value: g.id, label: g.name, description: g.description, icon: "users-round" }))}
            />
          )}
        </Field>
      )}
      {!project && !projectId && (
        <Field label={tr("Project")}>
          {(id) => (
            <Picker
              id={id}
              value={pid}
              onChange={setPid}
              searchable
              loading={projects.isPending}
              placeholder={tr("Choose a project")}
              options={(projects.data ?? [])
                .filter((p) => !p.is_domain)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((p) => ({ value: p.id, label: p.name, icon: "folder" }))}
            />
          )}
        </Field>
      )}
      <Field label={tr("Roles")}>
        {(id) => <MultiPicker id={id} values={chosen} onChange={setPicked} loading={roles.isPending} options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name, description: r.description ?? undefined }))} />}
      </Field>
    </ActionDialog>
  );
}

function UnassignGroupDialog({ groupId, groupName, project, onClose }: { groupId: string; groupName: string; project: { id: string; name: string; roles: string[] }; onClose: () => void }) {
  const refresh = useRefreshIdentity();
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Remove {group} from {project}?", { group: groupName, project: project.name })}
      submitLabel={tr("Remove")}
      done={tr("Group removed from the project")}
      onDone={refresh}
      run={async () => {
        for (const r of project.roles) await os.del("identity", `projects/${project.id}/groups/${groupId}/roles/${r}`);
      }}
    >
      <p className="text-sm">{tr("Members lose the roles they had on the project through this group; roles given to them directly stay.")}</p>
    </ActionDialog>
  );
}

// =========================================================================== shared cards

/** Roles on the whole system (system-scoped tokens: `openstack --os-system-scope all`). */
export function SystemRolesCard({ kind, id }: { kind: "users" | "groups"; id: string }) {
  const roles = useRoles();
  const refresh = useRefreshIdentity();
  const current = useOsList<{ id: string; name: string }>("identity", `system/${kind}/${id}/roles`, "roles");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  return (
    <Card
      title={tr("System roles")}
      actions={
        <Button className="h-8" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          {tr("Add")}
        </Button>
      }
    >
      <ErrorNotice error={current.error} />
      {current.data && current.data.length === 0 && <p className="text-sm text-muted">{tr("None. System roles apply to cloud-wide APIs with a system-scoped token (e.g. reader on the system for auditors).")}</p>}
      <div className="flex flex-wrap gap-1.5">
        {current.data?.map((r) => (
          <Badge key={r.id} tone={r.name === "admin" ? "warn" : "accent"} onRemove={() => setRemoving(r)} removeLabel={tr("Remove role {name}", { name: r.name })}>
            {r.name}
          </Badge>
        ))}
      </div>
      {adding && <SystemRoleDialog kind={kind} id={id} have={(current.data ?? []).map((r) => r.id)} roles={roles.data ?? []} onClose={() => setAdding(false)} />}
      {removing && (
        <ActionDialog
          onClose={() => setRemoving(null)}
          danger
          title={tr("Remove system role {name}?", { name: removing.name })}
          submitLabel={tr("Remove")}
          done={tr("System role removed")}
          onDone={refresh}
          run={() => os.del("identity", `system/${kind}/${id}/roles/${removing.id}`)}
        >
          <p className="text-sm">{tr("System-scoped tokens stop carrying this role.")}</p>
        </ActionDialog>
      )}
    </Card>
  );
}

function SystemRoleDialog({ kind, id, have, roles, onClose }: { kind: "users" | "groups"; id: string; have: string[]; roles: { id: string; name: string; description?: string | null }[]; onClose: () => void }) {
  const refresh = useRefreshIdentity();
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Add system roles")}
      description={tr("System roles grant access to cloud-wide operations (services, hypervisors, endpoints…) through a system-scoped token. Give admin on the system only to cloud operators.")}
      submitLabel={tr("Add")}
      canSubmit={picked.length > 0}
      done={tr("System roles added")}
      onDone={refresh}
      run={async () => {
        for (const r of picked) await os.put("identity", `system/${kind}/${id}/roles/${r}`);
      }}
    >
      <Field label={tr("Roles")}>
        {(fid) => (
          <MultiPicker
            id={fid}
            values={picked}
            onChange={setPicked}
            options={roles.map((r) => ({ value: r.id, label: r.name, description: r.description ?? undefined, disabled: have.includes(r.id) ? tr("Already granted") : false }))}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

/** The groups a user belongs to (user detail page). */
export function UserGroupsCard({ userId, userName }: { userId: string; userName: string }) {
  const groups = useOsList<Group>("identity", `users/${userId}/groups`, "groups");
  const all = useGroups();
  const refresh = useRefreshIdentity();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [removing, setRemoving] = useState<Group | null>(null);
  const has = new Set(groups.data?.map((g) => g.id));
  return (
    <Card
      flush
      title={tr("Groups{v}", { v: groups.data ? ` (${groups.data.length})` : "" })}
      actions={
        <Button className="h-8" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          {tr("Add to group")}
        </Button>
      }
    >
      <ErrorNotice error={groups.error} className="m-4" />
      <ul>
        {groups.data?.map((g) => (
          <li key={g.id} className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-0">
            <div className="min-w-0 flex-1 [&>*]:block [&>*]:truncate">
              <Link to={`/admin/identity/groups/${g.id}`} className="font-medium hover:text-cable">
                {g.name}
              </Link>
              {g.description && <p className="text-xs text-muted">{g.description}</p>}
            </div>
            <button onClick={() => setRemoving(g)} aria-label={tr("Remove from {name}", { name: g.name })} className="rounded-md p-1.5 text-muted hover:bg-led-red/10 hover:text-led-red">
              <Icon name="trash" />
            </button>
          </li>
        ))}
        {groups.data?.length === 0 && <li className="px-5 py-6 text-center text-sm text-muted">{tr("Not in any group.")}</li>}
      </ul>
      {adding && (
        <ActionDialog
          onClose={() => {
            setAdding(false);
            setPicked([]);
          }}
          size="md"
          title={tr("Add {name} to groups", { name: userName })}
          submitLabel={tr("Add")}
          canSubmit={picked.length > 0}
          done={tr("Added to the groups")}
          onDone={refresh}
          run={async () => {
            for (const g of picked) await os.put("identity", `groups/${g}/users/${userId}`);
          }}
        >
          <Field label={tr("Groups")}>
            {(id) => (
              <MultiPicker
                id={id}
                values={picked}
                onChange={setPicked}
                searchable
                loading={all.isPending}
                options={(all.data ?? []).map((g) => ({ value: g.id, label: g.name, description: g.description, icon: "users-round", disabled: has.has(g.id) ? tr("Already a member") : false }))}
              />
            )}
          </Field>
        </ActionDialog>
      )}
      {removing && (
        <ActionDialog
          onClose={() => setRemoving(null)}
          danger
          title={tr("Remove {user} from {group}?", { user: userName, group: removing.name })}
          submitLabel={tr("Remove")}
          done={tr("Removed from the group")}
          onDone={refresh}
          run={() => os.del("identity", `groups/${removing.id}/users/${userId}`)}
        >
          <p className="text-sm">{tr("They lose the roles they had through this group.")}</p>
        </ActionDialog>
      )}
    </Card>
  );
}

/** Groups with roles on a project (project detail page). */
export function ProjectGroupsCard({ projectId, projectName, assignments }: { projectId: string; projectName: string; assignments?: RoleAssignment[] }) {
  const rows = useMemo(() => {
    const m = new Map<string, { id: string; name: string; domain?: string; roles: { id: string; name: string }[] }>();
    for (const a of assignments ?? []) {
      if (!a.group) continue;
      const row = m.get(a.group.id) ?? { id: a.group.id, name: a.group.name ?? a.group.id, domain: a.group.domain?.name, roles: [] };
      row.roles.push({ id: a.role.id, name: a.role.name ?? a.role.id });
      m.set(a.group.id, row);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [assignments]);
  const [open, setOpen] = useState<{ kind: "add" } | { kind: "edit" | "remove"; g: { id: string; name: string; roles: string[] } } | null>(null);
  const close = () => setOpen(null);
  return (
    <Card
      flush
      title={tr("Groups ({n})", { n: rows.length })}
      actions={
        <Button className="h-8" onClick={() => setOpen({ kind: "add" })}>
          <Icon name="plus" />
          {tr("Add group")}
        </Button>
      }
    >
      <ProjectRoleRows
        rows={rows}
        link="group"
        empty={tr("No group has a role on this project.")}
        onEdit={(g) => setOpen({ kind: "edit", g: { id: g.id, name: g.name, roles: g.roles.map((r) => r.id) } })}
        onRemove={(g) => setOpen({ kind: "remove", g: { id: g.id, name: g.name, roles: g.roles.map((r) => r.id) } })}
      />
      {open?.kind === "add" && <GroupProjectRolesDialog projectId={projectId} onClose={close} />}
      {open?.kind === "edit" && (
        <GroupProjectRolesDialog groupId={open.g.id} groupName={open.g.name} project={{ id: projectId, name: projectName, roles: open.g.roles }} onClose={close} />
      )}
      {open?.kind === "remove" && (
        <UnassignGroupDialog groupId={open.g.id} groupName={open.g.name} project={{ id: projectId, name: projectName, roles: open.g.roles }} onClose={close} />
      )}
    </Card>
  );
}
