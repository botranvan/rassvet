/** Glance metadata definitions catalog (metadefs) for images. */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { tr } from "@/lib/i18n";

export interface MetaSchema {
  title?: string;
  description?: string;
  type?: "string" | "integer" | "number" | "boolean" | "array" | string;
  enum?: (string | number | boolean)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  readonly?: boolean;
  items?: { type?: string; enum?: (string | number)[] };
  operators?: string[];
}

export interface MetaNamespace {
  namespace: string;
  display_name?: string | null;
  description?: string | null;
  properties: Record<string, MetaSchema>;
  objects: { name: string; description?: string | null; properties: Record<string, MetaSchema> }[];
}

export interface Metadefs {
  /** `cloud` = the cloud's own catalog; `bundled` = Glance's defaults shipped with Rassvet. */
  source: "cloud" | "bundled";
  namespaces: MetaNamespace[];
}

/** A property definition with where it came from. */
export interface MetaProp extends MetaSchema {
  key: string;
  namespace: string;
  group: string;
}

/** What the definitions are for: images (default), or Nova server metadata / scheduler hints. */
export type MetaScope = { resourceType: "OS::Glance::Image" } | { resourceType: "OS::Nova::Server"; target: "metadata" | "scheduler_hints" };
export const IMAGE_SCOPE: MetaScope = { resourceType: "OS::Glance::Image" };
export const SERVER_METADATA: MetaScope = { resourceType: "OS::Nova::Server", target: "metadata" };

export const useMetadefs = (scope: MetaScope = IMAGE_SCOPE) =>
  useQuery({
    queryKey: ["image", "metadefs", scope.resourceType, "target" in scope ? scope.target : ""],
    queryFn: () => {
      if (scope.resourceType === "OS::Glance::Image") return api.get<Metadefs>("/image/metadefs");
      const q = new URLSearchParams({ resource_type: scope.resourceType, target: scope.target });
      return api.get<Metadefs>(`/image/metadefs?${q}`);
    },
    staleTime: Infinity,
  });

/** Flat lookup of every defined property key → definition. First definition wins. */
export function indexMetadefs(m: Metadefs | undefined): Map<string, MetaProp> {
  const out = new Map<string, MetaProp>();
  for (const ns of m?.namespaces ?? []) {
    const group = ns.display_name || ns.namespace;
    for (const [key, p] of Object.entries(ns.properties ?? {})) {
      if (!out.has(key)) out.set(key, { ...p, key, namespace: ns.namespace, group });
    }
    for (const o of ns.objects ?? []) {
      for (const [key, p] of Object.entries(o.properties ?? {})) {
        if (!out.has(key)) out.set(key, { ...p, key, namespace: ns.namespace, group: `${group}: ${o.name}` });
      }
    }
  }
  return out;
}

/** Label in the form "Firmware Type (hw_firmware_type)". */
export function propLabel(key: string, def?: MetaSchema) {
  return def?.title && def.title !== key ? `${def.title} (${key})` : key;
}

/** Initial value when a property is added: its default, else the first allowed value. */
export function defaultValue(def?: MetaSchema): string {
  if (def?.default !== undefined && def.default !== null) return String(def.default);
  if (def?.enum?.length) return String(def.enum[0]);
  if (def?.type === "boolean") return "false";
  return "";
}

/** Validate a value against its definition. Returns a message, or null when valid. */
export function validate(value: string, def?: MetaSchema): string | null {
  if (!def) return null;
  const v = value.trim();
  if (def.enum?.length && !def.enum.map(String).includes(v)) {
    return tr("Must be one of: {enum}", { enum: def.enum.join(", ") });
  }
  if (def.type === "boolean" && !["true", "false"].includes(v.toLowerCase())) return tr("Must be true or false");
  if (def.type === "integer" || def.type === "number") {
    if (v === "") return tr("A number is required");
    const n = Number(v);
    if (Number.isNaN(n) || (def.type === "integer" && !Number.isInteger(n))) {
      return def.type === "integer" ? tr("Must be a whole number") : tr("Must be a number");
    }
    if (def.minimum != null && n < def.minimum) return tr("Must be at least {minimum}", { minimum: def.minimum });
    if (def.maximum != null && n > def.maximum) return tr("Must be at most {maximum}", { maximum: def.maximum });
  }
  if (def.type === "string" || !def.type) {
    if (def.minLength != null && v.length < def.minLength) return tr("Must be at least {minLength} characters", { minLength: def.minLength });
    if (def.maxLength != null && v.length > def.maxLength) return tr("Must be at most {maxLength} characters", { maxLength: def.maxLength });
    if (def.pattern) {
      try {
        if (!new RegExp(`^(?:${def.pattern})$`).test(v)) return tr("Must match {pattern}", { pattern: def.pattern });
      } catch {
        /* pattern not valid in JS: let Glance judge */
      }
    }
  }
  return null;
}

/** Short summary of what a property accepts, for the description panel. */
export function describeType(def: MetaSchema): string | null {
  const parts: string[] = [];
  if (def.enum?.length) parts.push(tr("One of: {enum}", { enum: def.enum.join(", ") }));
  else if (def.type === "boolean") parts.push(tr("true or false"));
  else if (def.type === "integer" || def.type === "number") {
    const range =
      def.minimum != null && def.maximum != null
        ? tr(" from {minimum} to {maximum}", { minimum: def.minimum, maximum: def.maximum })
        : def.minimum != null
          ? tr(", at least {minimum}", { minimum: def.minimum })
          : def.maximum != null
            ? tr(", at most {maximum}", { maximum: def.maximum })
            : "";
    parts.push(`${def.type === "integer" ? tr("Whole number") : "Number"}${range}`);
  } else if (def.type === "array") {
    parts.push(def.items?.enum?.length ? tr("List of: {enum}", { enum: def.items.enum.join(", ") }) : "List");
  } else if (def.pattern) parts.push(tr("Text matching {pattern}", { pattern: def.pattern }));
  if (def.default !== undefined && def.default !== null) parts.push(`default ${String(def.default)}`);
  return parts.length ? parts.join("; ") : null;
}
