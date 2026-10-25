/**
 * One-click extra-spec sets above a flavor's key/value editor: confidential computing (SEV,
 * SEV-ES, SEV-SNP, TDX), vGPU, vTPM and Secure Boot. Shows what the guest image still needs
 * and the combinations Nova refuses.
 */
import { CopyButton } from "@/components/CodeBlock";
import { type KvRow, fromRows, toRows } from "@/components/KeyValueEditor";
import { Icon } from "@/components/ui";
import { SPEC_PRESETS, type SpecPreset, activePresets, applyPreset, requiredImageProps, specConflicts } from "@/lib/flavorPresets";
import { cn } from "@/lib/utils";
import { tr } from "@/lib/i18n";

const GROUPS: { id: SpecPreset["group"]; label: string }[] = [
  { id: "confidential", label: tr("Confidential computing") },
  { id: "gpu", label: "GPU" },
  { id: "tpm", label: "TPM" },
  { id: "boot", label: tr("Boot") },
];

export function SpecPresets({ rows, onChange }: { rows: KvRow[]; onChange: (rows: KvRow[]) => void }) {
  const specs = fromRows(rows);
  const active = activePresets(specs);
  const conflicts = specConflicts(specs);
  const image = requiredImageProps(specs);
  const imageCmd = Object.keys(image).length ? `openstack image set ${Object.entries(image).map(([k, v]) => `--property ${k}=${v}`).join(" ")} <image>` : "";
  const notes = [...new Set(active.flatMap((p) => p.notes ?? []))];
  const apply = (p: SpecPreset) => {
    const next = applyPreset(specs, p);
    // Keep the order of rows that stay, append the new keys.
    const kept = rows.filter((r) => r.key.trim() in next && next[r.key.trim()] === (specs[r.key.trim()] ?? r.value));
    const keptKeys = new Set(kept.map((r) => r.key.trim()));
    onChange([...kept.map((r) => ({ ...r, value: next[r.key.trim()] })), ...toRows(Object.fromEntries(Object.entries(next).filter(([k]) => !keptKeys.has(k))))]);
  };
  const remove = (p: SpecPreset) => onChange(rows.filter((r) => !(r.key.trim() in p.specs)));
  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface/50 p-3">
      <div className="flex flex-wrap items-start gap-x-5 gap-y-2">
        {GROUPS.map((g) => (
          <div key={g.id} className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted">{g.label}</p>
            <div className="flex flex-wrap gap-1.5">
              {SPEC_PRESETS.filter((p) => p.group === g.id).map((p) => {
                const on = active.includes(p);
                return (
                  <button
                    key={p.id}
                    type="button"
                    title={`${p.hint}\n${Object.entries(p.specs).map(([k, v]) => `${k}=${v}`).join("\n")}`}
                    aria-pressed={on}
                    onClick={() => (on ? remove(p) : apply(p))}
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors",
                      on ? "border-cable bg-cable-soft text-cable" : "border-line bg-panel hover:border-cable hover:text-cable",
                    )}
                  >
                    <Icon name={on ? "check" : "plus"} className="size-3.5" />
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {conflicts.map((c) => (
        <p key={c} className="flex items-start gap-2 text-sm text-led-red">
          <Icon name="warning" className="mt-0.5 size-4 shrink-0" />
          {c}
        </p>
      ))}
      {imageCmd && (
        <div className="space-y-1">
          <p className="text-xs text-muted">{tr("Guest images also need these properties (Nova refuses or the guest won't boot without them):")}</p>
          <div className="flex min-w-0 items-center gap-2 rounded-md border border-line bg-panel px-3 py-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={imageCmd}>
              {imageCmd}
            </code>
            <CopyButton text={imageCmd} label="" className="h-7 px-2" />
          </div>
        </div>
      )}
      {notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {active.length === 0 && conflicts.length === 0 && <p className="text-xs text-muted">{tr("Presets add the matching extra specs below; click again to remove them. Hosts must support the feature.")}</p>}
    </div>
  );
}
