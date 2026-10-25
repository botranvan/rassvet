import { LANGS, lang, setLang, tr } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** English / Tiếng Việt; switching reloads the page in the chosen language. */
export function LanguagePicker({ className }: { className?: string }) {
  return (
    <div role="radiogroup" aria-label={tr("Language")} className={cn("grid grid-cols-2 gap-1 p-1", className)}>
      {LANGS.map((l) => (
        <button
          key={l.id}
          type="button"
          role="radio"
          aria-checked={lang === l.id}
          onClick={() => setLang(l.id)}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs text-muted hover:bg-surface",
            lang === l.id && "bg-cable-soft text-cable",
          )}
        >
          <span className="rounded border border-current px-1 font-mono text-[10px] leading-4 font-semibold">{l.short}</span>
          {l.label}
        </button>
      ))}
    </div>
  );
}
