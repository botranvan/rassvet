import { useState } from "react";
import { useParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { ConfirmDialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { Badge, Button, Card, Detail, ErrorNotice, Icon, Mono, PageHeader } from "@/components/ui";
import { groupAssignments, useDeleteProject, useProject, useProjectAssignments, useSetProjectRoles } from "@/lib/identity";
import { useSession } from "@/lib/session";
import { ProjectDialog } from "./Projects";
import { AssignRolesDialog, Enabled, useDomainName } from "./shared";
import { tr } from "@/lib/i18n";
import { TagList } from "@/components/TagInput";
import { ProjectGroupsCard } from "./Groups";

export default function ProjectDetail() {
  const { id = "" } = useParams();
  const project = useProject(id);
  const assignments = useProjectAssignments(id);
  const domainName = useDomainName();
  const session = useSession().data!;
  const setRoles = useSetProjectRoles();
  const del = useDeleteProject();
  const toast = useToast();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editMember, setEditMember] = useState<{ id: string; name: string; roles: string[] } | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string; roles: string[] } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const members = groupAssignments(assignments.data, "user");
  const p = project.data;

  return (
    <>
      <Link to=".." relative="path" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Projects")}
      </Link>
      <PageHeader
        title={p?.name ?? tr("Project")}
        description={p?.description}
        actions={
          p && (
            <>
              <Button onClick={() => setEditing(true)}>
                <Icon name="pencil" />
                {tr("Edit")}
              </Button>
              <Link to={`/admin/quotas?project=${encodeURIComponent(p.id)}`} className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-panel px-3.5 text-sm font-medium hover:bg-surface">
                <Icon name="gauge" />
                {tr("Quotas")}
              </Link>
              <Link to={`/admin/compute/usage?project=${encodeURIComponent(p.id)}`} className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-panel px-3.5 text-sm font-medium hover:bg-surface">
                <Icon name="chart-bar" />
                {tr("Usage")}
              </Link>
              <Button onClick={() => setDeleting(true)} className="text-led-red">
                <Icon name="trash" />
                {tr("Delete")}
              </Button>
            </>
          )
        }
      />
      <ErrorNotice error={project.error} className="mb-4" />

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_2fr]">
        <Card title={tr("Details")}>
          {p && (
            <dl>
              <Detail label="ID">
                <Mono>{p.id}</Mono>
              </Detail>
              <Detail label={tr("Domain")}>{domainName(p.domain_id)}</Detail>
              <Detail label={tr("Status")}>
                <Enabled enabled={p.enabled} />
              </Detail>
              <Detail label={tr("Tags")} wrap>
                <TagList tags={p.tags} empty={tr("None")} />
              </Detail>
              {p.parent_id && p.parent_id !== p.domain_id && (
                <Detail label={tr("Parent")}>
                  <Link to={`../${p.parent_id}`} relative="path" className="text-cable hover:underline">
                    <Mono>{p.parent_id}</Mono>
                  </Link>
                </Detail>
              )}
            </dl>
          )}
        </Card>

        <div className="space-y-6">
        <Card
          flush
          title={tr("Members{v}", { v: assignments.data ? ` (${members.length})` : "" })}
          actions={
            <Button onClick={() => setAdding(true)} className="h-8">
              <Icon name="user-plus" />
              {tr("Add member")}
            </Button>
          }
        >
          <ErrorNotice error={assignments.error} className="m-4" />
          <ul>
            {members.map((m) => (
              <li key={m.key.id} className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3 last:border-0">
                <div className="w-52 min-w-0 shrink-0 [&>*]:block [&>*]:truncate">
                  <Link to={`/admin/identity/users/${m.key.id}`} className="font-medium hover:text-cable">
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
                          { projectId: id, userId: m.key.id, revoke: [r.id] },
                          { onSuccess: () => toast(tr("Removed {name} from {name2}", { name: r.name, name2: m.key.name })) },
                        )
                      }
                    >
                      {r.name}
                    </Badge>
                  ))}
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => setEditMember({ id: m.key.id, name: m.key.name ?? m.key.id, roles: m.roles.map((r) => r.id) })}
                    aria-label={tr("Edit roles of {name}", { name: m.key.name })}
                    className="rounded-md p-1.5 text-muted hover:bg-ink/5 hover:text-ink"
                  >
                    <Icon name="pencil" />
                  </button>
                  <button
                    onClick={() => setRemoving({ id: m.key.id, name: m.key.name ?? m.key.id, roles: m.roles.map((r) => r.id) })}
                    aria-label={tr("Remove {name} from project", { name: m.key.name })}
                    className="rounded-md p-1.5 text-muted hover:bg-led-red/10 hover:text-led-red"
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </li>
            ))}
            {assignments.data && members.length === 0 && (
              <li className="px-5 py-10 text-center text-sm text-muted">
                {tr("Nobody can use this project yet. Add a member to give them access.")}
              </li>
            )}
          </ul>
          <ErrorNotice error={setRoles.error} className="m-4" />
        </Card>
        {p && <ProjectGroupsCard projectId={p.id} projectName={p.name} assignments={assignments.data} />}
        </div>
      </div>

      {p && <ProjectDialog key={p.id + String(editing)} open={editing} onClose={() => setEditing(false)} project={p} />}
      <AssignRolesDialog open={adding} onClose={() => setAdding(false)} projectId={id} title={tr("Add member to {v}", { v: p?.name ?? tr("project") })} />
      {editMember && (
        <AssignRolesDialog
          open
          onClose={() => setEditMember(null)}
          projectId={id}
          userId={editMember.id}
          current={editMember.roles}
          title={tr("Roles of {name} in {name2}", { name: editMember.name, name2: p?.name })}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        onClose={() => {
          setRoles.reset();
          setRemoving(null);
        }}
        title={tr("Remove member?")}
        confirmLabel={tr("Remove from project")}
        busy={setRoles.isPending}
        error={setRoles.error}
        onConfirm={() =>
          removing &&
          setRoles.mutate(
            { projectId: id, userId: removing.id, revoke: removing.roles },
            {
              onSuccess: () => {
                toast(tr("{name} removed from {name2}", { name: removing.name, name2: p?.name }));
                setRemoving(null);
              },
            },
          )
        }
      >
        <strong className="font-medium">{removing?.name}</strong>{" "}{tr("loses every role in this project. Their existing tokens stop working for it within a few minutes.")}
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        onClose={() => {
          del.reset();
          setDeleting(false);
        }}
        title={tr("Delete project?")}
        confirmLabel={tr("Delete project")}
        busy={del.isPending}
        error={del.error}
        onConfirm={() =>
          del.mutate(id, {
            onSuccess: () => {
              toast(tr("Project {name} deleted", { name: p?.name }));
              navigate("/admin/identity/projects");
            },
          })
        }
      >
        {session.project?.id === id ? (
          <>{tr("You are working in this project. Switch to another project first.")}</>
        ) : (
          <>
            <strong className="font-medium">{p?.name}</strong>{" "}{tr("and its role assignments are deleted. Servers, volumes and networks it owns are")}{" "}<strong className="font-medium">{tr("not")}</strong>{" "}{tr("removed and become orphaned, so clean them up first. This can't be undone.")}
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
