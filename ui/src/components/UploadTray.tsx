import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "@/lib/api";
import { fmtBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Icon } from "./ui";
import { tr, trx } from "@/lib/i18n";

/**
 * Image uploads run in the background so people can keep working while a
 * multi-gigabyte file streams to Glance. Progress shows in a tray; leaving the
 * page while an upload runs asks for confirmation.
 */

export interface Upload {
  imageId: string;
  name: string;
  href: string;
  loaded: number;
  total: number;
  state: "uploading" | "done" | "error" | "cancelled";
  error?: string;
}

interface Ctx {
  start: (o: { imageId: string; name: string; href: string; file: File; stores?: string[] }) => void;
  /** Uploads of this browser tab, newest last. */
  items: Upload[];
}

const UploadCtx = createContext<Ctx>({ start: () => {}, items: [] });
export const useUploads = () => useContext(UploadCtx);

export function UploadProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Upload[]>([]);
  const xhrs = useRef(new Map<string, XMLHttpRequest>());
  const qc = useQueryClient();

  const patch = useCallback(
    (id: string, p: Partial<Upload>) => setItems((list) => list.map((u) => (u.imageId === id ? { ...u, ...p } : u))),
    [],
  );

  const start: Ctx["start"] = useCallback(
    ({ imageId, name, href, file, stores = [] }) => {
      const xhr = new XMLHttpRequest();
      xhrs.current.set(imageId, xhr);
      setItems((l) => [...l, { imageId, name, href, loaded: 0, total: file.size, state: "uploading" }]);
      const qs = stores.length ? `?stores=${encodeURIComponent(stores.join(","))}` : "";
      xhr.open("PUT", `/api/image/images/${encodeURIComponent(imageId)}/file${qs}`);
      xhr.setRequestHeader("x-rassvet-csrf", "1");
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => patch(imageId, { loaded: e.loaded, total: e.total || file.size });
      xhr.onload = () => {
        xhrs.current.delete(imageId);
        if (xhr.status >= 200 && xhr.status < 300) {
          patch(imageId, { state: "done", loaded: file.size });
        } else {
          let msg = tr("Upload failed ({status})", { status: xhr.status });
          try {
            msg = JSON.parse(xhr.responseText).error.message ?? msg;
          } catch {
            /* keep generic message */
          }
          patch(imageId, { state: "error", error: msg });
        }
        qc.invalidateQueries({ queryKey: ["image"] });
      };
      xhr.onerror = () => {
        xhrs.current.delete(imageId);
        patch(imageId, { state: "error", error: tr("The connection to Rassvet was lost during the upload.") });
      };
      xhr.send(file);
    },
    [patch, qc],
  );

  async function cancel(id: string) {
    xhrs.current.get(id)?.abort();
    xhrs.current.delete(id);
    patch(id, { state: "cancelled" });
    // The image record has no data; remove it so it doesn't linger as "queued".
    await api.del(`/image/images/${encodeURIComponent(id)}`).catch(() => {});
    qc.invalidateQueries({ queryKey: ["image"] });
  }

  const busy = items.some((u) => u.state === "uploading");
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  return (
    <UploadCtx.Provider value={{ start, items }}>
      {children}
      {items.length > 0 && (
        <div className="fixed bottom-4 left-4 z-[55] w-[min(360px,calc(100%-2rem))] overflow-hidden rounded-lg border border-line bg-panel shadow-xl shadow-ink/15 lg:left-[17rem]">
          <div className="flex items-center border-b border-line px-4 py-2.5">
            <h2 className="text-sm font-semibold">
              {busy ? tr("Uploading images") : tr("Uploads finished")}
            </h2>
            {!busy && (
              <button
                onClick={() => setItems([])}
                aria-label={tr("Close uploads")}
                className="ml-auto rounded p-1 text-muted hover:bg-ink/5 hover:text-ink"
              >
                <Icon name="x" className="size-3.5" />
              </button>
            )}
          </div>
          <ul className="max-h-64 overflow-y-auto">
            {items.map((u) => {
              const pct = u.total ? Math.min(100, Math.round((u.loaded / u.total) * 100)) : 0;
              return (
                <li key={u.imageId} className="border-b border-line px-4 py-3 last:border-0">
                  <div className="flex items-center gap-2 text-sm">
                    <Link to={u.href} className="min-w-0 flex-1 truncate font-medium hover:text-cable" title={u.name}>
                      {u.name}
                    </Link>
                    {u.state === "uploading" ? (
                      <button onClick={() => cancel(u.imageId)} className="text-xs text-muted hover:text-led-red">
                        {tr("Cancel")}
                      </button>
                    ) : (
                      <span
                        className={cn(
                          "text-xs",
                          u.state === "done" && "text-led-green",
                          u.state === "error" && "text-led-red",
                          u.state === "cancelled" && "text-muted",
                        )}
                      >
                        {u.state === "done" ? tr("Uploaded") : u.state === "error" ? tr("Failed") : tr("Cancelled")}
                      </span>
                    )}
                  </div>
                  {u.state === "uploading" && (
                    <>
                      <div
                        className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/8"
                        role="progressbar"
                        aria-valuenow={pct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <div className="h-full rounded-full bg-cable transition-[width]" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-muted tabular-nums">
                        {trx("{loaded} of {total}, {pct}%", { loaded: fmtBytes(u.loaded), total: fmtBytes(u.total), pct })}
                      </p>
                    </>
                  )}
                  {u.state === "done" && (
                    <p className="mt-1 text-xs text-muted">{tr("Glance is processing the image; its status turns active when ready.")}</p>
                  )}
                  {u.error && <p className="mt-1 line-clamp-2 text-xs text-led-red">{u.error}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </UploadCtx.Provider>
  );
}
