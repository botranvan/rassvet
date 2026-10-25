import { useMutation } from "@tanstack/react-query";
import { useNewParam } from "@/lib/useTab";
import { useState } from "react";
import { useParams } from "react-router";
import { Link, useInAdmin, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { ActionMenu, type MenuEntry } from "@/components/Menu";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Badge, Button, ErrorNotice, Field, Icon, Input, PageHeader, Textarea } from "@/components/ui";
import { type SecurityGroup, type SecurityGroupRule, os, ruleSummary, useInvalidate, useOsGet, useSecurityGroups } from "@/lib/os";
import { useSession } from "@/lib/session";
import { tr } from "@/lib/i18n";
import { useProjects } from "@/lib/identity";

export function useSecurityGroupActions({ onDeleted }: { onDeleted?: () => void } = {}) {
  const navigate = useNavigate();
  const session = useSession().data!;
  const all = useSecurityGroups({ project_id: session.project?.id });
  const [open, setOpen] = useState<{ kind: "rule" | "edit" | "delete"; group: SecurityGroup } | null>(null);
  const close = () => setOpen(null);
  const items = (g: SecurityGroup, where: "list" | "detail" = "list"): MenuEntry[] => [
    where === "list" && { label: tr("Manage rules"), icon: "shield", onSelect: () => navigate(`/network/security-groups/${g.id}`) },
    { label: tr("Add rule"), icon: "shield-plus", onSelect: () => setOpen({ kind: "rule", group: g }) },
    { label: tr("Edit security group"), icon: "edit", disabled: g.name === "default" ? tr("The default group can't be renamed") : false, onSelect: () => setOpen({ kind: "edit", group: g }) },
    "-",
    { label: tr("Delete security group"), icon: "trash", danger: true, disabled: g.name === "default" ? tr("Every project keeps its default group") : false, onSelect: () => setOpen({ kind: "delete", group: g }) },
  ];
  const o = open;
  const dialogs = o && (
    <>
      {o.kind === "rule" && <AddRuleDialog open onClose={close} group={o.group} groups={all.data ?? []} />}
      {o.kind === "edit" && <EditGroupDialog group={o.group} onClose={close} />}
      {o.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete {name}?", { name: o.group.name })}
          submitLabel={tr("Delete security group")}
          done={tr("Security group deleted")}
          refresh={["network"]}
          onDone={onDeleted}
          run={() => os.del("network", `security-groups/${o.group.id}`)}
        >
          <p className="text-sm">{tr("Neutron refuses while ports still use the group.")}</p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs };
}

function EditGroupDialog({ group, onClose }: { group: SecurityGroup; onClose: () => void }) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit {name}", { name: group.name })}
      submitLabel={tr("Save")}
      canSubmit={!!name.trim()}
      done={tr("Security group updated")}
      refresh={["network"]}
      run={() => os.put("network", `security-groups/${group.id}`, { security_group: { name: name.trim(), description } })}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

export default function SecurityGroups({ admin = false }: { admin?: boolean }) {
  const session = useSession().data!;
  // Neutron lists every project's groups to admins: the project view asks for its own only.
  const groups = useSecurityGroups(admin ? undefined : { project_id: session.project?.id });
  const projects = useProjects(admin);
  const projectName = (id?: string) => (id ? (projects.data?.find((p) => p.id === id)?.name ?? id) : "");
  const invalidate = useInvalidate();
  const actions = useSecurityGroupActions();
  const [creating, setCreating] = useState(false);
  useNewParam(setCreating);
  const inbound = (g: SecurityGroup) => g.security_group_rules.filter((r) => r.direction === "ingress");

  const columns: Column<SecurityGroup>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (g) => (
        <Link to={`/network/security-groups/${g.id}`} className="font-medium text-cable hover:underline">
          {g.name}
        </Link>
      ),
      value: (g) => g.name,
    },
    ...(admin
      ? [{ key: "project", header: tr("Project"), width: "10rem", cell: (g: SecurityGroup) => projectName(g.project_id), value: (g: SecurityGroup) => projectName(g.project_id) }]
      : []),
    { key: "description", header: tr("Description"), hideBelow: "md", cell: (g) => <span className="text-muted">{g.description}</span>, value: (g) => g.description },
    {
      key: "inbound",
      header: tr("Allows in"),
      hideBelow: "lg",
      cell: (g) => inbound(g).map((r) => `${ruleSummary(r)}${r.remote_ip_prefix ? ` from ${r.remote_ip_prefix}` : r.remote_group_id ? " from group" : ""}`).join("; ") || <span className="text-muted">{tr("nothing")}</span>,
      value: (g) => inbound(g).map(ruleSummary).join("; "),
    },
    { key: "rules", header: tr("Rules"), width: "5rem", className: "text-right", cell: (g) => g.security_group_rules.length, value: (g) => g.security_group_rules.length },
  ];

  return (
    <>
      <PageHeader
        title={admin ? tr("All security groups") : tr("Security groups")}
        description={
          admin
            ? tr("Security groups of every project. Neutron refuses to delete groups that ports still use.")
            : tr("Firewall rules for instance ports. Traffic in is denied unless a rule allows it; traffic out is allowed by default.")
        }
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Create security group")}
          </Button>
        }
      />
      <ErrorNotice error={groups.error} className="mb-4" />
      <DataTable
        rows={groups.data}
        columns={columns}
        rowKey={(g) => g.id}
        loading={groups.isPending}
        tableId={admin ? "admin-security-groups" : "security-groups"}
        noun={tr("security groups")}
        rowLabel={(g) => g.name}
        onRefresh={() => groups.refetch()}
        refreshing={groups.isFetching}
        onBulkDone={() => invalidate("network")}
        rowActions={(g) => actions.items(g)}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete security groups?"),
            past: tr("deleted"),
            body: tr("Neutron refuses while instances still use a group."),
            check: (g) => (g.name === "default" ? tr("Every project keeps its default group") : true),
            run: (g) => os.del("network", `security-groups/${g.id}`),
          },
        ]}
      />
      <CreateGroupDialog open={creating} onClose={() => setCreating(false)} />
      {actions.dialogs}
    </>
  );
}

function CreateGroupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const invalidate = useInvalidate();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => os.post<{ security_group: SecurityGroup }>("network", "security-groups", { security_group: { name: name.trim(), description } }),
    onSuccess: (r) => {
      toast(tr("Security group {name} created", { name: r.security_group.name }));
      invalidate("network");
      setName("");
      setDescription("");
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={tr("Create security group")}
      description={tr("New groups allow all outbound traffic and no inbound traffic. Add rules afterwards.")}
      onSubmit={() => m.mutate()}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!name.trim()}>
            {tr("Create")}
          </Button>
        </>
      }
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("web")} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}

const PRESETS: Record<string, { label: string; protocol: string | null; min?: number; max?: number }> = {
  ssh: { label: tr("SSH (TCP 22)"), protocol: "tcp", min: 22, max: 22 },
  http: { label: tr("HTTP (TCP 80)"), protocol: "tcp", min: 80, max: 80 },
  https: { label: tr("HTTPS (TCP 443)"), protocol: "tcp", min: 443, max: 443 },
  rdp: { label: tr("RDP (TCP 3389)"), protocol: "tcp", min: 3389, max: 3389 },
  dns: { label: tr("DNS (UDP 53)"), protocol: "udp", min: 53, max: 53 },
  mysql: { label: tr("MySQL (TCP 3306)"), protocol: "tcp", min: 3306, max: 3306 },
  postgres: { label: tr("PostgreSQL (TCP 5432)"), protocol: "tcp", min: 5432, max: 5432 },
  k8s: { label: tr("Kubernetes API (TCP 6443)"), protocol: "tcp", min: 6443, max: 6443 },
  wireguard: { label: tr("WireGuard (UDP 51820)"), protocol: "udp", min: 51820, max: 51820 },
  openvpn: { label: tr("OpenVPN (UDP 1194)"), protocol: "udp", min: 1194, max: 1194 },
  icmp: { label: tr("ICMP (ping)"), protocol: "icmp" },
  tcp: { label: tr("Custom TCP"), protocol: "tcp" },
  udp: { label: tr("Custom UDP"), protocol: "udp" },
  any: { label: tr("All traffic"), protocol: null },
};

export function SecurityGroupDetail() {
  const { id = "" } = useParams();
  const session = useSession().data!;
  const group = useOsGet<SecurityGroup>("network", `security-groups/${id}`, (r: { security_group: SecurityGroup }) => r.security_group);
  // Admin screens: remote groups can be any project's (Neutron lists them all for admins).
  const all = useSecurityGroups(useInAdmin() ? undefined : { project_id: session.project?.id });
  const invalidate = useInvalidate();
  const toast = useToast();
  const navigate = useNavigate();
  const actions = useSecurityGroupActions({ onDeleted: () => navigate("/network/security-groups") });
  const [adding, setAdding] = useState(false);
  const g = group.data;
  const groupName = (gid: string) => all.data?.find((x) => x.id === gid)?.name ?? gid;

  const del = useMutation({
    mutationFn: (r: SecurityGroupRule) => os.del("network", `security-group-rules/${r.id}`),
    onSuccess: () => {
      toast(tr("Rule deleted"));
      invalidate("network");
    },
  });

  const columns: Column<SecurityGroupRule>[] = [
    {
      key: "direction",
      header: tr("Direction"),
      width: "7rem",
      cell: (r) => <Badge tone={r.direction === "ingress" ? "accent" : "neutral"}>{r.direction === "ingress" ? tr("inbound") : tr("outbound")}</Badge>,
      value: (r) => r.direction,
    },
    { key: "proto", header: tr("Traffic"), cell: ruleSummary, value: ruleSummary },
    {
      key: "remote",
      header: tr("Remote"),
      cell: (r) => (r.remote_group_id ? tr("Group {groupName}", { groupName: groupName(r.remote_group_id) }) : r.remote_ip_prefix || (r.ethertype === "IPv6" ? "::/0" : "0.0.0.0/0")),
      value: (r) => r.remote_ip_prefix ?? r.remote_group_id ?? "",
      mono: true,
    },
    { key: "ether", header: "IP", width: "4.5rem", hideBelow: "sm", cell: (r) => r.ethertype, value: (r) => r.ethertype },
    { key: "description", header: tr("Description"), hideBelow: "lg", cell: (r) => r.description ?? "", value: (r) => r.description ?? "" },
  ];

  return (
    <>
      <Link to="/network/security-groups" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Security groups")}
      </Link>
      <PageHeader
        title={g?.name ?? tr("Security group")}
        description={g?.description || undefined}
        actions={
          g && (
            <>
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Icon name="plus" />
                {tr("Add rule")}
              </Button>
              <ActionMenu variant="button" items={() => actions.items(g, "detail").filter((e) => !(e && typeof e === "object" && "label" in e && e.label === tr("Add rule")))} />
            </>
          )
        }
      />
      <ErrorNotice error={group.error ?? del.error} className="mb-4" />
      <DataTable
        rows={g?.security_group_rules}
        columns={columns}
        rowKey={(r) => r.id}
        loading={group.isPending}
        tableId="sg-rules"
        noun={tr("rules")}
        rowLabel={ruleSummary}
        empty={tr("No rules. Nothing can reach instances in this group.")}
        onRefresh={() => group.refetch()}
        refreshing={group.isFetching}
        onBulkDone={() => invalidate("network")}
        rowActions={(r) => [{ label: tr("Delete rule"), icon: "trash", danger: true, onSelect: () => del.mutate(r) }]}
        bulkActions={[
          { id: "delete", label: tr("Delete"), icon: "trash", danger: true, title: tr("Delete rules?"), past: tr("deleted"), run: (r) => os.del("network", `security-group-rules/${r.id}`) },
        ]}
      />
      {g && <AddRuleDialog open={adding} onClose={() => setAdding(false)} group={g} groups={all.data ?? []} />}
      {actions.dialogs}
    </>
  );
}

function AddRuleDialog({ open, onClose, group, groups }: { open: boolean; onClose: () => void; group: SecurityGroup; groups: SecurityGroup[] }) {
  const [preset, setPreset] = useState("ssh");
  const [direction, setDirection] = useState<"ingress" | "egress">("ingress");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [remoteKind, setRemoteKind] = useState<"cidr" | "group">("cidr");
  const [cidr, setCidr] = useState("0.0.0.0/0");
  const [remoteGroup, setRemoteGroup] = useState(group.id);
  const [description, setDescription] = useState("");
  const invalidate = useInvalidate();
  const toast = useToast();
  const p = PRESETS[preset];
  const custom = preset === "tcp" || preset === "udp";
  const min = custom ? Number(from) : p.min;
  const max = custom ? Number(to || from) : p.max;
  const portsOk = !custom || (Number(from) >= 1 && Number(from) <= 65535 && max! >= min! && max! <= 65535);

  const m = useMutation({
    mutationFn: () =>
      os.post("network", "security-group-rules", {
        security_group_rule: {
          security_group_id: group.id,
          direction,
          ethertype: remoteKind === "cidr" && cidr.includes(":") ? "IPv6" : "IPv4",
          protocol: p.protocol,
          port_range_min: p.protocol && p.protocol !== "icmp" ? min : undefined,
          port_range_max: p.protocol && p.protocol !== "icmp" ? max : undefined,
          remote_ip_prefix: remoteKind === "cidr" ? cidr.trim() : undefined,
          remote_group_id: remoteKind === "group" ? remoteGroup : undefined,
          description: description || undefined,
        },
      }),
    onSuccess: () => {
      toast(tr("Rule added"));
      invalidate("network");
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={() => {
        m.reset();
        onClose();
      }}
      title={tr("Add rule to {name}", { name: group.name })}
      onSubmit={() => m.mutate()}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!portsOk || (remoteKind === "cidr" && !cidr.trim())}>
            {tr("Add rule")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Traffic")}>
          {(id) => (
            <Picker id={id} value={preset} onChange={setPreset} searchable options={Object.entries(PRESETS).map(([k, v]) => ({ value: k, label: v.label }))} />
          )}
        </Field>
        <Field label={tr("Direction")}>
          {(id) => (
            <Picker
              id={id}
              value={direction}
              onChange={(v) => setDirection(v as "ingress" | "egress")}
              options={[
                { value: "ingress", label: tr("Inbound"), icon: "arrow-down" },
                { value: "egress", label: tr("Outbound"), icon: "arrow-up" },
              ]}
            />
          )}
        </Field>
      </div>
      {custom && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("Port, or first port")}>{(id) => <Input id={id} type="number" min={1} max={65535} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="8080" />}</Field>
          <Field label={tr("Last port")} hint={tr("Leave empty for a single port.")}>
            {(id) => <Input id={id} type="number" min={1} max={65535} value={to} onChange={(e) => setTo(e.target.value)} />}
          </Field>
        </div>
      )}
      <Field label={direction === "ingress" ? tr("Allow from") : tr("Allow to")}>
        {(id) => (
          <Picker
            id={id}
            value={remoteKind}
            onChange={(v) => setRemoteKind(v as "cidr" | "group")}
            options={[
              { value: "cidr", label: tr("Addresses (CIDR)") },
              { value: "group", label: tr("Instances in a security group") },
            ]}
          />
        )}
      </Field>
      {remoteKind === "cidr" ? (
        <Field label="CIDR" hint={tr("0.0.0.0/0 means anywhere on IPv4; use ::/0 for IPv6.")}>
          {(id) => <Input id={id} value={cidr} onChange={(e) => setCidr(e.target.value)} className="font-mono text-[13px]" />}
        </Field>
      ) : (
        <Field label={tr("Security group")}>
          {(id) => (
            <Picker id={id} value={remoteGroup} onChange={setRemoteGroup} options={groups.map((x) => ({ value: x.id, label: x.name, description: x.description || undefined }))} />
          )}
        </Field>
      )}
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}
