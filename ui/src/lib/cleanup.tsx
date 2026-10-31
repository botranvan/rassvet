/**
 * Cleanup (Operations › Cleanup): the contract for findings. The host checks core resources;
 * an extension adds its own findings with a `CleanupContribution` (`ExtensionUi.cleanup`),
 * built with the helpers of the `CleanupContext` so its tables look like the host's.
 */
import type { ReactNode } from "react";
import type { BulkAction, Column } from "@/components/DataTable";

const DAY = 86_400_000;

/** Milliseconds since an OpenStack timestamp (naive ones are UTC), or null. */
export function since(iso?: string | null) {
  if (!iso) return null;
  const t = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
  return Number.isNaN(t) ? null : Date.now() - t;
}

/** Idle at least `days` (unknown age counts as old: better shown than hidden). */
export const idle = (days: number, ...iso: (string | null | undefined)[]) => {
  if (!days) return true;
  const ms = iso.map(since).find((x) => x != null);
  return ms == null || ms >= days * DAY;
};

/** One card on the page and the table it opens. */
export interface Finder {
  id: string;
  icon: string;
  title: string;
  hint: string;
  /** Undefined while loading. */
  count?: number;
  /** Next to the count, e.g. "120 GiB". */
  extra?: string;
  loading: boolean;
  error: unknown;
  table: () => ReactNode;
}

export interface CleanupContext {
  /** Admin view: every project. */
  admin: boolean;
  projectId: string;
  /** "Idle for at least" this many days (0: any age). */
  days: number;
  /** Where the extension's pages are (`/ext/<id>` or `/admin/ext/<id>`). */
  base: string;
  /** Idle at least `days` by the first known timestamp. */
  idle: (...iso: (string | null | undefined)[]) => boolean;
  /** A "Project" column in the admin view (none in the project view). */
  projectCol: <T>(id: (r: T) => string | undefined) => Column<T>[];
  ageCol: <T>(header: string, iso: (r: T) => string | null | undefined) => Column<T>;
  /** The findings table, with bulk actions (`table(id, rows, columns, rowLabel, actions, refresh, noun)`). */
  table: <T extends { id: string }>(id: string, rows: T[] | undefined, columns: Column<T>[], label: (r: T) => string, bulk: BulkAction<T>[], refresh: () => void, noun: string) => ReactNode;
}

export interface CleanupContribution {
  /** A hook (called on every render of the page) returning the extension's findings. */
  useFindings: (c: CleanupContext) => Finder[];
}
