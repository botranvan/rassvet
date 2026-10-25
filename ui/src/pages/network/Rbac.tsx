/**
 * Neutron RBAC: share a network, QoS policy, security group, subnet pool or address scope
 * with chosen projects (or, for admins, with every project / as an external network).
 */
import { useState } from "react";
import { Link } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { type PickOption, Picker } from "@/components/Picker";
import { Badge, Button, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Tabs } from "@/components/ui";
import { useProjects } from "@/lib/identity";
import { RBAC_OBJECTS, type RbacAction, type RbacObjectType, type RbacPolicy, useAddressScopes, useQosPolicies, useRbacPolicies, useSubnetPools } from "@/lib/neutron";
import { os, useInvalidate, useNetworks, useSecurityGroups } from "@/lib/os";
import { useSession } from "@/lib/session";
import { tr, trx } from "@/lib/i18n";

const ACTIONS: Record<RbacAction, string> = { access_as_shared: tr("Shared"), access_as_external: tr("External") };
const UUID = /^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i;

/** Names for RBAC objects, projects and owners. */
function useNames() {
  const session = useSession().data!;
  const projects = useProjects(session.is_admin);
  const networks = useNetworks();
  const qos = useQosPolicies();
  const sgs = useSecurityGroups();
  const pools = useSubnetPools();
  const scopes = useAddressScopes();
  const project = (id: string) =>
    id === "*" ? tr("All projects") : (projects.data?.find((p) => p.id === id)?.name ?? session.projects.find((p) => p.id === id)?.name ?? id);
  const object = (r: Pick<RbacPolicy, "object_type" | "object_id">) => {
    const lists: Partial<Record<RbacObjectType, { id: string; name: string }[] | undefined>> = {
      network: networks.data,
      qos_policy: qos.data,
      security_group: sgs.data,
      subnetpool: pools.data,
      address_scope: scopes.data,
    };
    const list = lists[r.object_type];
    return list?.find((x) => x.id === r.object_id)?.name || r.object_id;
  };
  /** Project cell: the name, or (when this user can't see the project) a shortened ID with the full one on hover. */
  const projectCell = (id: string) =>
    id === "*" ? (
      <Badge>{tr("all projects")}</Badge>
    ) : project(id) !== id ? (
      <span className="block truncate" title={id}>
        {project(id)}
      </span>
    ) : (
      <span className="block truncate font-mono text-[12.5px]" title={id}>
        {id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id}
      </span>
    );
  return { project, projectCell, object, projects, networks, qos, sgs, pools, scopes };
}

const OBJECT_PATHS: Partial<Record<RbacObjectType, (id: string) => string>> = {
  network: (id) => `/network/networks/${id}`,
  qos_policy: (id) => `/network/qos/${id}`,
  security_group: (id) => `/network/security-groups/${id}`,
  subnetpool: (id) => `/network/subnet-pools/${id}`,
  address_scope: () => "/network/subnet-pools?tab=scopes",
};
const objectPath = (r: Pick<RbacPolicy, "object_type" | "object_id">) => OBJECT_PATHS[r.object_type]?.(r.object_id) ?? null;
/** Object types the share dialog offers. */
const SHAREABLE: RbacObjectType[] = ["network", "qos_policy", "security_group", "subnetpool", "address_scope"];

export default function Rbac({ admin = false }: { admin?: boolean }) {
  const session = useSession().data!;
  const policies = useRbacPolicies();
  const N = useNames();
  const invalidate = useInvalidate();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<RbacPolicy | null>(null);
  const pid = session.project?.id;
  const rows = admin ? policies.data : policies.data?.filter((r) => r.project_id === pid || r.target_tenant === pid);
  const direction = (r: RbacPolicy) => (r.project_id === pid ? "outgoing" : "incoming");

  const columns: Column<RbacPolicy>[] = [
    {
      key: "object",
      header: tr("Object"),
      cell: (r) => {
        const path = objectPath(r);
        return (
          <span className="inline-flex max-w-full items-center gap-2">
            {path ? (
              <Link to={path} className="truncate font-medium text-cable hover:underline">
                {N.object(r)}
              </Link>
            ) : (
              <span className="truncate font-medium">{N.object(r)}</span>
            )}
            {!admin && direction(r) === "incoming" && <Badge tone="accent">{tr("shared with you")}</Badge>}
          </span>
        );
      },
      value: (r) => N.object(r),
    },
    { key: "type", header: tr("Type"), width: "9rem", hideBelow: "md", cell: (r) => RBAC_OBJECTS[r.object_type] ?? r.object_type, value: (r) => r.object_type },
    { key: "action", header: tr("Access"), width: "6.5rem", hideBelow: "sm", cell: (r) => (r.action === "access_as_external" ? <Badge tone="warn">{tr("external")}</Badge> : tr("Shared")), value: (r) => ACTIONS[r.action], wrap: true },
    { key: "target", header: tr("With project"), width: "11rem", cell: (r) => N.projectCell(r.target_tenant), value: (r) => N.project(r.target_tenant) },
    { key: "owner", header: tr("Owner"), width: "10rem", hideBelow: "lg", cell: (r) => N.projectCell(r.project_id), value: (r) => N.project(r.project_id) },
  ];

  return (
    <>
      <PageHeader
        title={admin ? tr("RBAC policies") : tr("Sharing (RBAC)")}
        description={tr("Role-based access control for Neutron objects: share a network, QoS policy, security group, subnet pool or address scope with chosen projects, without making it public. Admins can also share with every project or offer a network as external (for router gateways and floating IPs).")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Share an object")}
          </Button>
        }
      />
      <ErrorNotice error={policies.error} className="mb-4" />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={policies.isPending}
        tableId={admin ? "admin-rbac" : "rbac"}
        noun={tr("RBAC policies")}
        rowLabel={(r) => `${N.object(r)} → ${N.project(r.target_tenant)}`}
        empty={tr("Nothing is shared yet.")}
        onRefresh={() => policies.refetch()}
        refreshing={policies.isFetching}
        onBulkDone={() => invalidate("network")}
        rowActions={(r) => [
          { label: tr("Stop sharing"), icon: "x", danger: true, disabled: r.project_id !== pid && !session.is_admin ? tr("Shared by another project") : false, onSelect: () => setDeleting(r) },
        ]}
        bulkActions={[
          {
            id: "delete",
            label: tr("Stop sharing"),
            icon: "x",
            danger: true,
            title: tr("Stop sharing?"),
            past: tr("removed"),
            body: tr("Neutron refuses while the other project still uses the object (e.g. has ports on the network)."),
            check: (r) => (r.project_id === pid || session.is_admin ? true : tr("Shared by another project")),
            run: (r) => os.del("network", `rbac-policies/${r.id}`),
          },
        ]}
      />
      {creating && <ShareDialog onClose={() => setCreating(false)} />}
      {deleting && <StopSharingDialog policy={deleting} name={N.object(deleting)} target={N.project(deleting.target_tenant)} onClose={() => setDeleting(null)} />}
    </>
  );
}

export function StopSharingDialog({ policy, name, target, onClose }: { policy: RbacPolicy; name: string; target: string; onClose: () => void }) {
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Stop sharing {name}?", { name })}
      submitLabel={tr("Stop sharing")}
      done={tr("Sharing removed")}
      refresh={["network"]}
      run={() => os.del("network", `rbac-policies/${policy.id}`)}
    >
      <p className="text-sm">
        {trx("{target} loses access. Neutron refuses while {target} still uses it (for a network: ports, routers or floating IPs on it).", { target })}
      </p>
    </ActionDialog>
  );
}

/**
 * Create an RBAC policy. With `object`, the object is fixed (network detail's Sharing tab).
 */
export function ShareDialog({ onClose, object }: { onClose: () => void; object?: { type: RbacObjectType; id: string; name: string } }) {
  const session = useSession().data!;
  const N = useNames();
  const [type, setType] = useState<RbacObjectType>(object?.type ?? "network");
  const [objectId, setObjectId] = useState(object?.id ?? "");
  const [action, setAction] = useState<RbacAction>("access_as_shared");
  const [targetMode, setTargetMode] = useState<"project" | "all">("project");
  const [target, setTarget] = useState("");
  const [typed, setTyped] = useState("");
  const pid = session.project?.id;
  const own = (o: { project_id?: string }) => session.is_admin || o.project_id === pid;
  const allShared = tr("Already shared with all projects");
  const objectsByType: Record<string, () => PickOption[]> = {
    network: () => (N.networks.data ?? []).filter(own).map((n) => ({ value: n.id, label: n.name || n.id, icon: "network", description: n.shared ? allShared : undefined })),
    qos_policy: () => (N.qos.data ?? []).filter(own).map((q) => ({ value: q.id, label: q.name || q.id, icon: "gauge" })),
    security_group: () => (N.sgs.data ?? []).filter((g) => g.project_id === pid || session.is_admin).map((g) => ({ value: g.id, label: g.name, icon: "shield", description: g.description || undefined })),
    subnetpool: () =>
      (N.pools.data ?? []).filter(own).map((p) => ({ value: p.id, label: p.name || p.id, icon: "split", description: p.shared ? allShared : p.prefixes.join(", ") })),
    address_scope: () =>
      (N.scopes.data ?? []).filter(own).map((a) => ({ value: a.id, label: a.name || a.id, icon: "map-pin", description: a.shared ? allShared : tr("IPv{ip_version}", { ip_version: a.ip_version }) })),
  };
  const objects: PickOption[] = objectsByType[type]?.() ?? [];
  const projectOptions: PickOption[] = (session.is_admin ? (N.projects.data ?? []) : session.projects)
    .filter((p) => p.id !== pid)
    .map((p) => ({ value: p.id, label: p.name, icon: "folder", description: p.id }));
  const typedId = typed.trim();
  const targetId = targetMode === "all" ? "*" : target || (UUID.test(typedId) ? typedId : "");
  const typedOk = !typed.trim() || UUID.test(typed.trim());
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={object ? tr("Share {name}", { name: object.name }) : tr("Share an object")}
      description={tr("The other project sees the object in its lists and can use it (attach ports, apply the policy, reference the group). It can't change or delete it.")}
      submitLabel={tr("Share")}
      canSubmit={!!objectId && !!targetId && typedOk}
      done={tr("Shared")}
      refresh={["network"]}
      run={() => os.post("network", "rbac-policies", { rbac_policy: { object_type: type, object_id: objectId, action, target_tenant: targetId } })}
    >
      {!object && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("Object type")}>
            {(id) => (
              <Picker
                id={id}
                value={type}
                onChange={(t) => {
                  setType(t as RbacObjectType);
                  setObjectId("");
                  setAction("access_as_shared");
                }}
                options={SHAREABLE.map((t) => ({ value: t, label: RBAC_OBJECTS[t] }))}
              />
            )}
          </Field>
          <Field label={RBAC_OBJECTS[type]}>
            {(id) => <Picker id={id} value={objectId} onChange={setObjectId} searchable placeholder={tr("Choose…")} options={objects} emptyText={tr("Nothing of yours to share.")} />}
          </Field>
        </div>
      )}
      {type === "network" && session.is_admin && (
        <Field label={tr("Access")}>
          {(id) => (
            <Picker
              id={id}
              value={action}
              onChange={(a) => setAction(a as RbacAction)}
              options={[
                { value: "access_as_shared", label: tr("Shared"), description: tr("Attach instances and ports to the network") },
                { value: "access_as_external", label: tr("External"), description: tr("Use it for router gateways and floating IPs") },
              ]}
            />
          )}
        </Field>
      )}
      <Field label={tr("With")}>
        {(id) => (
          <div className="space-y-2">
            {session.is_admin && (
              <Tabs
                value={targetMode}
                onChange={setTargetMode}
                tabs={[
                  { id: "project", label: tr("A project") },
                  { id: "all", label: tr("All projects") },
                ]}
              />
            )}
            {targetMode === "project" ? (
              <>
                <Picker id={id} value={target} onChange={setTarget} clearable searchable placeholder={tr("Choose a project")} options={projectOptions} emptyText={tr("No other project you can see.")} />
                {!target && (
                  <Input
                    aria-label={tr("Project ID")}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={tr("…or paste the project ID")}
                    className="font-mono text-[13px]"
                  />
                )}
                {!typedOk && <p className="text-xs text-led-red">{tr("That isn't a project ID.")}</p>}
              </>
            ) : (
              <p className="text-sm text-muted">
                {trx("Same as marking it {v}: every project, including future ones, gets access.", { v: action === "access_as_external" ? tr("external") : tr("shared") })}
              </p>
            )}
          </div>
        )}
      </Field>
    </ActionDialog>
  );
}

/** Network detail tab: who the network is shared with. */
export function NetworkSharing({ network }: { network: { id: string; name: string; project_id: string } }) {
  return (
    <ObjectSharing
      type="network"
      object={network}
      notShared={tr("Not shared. Only this project can use the network.")}
      notYours={tr("Not your network")}
      idLabel={tr("Network ID")}
    />
  );
}

/** Detail-page tab of any RBAC-shareable object: who it is shared with, share / stop sharing. */
export function ObjectSharing({
  type,
  object: network,
  notShared,
  notYours,
  idLabel,
}: {
  type: RbacObjectType;
  object: { id: string; name: string; project_id: string };
  notShared: string;
  notYours: string;
  idLabel: string;
}) {
  const session = useSession().data!;
  const policies = useRbacPolicies({ object_id: network.id });
  const N = useNames();
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState<RbacPolicy | null>(null);
  const mine = session.is_admin || network.project_id === session.project?.id;
  const rows = policies.data?.filter((r) => r.object_id === network.id);
  const columns: Column<RbacPolicy>[] = [
    { key: "target", header: tr("Project"), cell: (r) => N.projectCell(r.target_tenant), value: (r) => N.project(r.target_tenant) },
    { key: "id", header: tr("Project ID"), mono: true, hideBelow: "md", cell: (r) => (r.target_tenant === "*" ? "*" : r.target_tenant), value: (r) => r.target_tenant },
    { key: "action", header: tr("Access"), width: "7rem", cell: (r) => ACTIONS[r.action], value: (r) => r.action },
  ];
  return (
    <>
      {mine && (
        <div className="mb-3">
          <Button onClick={() => setSharing(true)}>
            <Icon name="plus" />
            {tr("Share with a project")}
          </Button>
        </div>
      )}
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={policies.isPending}
        noun={tr("RBAC policies")}
        empty={mine ? notShared : tr("No sharing you can see.")}
        onRefresh={() => policies.refetch()}
        refreshing={policies.isFetching}
        rowActions={(r) => [{ label: tr("Stop sharing"), icon: "x", danger: true, disabled: mine ? false : notYours, onSelect: () => setDeleting(r) }]}
      />
      <p className="mt-3 text-xs text-muted">
        {idLabel} <Mono>{network.id}</Mono>
      </p>
      {sharing && <ShareDialog onClose={() => setSharing(false)} object={{ type, id: network.id, name: network.name || network.id }} />}
      {deleting && <StopSharingDialog policy={deleting} name={network.name || network.id} target={N.project(deleting.target_tenant)} onClose={() => setDeleting(null)} />}
    </>
  );
}
