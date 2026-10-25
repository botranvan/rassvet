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

async function request<T>(method: string, path: string, body?: Json, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
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
