/**
 * Admin: Neutron NDP proxies (l3-ndp-proxy). An NDP proxy makes a router answer neighbour
 * discovery for an internal IPv6 address on its external network, so that address is
 * reachable from outside without NAT (IPv6 has no floating IPs).
 */
import { useMemo, useState } from "react";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Link } from "@/components/Link";
import { Picker } from "@/components/Picker";
import { Badge, Button, Card, ErrorNotice, Field, Icon, Input, Mono, PageHeader, Switch } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import { type NdpProxy, useNdpProxies, useNeutronExtensions } from "@/lib/neutron";
import { type Port, type Router, os, useNetworks, usePorts, useRouters, useSubnets } from "@/lib/os";
import { useServerNames } from "../../storage/volumeActions";
import { tr, trx } from "@/lib/i18n";

const isV6 = (ip: string) => ip.includes(":");

export default function NdpProxies() {
  const ext = useNeutronExtensions();
  const enabled = !!ext.data?.has("l3-ndp-proxy");
  const proxies = useNdpProxies(undefined, enabled);
  const routers = useRouters();
  const ports = usePorts(undefined, enabled);
  const projects = useProjects(true);
  const serverName = useServerNames();
  const [open, setOpen] = useState<{ kind: "create" } | { kind: "edit" | "delete"; p: NdpProxy } | null>(null);
  const close = () => setOpen(null);

  const routerName = (id: string) => routers.data?.find((r) => r.id === id)?.name || id.slice(0, 8);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;
  const portOf = useMemo(() => {
    const m = new Map((ports.data ?? []).map((p) => [p.id, p]));
    return (id: string) => m.get(id);
  }, [ports.data]);
  const target = (p: NdpProxy) => {
    const port = portOf(p.port_id);
    if (port?.device_owner.startsWith("compute:")) return { server: port.device_id, label: serverName(port.device_id) };
    return { server: null, label: port?.name || tr("port {port_id}", { port_id: p.port_id.slice(0, 8) }) };
  };

  if (ext.data && !enabled) {
    return (
      <>
        <PageHeader title={tr("NDP proxies")} />
        <Card>
          <p className="text-sm">
            {tr("This Neutron doesn't have the")}{" "}<Mono>{tr("l3-ndp-proxy")}</Mono>{" "}{tr("extension. Enable the")}{" "}<Mono>ndp_proxy</Mono>{" "}{tr("service plugin (neutron.conf")}{" "}<Mono>service_plugins</Mono>{tr(") and the")}
            <Mono>ndp_proxy</Mono>{" "}{tr("L3 agent extension to publish internal IPv6 addresses through routers.")}
          </p>
        </Card>
      </>
    );
  }

  const columns: Column<NdpProxy>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium" title={p.description || undefined}>
            {p.name || <span className="font-mono text-[12.5px] font-normal text-muted">{p.id}</span>}
          </span>
          <span className="truncate font-mono text-[12px] text-muted">{p.ip_address}</span>
        </span>
      ),
      value: (p) => `${p.name} ${p.ip_address}`,
      csv: (p) => p.name,
    },
    { key: "ip", header: tr("IPv6 address"), width: "16rem", hideBelow: "2xl", mono: true, cell: (p) => p.ip_address, value: (p) => p.ip_address },
    {
      key: "target",
      header: tr("Points to"),
      width: "12rem",
      hideBelow: "md",
      cell: (p) => {
        const t = target(p);
        return t.server ? (
          <Link to={`/compute/instances/${t.server}`} className="truncate text-cable hover:underline">
            {t.label}
          </Link>
        ) : (
          <span className="truncate">{t.label}</span>
        );
      },
      value: (p) => target(p).label,
    },
    {
      key: "router",
      header: tr("Router"),
      width: "10rem",
      hideBelow: "lg",
      cell: (p) => (
        <Link to={`/network/routers/${p.router_id}`} className="truncate text-cable hover:underline">
          {routerName(p.router_id)}
        </Link>
      ),
      value: (p) => routerName(p.router_id),
    },
    { key: "project", header: tr("Project"), width: "9rem", hideBelow: "lg", cell: (p) => projectName(p.project_id), value: (p) => projectName(p.project_id) },
    { key: "created", header: tr("Created"), width: "8.5rem", hideBelow: "xl", cell: (p) => fmtDate(p.created_at, false), value: (p) => p.created_at ?? "" },
  ];

  return (
    <>
      <PageHeader
        title={tr("NDP proxies")}
        description={tr("Publish an internal IPv6 address (an instance's port) on a router's external network, so it's reachable from outside without NAT. The router needs an external gateway with an IPv6 subnet in the same address scope as the internal subnet, and NDP proxy enabled.")}
        actions={
          <Button variant="primary" onClick={() => setOpen({ kind: "create" })} disabled={!enabled}>
            <Icon name="plus" />
            {tr("Create NDP proxy")}
          </Button>
        }
      />
      <ErrorNotice error={proxies.error ?? ext.error} className="mb-4" />
      <DataTable
        rows={proxies.data}
        columns={columns}
        rowKey={(p) => p.id}
        loading={proxies.isPending || ext.isPending}
        tableId="admin-ndp-proxies"
        noun={tr("NDP proxies")}
        rowLabel={(p) => p.name || p.ip_address}
        filterPlaceholder={tr("Filter by name, address, instance, router or project")}
        empty={tr("No NDP proxies.")}
        onRefresh={() => proxies.refetch()}
        refreshing={proxies.isFetching}
        rowActions={(p) => [
          { label: tr("Edit"), icon: "edit", onSelect: () => setOpen({ kind: "edit", p }) },
          "-",
          { label: tr("Delete"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", p }) },
        ]}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete NDP proxies?"),
            past: tr("deleted"),
            body: tr("The addresses stop being reachable from the external network."),
            run: (p) => os.del("network", `ndp-proxies/${p.id}`),
          },
        ]}
      />
      {open?.kind === "create" && <CreateDialog routers={routers.data ?? []} onClose={close} />}
      {open?.kind === "edit" && <EditDialog p={open.p} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete NDP proxy {v}?", { v: open.p.name || open.p.ip_address })}
          submitLabel={tr("Delete")}
          done={tr("NDP proxy deleted")}
          refresh={["network"]}
          run={() => os.del("network", `ndp-proxies/${open.p.id}`)}
        >
          <p className="text-sm">
            <Mono>{open.p.ip_address}</Mono>{" "}{trx("stops being reachable from {routerName}'s external network.", { routerName: routerName(open.p.router_id) })}
          </p>
        </ActionDialog>
      )}
    </>
  );
}

function CreateDialog({ routers, onClose }: { routers: Router[]; onClose: () => void }) {
  const [routerId, setRouterId] = useState("");
  const [portId, setPortId] = useState("");
  const [ip, setIp] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enableOnRouter, setEnableOnRouter] = useState(true);
  const router = routers.find((r) => r.id === routerId);
  const ifaces = usePorts(routerId ? { device_id: routerId } : undefined, !!routerId);
  const allPorts = usePorts(undefined, !!routerId);
  const nets = useNetworks();
  const subnets = useSubnets();
  const serverName = useServerNames();
  const netName = (id: string) => nets.data?.find((n) => n.id === id)?.name ?? id.slice(0, 8);

  // Ports with an IPv6 address on the networks behind the router (its internal interfaces).
  const candidates = useMemo(() => {
    const internal = new Set((ifaces.data ?? []).filter((p) => p.device_owner !== "network:router_gateway").map((p) => p.network_id));
    return (allPorts.data ?? []).filter((p) => internal.has(p.network_id) && !p.device_owner.startsWith("network:") && p.fixed_ips.some((f) => isV6(f.ip_address)));
  }, [ifaces.data, allPorts.data]);
  const port: Port | undefined = candidates.find((p) => p.id === portId);
  const v6 = port?.fixed_ips.filter((f) => isV6(f.ip_address)) ?? [];
  const address = ip || v6[0]?.ip_address || "";
  const gw6 = (router?.external_gateway_info?.external_fixed_ips ?? []).some((f) => isV6(f.ip_address));
  const needsEnable = !!router && router.enable_ndp_proxy === false;
  const portLabel = (p: Port) => (p.device_owner.startsWith("compute:") ? serverName(p.device_id) : p.name || p.id.slice(0, 8));

  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Create NDP proxy")}
      description={tr("The router will answer neighbour discovery for the address on its external network.")}
      submitLabel={tr("Create")}
      canSubmit={!!router && !!port && !!address && (!needsEnable || enableOnRouter)}
      done={tr("NDP proxy for {address} created", { address })}
      refresh={["network"]}
      run={async () => {
        if (needsEnable) await os.put("network", `routers/${router!.id}`, { router: { enable_ndp_proxy: true } });
        return os.post("network", "ndp-proxies", {
          ndp_proxy: {
            router_id: router!.id,
            port_id: port!.id,
            ip_address: address,
            ...(name.trim() ? { name: name.trim() } : {}),
            ...(description.trim() ? { description: description.trim() } : {}),
          },
        });
      }}
    >
      <Field label={tr("Router")}>
        {(id) => (
          <Picker
            id={id}
            value={routerId}
            onChange={(v) => {
              setRouterId(v);
              setPortId("");
              setIp("");
            }}
            searchable
            placeholder={tr("Choose a router…")}
            options={routers.map((r) => ({
              value: r.id,
              label: r.name || r.id,
              icon: "router",
              description: r.external_gateway_info ? tr("gateway on {netName}", { netName: netName(r.external_gateway_info.network_id) }) : tr("no external gateway"),
              meta: r.enable_ndp_proxy ? tr("NDP proxy on") : undefined,
              disabled: r.external_gateway_info ? false : tr("Needs an external gateway"),
            }))}
          />
        )}
      </Field>
      {router && !gw6 && (
        <p className="text-sm text-led-amber">{tr("This router's gateway has no IPv6 address: Neutron refuses NDP proxies until the external network has an IPv6 subnet on it.")}</p>
      )}
      {needsEnable && (
        <Switch
          checked={enableOnRouter}
          onChange={setEnableOnRouter}
          label={tr("Enable NDP proxy on this router")}
          hint={tr("Sets enable_ndp_proxy on {v} first (required).", { v: router!.name || tr("the router") })}
        />
      )}
      <Field label={tr("Port")} hint={router && !ifaces.isPending && !allPorts.isPending && candidates.length === 0 ? tr("No port with an IPv6 address on the router's internal networks.") : undefined}>
        {(id) => (
          <Picker
            id={id}
            inlineDescription
            value={portId}
            onChange={(v) => {
              setPortId(v);
              setIp("");
            }}
            disabled={!router}
            searchable
            loading={!!router && (ifaces.isPending || allPorts.isPending)}
            placeholder={router ? tr("Choose an instance port…") : tr("Choose a router first")}
            options={candidates.map((p) => ({
              value: p.id,
              label: portLabel(p),
              icon: p.device_owner.startsWith("compute:") ? "server" : "plug",
              description: `${netName(p.network_id)} · ${p.fixed_ips.filter((f) => isV6(f.ip_address)).map((f) => f.ip_address).join(", ")}`,
            }))}
          />
        )}
      </Field>
      {v6.length > 1 && (
        <Field label={tr("IPv6 address")}>
          {(id) => (
            <Picker
              id={id}
              value={address}
              onChange={setIp}
              options={v6.map((f) => ({ value: f.ip_address, label: f.ip_address, description: subnets.data?.find((s) => s.id === f.subnet_id)?.cidr }))}
            />
          )}
        </Field>
      )}
      {v6.length === 1 && (
        <p className="text-sm">
          {tr("Address:")}{" "}<Mono>{address}</Mono>
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Name")}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("web-01-v6")} />}</Field>
        <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      </div>
    </ActionDialog>
  );
}

function EditDialog({ p, onClose }: { p: NdpProxy; onClose: () => void }) {
  const [name, setName] = useState(p.name ?? "");
  const [description, setDescription] = useState(p.description ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit NDP proxy {v}", { v: p.name || p.ip_address })}
      description={tr("Only the name and description can change; delete and recreate it to point at another address.")}
      submitLabel={tr("Save")}
      done={tr("NDP proxy updated")}
      refresh={["network"]}
      run={() => os.put("network", `ndp-proxies/${p.id}`, { ndp_proxy: { name: name.trim(), description } })}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <p className="text-sm text-muted">
        <Badge>{p.ip_address}</Badge>
      </p>
    </ActionDialog>
  );
}
