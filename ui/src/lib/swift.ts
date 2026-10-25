/**
 * Object storage (Swift API on OpenStack Swift or Ceph RGW) through `/api/object-store/*`.
 * Containers and objects are addressed by name; object names may contain "/" (pseudo-folders).
 */
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { RemotePaging } from "@/components/DataTable";
import { api } from "./api";
import { tr } from "@/lib/i18n";

export interface AccountStats {
  containers: number | null;
  objects: number | null;
  bytes: number | null;
  quota_bytes: number | null;
  has_temp_url_key: boolean;
  bytes_by_policy: Record<string, number>;
  metadata: Record<string, string>;
}

export interface SwiftPolicy {
  name: string;
  default?: boolean;
  aliases?: string;
}

export interface SwiftInfo {
  endpoint: string;
  account: AccountStats;
  /** `/info` of the cluster (null when not published). */
  capabilities: (Record<string, unknown> & { swift?: { version?: string; policies?: SwiftPolicy[]; max_file_size?: number; container_listing_limit?: number; max_object_name_length?: number } }) | null;
}

export interface SwiftContainer {
  name: string;
  count: number;
  bytes: number;
  last_modified?: string;
}

export interface ContainerMeta {
  name: string;
  objects: number | null;
  bytes: number | null;
  read_acl: string | null;
  write_acl: string | null;
  storage_policy: string | null;
  history_location: string | null;
  versions_location: string | null;
  quota_bytes: number | null;
  quota_count: number | null;
  has_temp_url_key: boolean;
  last_modified: string | null;
  metadata: Record<string, string>;
}

/** A listing entry: an object, or a pseudo-folder (`subdir`). */
export type Entry = { name: string; bytes: number; content_type: string; last_modified: string; hash: string } | { subdir: string };

export interface ObjectMeta {
  name: string;
  content_type: string | null;
  bytes: number | null;
  etag: string | null;
  last_modified: string | null;
  delete_at: number | null;
  static_large_object: boolean;
  manifest: string | null;
  metadata: Record<string, string>;
}

const enc = encodeURIComponent;
export const objPath = (o: string) => o.split("/").map(enc).join("/");
export const objectUrl = (c: string, o: string) => `/api/object-store/containers/${enc(c)}/objects/${objPath(o)}`;
export const isPublic = (acl?: string | null) => !!acl && acl.split(",").some((p) => p.trim() === ".r:*");

export const swift = {
  info: () => api.get<SwiftInfo>("/object-store/info"),
  containers: (q: Record<string, string | number> = {}) =>
    api.get<{ containers: SwiftContainer[] }>(`/object-store/containers?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`).then((r) => r.containers),
  container: (c: string) => api.get<ContainerMeta>(`/object-store/containers/${enc(c)}`),
  create: (c: string, body: { public?: boolean; storage_policy?: string; history_location?: string; metadata?: Record<string, string> }) => api.put(`/object-store/containers/${enc(c)}`, body),
  update: (c: string, body: Record<string, unknown>) => api.post(`/object-store/containers/${enc(c)}`, body),
  remove: (c: string, recursive = false) => api.del<{ deleted_objects: number }>(`/object-store/containers/${enc(c)}${recursive ? "?recursive=true" : ""}`),
  objects: (c: string, q: Record<string, string | number>) =>
    api.get<{ objects: Entry[] }>(`/object-store/containers/${enc(c)}/objects?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`).then((r) => r.objects),
  folder: (c: string, path: string) => api.post(`/object-store/containers/${enc(c)}/folders`, { path }),
  meta: (c: string, o: string) => api.get<ObjectMeta>(`/object-store/containers/${enc(c)}/meta/${objPath(o)}`),
  /** Delete every object whose name starts with `prefix` (a pseudo-folder and its contents). */
  deletePrefix: (c: string, prefix: string) => api.post<{ deleted_objects: number }>(`/object-store/containers/${enc(c)}/delete-prefix`, { prefix }),
  setMeta: (c: string, o: string, body: { content_type?: string; metadata: Record<string, string>; delete_at?: number | null }) =>
    api.post(`/object-store/containers/${enc(c)}/meta/${objPath(o)}`, body),
  delObject: (c: string, o: string) => api.del(`/object-store/containers/${enc(c)}/objects/${objPath(o)}`),
  copy: (from: { container: string; object: string }, to: { container: string; object: string }, move = false) => api.post("/object-store/copy", { from, to, move }),
  tempUrl: (c: string, o: string, seconds: number) => api.post<{ url: string; expires: number }>(`/object-store/containers/${enc(c)}/tempurl/${objPath(o)}`, { seconds }),
  account: (project: string) => api.get<{ project_id: string; account: AccountStats | null }>(`/object-store/accounts/${enc(project)}`),
  setQuota: (project: string, quota_bytes: number | null) => api.post(`/object-store/accounts/${enc(project)}`, { quota_bytes }),
};

export const useSwiftInfo = () => useQuery({ queryKey: ["object-store", "info"], queryFn: swift.info, staleTime: 30_000 });

/** Every container of the account (Swift lists up to 10 000 per call; follow markers). */
export const useSwiftContainers = () =>
  useQuery({
    queryKey: ["object-store", "containers"],
    queryFn: async () => {
      const all: SwiftContainer[] = [];
      let marker = "";
      for (;;) {
        const page = await swift.containers({ limit: 10000, ...(marker ? { marker } : {}) });
        all.push(...page);
        if (page.length < 10000) break;
        marker = page[page.length - 1].name;
      }
      return all;
    },
  });

export const useContainerMeta = (c: string) => useQuery({ queryKey: ["object-store", "container", c], queryFn: () => swift.container(c) });

/**
 * One folder level of a container, one page at a time: `delimiter=/` + `prefix=<folder>`,
 * marker = last name shown. The text filter narrows the prefix inside the folder.
 */
export function useObjectPages(container: string, folder: string) {
  const qc = useQueryClient();
  const [pageSize, setPageSize] = useState(50);
  const [markers, setMarkers] = useState<string[]>([""]);
  const [needle, setNeedle] = useState("");
  const page = markers.length - 1;
  const prefix = folder + needle;
  const query = useQuery({
    queryKey: ["object-store", "objects", container, prefix, pageSize, markers[page]],
    queryFn: async () => {
      const got = await swift.objects(container, { delimiter: "/", prefix, limit: pageSize + 1, ...(markers[page] ? { marker: markers[page] } : {}) });
      // Swift lists the folder's own marker object ("folder/") inside it; hide that.
      const rows = got.slice(0, pageSize).filter((e) => !("name" in e && e.name === folder));
      return { rows, hasNext: got.length > pageSize, last: got.slice(0, pageSize).map((e) => ("subdir" in e ? e.subdir : e.name)).pop() ?? "" };
    },
    placeholderData: keepPreviousData,
  });
  const reset = () => setMarkers([""]);
  const remote: RemotePaging = {
    page,
    hasNext: !!query.data?.hasNext,
    pageSize,
    fetching: query.isFetching,
    onPageSize: (n) => {
      setPageSize(n);
      reset();
    },
    onNext: () => query.data?.last && setMarkers((m) => [...m, query.data!.last]),
    onPrev: () => setMarkers((m) => (m.length > 1 ? m.slice(0, -1) : m)),
    onFirst: reset,
    filters: [{ key: "prefix", label: tr("Name"), placeholder: tr("Name starts with…") }],
    filter: { key: "prefix", value: needle },
    onFilter: (_k, v) => {
      setNeedle(v);
      reset();
    },
  };
  return { query, rows: query.data?.rows, remote, reset, refresh: () => qc.invalidateQueries({ queryKey: ["object-store"] }) };
}

/** Upload one file with progress (XHR: fetch has no upload progress). */
export function uploadObject(container: string, name: string, file: Blob, onProgress: (loaded: number, total: number) => void) {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    xhr.open("PUT", objectUrl(container, name));
    xhr.setRequestHeader("x-rassvet-csrf", "1");
    xhr.setRequestHeader("Content-Type", (file as File).type || "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.total || file.size);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `HTTP ${xhr.status}`;
      try {
        msg = JSON.parse(xhr.responseText).error.message ?? msg;
      } catch {
        /* keep the status */
      }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.onabort = () => reject(new Error("cancelled"));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}
