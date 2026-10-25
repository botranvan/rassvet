/**
 * Small UI preferences (e.g. each table's last filter and sort) kept in the server-side
 * session — so in memcached when it's configured. They come with the session, so they are
 * there on the first render, and last as long as the login. Writes are debounced.
 */
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { SESSION, type SessionInfo, useSession } from "./session";

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function usePref<T>(
  key: string | undefined,
): [T | undefined, (v: T) => void] {
  const session = useSession().data;
  const qc = useQueryClient();
  const value = key ? (session?.prefs?.[key] as T | undefined) : undefined;
  const save = (v: T) => {
    if (!key) return;
    const now = qc.getQueryData<SessionInfo | null>(SESSION)?.prefs?.[key];
    if (JSON.stringify(now) === JSON.stringify(v)) return;
    qc.setQueryData<SessionInfo | null>(
      SESSION,
      (s) => s && { ...s, prefs: { ...s.prefs, [key]: v } },
    );
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        api
          .put(`/session/prefs/${encodeURIComponent(key)}`, v as never)
          .catch(() => undefined);
      }, 600),
    );
  };
  return [value, save];
}
