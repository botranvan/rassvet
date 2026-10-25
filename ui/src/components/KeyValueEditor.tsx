import { ComboInput } from "./ComboInput";
import { Button, Icon, Input } from "./ui";
import { tr } from "@/lib/i18n";

export interface KeySuggestion {
  key: string;
  hint?: string;
  /** Typical values, offered in the value box's suggestions. */
  values?: string[];
}

export type KvRow = { key: string; value: string };

export const toRows = (o: Record<string, string> | undefined): KvRow[] => Object.entries(o ?? {}).map(([key, value]) => ({ key, value }));
export const fromRows = (rows: KvRow[]) => Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));

/** Same keys and values, whatever the order. */
export function sameKv(a: Record<string, string>, b: Record<string, string>) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
}

/** First problem with the rows (empty or repeated keys), or null. */
export function kvError(rows: KvRow[]) {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) return r.value ? tr("Every value needs a key") : null;
    if (seen.has(k)) return tr("\"{k}\" is listed twice", { k });
    seen.add(k);
  }
  return null;
}

/**
 * Apply an edited key/value set: one call that sets new and changed keys, one delete per removed key.
 * Specs APIs in Cinder (extra specs, QoS specs, group specs) all work this way.
 */
export async function saveKv(
  before: Record<string, string>,
  after: Record<string, string>,
  set: (changed: Record<string, string>) => Promise<unknown>,
  unset: (keys: string[]) => Promise<unknown>,
) {
  const changed = Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k] !== v));
  const removed = Object.keys(before).filter((k) => !(k in after));
  if (Object.keys(changed).length) await set(changed);
  if (removed.length) await unset(removed);
}

/** Editable list of free-form key/value pairs, with suggested keys and values. */
export function KeyValueEditor({
  rows,
  onChange,
  suggestions = [],
  keyPlaceholder = "key",
  valuePlaceholder = "value",
  addLabel = tr("Add"),
  empty = tr("Nothing set."),
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  suggestions?: KeySuggestion[];
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  empty?: string;
}) {
  const used = new Set(rows.map((r) => r.key.trim()));
  const unused = suggestions.filter((s) => !used.has(s.key));
  const set = (i: number, patch: Partial<KvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const dupes = new Set(rows.map((r) => r.key.trim()).filter((k, i, a) => k && a.indexOf(k) !== i));
  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-sm text-muted">{empty}</p>}
      {rows.map((r, i) => {
        const sug = suggestions.find((s) => s.key === r.key.trim());
        return (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-2">
            <div className="min-w-0">
              <ComboInput
                aria-label={tr("Key {v}", { v: i + 1 })}
                mono
                value={r.key}
                placeholder={keyPlaceholder}
                invalid={dupes.has(r.key.trim())}
                // Keys not used by another row (this row's own key stays listed).
                options={suggestions.filter((s) => s.key === r.key.trim() || !used.has(s.key)).map((s) => ({ value: s.key, description: s.hint }))}
                onChange={(key) => set(i, { key })}
                onPick={(o) => {
                  const values = suggestions.find((s) => s.key === o.value)?.values;
                  // A typical value for a freshly picked key, unless one was typed already.
                  set(i, { key: o.value, value: r.value || values?.[0] || "" });
                }}
              />
              {sug?.hint && <p className="mt-1 truncate text-xs text-muted" title={sug.hint}>{sug.hint}</p>}
            </div>
            <div className="min-w-0">
              {sug?.values ? (
                <ComboInput
                  aria-label={tr("Value {v}", { v: i + 1 })}
                  mono
                  value={r.value}
                  placeholder={valuePlaceholder}
                  options={sug.values.map((v) => ({ value: v }))}
                  onChange={(value) => set(i, { value })}
                />
              ) : (
                <Input
                  aria-label={tr("Value {v}", { v: i + 1 })}
                  value={r.value}
                  placeholder={valuePlaceholder}
                  onChange={(e) => set(i, { value: e.target.value })}
                  className="font-mono text-[13px]"
                />
              )}
            </div>
            <Button type="button" variant="ghost" className="px-2.5" aria-label={tr("Remove {v}", { v: r.key || tr("row") })} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <Icon name="x" />
            </Button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" onClick={() => onChange([...rows, { key: "", value: "" }])}>
          <Icon name="plus" />
          {addLabel}
        </Button>
        {unused.slice(0, 4).map((s) => (
          <button
            key={s.key}
            type="button"
            title={s.hint}
            onClick={() => onChange([...rows.filter((r) => r.key || r.value), { key: s.key, value: s.values?.[0] ?? "" }])}
            className="max-w-full truncate rounded-md border border-dashed border-line px-2 py-1 font-mono text-xs text-muted hover:border-cable hover:text-cable"
          >
            + {s.key}
          </button>
        ))}
      </div>
    </div>
  );
}
