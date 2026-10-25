/**
 * Server-side filters shared by the paged lists (field picker + value in the table toolbar).
 * Each API filters on its own parameters; these helpers keep the labels and options alike.
 */
import { useMemo } from "react";
import { useProjects } from "./identity";
import {
  type ServerFilter,
  useComputeAZs,
  useFlavors,
  useOsList,
  useVolumeAZs,
} from "./os";
import { tr } from "@/lib/i18n";

const opts = (values: string[], label = (v: string) => v) =>
  values.map((v) => ({ value: v, label: label(v) }));
const title = (v: string) =>
  tr((v.charAt(0) + v.slice(1).toLowerCase()).replace(/_/g, " "));

export const text = (
  key: string,
  label: string,
  param: string,
  placeholder?: string,
): ServerFilter => ({ key, label, param, placeholder });
export const choice = (
  key: string,
  label: string,
  param: string,
  values: string[],
  label2?: (v: string) => string,
): ServerFilter => ({
  key,
  label,
  param,
  options: opts(values, label2),
});

export const NOVA_STATUSES = [
  "ACTIVE",
  "BUILD",
  "SHUTOFF",
  "PAUSED",
  "SUSPENDED",
  "SHELVED_OFFLOADED",
  "RESCUE",
  "RESIZE",
  "VERIFY_RESIZE",
  "MIGRATING",
  "REBOOT",
  "HARD_REBOOT",
  "ERROR",
];
export const VOLUME_STATUSES = [
  "available",
  "in-use",
  "creating",
  "attaching",
  "detaching",
  "extending",
  "downloading",
  "uploading",
  "retyping",
  "backing-up",
  "restoring-backup",
  "awaiting-transfer",
  "maintenance",
  "reserved",
  "deleting",
  "error",
  "error_deleting",
  "error_extending",
];
export const SNAPSHOT_STATUSES = [
  "available",
  "creating",
  "deleting",
  "backing-up",
  "restoring",
  "unmanaging",
  "error",
  "error_deleting",
];
export const BACKUP_STATUSES = [
  "available",
  "creating",
  "deleting",
  "restoring",
  "error",
  "error_deleting",
  "error_restoring",
];
export const NEUTRON_STATUSES = ["ACTIVE", "DOWN", "BUILD", "ERROR"];

export { title as statusLabel };

/** Project filter (admin lists): pick a project by name, filter on its ID. */
export function useProjectFilter(
  enabled: boolean,
  param = "project_id",
): ServerFilter | null {
  const projects = useProjects(enabled);
  return useMemo(
    () =>
      enabled
        ? {
            key: "project",
            label: tr("Project"),
            param,
            placeholder: tr("Any project"),
            options: (projects.data ?? [])
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((p) => ({
                value: p.id,
                label: p.name,
                description: p.id.slice(0, 8),
              })),
          }
        : null,
    [enabled, param, projects.data],
  );
}

/** Compute host (hypervisor) filter for Nova servers (admin only: `host`). */
export function useHostFilter(enabled: boolean): ServerFilter | null {
  const services = useOsList<{ binary: string; host: string }>(
    "compute",
    "os-services",
    "services",
    { binary: "nova-compute" },
    { enabled },
  );
  return useMemo(
    () =>
      enabled
        ? {
            key: "host",
            label: tr("Host (hypervisor)"),
            param: "host",
            placeholder: tr("Any host"),
            options: [
              ...new Set(
                (services.data ?? [])
                  .filter((s) => s.binary === "nova-compute")
                  .map((s) => s.host),
              ),
            ]
              .sort()
              .map((h) => ({ value: h, label: h })),
          }
        : null,
    [enabled, services.data],
  );
}

export function useFlavorFilter(): ServerFilter {
  const flavors = useFlavors();
  return useMemo(
    () => ({
      key: "flavor",
      label: tr("Flavor"),
      param: "flavor",
      options: (flavors.data ?? []).map((f) => ({
        value: f.id,
        label: f.name,
        description: tr("{vcpus} vCPU · {v}", { vcpus: f.vcpus, v: f.ram >= 1024 ? tr("{v} GiB", { v: f.ram / 1024 }) : tr("{ram} MiB", { ram: f.ram }) }),
      })),
    }),
    [flavors.data],
  );
}

export function useZoneFilter(svc: "compute" | "volume"): ServerFilter {
  const compute = useComputeAZs();
  const volume = useVolumeAZs();
  const zones = svc === "compute" ? compute.data : volume.data;
  return useMemo(
    () => choice("zone", tr("Zone"), "availability_zone", zones ?? []),
    [zones],
  );
}

/** Drop the filters that don't apply (null) and keep the order given. */
export const filters = (...f: (ServerFilter | null | false | undefined)[]) =>
  f.filter(Boolean) as ServerFilter[];

/** Find one item by its full ID (`GET <collection>/<id>`): works for every API and role. */
export const idFilter = (collection: string, key: string): ServerFilter => ({
  key: "id",
  label: "ID",
  param: "id",
  placeholder: tr("Full ID (UUID)"),
  byId: (v) => ({
    path: `${collection}/${v.replace(/[^A-Za-z0-9_-]/g, "")}`,
    key,
  }),
});

/** Case-insensitive regular expression test (plain substring when the pattern is invalid). */
export function matches(text: string | null | undefined, pattern: string) {
  try {
    return new RegExp(pattern, "i").test(text ?? "");
  } catch {
    return (text ?? "").toLowerCase().includes(pattern.toLowerCase());
  }
}

/**
 * Name as a regular expression, matched in the browser: for APIs whose `name` filter is an
 * exact match (Neutron). Only used while a name is typed; the list is fetched whole then.
 */
export const nameRegex = (): ServerFilter => ({
  key: "name",
  label: tr("Name"),
  param: "name",
  placeholder: tr("Name (regular expression)"),
  client: (row: { name?: string | null }, v) => matches(row.name, v),
});
