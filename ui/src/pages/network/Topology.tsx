/**
 * Network topology, three ways: a force-directed graph with translucent network hulls,
 * a bus diagram (networks as vertical bars, devices as rows with a line and IP per port)
 * and a 3D view; plus a port map table. Built from Neutron ports (device_id/device_owner),
 * router gateways, trunks and floating IPs. Pan, zoom, full screen, export.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@/components/Link";
import { downloadText } from "@/components/CodeBlock";
import { type Column, DataTable } from "@/components/DataTable";
import { Badge, Button, Card, Checkbox, Detail, ErrorNotice, Icon, Mono, PageHeader, StatusDot, Switch, Tabs } from "@/components/ui";
import { useTrunks } from "@/lib/neutron";
import {
  type Network,
  type Port,
  type Router,
  type Server,
  type Subnet,
  networkStatus,
  portLabel,
  serverStatus,
  useFloatingIps,
  useNetworks,
  usePorts,
  useRouters,
  useServers,
  useSubnets,
} from "@/lib/os";
import { useSession } from "@/lib/session";
import { useTab } from "@/lib/useTab";
import { useScrollZoom } from "@/lib/useScrollZoom";
import { cn } from "@/lib/utils";
import type { Graph3DHandle } from "./Topology3D";
import { type GraphHandle, TopologyGraph } from "./TopologyGraph";
import { tr, trx } from "@/lib/i18n";

const Topology3D = lazy(() => import("./Topology3D"));

export type Kind = "router" | "instance" | "lb" | "dhcp" | "port" | "other";

export interface Wire {
  network: string;
  ips: string[];
  port?: Port;
  /** "gateway", "vlan 120", "interface"… */
  tag?: string;
}

export interface Device {
  id: string;
  kind: Kind;
  name: string;
  sub: string;
  status: "ok" | "warn" | "error" | "off";
  href?: string;
  wires: Wire[];
  fips: string[];
}

const KIND_ORDER: Record<Kind, number> = { router: 0, lb: 1, instance: 2, other: 3, dhcp: 4, port: 5 };
const KIND_ICON: Record<Kind, string> = { router: "router", instance: "server", lb: "split", dhcp: "settings", port: "cable", other: "boxes" };
const KIND_LABEL: Record<Kind, string> = { router: tr("Router"), instance: tr("Instance"), lb: tr("Load balancer"), dhcp: "DHCP", port: tr("Free port"), other: tr("Device") };

/** Categorical colours for network bars (external networks are always slate). */
const PALETTE = ["#0f8b8d", "#3b82f6", "#8b5cf6", "#db2777", "#ea7a1a", "#16a34a", "#0891b2", "#a16207", "#6366f1", "#be123c"];
const EXTERNAL = "#64748b";

const ips = (p: Port) => p.fixed_ips.map((f) => f.ip_address);
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function build(opts: {
  networks: Network[];
  subnets: Subnet[];
  ports: Port[];
  routers: Router[];
  servers: Server[];
  fips: { port_id: string | null; floating_ip_address: string }[];
  trunks: { id: string; port_id: string; name: string }[];
  dhcp: boolean;
  free: boolean;
  empty: boolean;
  inScope: (o: { project_id?: string }) => boolean;
}) {
  const { networks, ports, routers, servers, inScope } = opts;
  const netById = new Map(networks.map((n) => [n.id, n]));
  const serverById = new Map(servers.map((s) => [s.id, s]));
  const fipByPort = new Map<string, string[]>();
  for (const f of opts.fips) if (f.port_id) fipByPort.set(f.port_id, [...(fipByPort.get(f.port_id) ?? []), f.floating_ip_address]);
  const trunkParent = new Map(opts.trunks.map((t) => [t.id, t.port_id]));
  const portById = new Map(ports.map((p) => [p.id, p]));
  const devices = new Map<string, Device>();
  const dev = (id: string, init: () => Omit<Device, "wires" | "fips">) => {
    let d = devices.get(id);
    if (!d) {
      d = { ...init(), wires: [], fips: [] };
      devices.set(id, d);
    }
    return d;
  };
  const wire = (d: Device, p: Port, tag?: string) => {
    if (!netById.has(p.network_id)) return;
    d.wires.push({ network: p.network_id, ips: ips(p), port: p, tag });
    d.fips.push(...(fipByPort.get(p.id) ?? []));
  };

  for (const r of routers.filter(inScope)) {
    dev(r.id, () => ({
      id: r.id,
      kind: "router",
      name: r.name || r.id.slice(0, 8),
      sub: r.external_gateway_info ? tr("Router · SNAT") : tr("Router"),
      status: r.admin_state_up ? networkStatus(r.status) : "off",
      href: `/network/routers/${r.id}`,
    }));
  }
  for (const p of ports) {
    const o = p.device_owner ?? "";
    if (o.startsWith("network:router") || o === "network:ha_router_replicated_interface") {
      const r = devices.get(p.device_id);
      if (r) wire(r, p, o === "network:router_gateway" ? "gateway" : undefined);
    } else if (o.startsWith("compute:")) {
      const s = serverById.get(p.device_id);
      if (!s && !inScope(p)) continue;
      const d = dev(p.device_id, () => ({
        id: p.device_id,
        kind: "instance",
        name: s?.name ?? p.device_id.slice(0, 8),
        sub: s ? `${s.flavor.original_name ?? tr("instance")} · ${s.status.toLowerCase()}` : tr("Instance"),
        status: s ? serverStatus(s) : "off",
        href: `/compute/instances/${p.device_id}`,
      }));
      wire(d, p, p.trunk_details ? "trunk" : undefined);
    } else if (o === "trunk:subport") {
      const parent = portById.get(trunkParent.get(p.device_id) ?? "");
      const owner = parent?.device_owner?.startsWith("compute:") ? devices.get(parent.device_id) : undefined;
      const seg = parent?.trunk_details?.sub_ports.find((s) => s.port_id === p.id)?.segmentation_id;
      if (owner) wire(owner, p, seg != null ? `vlan ${seg}` : "subport");
      else if (inScope(p) && opts.free) {
        const d = dev(p.id, () => ({ id: p.id, kind: "port", name: portLabel(p), sub: tr("Trunk sub-port"), status: "off" }));
        wire(d, p, seg != null ? `vlan ${seg}` : undefined);
      }
    } else if (o === "network:dhcp") {
      if (!opts.dhcp || !inScope(netById.get(p.network_id) ?? p)) continue;
      const d = dev(`dhcp:${p.network_id}:${p.device_id}`, () => ({ id: p.device_id, kind: "dhcp", name: "DHCP", sub: p.device_id.split("-")[0].slice(0, 16), status: networkStatus(p.status) }));
      wire(d, p);
    } else if (/octavia|loadbalancer|LOADBALANCER/i.test(o)) {
      if (!inScope(p)) continue;
      const d = dev(p.device_id || p.id, () => ({ id: p.device_id || p.id, kind: "lb", name: p.name || "Load balancer", sub: o, status: networkStatus(p.status) }));
      wire(d, p, "vip");
    } else if (!p.device_id) {
      if (!opts.free || !inScope(p)) continue;
      const d = dev(p.id, () => ({ id: p.id, kind: "port", name: portLabel(p), sub: tr("Unattached port"), status: "off" }));
      wire(d, p);
    } else if (!o.startsWith("network:") && inScope(p)) {
      const d = dev(p.device_id, () => ({ id: p.device_id, kind: "other", name: p.name || o || "Device", sub: o || tr("Device"), status: networkStatus(p.status) }));
      wire(d, p);
    }
  }
  // Router gateways that have no visible gateway port (non-admins don't see them).
  for (const r of routers) {
    const d = devices.get(r.id);
    const gw = r.external_gateway_info;
    if (!d || !gw || !netById.has(gw.network_id) || d.wires.some((w) => w.network === gw.network_id)) continue;
    d.wires.push({ network: gw.network_id, ips: (gw.external_fixed_ips ?? []).map((f) => f.ip_address), tag: "gateway" });
  }

  // Network order: external first, then each router's networks, then the rest.
  const used = new Set([...devices.values()].flatMap((d) => d.wires.map((w) => w.network)));
  const order: string[] = [];
  const push = (id: string) => !order.includes(id) && order.push(id);
  networks.filter((n) => n["router:external"] && used.has(n.id)).sort((a, b) => a.name.localeCompare(b.name)).forEach((n) => push(n.id));
  const devs = [...devices.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
  for (const d of devs) for (const w of d.wires) push(w.network);
  if (opts.empty) networks.filter((n) => inScope(n) && !n["router:external"]).sort((a, b) => a.name.localeCompare(b.name)).forEach((n) => push(n.id));
  const idx = new Map(order.map((id, i) => [id, i]));
  for (const d of devs) d.wires.sort((a, b) => idx.get(a.network)! - idx.get(b.network)!);
  devs.sort((a, b) => {
    const ia = a.wires.length ? idx.get(a.wires[0].network)! : 999;
    const ib = b.wires.length ? idx.get(b.wires[0].network)! : 999;
    return ia - ib || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name);
  });
  const nets = order.map((id) => netById.get(id)!).filter(Boolean);
  let c = 0;
  const color = new Map(nets.map((n) => [n.id, n["router:external"] ? EXTERNAL : PALETTE[c++ % PALETTE.length]]));
  return { nets, devices: devs.filter((d) => d.wires.length), color, idx };
}

export type TopoGraph = ReturnType<typeof build>;

// ---------------------------------------------------------------- geometry
const LEFT = 24;
const GAP = 300;
const BAR = 22;
const HEAD = 70;
const ROW = 66;
const BOX_W = 160;
const BOX_H = 46;
const LABEL = 92; // room for the IP on the left wire

export default function Topology() {
  const session = useSession().data!;
  const navigate = useNavigate();
  const [allProjects, setAllProjects] = useState(false);
  const scopeAll = session.is_admin && allProjects;
  const networks = useNetworks();
  const subnets = useSubnets();
  const ports = usePorts();
  const routers = useRouters();
  const servers = useServers(scopeAll ? { all_tenants: 1 } : undefined);
  const fips = useFloatingIps();
  const trunks = useTrunks();
  const [tab, setTab] = useTab(["graph", "diagram", "3d", "ports"] as const, "graph");
  const [dhcp, setDhcp] = useState(false);
  const [free, setFree] = useState(false);
  const [empty, setEmpty] = useState(true);
  const [labels, setLabels] = useState(true);
  const [full, setFull] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<GraphHandle>(null);
  const g3dRef = useRef<Graph3DHandle>(null);
  const bus = useScrollZoom({ min: 0.3, max: 2 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const [wheelHint, setWheelHint] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ kind: "device" | "network"; id: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const pid = session.project?.id;
  // Admins get every project's resources from Neutron; keep the project's own unless asked.
  const inScope = (o: { project_id?: string }) => scopeAll || !session.is_admin || !o.project_id || o.project_id === pid;

  const loading = networks.isPending || ports.isPending || routers.isPending || servers.isPending;
  const error = networks.error || ports.error || routers.error || servers.error;
  const g = useMemo(
    () =>
      build({
        networks: networks.data ?? [],
        subnets: subnets.data ?? [],
        ports: ports.data ?? [],
        routers: routers.data ?? [],
        servers: servers.data ?? [],
        fips: fips.data ?? [],
        trunks: trunks.data ?? [],
        dhcp,
        free,
        empty,
        inScope,
      }),
    [networks.data, subnets.data, ports.data, routers.data, servers.data, fips.data, trunks.data, dhcp, free, empty, scopeAll, pid],
  );
  const cidrs = (n: Network) =>
    (subnets.data ?? [])
      .filter((s) => s.network_id === n.id)
      .map((s) => s.cidr)
      .join(", ");
  const width = LEFT + Math.max(g.nets.length, 1) * GAP;
  const height = HEAD + 30 + g.devices.length * ROW + 20;
  const barX = (i: number) => LEFT + i * GAP;
  // Scroll area of the diagram: room on top for the floating toolbar, a margin around.
  const CW = width + 24;
  const CH = height + 64;
  const active = (d: Device) => !hover || hover === d.id || d.wires.some((w) => w.network === hover);

  /** Export the visible view: SVG for graph and diagram (whole drawing, no pan/zoom), PNG for 3D. */
  const exportView = () => {
    const file = `topology-${session.project?.name ?? "cloud"}`;
    if (tab === "3d") {
      const url = g3dRef.current?.png();
      if (url) Object.assign(document.createElement("a"), { href: url, download: `${file}.png` }).click();
      return;
    }
    const el = tab === "graph" ? graphRef.current?.svg() : svgRef.current;
    const inner = el?.querySelector("g");
    if (!el || !inner) return;
    const box = (inner as SVGGraphicsElement).getBBox();
    const pad = 24;
    const css = getComputedStyle(document.documentElement);
    const clone = el.cloneNode(true) as SVGSVGElement;
    clone.querySelector("g")!.removeAttribute("transform");
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("viewBox", `${box.x - pad} ${box.y - pad} ${box.width + 2 * pad} ${box.height + 2 * pad}`);
    clone.setAttribute("width", String(Math.ceil(box.width + 2 * pad)));
    clone.setAttribute("height", String(Math.ceil(box.height + 2 * pad)));
    const bg = `<rect x="${box.x - pad}" y="${box.y - pad}" width="${box.width + 2 * pad}" height="${box.height + 2 * pad}" fill="${css.getPropertyValue("--color-panel").trim() || "#fff"}"/>`;
    const src = clone.outerHTML.replace(/var\((--[\w-]+)\)/g, (_, v: string) => css.getPropertyValue(v).trim() || "#888").replace(/(<svg[^>]*>)/, `$1${bg}`);
    downloadText(`${file}.svg`, src, "image/svg+xml");
  };

  const fitView = () => {
    if (tab === "graph") graphRef.current?.fit();
    else if (tab === "3d") g3dRef.current?.fit();
    else {
      // Fit the bars, but keep text readable on big clouds: never below 50% (scroll for the rest).
      const el = bus.el.current;
      if (!el) return;
      bus.reset(Math.max(0.5, Math.min(1, el.clientWidth / CW, el.clientHeight / CH)));
    }
  };
  const zoomView = (f: number) => {
    if (tab === "graph") graphRef.current?.zoomBy(f);
    else if (tab === "3d") g3dRef.current?.zoomBy(f);
    else bus.zoomBy(f);
  };

  // Full screen: the browser's Fullscreen API when allowed, a fixed overlay otherwise.
  const toggleFull = async () => {
    if (!full) {
      setFull(true);
      try {
        await stageRef.current?.requestFullscreen?.();
      } catch {
        /* overlay only */
      }
    } else {
      setFull(false);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    }
  };
  useEffect(() => {
    const onChange = () => !document.fullscreenElement && setFull(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  // Embedded in the page, a plain wheel / two-finger scroll scrolls the page; zooming needs
  // Ctrl/⌘ + wheel or a trackpad pinch (which browsers send as ctrl+wheel). Full screen zooms freely.
  useEffect(() => {
    const el = canvasRef.current;
    // The diagram scrolls natively (and hands over to the page at its edges), so it needs no hint.
    if (!el || full || tab === "diagram") return;
    let timer = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      e.stopPropagation(); // keep it from the canvas (and from three.js orbit controls); the page scrolls
      setWheelHint(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => setWheelHint(false), 1400);
    };
    el.addEventListener("wheel", onWheel, { capture: true });
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true });
      clearTimeout(timer);
    };
  }, [full, tab, loading]);

  // Re-fit when the canvas changes size (full screen on/off).
  useEffect(() => {
    const t = setTimeout(fitView, 120);
    return () => clearTimeout(t);
  }, [full, tab, loading]);

  const sel = selected?.kind === "device" ? g.devices.find((d) => d.id === selected.id) : undefined;
  const selNet = selected?.kind === "network" ? g.nets.find((n) => n.id === selected.id) : undefined;

  // Port map rows
  type Row = { d: Device; w: Wire };
  const rows: Row[] = g.devices.flatMap((d) => d.wires.map((w) => ({ d, w })));
  const netName = (id: string) => g.nets.find((n) => n.id === id)?.name ?? id;
  const portCols: Column<Row>[] = [
    {
      key: "device",
      header: tr("Device"),
      cell: ({ d }) =>
        d.href ? (
          <Link to={d.href} className="font-medium text-cable hover:underline">
            {d.name}
          </Link>
        ) : (
          <span className="font-medium">{d.name}</span>
        ),
      value: ({ d }) => d.name,
    },
    { key: "kind", header: tr("Kind"), width: "8rem", hideBelow: "sm", cell: ({ d }) => KIND_LABEL[d.kind], value: ({ d }) => KIND_LABEL[d.kind] },
    {
      key: "network",
      header: tr("Network"),
      cell: ({ w }) => (
        <Link to={`/network/networks/${w.network}`} className="inline-flex max-w-full items-center gap-2 hover:text-cable">
          <span className="size-2.5 shrink-0 rounded-sm" style={{ background: g.color.get(w.network) }} />
          <span className="truncate">{netName(w.network)}</span>
        </Link>
      ),
      value: ({ w }) => netName(w.network),
    },
    { key: "ip", header: "IP", width: "10rem", mono: true, cell: ({ w }) => w.ips.join(", "), value: ({ w }) => w.ips.join(", ") },
    { key: "tag", header: tr("Role"), width: "7rem", hideBelow: "md", cell: ({ w }) => w.tag ?? "", value: ({ w }) => w.tag ?? "" },
    { key: "port", header: tr("Port"), hideBelow: "lg", cell: ({ w }) => (w.port ? portLabel(w.port) : "—"), value: ({ w }) => (w.port ? portLabel(w.port) : "") },
    { key: "mac", header: "MAC", width: "10rem", mono: true, hideBelow: "xl", cell: ({ w }) => w.port?.mac_address ?? "", value: ({ w }) => w.port?.mac_address ?? "" },
    { key: "fip", header: tr("Floating IP"), width: "9rem", mono: true, hideBelow: "lg", cell: ({ w }) => (w.port ? (fips.data ?? []).filter((f) => f.port_id === w.port!.id).map((f) => f.floating_ip_address).join(", ") : ""), value: ({ w }) => (w.port ? (fips.data ?? []).filter((f) => f.port_id === w.port!.id).map((f) => f.floating_ip_address).join(", ") : "") },
  ];

  return (
    <>
      <PageHeader
        title={tr("Network topology")}
        description={tr("How {v} networks, routers and instances connect. Drag the background to pan, Ctrl/⌘ + scroll or pinch to zoom (plain scrolling in full screen), drag nodes to arrange them; hover to trace, click for details.", { v: scopeAll ? tr("the cloud's") : tr("this project's") })}
        actions={
          <>
            <Button onClick={() => navigate("/network/networks")}>
              <Icon name="network" />
              {tr("Networks")}
            </Button>
            <Button onClick={exportView} disabled={tab === "ports" || !g.nets.length}>
              <Icon name="download" />
              {tab === "3d" ? tr("Export PNG") : tr("Export SVG")}
            </Button>
          </>
        }
      />
      <ErrorNotice error={error} className="mb-4" />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-4"
        tabs={[
          { id: "graph", label: tr("Graph") },
          { id: "diagram", label: tr("Diagram") },
          { id: "3d", label: "3D" },
          { id: "ports", label: tr("Port map ({length})", { length: rows.length }) },
        ]}
      />
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Checkbox checked={empty} onChange={setEmpty}>
          {tr("Networks without devices")}
        </Checkbox>
        <Checkbox checked={dhcp} onChange={setDhcp}>
          {tr("DHCP ports")}
        </Checkbox>
        <Checkbox checked={free} onChange={setFree}>
          {tr("Unattached ports")}
        </Checkbox>
        {session.is_admin && <Switch checked={allProjects} onChange={setAllProjects} label={tr("All projects")} />}
        {(tab === "graph" || tab === "3d") && (
          <Checkbox checked={labels} onChange={setLabels}>
            {tr("Labels")}
          </Checkbox>
        )}
      </div>

      {tab === "ports" && (
        <DataTable
          rows={loading ? undefined : rows}
          columns={portCols}
          rowKey={({ d, w }) => `${d.id}:${w.port?.id ?? w.network}`}
          loading={loading}
          tableId="topology-ports"
          noun={tr("ports")}
          filterPlaceholder={tr("Filter by device, network, IP or MAC")}
          empty={tr("No ports in scope.")}
        />
      )}

      {tab !== "ports" && (
        <div
          ref={stageRef}
          className={cn(full ? "fixed inset-0 z-[70] flex flex-col bg-surface" : "grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]")}
        >
          <div ref={canvasRef} className={cn("relative min-w-0 overflow-hidden border-line bg-panel", full ? "flex-1 border-0" : "h-[70vh] min-h-[26rem] rounded-lg border")}>
            {!full && (
              <div
                aria-hidden
                className={cn(
                  "pointer-events-none absolute inset-0 z-20 grid place-items-center bg-ink/25 transition-opacity duration-200",
                  wheelHint ? "opacity-100" : "opacity-0",
                )}
              >
                <p className="rounded-lg bg-panel px-4 py-2.5 text-sm font-medium shadow-lg">
                  {tr("Hold Ctrl (⌘ on Mac) while scrolling, or pinch, to zoom — or open full screen")}
                </p>
              </div>
            )}
            {/* floating toolbar */}
            <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-1 rounded-lg border border-line bg-panel/90 p-1 shadow-sm backdrop-blur">
              {full && (
                <Tabs
                  value={tab}
                  onChange={setTab}
                  className="mr-1 border-0"
                  tabs={[
                    { id: "graph", label: tr("Graph") },
                    { id: "diagram", label: tr("Diagram") },
                    { id: "3d", label: "3D" },
                  ]}
                />
              )}
              <Button variant="ghost" className="h-8 px-2" aria-label={tr("Zoom out")} title={tr("Zoom out")} onClick={() => zoomView(1 / 1.25)}>
                <Icon name="minus" />
              </Button>
              <Button variant="ghost" className="h-8 px-2" aria-label={tr("Zoom in")} title={tr("Zoom in")} onClick={() => zoomView(1.25)}>
                <Icon name="plus" />
              </Button>
              <Button variant="ghost" className="h-8 px-2" aria-label={tr("Fit to screen")} title={tr("Fit to screen")} onClick={fitView}>
                <Icon name="scaling" />
              </Button>
              {tab !== "diagram" && (
                <Button variant="ghost" className={cn("h-8 px-2", labels && "text-cable")} aria-label={tr("Toggle labels")} title={tr("Toggle labels")} onClick={() => setLabels((l) => !l)}>
                  <Icon name="tags" />
                </Button>
              )}
              <Button variant="ghost" className="h-8 px-2" aria-label={full ? tr("Exit full screen") : tr("Full screen")} title={full ? tr("Exit full screen (Esc)") : tr("Full screen")} onClick={toggleFull}>
                <Icon name={full ? "minimize" : "maximize"} />
              </Button>
              {full && (
                <Button variant="ghost" className="h-8 px-2" aria-label={tr("Export")} title={tab === "3d" ? tr("Export PNG") : tr("Export SVG")} onClick={exportView}>
                  <Icon name="download" />
                </Button>
              )}
            </div>
            {loading ? (
              <p className="p-10 pt-20 text-center text-sm text-muted">{tr("Loading topology…")}</p>
            ) : !g.nets.length ? (
              <p className="p-10 pt-20 text-center text-sm text-muted">{tr("No networks in scope.")}</p>
            ) : tab === "graph" ? (
              <TopologyGraph
                ref={graphRef}
                g={g}
                labels={labels}
                embedded={!full}
                selected={selected?.id}
                onSelect={(kind, id) => setSelected({ kind, id })}
                onClear={() => setSelected(null)}
              />
            ) : tab === "3d" ? (
              <Suspense fallback={<p className="p-10 pt-20 text-center text-sm text-muted">{tr("Loading 3D view…")}</p>}>
                <Topology3D ref={g3dRef} g={g} labels={labels} embedded={!full} onSelect={(kind, id) => setSelected({ kind, id })} />
              </Suspense>
            ) : (
              <div ref={bus.ref} className="h-full w-full cursor-grab overflow-auto select-none active:cursor-grabbing" onMouseLeave={() => setHover(null)}>
              <svg
                ref={svgRef}
                width={CW * bus.k}
                height={CH * bus.k}
                viewBox={`-12 -52 ${CW} ${CH}`}
                className="block"
                role="img"
                aria-label={tr("Network topology diagram")}
                fontFamily="Be Vietnam Pro, system-ui, sans-serif"
              >
                <g>
                {/* network bars */}
                {g.nets.map((n, i) => {
                  const x = barX(i);
                  const col = g.color.get(n.id)!;
                  const dim = hover && hover !== n.id && !g.devices.some((d) => d.id === hover && d.wires.some((w) => w.network === n.id));
                  const reps = Math.max(1, Math.floor((height - HEAD) / 420));
                  return (
                    <g
                      key={n.id}
                      opacity={dim ? 0.3 : 1}
                      className="cursor-pointer"
                      onMouseEnter={() => setHover(n.id)}
                      onClick={() => setSelected({ kind: "network", id: n.id })}
                    >
                      <text x={x} y={22} fontSize={13} fontWeight={600} fill="var(--color-ink)">
                        {short(n.name || n.id, 34)}
                      </text>
                      <text x={x} y={40} fontSize={11} fill="var(--color-muted)" fontFamily="JetBrains Mono, monospace">
                        {short(cidrs(n) || "no subnet", 40)}
                      </text>
                      <text x={x} y={56} fontSize={10.5} fill="var(--color-muted)">
                        {[n["router:external"] ? "external" : n.shared ? "shared" : null, n["provider:network_type"], n["provider:segmentation_id"] != null ? `seg ${n["provider:segmentation_id"]}` : null].filter(Boolean).join(" · ")}
                      </text>
                      <rect x={x} y={HEAD} width={BAR} height={height - HEAD - 12} rx={5} fill={col} opacity={selected?.id === n.id ? 1 : 0.9} />
                      {Array.from({ length: reps }, (_, k) => {
                        const cy = HEAD + 40 + k * 420 + 120;
                        return (
                          <text key={k} x={x + BAR / 2 + 4} y={cy} fontSize={11} fontWeight={600} fill="#fff" transform={`rotate(-90 ${x + BAR / 2 + 4} ${cy})`} textAnchor="middle">
                            {short(n.name || n.id, 26)}
                          </text>
                        );
                      })}
                    </g>
                  );
                })}
                {/* devices */}
                {g.devices.map((d, r) => {
                  const first = g.idx.get(d.wires[0].network)!;
                  const y = HEAD + 30 + r * ROW;
                  const cy = y + BOX_H / 2;
                  const bx = barX(first) + BAR + LABEL;
                  const on = active(d);
                  const seen = new Map<string, number>();
                  const accent = d.kind === "router" ? "var(--color-led-amber)" : d.kind === "instance" ? "var(--color-cable)" : "var(--color-muted)";
                  return (
                    <g
                      key={`${d.kind}:${d.id}`}
                      opacity={on ? 1 : 0.2}
                      className="cursor-pointer"
                      onMouseEnter={() => setHover(d.id)}
                      onClick={() => setSelected({ kind: "device", id: d.id })}
                    >
                      {d.wires.map((w) => {
                        const j = g.idx.get(w.network)!;
                        const n = seen.get(w.network) ?? 0;
                        seen.set(w.network, n + 1);
                        // a second port on the same network is drawn just below/above the first
                        const wy = cy + (n ? (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 10 : 0);
                        const col = g.color.get(w.network)!;
                        const dotX = barX(j) + BAR / 2;
                        const label = [w.ips[0] ?? "", w.tag === "gateway" ? "gw" : w.tag && w.tag !== "trunk" ? w.tag.replace("vlan ", "v") : ""].filter(Boolean).join(" ");
                        if (j === first)
                          return (
                            <g key={`${w.network}${n}`}>
                              <line x1={dotX} y1={wy} x2={bx} y2={wy} stroke={col} strokeWidth={2} />
                              <circle cx={dotX} cy={wy} r={4.5} fill="var(--color-panel)" stroke={col} strokeWidth={2} />
                              <text x={dotX + 12} y={wy - 5} fontSize={10} fill="var(--color-muted)" fontFamily="JetBrains Mono, monospace">
                                {short(label, 15)}
                              </text>
                            </g>
                          );
                        return (
                          <g key={`${w.network}${n}`}>
                            <line x1={bx + BOX_W} y1={wy} x2={dotX} y2={wy} stroke={col} strokeWidth={2} strokeDasharray={w.tag?.startsWith("vlan") ? "6 4" : undefined} />
                            <circle cx={dotX} cy={wy} r={4.5} fill="var(--color-panel)" stroke={col} strokeWidth={2} />
                            <text x={dotX + 12} y={wy - 5} fontSize={10} fill="var(--color-muted)" fontFamily="JetBrains Mono, monospace">
                              {short(label, 15)}
                            </text>
                          </g>
                        );
                      })}
                      <rect
                        x={bx}
                        y={y}
                        width={BOX_W}
                        height={BOX_H}
                        rx={7}
                        fill="var(--color-panel)"
                        stroke={selected?.id === d.id ? "var(--color-cable)" : "var(--color-line)"}
                        strokeWidth={selected?.id === d.id ? 2 : 1}
                      />
                      <rect x={bx} y={y} width={4} height={BOX_H} rx={2} fill={accent} />
                      <circle
                        cx={bx + BOX_W - 12}
                        cy={y + 12}
                        r={3.5}
                        fill={d.status === "ok" ? "var(--color-led-green)" : d.status === "warn" ? "var(--color-led-amber)" : d.status === "error" ? "var(--color-led-red)" : "var(--color-line)"}
                      />
                      <text x={bx + 14} y={y + 19} fontSize={12.5} fontWeight={600} fill="var(--color-ink)">
                        {short(d.name, 19)}
                      </text>
                      <text x={bx + 14} y={y + 35} fontSize={10.5} fill="var(--color-muted)">
                        {short(d.fips.length ? `${KIND_LABEL[d.kind]} · FIP ${d.fips[0]}` : d.sub, 26)}
                      </text>
                      <title>{`${KIND_LABEL[d.kind]} ${d.name}\n${d.wires.map((w) => `${netName(w.network)}: ${w.ips.join(", ")}${w.tag ? ` (${w.tag})` : ""}`).join("\n")}${d.fips.length ? tr("\nFloating IP: {fips}", { fips: d.fips.join(", ") }) : ""}`}</title>
                    </g>
                  );
                })}
                </g>
              </svg>
              </div>
            )}
          </div>
          <aside className={cn("space-y-4", full && "absolute top-16 right-3 z-10 max-h-[calc(100vh-5rem)] w-80 overflow-y-auto", full && !sel && !selNet && "hidden")}>
            {sel ? (
              <DevicePanel d={sel} color={g.color} netName={netName} onClose={() => setSelected(null)} />
            ) : selNet ? (
              <NetworkPanel n={selNet} color={g.color.get(selNet.id)!} cidrs={cidrs(selNet)} devices={g.devices.filter((d) => d.wires.some((w) => w.network === selNet.id))} onClose={() => setSelected(null)} />
            ) : (
              <Card title={tr("Legend")}>
                <ul className="space-y-2.5 text-sm">
                  <li className="flex items-center gap-3">
                    <span className="h-5 w-2.5 rounded-sm" style={{ background: PALETTE[0] }} />
                    {tr("Network (bar or hub), external in slate")}
                  </li>
                  <li className="flex items-center gap-3">
                    <span className="h-5 w-1 rounded-sm bg-led-amber" />
                    {tr("Router")}
                  </li>
                  <li className="flex items-center gap-3">
                    <span className="h-5 w-1 rounded-sm bg-cable" />
                    {tr("Instance")}
                  </li>
                  <li className="flex items-center gap-3">
                    <svg width="28" height="8" aria-hidden>
                      <line x1="0" y1="4" x2="28" y2="4" stroke={PALETTE[1]} strokeWidth="2" strokeDasharray="6 4" />
                    </svg>
                    {tr("Trunk VLAN sub-port")}
                  </li>
                </ul>
                <dl className="mt-4">
                  <Detail label={tr("Networks")}>{g.nets.length}</Detail>
                  <Detail label={tr("Routers")}>{g.devices.filter((d) => d.kind === "router").length}</Detail>
                  <Detail label={tr("Instances")}>{g.devices.filter((d) => d.kind === "instance").length}</Detail>
                  <Detail label={tr("Ports drawn")}>{rows.length}</Detail>
                </dl>
              </Card>
            )}
          </aside>
        </div>
      )}
    </>
  );
}

function PanelHead({ title, sub, onClose }: { title: string; sub: string; onClose: () => void }) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-semibold" title={title}>
          {title}
        </h3>
        <p className="text-xs text-muted">{sub}</p>
      </div>
      <button type="button" aria-label={tr("Close")} onClick={onClose} className="rounded p-1 text-muted hover:bg-ink/5 hover:text-ink">
        <Icon name="x" />
      </button>
    </div>
  );
}

function DevicePanel({ d, color, netName, onClose }: { d: Device; color: Map<string, string>; netName: (id: string) => string; onClose: () => void }) {
  return (
    <Card>
      <PanelHead title={d.name} sub={d.sub} onClose={onClose} />
      <div className="mt-3 flex items-center gap-2">
        <Icon name={KIND_ICON[d.kind]} className="text-muted" />
        <StatusDot status={d.status} label={KIND_LABEL[d.kind]} />
      </div>
      <ul className="mt-4 space-y-2">
        {d.wires.map((w, i) => (
          <li key={i} className="rounded-md border border-line px-3 py-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: color.get(w.network) }} />
              <Link to={`/network/networks/${w.network}`} className="min-w-0 flex-1 truncate font-medium hover:text-cable">
                {netName(w.network)}
              </Link>
              {w.tag && <Badge>{w.tag}</Badge>}
            </div>
            <div className="mt-1 font-mono text-xs text-muted">{w.ips.join(", ") || tr("no IP")}</div>
            {w.port && <div className="truncate font-mono text-[11px] text-muted">{w.port.mac_address}</div>}
          </li>
        ))}
      </ul>
      {d.fips.length > 0 && (
        <p className="mt-3 text-sm">
          {tr("Floating IP")}{" "}<Mono>{d.fips.join(", ")}</Mono>
        </p>
      )}
      {d.href && (
        <Link to={d.href} className="mt-4 inline-flex items-center gap-1.5 text-sm text-cable hover:underline">
          {trx("Open {toLowerCase}", { toLowerCase: KIND_LABEL[d.kind].toLowerCase() })}
          <Icon name="chevron-right" className="size-3.5" />
        </Link>
      )}
    </Card>
  );
}

function NetworkPanel({ n, color, cidrs, devices, onClose }: { n: Network; color: string; cidrs: string; devices: Device[]; onClose: () => void }) {
  return (
    <Card>
      <PanelHead title={n.name || n.id} sub={n["router:external"] ? tr("External network") : n.shared ? tr("Shared network") : tr("Network")} onClose={onClose} />
      <div className="mt-3 h-1.5 rounded-full" style={{ background: color }} />
      <dl className="mt-3">
        <Detail label={tr("Subnets")}>{cidrs || tr("None")}</Detail>
        {n["provider:network_type"] && <Detail label={tr("Type")}>{n["provider:network_type"]}</Detail>}
        {n["provider:segmentation_id"] != null && <Detail label={tr("Segment")}>{n["provider:segmentation_id"]}</Detail>}
        {n.mtu && <Detail label="MTU">{n.mtu}</Detail>}
        <Detail label={tr("Devices")}>{devices.length}</Detail>
      </dl>
      <ul className={cn("mt-3 max-h-64 space-y-1 overflow-y-auto text-sm")}>
        {devices.map((d) => (
          <li key={d.id} className="flex items-center gap-2">
            <Icon name={KIND_ICON[d.kind]} className="size-3.5 text-muted" />
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            <span className="font-mono text-xs text-muted">{d.wires.find((w) => w.network === n.id)?.ips[0]}</span>
          </li>
        ))}
      </ul>
      <Link to={`/network/networks/${n.id}`} className="mt-4 inline-flex items-center gap-1.5 text-sm text-cable hover:underline">
        {tr("Open network")}
        <Icon name="chevron-right" className="size-3.5" />
      </Link>
    </Card>
  );
}
