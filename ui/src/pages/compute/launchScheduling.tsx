/** The launch wizard's Scheduling step: server group, host (anti-)affinity and custom scheduler hints. */
import { ComboInput } from "@/components/ComboInput";
import { useState } from "react";
import { MultiPicker, Picker } from "@/components/Picker";
import { Button, Card, Field, Icon, Input } from "@/components/ui";
import { POLICY_TEXT, groupPolicy, useServerGroups, useServers } from "@/lib/os";
import { CreateServerGroupDialog } from "./ServerGroups";
import { tr } from "@/lib/i18n";

export interface HintRow {
  key: string;
  name: string;
  value: string;
}

export interface Scheduling {
  group: string;
  differentHost: string[];
  sameHost: string[];
  custom: HintRow[];
}

export const NO_SCHEDULING: Scheduling = { group: "", differentHost: [], sameHost: [], custom: [] };

const HINT_NAME = /^[A-Za-z0-9_.:-]{1,255}$/;
/** Hints with their own fields above, or that the scheduler uses for groups. */
const OWN_FIELDS = new Set(["group", "same_host", "different_host"]);
/** Common hints offered as suggestions (the cloud's enabled filters decide what works). */
const KNOWN_HINTS = [
  { name: "query", help: tr("JSONFilter, e.g. [\">=\", \"$free_ram_mb\", 1024]") },
  { name: "target_cell", help: tr("Cell to build in (admins)") },
  { name: "different_cell", help: tr("List of cells to avoid") },
  { name: "build_near_host_ip", help: tr("SimpleCIDRAffinityFilter: host IP…") },
  { name: "cidr", help: tr("…and its prefix, e.g. /24") },
];

/** Validation message for the step, or null. */
export function schedulingProblem(s: Scheduling): string | null {
  for (const h of s.custom) {
    const n = h.name.trim();
    if (!n && !h.value.trim()) continue;
    if (!HINT_NAME.test(n)) return tr("“{v}” isn't a valid hint name", { v: n || tr("(empty)") });
    if (OWN_FIELDS.has(n)) return tr("Use the fields above for “{n}”", { n });
    if (s.custom.filter((x) => x.name.trim() === n).length > 1) return tr("The hint “{n}” is listed twice", { n });
  }
  const both = s.sameHost.filter((id) => s.differentHost.includes(id));
  if (both.length) return tr("An instance can't be both on the same and on a different host");
  return null;
}

/** A hint value: a JSON list of texts stays a list, anything else is sent as text. */
function hintValue(v: string): string | string[] {
  const t = v.trim();
  if (t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed;
    } catch {
      /* not JSON: send as typed (JSONFilter queries are strings) */
    }
  }
  return t;
}

/** Request fields for /api/compute/launch. */
export function schedulingBody(s: Scheduling) {
  const hints: Record<string, string | string[]> = {};
  if (s.differentHost.length) hints.different_host = s.differentHost;
  if (s.sameHost.length) hints.same_host = s.sameHost;
  for (const h of s.custom) if (h.name.trim() && h.value.trim()) hints[h.name.trim()] = hintValue(h.value);
  return { server_group: s.group || undefined, scheduler_hints: Object.keys(hints).length ? hints : undefined };
}

/** One-line summary for the review step. */
export function schedulingSummary(s: Scheduling, groupName: (id: string) => string, serverName: (id: string) => string) {
  const parts = [
    s.group && tr("group {name}", { name: groupName(s.group) }),
    s.differentHost.length && tr("away from {names}", { names: s.differentHost.map(serverName).join(", ") }),
    s.sameHost.length && tr("with {names}", { names: s.sameHost.map(serverName).join(", ") }),
    ...s.custom.filter((h) => h.name.trim() && h.value.trim()).map((h) => `${h.name.trim()}=${h.value.trim()}`),
  ].filter(Boolean);
  return parts.join("; ");
}

let seq = 0;

export function SchedulingStep({ value, onChange, count }: { value: Scheduling; onChange: (s: Scheduling) => void; count: number }) {
  const groups = useServerGroups();
  const servers = useServers();
  const [creating, setCreating] = useState(false);
  const set = (p: Partial<Scheduling>) => onChange({ ...value, ...p });
  const group = groups.data?.find((g) => g.id === value.group);
  const policy = group && groupPolicy(group);
  const serverOptions = (servers.data ?? []).map((s) => ({
    value: s.id,
    label: s.name,
    icon: "server",
    description: [s.status.toLowerCase(), s.flavor.original_name].filter(Boolean).join(" · "),
  }));
  const setRow = (key: string, p: Partial<HintRow>) => set({ custom: value.custom.map((h) => (h.key === key ? { ...h, ...p } : h)) });

  return (
    <>
      <Card title={tr("Server group")}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1">
              <Field label={tr("Group")} hint={tr("Instances can only join a group when they are launched.")}>
                {(id) => (
                  <Picker
                    id={id}
                    value={value.group}
                    onChange={(g) => set({ group: g })}
                    searchable
                    inlineDescription
                    loading={groups.isPending}
                    options={[
                      { value: "", label: tr("None"), description: tr("no placement policy") },
                      ...(groups.data ?? []).map((g) => {
                        const p = groupPolicy(g);
                        return {
                          value: g.id,
                          label: g.name,
                          icon: "boxes",
                          description: tr("{v} · {length} member{s}", { v: p ? POLICY_TEXT[p].label.toLowerCase() : "", length: g.members.length, s: g.members.length === 1 ? "" : "s" }),
                        };
                      }),
                    ]}
                  />
                )}
              </Field>
            </div>
            <Button className="mb-[1.375rem]" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              {tr("New server group")}
            </Button>
          </div>
          {policy && (
            <p className="rounded-md bg-surface/70 px-3 py-2 text-xs text-muted">
              <span className="font-medium text-ink">{POLICY_TEXT[policy].label}:</span> {POLICY_TEXT[policy].help}
              {group?.rules?.max_server_per_host ? tr(" Up to {max_server_per_host} per host.", { max_server_per_host: group.rules.max_server_per_host }) : ""}
              {policy === "anti-affinity" && count > 1 ? tr(" Launching {count} needs {count} free hosts.", { count }) : ""}
            </p>
          )}
        </div>
      </Card>

      <Card title={tr("Host placement")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("Keep away from")} hint={tr("Run on a different host than these instances (different_host).")}>
            {(id) => (
              <MultiPicker
                id={id}
                values={value.differentHost}
                onChange={(v) => set({ differentHost: v })}
                options={serverOptions}
                loading={servers.isPending}
                searchable
                placeholder={tr("Any host")}
              />
            )}
          </Field>
          <Field label={tr("Keep together with")} hint={tr("Run on the same host as these instances (same_host).")}>
            {(id) => (
              <MultiPicker
                id={id}
                values={value.sameHost}
                onChange={(v) => set({ sameHost: v })}
                options={serverOptions}
                loading={servers.isPending}
                searchable
                placeholder={tr("Any host")}
              />
            )}
          </Field>
        </div>
      </Card>

      <Card
        title={tr("Custom scheduler hints")}
        flush
        actions={
          <Button className="h-8" onClick={() => set({ custom: [...value.custom, { key: `h${++seq}`, name: "", value: "" }] })}>
            <Icon name="plus" />
            {tr("Add hint")}
          </Button>
        }
      >
        <ul>
          {value.custom.map((h) => {
            const n = h.name.trim();
            const bad = !!n && (!HINT_NAME.test(n) || OWN_FIELDS.has(n));
            return (
              <li key={h.key} className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_2rem] items-center gap-2 border-b border-line px-5 py-2.5 last:border-0">
                <ComboInput
                  aria-label={tr("Hint name")}
                  mono
                  value={h.name}
                  onChange={(name) => setRow(h.key, { name })}
                  options={KNOWN_HINTS.map((k) => ({ value: k.name, description: k.help }))}
                  placeholder={tr("name")}
                  invalid={bad}
                  className="h-9"
                />
                <Input
                  aria-label={tr("Value of {v}", { v: n || tr("hint") })}
                  value={h.value}
                  onChange={(e) => setRow(h.key, { value: e.target.value })}
                  placeholder={KNOWN_HINTS.find((k) => k.name === n)?.help ?? tr("text, or a list: [\"a\", \"b\"]")}
                  className="h-9 font-mono text-[13px]"
                />
                <button
                  type="button"
                  aria-label={tr("Remove hint")}
                  onClick={() => set({ custom: value.custom.filter((x) => x.key !== h.key) })}
                  className="grid size-8 place-items-center rounded-md text-muted hover:bg-ink/5 hover:text-ink"
                >
                  <Icon name="x" />
                </button>
              </li>
            );
          })}
          {value.custom.length === 0 && (
            <li className="px-5 py-5 text-sm text-muted">
              {tr("None. Hints only work when the matching scheduler filter is enabled in Nova (e.g. JsonFilter for")}{" "}<code className="font-mono">{tr("query")}</code>).
            </li>
          )}
        </ul>
      </Card>
      <CreateServerGroupDialog open={creating} onClose={() => setCreating(false)} onCreated={(g) => set({ group: g.id })} />
    </>
  );
}
