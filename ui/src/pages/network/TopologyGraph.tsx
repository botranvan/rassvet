/**
 * Force-directed topology: networks are hubs, devices orbit them, and every network is
 * wrapped in a translucent hull (like Horizon's graph view). Drag nodes, pan, zoom.
 */
import { type Simulation, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { polygonHull } from "d3-polygon";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { lookupIcon } from "@/components/icons";
import type { Network } from "@/lib/os";
import { usePanZoom } from "@/lib/usePanZoom";
import { cn } from "@/lib/utils";
import type { Device, TopoGraph } from "./Topology";
import { tr } from "@/lib/i18n";

export interface GNode {
  id: string;
  /** Network id or device id, for selection. */
  ref: string;
  type: "network" | Device["kind"];
  label: string;
  sub?: string;
  color: string;
  r: number;
  external?: boolean;
  status?: Device["status"];
  x?: number;
  y?: number;
  z?: number;
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
}

export interface GLink {
  source: string | GNode;
  target: string | GNode;
  network: string;
  color: string;
  label: string;
}

const DEVICE_COLOR: Record<string, string> = { router: "#e8a33d", instance: "#0f8b8d", lb: "#8b5cf6", dhcp: "#94a3b8", port: "#94a3b8", other: "#64748b" };
const ICON: Record<GNode["type"], string> = { network: "cloud", router: "router", instance: "monitor", lb: "split", dhcp: "settings", port: "cable", other: "boxes" };

/** Nodes and links shared by the 2D graph and the 3D view. */
export function toGraph(g: TopoGraph): { nodes: GNode[]; links: GLink[] } {
  const nodes: GNode[] = g.nets.map((n: Network) => ({
    id: `n:${n.id}`,
    ref: n.id,
    type: "network",
    label: n.name || n.id.slice(0, 8),
    color: g.color.get(n.id)!,
    r: 20,
    external: !!n["router:external"],
  }));
  const links: GLink[] = [];
  for (const d of g.devices) {
    const id = `d:${d.kind}:${d.id}`;
    nodes.push({ id, ref: d.id, type: d.kind, label: d.name, sub: d.sub, color: DEVICE_COLOR[d.kind] ?? "#64748b", r: d.kind === "router" ? 16 : 13, status: d.status });
    const seen = new Set<string>();
    for (const w of d.wires) {
      if (seen.has(w.network)) continue;
      seen.add(w.network);
      links.push({ source: id, target: `n:${w.network}`, network: w.network, color: g.color.get(w.network)!, label: w.ips.join(", ") });
    }
  }
  return { nodes, links };
}

const endId = (e: string | GNode) => (typeof e === "string" ? e : e.id);

export interface GraphHandle {
  fit: () => void;
  zoomBy: (f: number) => void;
  svg: () => SVGSVGElement | null;
}

export const TopologyGraph = forwardRef<
  GraphHandle,
  { g: TopoGraph; labels: boolean; embedded?: boolean; selected?: string; onSelect: (kind: "device" | "network", id: string) => void; onClear: () => void }
>(function TopologyGraph({ g, labels, embedded, selected, onSelect, onClear }, ref) {
  const pz = usePanZoom();
  const { nodes, links } = useMemo(() => toGraph(g), [g]);
  const sim = useRef<Simulation<GNode, GLink> | null>(null);
  const [, setFrame] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const prev = useRef(new Map<string, { x: number; y: number }>());

  const bounds = () => {
    if (!nodes.length) return { x: 0, y: 0, w: 1, h: 1 };
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const pad = 70;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + 2 * pad + 120, h: Math.max(...ys) - Math.min(...ys) + 2 * pad };
  };

  useEffect(() => {
    // Keep positions of nodes that survive a data refresh.
    for (const n of nodes) {
      const p = prev.current.get(n.id);
      if (p) Object.assign(n, p);
    }
    const s = forceSimulation<GNode, GLink>(nodes)
      .force(
        "link",
        forceLink<GNode, GLink>(links)
          .id((n) => n.id)
          .distance((l) => ((l.source as GNode).type === "router" ? 150 : 95))
          .strength(0.6),
      )
      .force("charge", forceManyBody<GNode>().strength((n) => (n.type === "network" ? -1500 : -320)))
      .force("collide", forceCollide<GNode>((n) => n.r + (n.type === "network" ? 40 : 22)))
      .force("x", forceX(0).strength(0.04))
      .force("y", forceY(0).strength(0.04))
      .stop();
    const settled = prev.current.size > 0 && nodes.every((n) => prev.current.has(n.id));
    for (let i = 0; i < (settled ? 30 : 320); i++) s.tick();
    let raf = 0;
    s.on("tick", () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setFrame((f) => f + 1));
    });
    sim.current = s;
    setFrame((f) => f + 1);
    if (!settled) requestAnimationFrame(() => pz.fit(bounds()));
    return () => {
      s.stop();
      cancelAnimationFrame(raf);
      for (const n of nodes) prev.current.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
    };
  }, [nodes, links]);

  useImperativeHandle(ref, () => ({ fit: () => pz.fit(bounds()), zoomBy: pz.zoomBy, svg: () => svgRef.current }));

  const startDrag = (n: GNode) => (e: React.PointerEvent) => {
    e.stopPropagation();
    const target = e.currentTarget as Element;
    target.setPointerCapture(e.pointerId);
    let moved = false;
    const begin = pz.toContent(e.clientX, e.clientY);
    const off = { x: (n.x ?? 0) - begin.x, y: (n.y ?? 0) - begin.y };
    const move = (ev: PointerEvent) => {
      const p = pz.toContent(ev.clientX, ev.clientY);
      if (!moved && Math.hypot(p.x - begin.x, p.y - begin.y) * pz.t.k < 3) return;
      if (!moved) sim.current?.alphaTarget(0.25).restart();
      moved = true;
      n.fx = p.x + off.x;
      n.fy = p.y + off.y;
    };
    const up = () => {
      target.removeEventListener("pointermove", move as EventListener);
      target.removeEventListener("pointerup", up);
      sim.current?.alphaTarget(0);
      if (!moved) {
        n.fx = null;
        n.fy = null;
        onSelect(n.type === "network" ? "network" : "device", n.ref);
      }
      // Dragged nodes stay where they were dropped (double-click releases them).
    };
    target.addEventListener("pointermove", move as EventListener);
    target.addEventListener("pointerup", up);
  };

  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of links) {
      const a = endId(l.source);
      const b = endId(l.target);
      m.set(a, (m.get(a) ?? new Set()).add(b));
      m.set(b, (m.get(b) ?? new Set()).add(a));
    }
    return m;
  }, [links]);
  const lit = (id: string) => !hover || hover === id || !!neighbours.get(hover)?.has(id);

  // Hulls: every network with the devices attached to it.
  const hulls = nodes
    .filter((n) => n.type === "network")
    .map((net) => {
      const members = [net, ...links.filter((l) => endId(l.target) === net.id).map((l) => l.source as GNode)];
      const pts = members.map((m) => [m.x ?? 0, m.y ?? 0] as [number, number]);
      let d: string;
      if (pts.length >= 3) {
        const h = polygonHull(pts) ?? pts;
        d = `M${h.map((p) => p.join(",")).join("L")}Z`;
      } else if (pts.length === 2) d = `M${pts[0].join(",")}L${pts[1].join(",")}`;
      else d = `M${pts[0][0]},${pts[0][1]}l0.01,0`;
      return { net, d };
    });

  const { x, y, k } = pz.t;
  return (
    <div
      ref={pz.ref}
      // Embedded in the page, one-finger vertical swipes scroll the page; pinch still zooms.
      className={cn("relative h-full w-full cursor-grab overflow-hidden select-none active:cursor-grabbing", embedded ? "touch-pan-y" : "touch-none")}
      onClick={() => !pz.wasDrag() && onClear()}
      onMouseLeave={() => setHover(null)}
    >
      <svg ref={svgRef} width="100%" height="100%" role="img" aria-label={tr("Network topology graph")} fontFamily="Be Vietnam Pro, system-ui, sans-serif">
        <g transform={`translate(${x},${y}) scale(${k})`}>
          {hulls.map(({ net, d }) => (
            <g key={net.id} opacity={lit(net.id) ? 0.17 : 0.05} style={{ transition: "opacity .15s" }}>
              <path d={d} fill={net.color} stroke={net.color} strokeWidth={84} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ))}
          {links.map((l) => {
            const s = l.source as GNode;
            const t = l.target as GNode;
            const on = lit(s.id) && lit(t.id) && (!hover || hover === s.id || hover === t.id);
            return (
              <line
                key={`${s.id}-${t.id}`}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                stroke={on && hover ? l.color : "var(--color-ink)"}
                strokeOpacity={on ? (hover ? 0.9 : 0.35) : 0.08}
                strokeWidth={on && hover ? 2 : 1.1}
              />
            );
          })}
          {hover &&
            links
              .filter((l) => endId(l.source) === hover || endId(l.target) === hover)
              .map((l) => {
                const s = l.source as GNode;
                const t = l.target as GNode;
                return (
                  <text key={`lbl-${s.id}-${t.id}`} x={((s.x ?? 0) + (t.x ?? 0)) / 2} y={((s.y ?? 0) + (t.y ?? 0)) / 2 - 4} fontSize={10} textAnchor="middle" fill="var(--color-ink)" fontFamily="JetBrains Mono, monospace" paintOrder="stroke" stroke="var(--color-panel)" strokeWidth={3}>
                    {l.label}
                  </text>
                );
              })}
          {nodes.map((n) => {
            const I = lookupIcon(n.external ? "globe" : ICON[n.type]);
            const sel = selected === n.ref;
            return (
              <g
                key={n.id}
                data-no-pan
                transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                opacity={lit(n.id) ? 1 : 0.25}
                className="cursor-pointer"
                onPointerDown={startDrag(n)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  n.fx = null;
                  n.fy = null;
                  sim.current?.alpha(0.3).restart();
                }}
                onClick={(e) => e.stopPropagation()}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
              >
                <circle r={n.r + (sel ? 4 : 0)} fill="var(--color-panel)" stroke={sel ? "var(--color-cable)" : n.type === "network" ? n.color : "var(--color-ink)"} strokeWidth={sel ? 3 : n.type === "network" ? 3 : 1.6} />
                <I x={-n.r * 0.55} y={-n.r * 0.55} width={n.r * 1.1} height={n.r * 1.1} color={n.type === "network" ? n.color : "var(--color-ink)"} strokeWidth={2} />
                {n.status && n.status !== "off" && (
                  <circle cx={n.r * 0.72} cy={-n.r * 0.72} r={3.5} fill={n.status === "ok" ? "var(--color-led-green)" : n.status === "warn" ? "var(--color-led-amber)" : "var(--color-led-red)"} stroke="var(--color-panel)" strokeWidth={1.5} />
                )}
                {(labels || hover === n.id || sel) && (
                  <text x={n.r + 6} y={4} fontSize={n.type === "network" ? 12.5 : 11} fontWeight={n.type === "network" ? 600 : 500} fill="var(--color-ink)" paintOrder="stroke" stroke="var(--color-panel)" strokeWidth={3}>
                    {n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
});
