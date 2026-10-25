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
import { type Project, useCreateProject, useDomains, useIdentitySearch, useProjects, useUpdateProject } from "@/lib/identity";
import { Enabled, useDomainName } from "./shared";
import { tr, trx } from "@/lib/i18n";
import { TagInput, TagList } from "@/components/TagInput";

export default function Projects() {
  const domains = useDomains();
  const domainName = useDomainName();
  const [domain, setDomain] = useState("");
  const [search, setSearch] = useState("");
  // Keystone filters by name and domain itself; large clouds never send every project.
  // Small backends: everything is loaded, so the filter matches any column (name, email, ID…).
  // When Keystone truncates the list (list_limit), names are searched on the server instead.
  const whole = useIdentitySearch<Project>("projects", { domain_id: domain });
  const serverSearch = !!whole.data?.truncated;
  const projects = useIdentitySearch<Project>("projects", { q: serverSearch ? search : "", domain_id: domain });
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  const rows = projects.data?.rows.filter((p) => !p.is_domain);
  const current = useSession().data?.project?.id;
  const qc = useQueryClient();
  const path = (p: Project) => `/identity/admin/projects/${encodeURIComponent(p.id)}`;
  const bulk: BulkAction<Project>[] = [
    {
      id: "enable",
      label: tr("Enable"),
      icon: "lock-open",
      title: tr("Enable projects?"),
      past: tr("enabled"),
      check: (p) => (p.enabled ? tr("Already enabled") : true),
      run: (p) => api.patch(path(p), { enabled: true }),
    },
    {
      id: "disable",
      label: tr("Disable"),
      icon: "lock",
      title: tr("Disable projects?"),
      past: tr("disabled"),
      body: tr("Members can't sign in to disabled projects or use their resources."),
      check: (p) => (p.id === current ? tr("You are working in this project") : p.enabled ? true : tr("Already disabled")),
      run: (p) => api.patch(path(p), { enabled: false }),
    },
    {
      id: "delete",
      label: tr("Delete"),
      icon: "trash",
      danger: true,
      title: tr("Delete projects?"),
      past: tr("deleted"),
      body: tr("Projects and their role assignments are deleted. Servers, volumes and networks they own are not removed and become orphaned, so clean them up first. This can't be undone."),
      check: (p) => (p.id === current ? tr("You are working in this project") : true),
      run: (p) => api.del(path(p)),
    },
  ];
  const columns: Column<Project>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (p) => (
        <Link to={p.id} className="font-medium text-cable hover:underline">
          {p.name}
        </Link>
      ),
      value: (p) => p.name,
    },
    { key: "domain", width: "8rem", hideBelow: "md", header: tr("Domain"), cell: (p) => domainName(p.domain_id), value: (p) => domainName(p.domain_id) },
    {
      key: "description", hideBelow: "lg",
      header: tr("Description"),
      cell: (p) => <span className="text-muted">{p.description}</span>,
      value: (p) => p.description ?? "",
    },
    { key: "tags", width: "12rem", hideBelow: "xl", header: tr("Tags"), wrap: true, cell: (p) => <TagList tags={p.tags} />, value: (p) => (p.tags ?? []).join(" ") },
    { key: "enabled", width: "7.5rem", header: tr("Status"), cell: (p) => <Enabled enabled={p.enabled} />, value: (p) => (p.enabled ? 1 : 0), csv: (p) => (p.enabled ? "Enabled" : "Disabled") },
    { key: "id", width: "10rem", hideBelow: "xl", header: "ID", cell: (p) => <Mono>{p.id}</Mono>, value: (p) => p.id },
  ];

  return (
    <>
      <PageHeader
        title={tr("Projects")}
        description={tr("Projects own cloud resources and quotas. Open a project to manage who can use it.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Create project")}
          </Button>
        }
      />
      <ErrorNotice error={projects.error} className="mb-4" />
      {projects.data?.truncated && (
        <p className="mb-4 rounded-md border border-led-amber/40 bg-led-amber/8 px-4 py-2.5 text-sm">
          {trx("Keystone returned only the first {length} projects (its", { length: projects.data.rows.length })}{" "}<code className="font-mono">list_limit</code>{tr("). Search by name to find others.")}
        </p>
      )}
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(p) => p.id}
        loading={projects.isPending}
        tableId="admin-projects"
        noun={tr("projects")}
        rowLabel={(p) => p.name}
        bulkActions={bulk}
        onRefresh={() => projects.refetch()}
        refreshing={projects.isFetching}
        onSearch={serverSearch ? setSearch : undefined}
        rowActions={(p) => [
          { label: tr("View details"), icon: "eye", onSelect: () => navigate(p.id) },
          { label: tr("Edit quotas"), icon: "gauge", onSelect: () => navigate(`/admin/quotas?project=${encodeURIComponent(p.id)}`) },
          { label: tr("Usage"), icon: "chart-bar", onSelect: () => navigate(`/admin/compute/usage?project=${encodeURIComponent(p.id)}`) },
        ]}
        onBulkDone={() => qc.invalidateQueries({ queryKey: ["identity"] })}
        filterPlaceholder={serverSearch ? tr("Search project names on the server") : tr("Filter by any column")}
        empty={tr("No projects in this domain.")}
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
      <ProjectDialog open={creating} onClose={() => setCreating(false)} onSaved={(p) => navigate(p.id)} />
    </>
  );
}

/** Create a project, or edit one when `project` is given. */
export function ProjectDialog({
  open,
  onClose,
  project,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  project?: Project;
  onSaved?: (p: Project) => void;
}) {
  const domains = useDomains();
  const create = useCreateProject();
  const update = useUpdateProject();
  const toast = useToast();
  const m = project ? update : create;
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [enabled, setEnabled] = useState(project?.enabled ?? true);
  const [tags, setTags] = useState<string[]>(project?.tags ?? []);
  const allProjects = useProjects(open);
  const knownTags = [...new Set((allProjects.data ?? []).flatMap((p) => p.tags ?? []))].sort();
  const [domainId, setDomainId] = useState("");
  const domain = domainId || domains.data?.find((d) => d.id === "default")?.id || domains.data?.[0]?.id || "";

  function close() {
    create.reset();
    update.reset();
    if (!project) {
      setName("");
      setDescription("");
      setEnabled(true);
      setTags([]);
    }
    onClose();
  }

  const done = (p: Project) => {
    toast(project ? tr("Project {name} updated", { name: p.name }) : tr("Project {name} created", { name: p.name }));
    onSaved?.(p);
    close();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={project ? tr("Edit project") : tr("Create project")}
      onSubmit={() =>
        project
          ? update.mutate({ id: project.id, name: name.trim(), description, enabled, tags }, { onSuccess: done })
          : create.mutate({ name: name.trim(), description: description || undefined, enabled, domain_id: domain, tags: tags.length ? tags : undefined }, { onSuccess: done })
      }
      footer={
        <>
          <Button type="button" onClick={close}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!name.trim()}>
            {project ? tr("Save changes") : tr("Create project")}
          </Button>
        </>
      }
    >
      <Field label={tr("Name")}>
        {(id) => <Input id={id} required autoFocus value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      {!project && (
        <Field label={tr("Domain")}>
          {(id) => (
            <Picker id={id} value={domain} onChange={setDomainId} options={(domains.data ?? []).map((d) => ({ value: d.id, label: d.name }))} />
          )}
        </Field>
      )}
      <Field label={tr("Description")}>
        {(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <Field label={tr("Tags")} hint={tr("Labels to find and group projects, e.g. a team or cost center. Keystone can filter projects by them.")}>
        {(id) => <TagInput id={id} value={tags} onChange={setTags} maxLength={255} suggestions={knownTags} />}
      </Field>
      <Switch
        checked={enabled}
        onChange={setEnabled}
        label={tr("Enabled")}
        hint={tr("Members of a disabled project can't sign in to it or use its resources.")}
      />
      <ErrorNotice error={m.error ?? domains.error} />
    </Dialog>
  );
}
