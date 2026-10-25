import { useMemo, useState } from "react";
import { Picker } from "./Picker";
import {
  type MetaNamespace,
  type MetaProp,
  type MetaSchema,
  defaultValue,
  describeType,
  IMAGE_SCOPE,
  type MetaScope,
  indexMetadefs,
  propLabel,
  useMetadefs,
  validate,
} from "@/lib/metadefs";
import { cn } from "@/lib/utils";
import { ErrorNotice, Icon } from "./ui";
import { tr, trx } from "@/lib/i18n";

/** Keys Glance manages or that have their own fields; never edited as metadata. */
const RESERVED = new Set([
  "id", "status", "size", "virtual_size", "checksum", "os_hash_algo", "os_hash_value", "owner",
  "created_at", "updated_at", "file", "schema", "self", "direct_url", "locations", "stores",
  "member_status", "name", "visibility", "protected", "min_disk", "min_ram", "os_hidden", "tags",
  "disk_format", "container_format",
]);

export function customKeyError(key: string, scope: MetaScope = IMAGE_SCOPE): string | null {
  if (!key) return null;
  if (scope.resourceType !== "OS::Glance::Image") return key.length > 255 ? tr("Keys can be at most 255 characters") : null;
  if (/[\s/~]/.test(key)) return tr("Keys can't contain spaces, slashes or tildes");
  if (key.length > 255) return tr("Keys can be at most 255 characters");
  if (RESERVED.has(key)) return tr("{key} is managed by Glance or has its own field", { key });
  return null;
}

/** Validation errors for a metadata map, keyed by property. */
export function useMetadataErrors(value: Record<string, string>, scope: MetaScope = IMAGE_SCOPE) {
  const defs = useMetadefs(scope);
  const index = useMemo(() => indexMetadefs(defs.data), [defs.data]);
  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      const e = validate(v, index.get(k)) ?? (scope.resourceType === "OS::Nova::Server" && v.length > 255 ? tr("At most 255 characters") : null);
      if (e) out[k] = e;
    }
    return out;
  }, [value, index]);
}

type Selection = { kind: "prop"; key: string } | { kind: "ns"; ns: MetaNamespace } | null;

/**
 * Two-column metadata editor modelled on Horizon's: definitions from the Glance
 * metadata catalog on the left, the image's metadata on the right, and a
 * description of the selected item underneath.
 */
export function MetadataEditor({
  value,
  onChange,
  scope = IMAGE_SCOPE,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  /** Which definitions to offer; images by default. */
  scope?: MetaScope;
}) {
  const defs = useMetadefs(scope);
  const index = useMemo(() => indexMetadefs(defs.data), [defs.data]);
  const errors = useMetadataErrors(value, scope);
  const [availQ, setAvailQ] = useState("");
  const [existQ, setExistQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [custom, setCustom] = useState("");
  const [selected, setSelected] = useState<Selection>(null);

  const add = (entries: [string, MetaSchema | undefined][]) => {
    const next = { ...value };
    for (const [k, d] of entries) if (!(k in next)) next[k] = defaultValue(d);
    onChange(next);
    if (entries.length === 1) setSelected({ kind: "prop", key: entries[0][0] });
  };
  const remove = (k: string) => {
    const next = { ...value };
    delete next[k];
    onChange(next);
  };

  const customError = customKeyError(custom.trim(), scope) ?? (custom.trim() in value ? tr("Already in the list") : null);

  const matches = (key: string, p: MetaSchema, q: string) =>
    !q || `${key} ${p.title ?? ""} ${p.description ?? ""}`.toLowerCase().includes(q);

  /** Namespaces with their still-available properties after filtering. */
  const available = useMemo(() => {
    const q = availQ.trim().toLowerCase();
    return (defs.data?.namespaces ?? [])
      .map((ns) => {
        const nsHit = !!q && `${ns.display_name ?? ""} ${ns.namespace}`.toLowerCase().includes(q);
        const free = (props: Record<string, MetaSchema>) =>
          Object.entries(props ?? {}).filter(
            ([k, p]) => !p.readonly && !(k in value) && !RESERVED.has(k) && (nsHit || matches(k, p, q)),
          );
        const props = free(ns.properties);
        const objects = (ns.objects ?? [])
          .map((o) => ({ name: o.name, description: o.description, props: free(o.properties) }))
          .filter((o) => o.props.length);
        return { ns, props, objects, count: props.length + objects.reduce((n, o) => n + o.props.length, 0) };
      })
      .filter((g) => g.count > 0);
  }, [defs.data, availQ, value]);

  const existing = Object.keys(value)
    .filter((k) => {
      const q = existQ.trim().toLowerCase();
      return !q || `${k} ${index.get(k)?.title ?? ""} ${value[k]}`.toLowerCase().includes(q);
    })
    .sort((a, b) => (index.get(a)?.title ?? a).localeCompare(index.get(b)?.title ?? b));

  const toggle = (ns: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(ns)) n.delete(ns);
      else n.add(ns);
      return n;
    });

  return (
    <div className="space-y-3">
      <ErrorNotice error={defs.error} />
      <div className="grid gap-4 md:grid-cols-2">
        {/* Available */}
        <section className="flex h-[min(26rem,44vh)] min-h-64 min-w-0 flex-col rounded-lg border border-line">
          <PaneHeader title={tr("Available metadata")} q={availQ} setQ={setAvailQ} />
          <div className="flex gap-2 border-b border-line p-2.5">
            <input
              aria-label={tr("Custom key")}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (custom.trim() && !customError) {
                    add([[custom.trim(), undefined]]);
                    setCustom("");
                  }
                }
              }}
              placeholder={tr("Custom key")}
              aria-invalid={!!customError}
              className={cn(
                "h-8 min-w-0 flex-1 rounded-md border border-line bg-panel px-2.5 font-mono text-[13px] focus:border-cable focus:outline-none",
                customError && "border-led-red",
              )}
            />
            <AddButton
              label={tr("Add custom key")}
              disabled={!custom.trim() || !!customError}
              onClick={() => {
                add([[custom.trim(), undefined]]);
                setCustom("");
              }}
            />
          </div>
          {customError && <p className="border-b border-line px-3 py-1.5 text-xs text-led-red">{customError}</p>}
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {defs.isPending && <li className="px-3 py-4 text-sm text-muted">{tr("Loading the metadata catalog…")}</li>}
            {available.map(({ ns, props, objects, count }) => {
              const expanded = open.has(ns.namespace) || !!availQ.trim();
              const all: [string, MetaSchema][] = [...props, ...objects.flatMap((o) => o.props)];
              return (
                <li key={ns.namespace} className="border-b border-line last:border-0">
                  <div
                    className={cn(
                      "flex items-center gap-2 px-2.5 py-2 hover:bg-surface/70",
                      selected?.kind === "ns" && selected.ns.namespace === ns.namespace && "bg-cable-soft/50",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        toggle(ns.namespace);
                        setSelected({ kind: "ns", ns });
                      }}
                      aria-expanded={expanded}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium"
                    >
                      <Icon name="chevron-down" className={cn("size-3.5 text-muted transition-transform", !expanded && "-rotate-90")} />
                      <span className="truncate" title={ns.display_name ?? ns.namespace}>
                        {ns.display_name || ns.namespace}
                      </span>
                      <span className="shrink-0 text-xs font-normal text-muted tabular-nums">{count}</span>
                    </button>
                    <AddButton label={tr("Add all of {v}", { v: ns.display_name ?? ns.namespace })} onClick={() => add(all)} />
                  </div>
                  {expanded && (
                    <ul className="pb-1">
                      {props.map(([k, p]) => (
                        <PropRow key={k} k={k} p={p} selected={selected} setSelected={setSelected} onAdd={() => add([[k, p]])} />
                      ))}
                      {objects.map((o) => (
                        <li key={o.name}>
                          <div className="flex items-center gap-2 py-1 pr-2.5 pl-8">
                            <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted" title={o.description ?? o.name}>
                              {o.name}
                            </span>
                            <AddButton label={tr("Add all of {name}", { name: o.name })} onClick={() => add(o.props)} />
                          </div>
                          <ul>
                            {o.props.map(([k, p]) => (
                              <PropRow
                                key={k}
                                k={k}
                                p={p}
                                indent
                                selected={selected}
                                setSelected={setSelected}
                                onAdd={() => add([[k, p]])}
                              />
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
            {defs.data && available.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted">
                {availQ ? tr("No definitions match “{availQ}”.", { availQ }) : tr("Every defined property is already set.")}
              </li>
            )}
          </ul>
        </section>

        {/* Existing */}
        <section className="flex h-[min(26rem,44vh)] min-h-64 min-w-0 flex-col rounded-lg border border-line">
          <PaneHeader title={tr("Existing metadata ({length})", { length: Object.keys(value).length })} q={existQ} setQ={setExistQ} />
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {existing.map((k) => {
              const def = index.get(k);
              const err = errors[k];
              return (
                <li
                  key={k}
                  className={cn(
                    "border-b border-line px-2.5 py-2",
                    selected?.kind === "prop" && selected.key === k && "bg-cable-soft/50",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelected({ kind: "prop", key: k })}
                      className="w-[45%] min-w-0 shrink-0 text-left"
                      title={propLabel(k, def)}
                    >
                      <span className="block truncate text-sm font-medium">{def?.title ?? k}</span>
                      {def?.title && <span className="block truncate font-mono text-[11.5px] text-muted">{k}</span>}
                    </button>
                    <ValueInput
                      def={def}
                      value={value[k]}
                      invalid={!!err}
                      onFocus={() => setSelected({ kind: "prop", key: k })}
                      onChange={(v) => onChange({ ...value, [k]: v })}
                    />
                    <button
                      type="button"
                      onClick={() => remove(k)}
                      aria-label={tr("Remove {k}", { k })}
                      className="shrink-0 rounded-md p-1.5 text-muted hover:bg-led-red/10 hover:text-led-red"
                    >
                      <Icon name="x" />
                    </button>
                  </div>
                  {err && <p className="mt-1 text-xs text-led-red">{err}</p>}
                </li>
              );
            })}
            {existing.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted">
                {existQ ? tr("Nothing matches “{existQ}”.", { existQ }) : tr("No metadata yet. Add properties from the left.")}
              </li>
            )}
          </ul>
        </section>
      </div>

      <Description selected={selected} index={index} />
      {defs.data?.source === "bundled" && (
        <p className="text-xs text-muted">
          {tr("Definitions come from Glance's standard catalog, built into Rassvet, because this cloud has none loaded.")}
        </p>
      )}
    </div>
  );
}

function PaneHeader({ title, q, setQ }: { title: string; q: string; setQ: (s: string) => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-3 py-2">
      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h3>
      <div className="relative w-40 shrink-0">
        <Icon name="search" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
        <input
          aria-label={tr("Filter {title}", { title })}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tr("Filter")}
          className="h-8 w-full rounded-md border border-line bg-panel pr-2 pl-8 text-sm focus:border-cable focus:outline-none"
        />
      </div>
    </div>
  );
}

function AddButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid size-7 shrink-0 place-items-center rounded-md bg-cable text-white hover:brightness-110 disabled:opacity-40"
    >
      <Icon name="plus" className="size-3.5" />
    </button>
  );
}

function PropRow({
  k,
  p,
  indent,
  selected,
  setSelected,
  onAdd,
}: {
  k: string;
  p: MetaSchema;
  indent?: boolean;
  selected: Selection;
  setSelected: (s: Selection) => void;
  onAdd: () => void;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-2 py-1.5 pr-2.5 hover:bg-surface/70",
        indent ? "pl-10" : "pl-8",
        selected?.kind === "prop" && selected.key === k && "bg-cable-soft/50",
      )}
    >
      <button type="button" onClick={() => setSelected({ kind: "prop", key: k })} className="min-w-0 flex-1 text-left" title={propLabel(k, p)}>
        <span className="block truncate text-sm">{p.title ?? k}</span>
        {p.title && <span className="block truncate font-mono text-[11.5px] text-muted">{k}</span>}
      </button>
      <AddButton label={tr("Add {v}", { v: p.title ?? k })} onClick={onAdd} />
    </li>
  );
}

function ValueInput({
  def,
  value,
  invalid,
  onChange,
  onFocus,
}: {
  def?: MetaProp;
  value: string;
  invalid: boolean;
  onChange: (v: string) => void;
  onFocus: () => void;
}) {
  const cls = cn(
    "h-8 min-w-0 flex-1 rounded-md border bg-panel px-2 text-sm focus:border-cable focus:outline-none",
    invalid ? "border-led-red" : "border-line",
  );
  const options = def?.enum?.map(String) ?? (def?.type === "boolean" ? ["true", "false"] : null);
  if (options) {
    return (
      <div className="min-w-0 flex-1" onFocus={onFocus}>
        <Picker
          size="sm"
          value={value}
          onChange={onChange}
          className={cn("font-mono text-[13px]", invalid && "border-led-red")}
          panelWidth={200}
          options={[
            ...(!options.includes(value) ? [{ value, label: value || tr("(empty)") }] : []),
            ...options.map((o) => ({ value: o, label: o })),
          ]}
        />
      </div>
    );
  }
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={onFocus}
      inputMode={def?.type === "integer" || def?.type === "number" ? "numeric" : undefined}
      aria-invalid={invalid}
      className={cn(cls, "font-mono text-[13px]")}
    />
  );
}

function Description({ selected, index }: { selected: Selection; index: Map<string, MetaProp> }) {
  let body;
  if (selected?.kind === "prop") {
    const def = index.get(selected.key);
    body = def ? (
      <>
        <p className="font-medium">{propLabel(selected.key, def)}</p>
        <p className="mt-0.5 text-xs text-muted">{def.group}</p>
        {def.description && <p className="mt-2 whitespace-pre-line">{def.description}</p>}
        {describeType(def) && <p className="mt-2 text-xs text-muted">{trx("Accepts: {describeType}", { describeType: describeType(def) })}</p>}
      </>
    ) : (
      <>
        <p className="font-mono font-medium">{selected.key}</p>
        <p className="mt-1 text-muted">{tr("Custom key, not described in the metadata catalog. Any text value is accepted.")}</p>
      </>
    );
  } else if (selected?.kind === "ns") {
    body = (
      <>
        <p className="font-medium">
          {selected.ns.display_name || selected.ns.namespace}{" "}
          <span className="font-mono text-xs font-normal text-muted">{selected.ns.namespace}</span>
        </p>
        {selected.ns.description && <p className="mt-2 whitespace-pre-line">{selected.ns.description}</p>}
      </>
    );
  } else {
    body = <p className="text-muted">{tr("Select an item to see what it does.")}</p>;
  }
  return <div className="max-h-32 min-h-[4.5rem] overflow-y-auto rounded-lg bg-surface px-4 py-3 text-sm">{body}</div>;
}
