/** Error returned by the rassvet server, carrying the OpenStack request id when known. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string | null,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[];

/**
 * The cloud this tab works on. A session can be signed in to several clouds; every request
 * names its cloud (`X-Rassvet-Cloud`), so each tab keeps its own, across reloads too.
 * Unset (new tab): the server uses the session's active cloud and the session query sets it.
 */
const CLOUD_KEY = "rassvet.cloud";
let tabCloud: string | null = (() => {
  try {
    return sessionStorage.getItem(CLOUD_KEY);
  } catch {
    return null; /* storage unavailable */
  }
})();

export const currentCloud = () => tabCloud;

export function setCurrentCloud(id: string | null) {
  tabCloud = id;
  try {
    if (id) sessionStorage.setItem(CLOUD_KEY, id);
    else sessionStorage.removeItem(CLOUD_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Headers for requests made outside `api` (XHR uploads). */
export function cloudHeaders(): Record<string, string> {
  return tabCloud ? { "x-rassvet-cloud": tabCloud } : {};
}

/** A plain link (download) to `/api…` for this tab's cloud: links can't send headers. */
export function withCloud(url: string) {
  return tabCloud ? `${url}${url.includes("?") ? "&" : "?"}rassvet_cloud=${encodeURIComponent(tabCloud)}` : url;
}

async function request<T>(method: string, path: string, body?: Json, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...cloudHeaders() };
  if (method !== "GET") headers["x-rassvet-csrf"] = "1";
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.message ?? res.statusText, err.request_id);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, opts?: { signal?: AbortSignal }) => request<T>("GET", path, undefined, opts?.signal),
  post: <T>(path: string, body?: Json) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: Json) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: Json) => request<T>("PATCH", path, body ?? {}),
  del: <T>(path: string, body?: Json) => request<T>("DELETE", path, body),
};
