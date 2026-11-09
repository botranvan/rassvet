import { Icon } from "@/components/ui";
import type { CloudInfo, Platform } from "@/lib/session";
import { tr } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { PLATFORMS } from ".";

/** Step 1 of signing in: which kind of cloud. Only platforms with a configured cloud are offered. */
export function PlatformPicker({ clouds, onPick }: { clouds: CloudInfo[]; onPick: (p: Platform) => void }) {
  const offered = PLATFORMS.filter((p) => clouds.some((c) => c.platform === p.id));
  return (
    <div className="space-y-2" role="list" aria-label={tr("Cloud platform")}>
      {offered.map((p) => {
        const count = clouds.filter((c) => c.platform === p.id).length;
        return (
          <button
            key={p.id}
            type="button"
            role="listitem"
            onClick={() => onPick(p.id)}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3 text-left transition-colors",
              "hover:border-cable/60 hover:bg-cable-soft/40 focus-visible:border-cable focus-visible:outline-none",
            )}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-ink/5 text-muted">
              <Icon name={p.icon} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{p.label}</span>
              <span className="block truncate text-xs text-muted">
                {count > 1 ? tr("{count} clouds", { count }) : p.description}
              </span>
            </span>
            <Icon name="chevron-right" className="size-4 shrink-0 text-muted" />
          </button>
        );
      })}
    </div>
  );
}
