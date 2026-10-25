/**
 * Trunks (VLAN-aware instances): one parent port carries several networks as VLANs.
 * The parent port is attached to the instance; each sub-port is a network on a VLAN ID.
 */
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { Link, useInAdmin, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { ActionMenu, type MenuEntry } from "@/components/Menu";
import { Picker } from "@/components/Picker";
import { Badge, Button, Card, Detail, ErrorNotice, Field, Icon, Input, Mono, PageHeader, StatusDot, Switch, Tabs, Textarea } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { type SubPort, type Trunk, useTrunks } from "@/lib/neutron";
import { type Port, networkStatus, os, portLabel, useInvalidate, useNetworks, useOsGet, usePorts, useServers } from "@/lib/os";
import { useTab } from "@/lib/useTab";
import { tr, trx } from "@/lib/i18n";

const tName = (t: Trunk) => t.name || `(${t.id.slice(0, 13)})`;
const ips = (p?: Port) => p?.fixed_ips.map((f) => f.ip_address).join(", ") ?? "";

function useLookups() {
  const ports = usePorts();
  const networks = useNetworks();
  const servers = useServers(useInAdmin() ? { all_tenants: 1 } : undefined);
  return useMemo(() => {
    const pm = new Map(ports.data?.map((p) => [p.id, p]));
    const nm = new Map(networks.data?.map((n) => [n.id, n]));
    const sm = new Map(servers.data?.map((s) => [s.id, s.name]));
    return {
      ports,
      networks,
      port: (id: string) => pm.get(id),
      netName: (id?: string) => (id ? (nm.get(id)?.name ?? id) : ""),
      network: (id?: string) => (id ? nm.get(id) : undefined),
      serverName: (id: string) => sm.get(id),
    };
  }, [ports, networks, servers.data]);
}

export default function Trunks() {
  const trunks = useTrunks();
  const L = useLookups();
  const invalidate = useInvalidate();
  const actions = useTrunkActions();
  const [creating, setCreating] = useState(false);

  const parentText = (t: Trunk) => {
    const p = L.port(t.port_id);
    return p ? `${portLabel(p)} · ${L.netName(p.network_id)}` : t.port_id;
  };
  const instance = (t: Trunk) => {
    const p = L.port(t.port_id);
    return p?.device_owner?.startsWith("compute:") ? (L.serverName(p.device_id) ?? p.device_id) : "";
  };
  const columns: Column<Trunk>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (t) => (
        <Link to={`/network/trunks/${t.id}`} className="font-medium text-cable hover:underline">
          {tName(t)}
        </Link>
      ),
      value: tName,
    },
    { key: "parent", header: tr("Parent port"), hideBelow: "md", cell: parentText, value: parentText },
    {
      key: "instance",
      header: tr("Instance"),
      hideBelow: "lg",
      cell: (t) => {
        const p = L.port(t.port_id);
        return p?.device_owner?.startsWith("compute:") ? (
          <Link to={`/compute/instances/${p.device_id}`} className="text-cable hover:underline" onClick={(e) => e.stopPropagation()}>
            {instance(t)}
          </Link>
        ) : (
          <span className="text-muted">{tr("Not attached")}</span>
        );
      },
      value: instance,
    },
    {
      key: "vlans",
      header: tr("VLANs"),
      width: "10rem",
      hideBelow: "sm",
      cell: (t) => (t.sub_ports.length ? t.sub_ports.map((s) => s.segmentation_id).sort((a, b) => a - b).join(", ") : <span className="text-muted">{tr("None")}</span>),
      value: (t) => t.sub_ports.map((s) => s.segmentation_id).join(", "),
    },
    { key: "status", header: tr("Status"), width: "7rem", cell: (t) => <StatusDot status={networkStatus(t.status)} label={t.status.toLowerCase()} />, value: (t) => t.status },
  ];

  return (
    <>
      <PageHeader
        title={tr("Trunks")}
        description={tr("Carry several networks to one instance interface as tagged VLANs (VLAN-aware instances, NFV appliances, nested containers). Create the trunk on a free port, then launch or attach the instance with that parent port.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Create trunk")}
          </Button>
        }
      />
      <ErrorNotice error={trunks.error} className="mb-4" />
      <DataTable
        rows={trunks.data}
        columns={columns}
        rowKey={(t) => t.id}
        loading={trunks.isPending}
        tableId="trunks"
        noun={tr("trunks")}
        rowLabel={tName}
        empty={tr("No trunks. Trunks need the Neutron trunk extension and an ML2 driver that supports it (Open vSwitch, OVN, Linux bridge).")}
        onRefresh={() => trunks.refetch()}
        refreshing={trunks.isFetching}
        onBulkDone={() => invalidate("network")}
        rowActions={(t) => actions.items(t)}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete trunks?"),
            past: tr("deleted"),
            body: tr("The parent and sub-ports are kept. Neutron refuses while the parent port is attached to an instance."),
            run: (t) => os.del("network", `trunks/${t.id}`),
          },
        ]}
      />
      {creating && <CreateTrunkDialog onClose={() => setCreating(false)} />}
      {actions.dialogs}
    </>
  );
}

// =========================================================================== actions

type Kind = "edit" | "add" | "delete";

export function useTrunkActions({ onDeleted }: { onDeleted?: () => void } = {}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ kind: Kind; t: Trunk } | null>(null);
  const close = () => setOpen(null);
  const items = (t: Trunk, where: "list" | "detail" = "list"): MenuEntry[] => [
    where === "list" && { label: tr("View details"), icon: "eye", onSelect: () => navigate(`/network/trunks/${t.id}`) },
    where === "list" && "-",
    { label: tr("Edit trunk"), icon: "edit", onSelect: () => setOpen({ kind: "edit", t }) },
    { label: tr("Add sub-ports"), icon: "plus", onSelect: () => setOpen({ kind: "add", t }) },
    "-",
    { label: tr("Delete trunk"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", t }) },
  ];
  const o = open;
  const dialogs = o && (
    <>
      {o.kind === "edit" && <EditTrunkDialog trunk={o.t} onClose={close} />}
      {o.kind === "add" && <AddSubportsDialog trunk={o.t} onClose={close} />}
      {o.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete trunk {tName}?", { tName: tName(o.t) })}
          submitLabel={tr("Delete trunk")}
          done={tr("Trunk deleted")}
          refresh={["network"]}
          onDone={onDeleted}
          run={() => os.del("network", `trunks/${o.t.id}`)}
        >
          <p className="text-sm">{tr("The parent port and the sub-ports stay, as ordinary ports. Detach the parent port from its instance first.")}</p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs, openDialog: (t: Trunk, kind: Kind) => setOpen({ kind, t }) };
}

/** Ports that can join a trunk: not attached to anything and not a trunk parent. */
const freePort = (p: Port) => !p.device_id && !p.device_owner && !p.trunk_details;

type NewSub = { mode: "existing" | "new"; port: string; network: string; type: "vlan" | "inherit"; vlan: string; sameMac: boolean };
const blankSub = (): NewSub => ({ mode: "new", port: "", network: "", type: "vlan", vlan: "", sameMac: true });

function SubportRows({ rows, set, parent, used }: { rows: NewSub[]; set: (rows: NewSub[]) => void; parent?: Port; used: Set<number> }) {
  const L = useLookups();
  const taken = new Set(rows.filter((r) => r.mode === "existing").map((r) => r.port));
  const patch = (i: number, p: Partial<NewSub>) => set(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="space-y-3">
      {rows.map((r, i) => {
        const vlan = Number(r.vlan);
        const clash = r.type === "vlan" && r.vlan && (used.has(vlan) || rows.some((x, j) => j !== i && x.type === "vlan" && Number(x.vlan) === vlan));
        return (
          <div key={i} className="rounded-md border border-line p-3 @container">
            <div className="mb-2 flex items-center gap-3">
              <Tabs
                value={r.mode}
                onChange={(mode) => patch(i, { mode, port: "", network: "" })}
                tabs={[
                  { id: "new", label: tr("New port on a network") },
                  { id: "existing", label: tr("Existing port") },
                ]}
              />
              <Button type="button" variant="ghost" className="ml-auto px-2.5" aria-label={tr("Remove sub-port")} onClick={() => set(rows.filter((_, j) => j !== i))}>
                <Icon name="x" />
              </Button>
            </div>
            <div className="grid gap-3 @lg:grid-cols-[minmax(0,1fr)_9rem_7rem]">
              {r.mode === "new" ? (
                <Picker
                  aria-label={tr("Network")}
                  value={r.network}
                  onChange={(network) => patch(i, { network })}
                  searchable
                  loading={L.networks.isPending}
                  placeholder={tr("Choose a network")}
                  options={(L.networks.data ?? [])
                    .filter((n) => !n["router:external"])
                    .map((n) => ({
                      value: n.id,
                      label: n.name || n.id,
                      icon: "network",
                      description: [n["provider:network_type"], n["provider:segmentation_id"] != null ? `seg ${n["provider:segmentation_id"]}` : ""].filter(Boolean).join(" · "),
                      disabled: n.id === parent?.network_id ? tr("The parent port's network") : false,
                    }))}
                />
              ) : (
                <Picker
                  aria-label={tr("Port")}
                  inlineDescription
                  value={r.port}
                  onChange={(port) => patch(i, { port })}
                  searchable
                  loading={L.ports.isPending}
                  placeholder={tr("Choose a free port")}
                  options={(L.ports.data ?? [])
                    .filter((p) => freePort(p) && p.id !== parent?.id)
                    .map((p) => ({
                      value: p.id,
                      label: portLabel(p),
                      description: `${L.netName(p.network_id)} · ${ips(p)}`,
                      disabled: taken.has(p.id) && p.id !== r.port ? tr("Already chosen") : false,
                    }))}
                />
              )}
              <Picker
                aria-label={tr("Segmentation type")}
                value={r.type}
                onChange={(type) => patch(i, { type: type as NewSub["type"] })}
                options={[
                  { value: "vlan", label: "VLAN" },
                  { value: "inherit", label: tr("Inherit"), description: tr("Use the network's own segmentation ID") },
                ]}
              />
              <Input aria-label={tr("VLAN ID")} type="number" min={1} max={4094} placeholder={tr("VLAN ID")} disabled={r.type === "inherit"} value={r.type === "inherit" ? "" : r.vlan} onChange={(e) => patch(i, { vlan: e.target.value })} className={clash ? "border-led-red" : undefined} />
            </div>
            {r.mode === "new" && (
              <div className="mt-2">
                <Switch checked={r.sameMac} onChange={(sameMac) => patch(i, { sameMac })} label={tr("Use the parent port's MAC address")} hint={tr("Most guests create VLAN interfaces with the parent's MAC; Neutron's anti-spoofing then matches.")} />
              </div>
            )}
            {clash && <p className="mt-1 text-xs text-led-red">{trx("VLAN {vlan} is already used on this trunk.", { vlan })}</p>}
          </div>
        );
      })}
      <Button type="button" onClick={() => set([...rows, blankSub()])}>
        <Icon name="plus" />
        {tr("Add sub-port")}
      </Button>
    </div>
  );
}

const rowReady = (r: NewSub) => (r.mode === "new" ? !!r.network : !!r.port) && (r.type === "inherit" || (Number(r.vlan) >= 1 && Number(r.vlan) <= 4094));

/** Turn the form rows into sub-ports, creating new ports where asked. */
async function materialize(rows: NewSub[], parent: Port | undefined, created: string[]): Promise<SubPort[]> {
  const out: SubPort[] = [];
  for (const r of rows) {
    let portId = r.port;
    if (r.mode === "new") {
      const p = await os.post<{ port: Port }>("network", "ports", {
        port: {
          network_id: r.network,
          name: `${parent ? portLabel(parent) : "trunk"}-vlan${r.type === "vlan" ? r.vlan : ""}`.replace(/[()]/g, ""),
          ...(r.sameMac && parent ? { mac_address: parent.mac_address } : {}),
        },
      });
      portId = p.port.id;
      created.push(portId);
    }
    out.push(r.type === "inherit" ? ({ port_id: portId, segmentation_type: "inherit" } as SubPort) : { port_id: portId, segmentation_type: "vlan", segmentation_id: Number(r.vlan) });
  }
  return out;
}

function CreateTrunkDialog({ onClose }: { onClose: () => void }) {
  const L = useLookups();
  const navigate = useNavigate();
  const [parentMode, setParentMode] = useState<"new" | "existing">("new");
  const [parentId, setParentId] = useState("");
  const [parentNet, setParentNet] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rows, setRows] = useState<NewSub[]>([blankSub()]);
  const existingParent = L.port(parentId);
  const create = async () => {
    const created: string[] = [];
    try {
      let parent = existingParent;
      if (parentMode === "new") {
        parent = (await os.post<{ port: Port }>("network", "ports", { port: { network_id: parentNet, name: `${name.trim() || "trunk"}-parent` } })).port;
        created.push(parent.id);
      }
      const sub_ports = await materialize(rows, parent, created);
      return (await os.post<{ trunk: Trunk }>("network", "trunks", { trunk: { name: name.trim(), description: description || undefined, port_id: parent!.id, sub_ports } })).trunk;
    } catch (e) {
      // Don't leave half-made ports behind.
      await Promise.allSettled(created.map((id) => os.del("network", `ports/${id}`)));
      throw e;
    }
  };
  const ready = (parentMode === "new" ? !!parentNet : !!parentId) && rows.every(rowReady);
  return (
    <ActionDialog<Trunk>
      onClose={onClose}
      size="lg"
      title={tr("Create trunk")}
      description={tr("The parent port carries untagged traffic on its own network; every sub-port adds a network as a VLAN.")}
      submitLabel={tr("Create trunk")}
      canSubmit={ready}
      done={(t) => tr("Trunk {tName} created", { tName: tName(t) })}
      refresh={["network"]}
      onDone={(t) => navigate(`/network/trunks/${t.id}`)}
      run={create}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("nfv-trunk")} />}</Field>
        <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      </div>
      <Field label={tr("Parent port")} hint={tr("Attach this port to the instance afterwards (launch with it as an existing port, or attach interface). Open vSwitch can't turn a port already in use into a trunk.")}>
        {(id) => (
          <div className="space-y-2">
            <Tabs
              value={parentMode}
              onChange={setParentMode}
              tabs={[
                { id: "new", label: tr("New port on a network") },
                { id: "existing", label: tr("Existing free port") },
              ]}
            />
            {parentMode === "new" ? (
              <Picker
                id={id}
                value={parentNet}
                onChange={setParentNet}
                searchable
                placeholder={tr("Network of the untagged traffic")}
                options={(L.networks.data ?? []).filter((n) => !n["router:external"]).map((n) => ({ value: n.id, label: n.name || n.id, icon: "network" }))}
              />
            ) : (
              <Picker
                id={id}
                inlineDescription
                value={parentId}
                onChange={setParentId}
                searchable
                loading={L.ports.isPending}
                placeholder={tr("Choose a port")}
                options={(L.ports.data ?? [])
                  .filter((p) => !p.trunk_details && p.device_owner !== "trunk:subport" && !p.device_owner?.startsWith("network:"))
                  .map((p) => ({
                    value: p.id,
                    label: portLabel(p),
                    description: `${L.netName(p.network_id)} · ${ips(p)}`,
                    disabled: p.device_id ? tr("In use by {v}", { v: L.serverName(p.device_id) ?? tr("a device") }) : false,
                  }))}
              />
            )}
          </div>
        )}
      </Field>
      <Field label={tr("Sub-ports")}>{() => <SubportRows rows={rows} set={setRows} parent={existingParent} used={new Set()} />}</Field>
    </ActionDialog>
  );
}

function AddSubportsDialog({ trunk, onClose }: { trunk: Trunk; onClose: () => void }) {
  const L = useLookups();
  const [rows, setRows] = useState<NewSub[]>([blankSub()]);
  const parent = L.port(trunk.port_id);
  const used = new Set(trunk.sub_ports.map((s) => s.segmentation_id));
  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={tr("Add sub-ports to {tName}", { tName: tName(trunk) })}
      description={tr("Running instances see new VLANs at once; configure the matching VLAN interfaces in the guest.")}
      submitLabel={tr("Add {length} sub-port{s}", { length: rows.length, s: rows.length === 1 ? "" : "s" })}
      canSubmit={rows.length > 0 && rows.every(rowReady)}
      done={tr("Sub-ports added")}
      refresh={["network"]}
      run={async () => {
        const created: string[] = [];
        try {
          const sub_ports = await materialize(rows, parent, created);
          return await os.put("network", `trunks/${trunk.id}/add_subports`, { sub_ports });
        } catch (e) {
          await Promise.allSettled(created.map((id) => os.del("network", `ports/${id}`)));
          throw e;
        }
      }}
    >
      <SubportRows rows={rows} set={setRows} parent={parent} used={used} />
    </ActionDialog>
  );
}

function EditTrunkDialog({ trunk, onClose }: { trunk: Trunk; onClose: () => void }) {
  const [name, setName] = useState(trunk.name);
  const [description, setDescription] = useState(trunk.description ?? "");
  const [up, setUp] = useState(trunk.admin_state_up);
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit {tName}", { tName: tName(trunk) })}
      submitLabel={tr("Save")}
      done={tr("Trunk updated")}
      refresh={["network"]}
      run={() => os.put("network", `trunks/${trunk.id}`, { trunk: { name: name.trim(), description, admin_state_up: up } })}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Switch checked={up} onChange={setUp} label={tr("Admin state up")} hint={tr("A trunk that is down can't have sub-ports added or removed.")} />
    </ActionDialog>
  );
}

// =========================================================================== detail

const TABS = ["overview", "subports"] as const;

type SubRow = SubPort & { port?: Port };

export function TrunkDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const trunk = useOsGet<Trunk>("network", `trunks/${id}`, (r: { trunk: Trunk }) => r.trunk);
  const L = useLookups();
  const invalidate = useInvalidate();
  const actions = useTrunkActions({ onDeleted: () => navigate("/network/trunks") });
  const [tab, setTab] = useTab(TABS, "overview");
  const t = trunk.data;
  const parent = t && L.port(t.port_id);
  const rows: SubRow[] = (t?.sub_ports ?? []).map((s) => ({ ...s, port: L.port(s.port_id) })).sort((a, b) => a.segmentation_id - b.segmentation_id);
  const cols: Column<SubRow>[] = [
    { key: "vlan", header: "VLAN", width: "5.5rem", className: "text-right", cell: (s) => <span className="tabular-nums">{s.segmentation_id}</span>, value: (s) => s.segmentation_id },
    { key: "network", header: tr("Network"), cell: (s) => (s.port ? <Link to={`/network/networks/${s.port.network_id}`} className="text-cable hover:underline">{L.netName(s.port.network_id)}</Link> : "—"), value: (s) => L.netName(s.port?.network_id) },
    { key: "port", header: tr("Port"), hideBelow: "md", cell: (s) => (s.port ? portLabel(s.port) : <Mono>{s.port_id}</Mono>), value: (s) => (s.port ? portLabel(s.port) : s.port_id) },
    { key: "ip", header: "IP", width: "9rem", mono: true, hideBelow: "sm", cell: (s) => ips(s.port), value: (s) => ips(s.port) },
    { key: "mac", header: "MAC", width: "10rem", mono: true, hideBelow: "lg", cell: (s) => s.port?.mac_address ?? s.mac_address ?? "", value: (s) => s.port?.mac_address ?? "" },
    { key: "type", header: tr("Type"), width: "5rem", hideBelow: "xl", cell: (s) => s.segmentation_type, value: (s) => s.segmentation_type },
  ];
  return (
    <>
      <Link to="/network/trunks" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Trunks")}
      </Link>
      <PageHeader
        title={t ? tName(t) : tr("Trunk")}
        description={t ? t.description || tr("{length} VLAN{s} on {v}", { length: t.sub_ports.length, s: t.sub_ports.length === 1 ? "" : "s", v: parent ? portLabel(parent) : tr("its parent port") }) : undefined}
        actions={t && <ActionMenu variant="button" items={() => actions.items(t, "detail")} />}
      />
      <ErrorNotice error={trunk.error} className="mb-4" />
      {t && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "subports", label: tr("Sub-ports ({length})", { length: t.sub_ports.length }) },
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <Card title={tr("Details")}>
                <dl>
                  <Detail label={tr("Name")}>{t.name || "—"}</Detail>
                  <Detail label="ID">
                    <Mono>{t.id}</Mono>
                  </Detail>
                  <Detail label={tr("Status")}>
                    <StatusDot status={networkStatus(t.status)} label={t.status.toLowerCase()} />
                  </Detail>
                  <Detail label={tr("Admin state")}>{t.admin_state_up ? tr("Up") : tr("Down")}</Detail>
                  {t.created_at && <Detail label={tr("Created")}>{fmtDate(t.created_at)}</Detail>}
                </dl>
              </Card>
              <Card title={tr("Parent port")}>
                <dl>
                  <Detail label={tr("Port")}>{parent ? portLabel(parent) : <Mono>{t.port_id}</Mono>}</Detail>
                  <Detail label={tr("Network")}>
                    {parent ? (
                      <Link to={`/network/networks/${parent.network_id}`} className="text-cable hover:underline">
                        {L.netName(parent.network_id)}
                      </Link>
                    ) : (
                      "—"
                    )}{" "}
                    <Badge>{tr("untagged")}</Badge>
                  </Detail>
                  <Detail label="IP">{ips(parent) || "—"}</Detail>
                  <Detail label="MAC">{parent ? <Mono>{parent.mac_address}</Mono> : "—"}</Detail>
                  <Detail label={tr("Instance")}>
                    {parent?.device_owner?.startsWith("compute:") ? (
                      <Link to={`/compute/instances/${parent.device_id}`} className="text-cable hover:underline">
                        {L.serverName(parent.device_id) ?? parent.device_id}
                      </Link>
                    ) : (
                      <span className="text-muted">{tr("Not attached yet")}</span>
                    )}
                  </Detail>
                </dl>
              </Card>
            </div>
          )}
          {tab === "subports" && (
            <>
              <div className="mb-3">
                <Button onClick={() => actions.openDialog(t, "add")}>
                  <Icon name="plus" />
                  {tr("Add sub-ports")}
                </Button>
              </div>
              <DataTable
                rows={rows}
                columns={cols}
                rowKey={(s) => s.port_id}
                loading={L.ports.isPending}
                tableId="trunk-subports"
                noun={tr("sub-ports")}
                rowLabel={(s) => `VLAN ${s.segmentation_id}`}
                empty={tr("No sub-ports; the trunk only carries the parent port's network.")}
                onRefresh={() => trunk.refetch()}
                refreshing={trunk.isFetching}
                onBulkDone={() => invalidate("network")}
                bulkActions={[
                  {
                    id: "remove",
                    label: tr("Remove"),
                    icon: "x",
                    danger: true,
                    title: tr("Remove sub-ports?"),
                    past: tr("removed"),
                    body: tr("The ports leave the trunk and are kept as ordinary ports. Delete them from the network's Ports tab if no longer needed."),
                    run: (s) => os.put("network", `trunks/${t.id}/remove_subports`, { sub_ports: [{ port_id: s.port_id }] }),
                  },
                ]}
              />
            </>
          )}
        </>
      )}
      {actions.dialogs}
    </>
  );
}
