import { useCallback, useEffect, useRef, useState } from "react";

export interface PanZoom {
  x: number;
  y: number;
  k: number;
}

/**
 * Pan and zoom for a canvas element: mouse wheel and trackpad pinch (ctrl+wheel) zoom
 * around the pointer, trackpad two-finger scroll pans, dragging the background pans,
 * two-finger touch pinches. Elements marked `data-no-pan` (draggable nodes) are left alone.
 * Pages that embed the canvas can stop plain wheel events before they reach it (see the
 * topology page) so the page itself still scrolls.
 */
export function usePanZoom({ min = 0.15, max = 4 }: { min?: number; max?: number } = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState<PanZoom>({ x: 0, y: 0, k: 1 });
  const tRef = useRef(t);
  tRef.current = t;
  const dragged = useRef(false);
  const clamp = useCallback((k: number) => Math.min(max, Math.max(min, k)), [min, max]);

  const zoomAt = useCallback(
    (cx: number, cy: number, factor: number) => {
      const { x, y, k } = tRef.current;
      const nk = clamp(k * factor);
      setT({ k: nk, x: cx - ((cx - x) * nk) / k, y: cy - ((cy - y) * nk) / k });
    },
    [clamp],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Mouse wheels send whole lines or large integer steps without deltaX; trackpads send small fractional deltas.
      const mouse = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY));
      const pinch = e.ctrlKey || e.metaKey;
      if (pinch || mouse) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (pinch ? 0.01 : 0.0015)));
      else setT((p) => ({ ...p, x: p.x - e.deltaX, y: p.y - e.deltaY }));
    };
    const pts = new Map<number, { x: number; y: number }>();
    let start = { x: 0, y: 0 };
    let pinch: { d: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element).closest("[data-no-pan]")) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      start = { x: e.clientX, y: e.clientY };
      dragged.current = false;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      pts.set(e.pointerId, cur);
      if (!dragged.current && Math.hypot(cur.x - start.x, cur.y - start.y) > 4) {
        dragged.current = true;
        // Capture only once it's a drag, so plain clicks still reach nodes.
        el.setPointerCapture(e.pointerId);
      }
      if (pts.size === 1) {
        setT((p) => ({ ...p, x: p.x + cur.x - prev.x, y: p.y + cur.y - prev.y }));
      } else if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = el.getBoundingClientRect();
        zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinch.d);
        pinch.d = d;
      }
    };
    const onUp = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, [zoomAt]);

  /** Fit a content box (in content coordinates) into the element. */
  const fit = useCallback(
    (box: { x: number; y: number; w: number; h: number }, pad = 32, maxK = 1.2) => {
      const el = ref.current;
      if (!el || box.w <= 0 || box.h <= 0) return;
      const W = el.clientWidth;
      const H = el.clientHeight;
      const k = clamp(Math.min((W - 2 * pad) / box.w, (H - 2 * pad) / box.h, maxK));
      setT({ k, x: (W - box.w * k) / 2 - box.x * k, y: (H - box.h * k) / 2 - box.y * k });
    },
    [clamp],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const el = ref.current;
      if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor);
    },
    [zoomAt],
  );

  /** Screen point → content coordinates. */
  const toContent = useCallback((clientX: number, clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    const { x, y, k } = tRef.current;
    return { x: (clientX - r.left - x) / k, y: (clientY - r.top - y) / k };
  }, []);

  return { ref, t, setT, fit, zoomBy, toContent, wasDrag: () => dragged.current };
}
