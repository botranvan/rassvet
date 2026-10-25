import { type ReactNode, createContext, useCallback, useContext, useState } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "./ui";
import { tr } from "@/lib/i18n";

type Tone = "success" | "error";
interface Toast {
  id: number;
  tone: Tone;
  message: ReactNode;
}

const Ctx = createContext<(message: ReactNode, tone?: Tone) => void>(() => {});

/** `const toast = useToast(); toast("Project created")` — short confirmation of a finished action. */
export const useToast = () => useContext(Ctx);

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((message: ReactNode, tone: Tone = "success") => {
    const id = ++seq;
    setItems((t) => [...t, { id, tone, message }]);
    setTimeout(() => setItems((t) => t.filter((x) => x.id !== id)), tone === "error" ? 8000 : 4000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100%-2rem))] flex-col gap-2"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-rack-line bg-rack px-4 py-3 text-sm text-rack-ink shadow-xl shadow-black/25"
          >
            <Icon
              name={t.tone === "success" ? "circle-check" : "warning"}
              className={cn("mt-0.5", t.tone === "success" ? "text-led-green" : "text-led-red")}
            />
            <div className="line-clamp-3 min-w-0 flex-1 break-words text-white">{t.message}</div>
            <button
              onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))}
              aria-label={tr("Dismiss")}
              className="text-rack-dim hover:text-white"
            >
              <Icon name="x" className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
