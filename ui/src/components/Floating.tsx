import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * A panel floating next to an anchor element (menus, pickers).
 *
 * - Rendered in a portal so table cells and scrolling cards never clip it. Inside a
 *   modal <dialog> the portal goes into the dialog itself, because the dialog lives in
 *   the browser's top layer and anything in <body> would be drawn underneath it.
 * - Fixed positioning, kept in place while the page scrolls; opens upwards when there
 *   is no room below.
 * - Short fade/scale animation in both directions.
 */
export function Floating({
  anchor,
  open,
  onClose,
  children,
  align = "start",
  matchWidth,
  minWidth = 224,
  maxHeight = 360,
  className,
  role,
  label,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  /** Make the panel at least as wide as the anchor (pickers). */
  matchWidth?: boolean;
  minWidth?: number;
  maxHeight?: number;
  className?: string;
  role?: string;
  label?: string;
}) {
  // Keep the panel mounted briefly after closing so it can animate out.
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    const t = setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, 110);
    return () => clearTimeout(t);
  }, [open, mounted]);

  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ style: CSSProperties; up: boolean } | null>(null);

  const place = useCallback(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 6;
    const width = Math.max(minWidth, matchWidth ? r.width : 0);
    const below = vh - r.bottom - gap - 8;
    const above = r.top - gap - 8;
    const natural = panel.current?.scrollHeight ?? maxHeight;
    const want = Math.min(maxHeight, natural);
    const up = below < Math.min(want, 220) && above > below;
    const room = Math.max(120, up ? above : below);
    // Content can make the panel wider than its minimum; place by the real width.
    const real = Math.max(width, panel.current?.offsetWidth ?? 0);
    let left = align === "end" ? r.right - real : r.left;
    left = Math.max(8, Math.min(left, vw - real - 8));
    const style: CSSProperties = {
      position: "fixed",
      left,
      minWidth: width,
      maxWidth: Math.max(width, Math.min(480, vw - 16)),
      maxHeight: Math.min(maxHeight, room),
      ...(up ? { bottom: vh - r.top + gap } : { top: r.bottom + gap }),
    };
    setPos({ style, up });
  }, [anchor, align, matchWidth, minWidth, maxHeight]);

  useLayoutEffect(() => {
    if (!mounted) return;
    place();
    // A second pass once the content has its real height.
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [mounted, place]);

  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const onMove = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    document.addEventListener("mousedown", onDown);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, place, onClose, anchor]);

  if (!mounted || !anchor) return null;
  const host = (anchor.closest("dialog[open]") as HTMLElement | null) ?? document.body;
  return createPortal(
    <div
      ref={panel}
      role={role}
      aria-label={label}
      style={pos?.style ?? { position: "fixed", visibility: "hidden" }}
      className={cn(
        "z-[60] flex flex-col overflow-hidden rounded-xl border border-line bg-panel text-ink shadow-xl shadow-ink/12 ring-1 ring-black/[0.03]",
        pos?.up ? "origin-bottom" : "origin-top",
        leaving ? "animate-pop-out" : pos?.up ? "animate-pop-in-up" : "animate-pop-in",
        className,
      )}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          onClose();
          anchor.focus();
        }
      }}
    >
      {children}
    </div>,
    host,
  );
}
