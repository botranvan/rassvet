/**
 * 3D topology (three.js via 3d-force-graph), loaded on demand. Networks are glassy
 * translucent spheres, devices small solid ones, traffic particles run along the links.
 * Drag to rotate, scroll / pinch to zoom, right-drag (or two fingers) to pan.
 */
import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import SpriteText from "three-spritetext";
import type { TopoGraph } from "./Topology";
import { type GLink, type GNode, toGraph } from "./TopologyGraph";

export interface Graph3DHandle {
  fit: () => void;
  zoomBy: (f: number) => void;
  png: () => string | null;
}

// The library's node/link types don't allow null fx/fy; our nodes are plain objects with extra fields.
const N = (o: object) => o as GNode;
const L = (o: object) => o as GLink;

const css = (v: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fallback;

const Topology3D = forwardRef<Graph3DHandle, { g: TopoGraph; labels: boolean; embedded?: boolean; onSelect: (kind: "device" | "network", id: string) => void }>(function Topology3D(
  { g, labels, embedded, onSelect },
  ref,
) {
  const el = useRef<HTMLDivElement>(null);
  const fg = useRef<ForceGraph3DInstance | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;

  // Create the scene once.
  useEffect(() => {
    const host = el.current!;
    const graph = new ForceGraph3D(host, { controlType: "orbit", rendererConfig: { antialias: true, alpha: true, preserveDrawingBuffer: true } });
    graph
      .backgroundColor("rgba(0,0,0,0)")
      .showNavInfo(false)
      .nodeLabel((o) => {
        const n = N(o);
        return `<div style="font:12px 'Be Vietnam Pro',sans-serif;padding:4px 8px;border-radius:6px;background:rgba(15,20,28,.85);color:#fff">${escapeHtml(n.label)}${n.sub ? `<br><span style="opacity:.7">${escapeHtml(n.sub)}</span>` : ""}</div>`;
      })
      .linkColor((l) => L(l).color)
      .linkOpacity(0.55)
      .linkWidth(0.9)
      .linkDirectionalParticles(2)
      .linkDirectionalParticleWidth(1.8)
      .linkDirectionalParticleSpeed(0.006)
      .linkDirectionalParticleColor((l) => L(l).color)
      .onNodeClick((o) => {
        const n = N(o);
        select.current(n.type === "network" ? "network" : "device", n.ref);
        // Fly towards the clicked node.
        const d = 90;
        const r = 1 + d / Math.hypot(n.x ?? 1, n.y ?? 1, n.z ?? 1);
        graph.cameraPosition({ x: (n.x ?? 0) * r, y: (n.y ?? 0) * r, z: (n.z ?? 0) * r }, { x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0 }, 900);
      })
      .onNodeDragEnd((n) => {
        n.fx = n.x;
        n.fy = n.y;
        n.fz = n.z;
      });
    graph.d3Force("charge")?.strength((n: object) => (N(n).type === "network" ? -260 : -60));
    graph.d3Force("link")?.distance((l: object) => ((L(l).source as GNode).type === "router" ? 70 : 45));
    const scene = graph.scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(120, 200, 160);
    scene.add(sun);
    const ro = new ResizeObserver(() => graph.width(host.clientWidth).height(host.clientHeight));
    ro.observe(host);
    fg.current = graph;
    return () => {
      ro.disconnect();
      graph._destructor();
      host.replaceChildren();
      fg.current = null;
    };
  }, []);

  // Embedded in the page, let one-finger vertical swipes scroll the page (orbit with two fingers).
  useEffect(() => {
    const canvas = fg.current?.renderer().domElement;
    if (canvas) canvas.style.touchAction = embedded ? "pan-y" : "none";
  }, [embedded]);

  // Data and label changes.
  useEffect(() => {
    const graph = fg.current;
    if (!graph) return;
    const ink = css("--color-ink", "#18202b");
    graph.nodeThreeObject((o) => {
      const n = N(o);
      const group = new THREE.Group();
      const color = new THREE.Color(n.color);
      if (n.type === "network") {
        // Glass shell + bright core.
        group.add(
          new THREE.Mesh(
            new THREE.SphereGeometry(11, 40, 24),
            new THREE.MeshPhysicalMaterial({ color, transparent: true, opacity: 0.28, roughness: 0.1, metalness: 0.1, transmission: 0.6, clearcoat: 1, depthWrite: false }),
          ),
        );
        group.add(new THREE.Mesh(new THREE.SphereGeometry(3.2, 24, 16), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 })));
        const ring = new THREE.Mesh(new THREE.TorusGeometry(13, 0.35, 8, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 }));
        ring.rotation.x = Math.PI / 2;
        group.add(ring);
      } else {
        const size = n.type === "router" ? 4.6 : 3.6;
        const geo = n.type === "router" ? new THREE.OctahedronGeometry(size) : n.type === "instance" ? new THREE.BoxGeometry(size * 1.5, size * 1.5, size * 1.5) : new THREE.SphereGeometry(size * 0.8, 16, 12);
        group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.92, roughness: 0.35, metalness: 0.2 })));
        if (n.status && n.status !== "ok" && n.status !== "off") {
          const dot = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), new THREE.MeshBasicMaterial({ color: n.status === "warn" ? 0xe8a33d : 0xe5484d }));
          dot.position.set(size, size, 0);
          group.add(dot);
        }
      }
      if (labels) {
        const t = new SpriteText(n.label, n.type === "network" ? 4.2 : 3, n.type === "network" ? n.color : ink);
        t.fontFace = "Be Vietnam Pro, system-ui, sans-serif";
        t.fontWeight = n.type === "network" ? "600" : "500";
        t.position.y = n.type === "network" ? 17 : 8;
        group.add(t);
      }
      return group;
    });
    const { nodes, links } = toGraph(g);
    // Keep positions across refreshes.
    const old = new Map(graph.graphData().nodes.map((n) => [n.id, N(n)]));
    for (const n of nodes) {
      const o = old.get(n.id);
      if (o) Object.assign(n, { x: o.x, y: o.y, z: o.z, fx: o.fx, fy: o.fy, fz: o.fz });
    }
    graph.graphData({ nodes, links } as never);
    if (!old.size) setTimeout(() => graph.zoomToFit(800, 40), 1200);
  }, [g, labels]);

  useImperativeHandle(ref, () => ({
    fit: () => fg.current?.zoomToFit(700, 40),
    zoomBy: (f: number) => {
      const graph = fg.current;
      if (!graph) return;
      const c = graph.cameraPosition();
      graph.cameraPosition({ x: c.x / f, y: c.y / f, z: c.z / f }, undefined, 300);
    },
    png: () => fg.current?.renderer().domElement.toDataURL("image/png") ?? null,
  }));

  return <div ref={el} className="h-full w-full cursor-grab active:cursor-grabbing" />;
});

export default Topology3D;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
