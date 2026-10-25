import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Badge, Button, ErrorNotice, Field, Icon, Input, PageHeader } from "@/components/ui";
import {
  POLICY_TEXT,
  type ServerGroup,
  type ServerGroupPolicy,
  groupPolicy,
  os,
  useComputeLimits,
  useInvalidate,
  useServerGroups,
} from "@/lib/os";
import { useServerNames } from "../storage/volumeActions";
import { tr, trx } from "@/lib/i18n";
import { useProjects } from "@/lib/identity";

export default function ServerGroups({ admin = false }: { admin?: boolean }) {
  const groups = useServerGroups(admin ? { all_projects: "True" } : undefined);
  const projects = useProjects(admin);
  const projectName = (id?: string) => (id ? (projects.data?.find((p) => p.id === id)?.name ?? id) : "");
  const serverName = useServerNames();
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ServerGroup | null>(null);
  const policy = (g: ServerGroup) => {
    const p = groupPolicy(g);
    return p ? POLICY_TEXT[p].label : "";
  };
  const members = (g: ServerGroup) => g.members.map(serverName).join(", ");

  const columns: Column<ServerGroup>[] = [
    { key: "name", header: tr("Name"), cell: (g) => <span className="font-medium">{g.name}</span>, value: (g) => g.name },
    ...(admin
      ? [{ key: "project", header: tr("Project"), width: "10rem", hideBelow: "md" as const, cell: (g: ServerGroup) => projectName(g.project_id), value: (g: ServerGroup) => projectName(g.project_id) }]
      : []),
    {
      key: "policy",
      header: tr("Policy"),
      width: "11rem",
      cell: (g) => <Badge tone={groupPolicy(g)?.startsWith("soft") ? "neutral" : "accent"}>{policy(g)}</Badge>,
      value: policy,
    },
    {
      key: "rules",
      header: tr("Rules"),
      width: "12rem",
      hideBelow: "lg",
      cell: (g) => (g.rules?.max_server_per_host ? tr("max {max_server_per_host} per host", { max_server_per_host: g.rules.max_server_per_host }) : <span className="text-muted">—</span>),
      value: (g) => g.rules?.max_server_per_host ?? 0,
    },
    {
      key: "members",
      header: tr("Members"),
      hideBelow: "md",
      cell: (g) =>
        g.members.length ? (
          <span>
            {g.members.map((id, i) => (
              <span key={id}>
                {i > 0 && ", "}
                <Link to={`/compute/instances/${id}`} className="text-cable hover:underline">
                  {serverName(id)}
                </Link>
              </span>
            ))}
          </span>
        ) : (
          <span className="text-muted">{tr("none")}</span>
        ),
      value: members,
    },
    { key: "count", header: tr("Count"), width: "5.5rem", className: "text-right", cell: (g) => g.members.length, value: (g) => g.members.length },
  ];

  return (
    <>
      <PageHeader
        title={admin ? tr("All server groups") : tr("Server groups")}
        description={
          admin
            ? tr("Server groups of every project, with their placement policy and members.")
            : tr("Keep instances together on one host (affinity) or spread them over different hosts (anti-affinity). Instances join a group when they are launched.")
        }
        actions={
          !admin && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              {tr("Create server group")}
            </Button>
          )
        }
      />
      <ErrorNotice error={groups.error} className="mb-4" />
      <DataTable
        rows={groups.data}
        columns={columns}
        rowKey={(g) => g.id}
        loading={groups.isPending}
        tableId={admin ? "admin-server-groups" : "server-groups"}
        noun={tr("server groups")}
        rowLabel={(g) => g.name}
        empty={tr("No server groups. Create one, then pick it when launching instances.")}
        onRefresh={() => groups.refetch()}
        refreshing={groups.isFetching}
        onBulkDone={() => invalidate("compute")}
        rowActions={(g) => [
          !admin && { label: tr("Launch instance in this group"), icon: "rocket", onSelect: () => navigate(`/compute/instances/launch?group=${g.id}`) },
          !admin && "-",
          { label: tr("Delete server group"), icon: "trash", danger: true, onSelect: () => setDeleting(g) },
        ]}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete server groups?"),
            past: tr("deleted"),
            body: tr("Members keep running; the policy just stops applying to them."),
            run: (g) => os.del("compute", `os-server-groups/${g.id}`),
          },
        ]}
      />
      <CreateServerGroupDialog open={creating} onClose={() => setCreating(false)} />
      {deleting && (
        <ActionDialog
          onClose={() => setDeleting(null)}
          danger
          title={tr("Delete {name}?", { name: deleting.name })}
          submitLabel={tr("Delete server group")}
          done={tr("Server group {name} deleted", { name: deleting.name })}
          refresh={["compute"]}
          run={() => os.del("compute", `os-server-groups/${deleting.id}`)}
        >
          <p className="text-sm">
            {trx("{v}the placement policy stops applying. This can't be undone.", { v: deleting.members.length ? tr("Its {length} member(s) keep running; ", { length: deleting.members.length }) : "" })}
          </p>
        </ActionDialog>
      )}
    </>
  );
}

const POLICIES = (Object.keys(POLICY_TEXT) as ServerGroupPolicy[]).map((p) => ({ value: p, label: POLICY_TEXT[p].label, description: POLICY_TEXT[p].help }));

/** Create a server group (compute API 2.64 format: one policy plus optional rules). */
export function CreateServerGroupDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (g: ServerGroup) => void }) {
  const [name, setName] = useState("");
  const [policy, setPolicy] = useState<ServerGroupPolicy>("anti-affinity");
  const [maxPerHost, setMaxPerHost] = useState("");
  const invalidate = useInvalidate();
  const toast = useToast();
  const limits = useComputeLimits();
  const L = limits.data as (typeof limits.data & { maxServerGroups?: number; totalServerGroupsUsed?: number; maxServerGroupMembers?: number }) | undefined;
  const m = useMutation({
    mutationFn: () =>
      os.post<{ server_group: ServerGroup }>("compute", "os-server-groups", {
        server_group: {
          name: name.trim(),
          policy,
          ...(policy === "anti-affinity" && Number(maxPerHost) > 0 ? { rules: { max_server_per_host: Number(maxPerHost) } } : {}),
        },
      }),
    onSuccess: (r) => {
      toast(tr("Server group {name} created", { name: r.server_group.name }));
      invalidate("compute");
      onCreated?.(r.server_group);
      close();
    },
  });
  function close() {
    m.reset();
    setName("");
    setMaxPerHost("");
    onClose();
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      title={tr("Create server group")}
      description={
        L?.maxServerGroups != null && L.maxServerGroups >= 0
          ? tr("Quota: {v} of {maxServerGroups} groups used{v2}.", { v: L.totalServerGroupsUsed ?? "?", maxServerGroups: L.maxServerGroups, v2: L.maxServerGroupMembers != null && L.maxServerGroupMembers >= 0 ? tr(", up to {maxServerGroupMembers} members each", { maxServerGroupMembers: L.maxServerGroupMembers }) : "" })
          : undefined
      }
      onSubmit={() => m.mutate()}
      footer={
        <>
          <Button type="button" onClick={close}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!name.trim()}>
            {tr("Create")}
          </Button>
        </>
      }
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("web-spread")} />}</Field>
      <Field label={tr("Policy")}>{(id) => <Picker id={id} value={policy} onChange={(v) => setPolicy(v as ServerGroupPolicy)} options={POLICIES} panelWidth={340} />}</Field>
      {policy === "anti-affinity" && (
        <Field label={tr("Max instances per host")} hint={tr("Optional. Allows up to this many members on one host instead of strictly one.")}>
          {(id) => <Input id={id} type="number" min={1} value={maxPerHost} onChange={(e) => setMaxPerHost(e.target.value)} placeholder="1" className="w-32" />}
        </Field>
      )}
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}
