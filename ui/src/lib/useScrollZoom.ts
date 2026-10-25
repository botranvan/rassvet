import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Zoom for a natively scrolling canvas (overflow: auto): the wheel, trackpad and touch
 * scroll it like any page, with scrollbars, momentum and hand-over to the page at the
 * edges; Ctrl/⌘ + wheel or a pinch zooms around the pointer; dragging with the mouse
 * scrolls it too. Content is drawn at `k` times its natural size.
 */
export function useScrollZoom({ min = 0.3, max = 2.5 }: { min?: number; max?: number } = {}) {
  // The canvas may mount after the page (tabs, loading), so listen to the element itself.
  const elRef = useRef<HTMLDivElement | null>(null);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    setNode(el);
  }, []);
  const [k, setK] = useState(1);
  const kRef = useRef(k);
  kRef.current = k;
  const anchor = useRef<{ px: number; py: number; cx: number; cy: number } | null>(null);
  const dragged = useRef(false);

  // After a zoom renders, scroll so the point under the pointer stays put.
  useLayoutEffect(() => {
    const el = elRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    el.scrollLeft = a.px * k - a.cx;
    el.scrollTop = a.py * k - a.cy;
    anchor.current = null;
  }, [k]);

  const zoomAt = useCallback(
    (cx: number, cy: number, factor: number) => {
      const el = elRef.current;
      if (!el) return;
      const k0 = kRef.current;
      const nk = Math.min(max, Math.max(min, k0 * factor));
      if (nk === k0) return;
      anchor.current = { px: (el.scrollLeft + cx) / k0, py: (el.scrollTop + cy) / k0, cx, cy };
      setK(nk);
    },
    [min, max],
  );

  useEffect(() => {
    const el = node;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel: native scrolling
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
    };
    let last: { x: number; y: number; sx: number; sy: number } | null = null;
    const onDown = (e: PointerEvent) => {
      // Touch scrolls natively; mouse and pen drag-scroll.
      if (e.pointerType === "touch" || e.button !== 0 || (e.target as Element).closest("[data-no-pan]")) return;
      last = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
      dragged.current = false;
    };
    const onMove = (e: PointerEvent) => {
      if (!last) return;
      if (!dragged.current && Math.hypot(e.clientX - last.sx, e.clientY - last.sy) > 4) {
        dragged.current = true;
        el.setPointerCapture(e.pointerId);
      }
      if (dragged.current) {
        el.scrollLeft -= e.clientX - last.x;
        el.scrollTop -= e.clientY - last.y;
      }
      last = { ...last, x: e.clientX, y: e.clientY };
    };
    const onUp = () => {
      last = null;
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
  }, [node, zoomAt]);

  const zoomBy = useCallback(
    (factor: number) => {
      const el = elRef.current;
      if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor);
    },
    [zoomAt],
  );

  /** Set the zoom and scroll back to the top-left corner. */
  const reset = useCallback((nk: number) => {
    setK(Math.min(max, Math.max(min, nk)));
    requestAnimationFrame(() => elRef.current?.scrollTo({ left: 0, top: 0 }));
  }, [min, max]);

  return { ref, el: elRef, k, zoomBy, reset, wasDrag: () => dragged.current };
}
