/** Glance feature: types and data hooks for /api/image. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Status } from "@/components/ui";
import { api } from "./api";

export type Visibility = "private" | "shared" | "community" | "public";

export interface Image {
  id: string;
  name: string | null;
  status: string;
  visibility: Visibility;
  protected: boolean;
  os_hidden?: boolean;
  disk_format: string | null;
  container_format: string | null;
  size: number | null;
  virtual_size: number | null;
  min_disk: number;
  min_ram: number;
  owner: string;
  created_at: string;
  updated_at: string;
  tags: string[];
  checksum?: string | null;
  os_hash_algo?: string | null;
  os_hash_value?: string | null;
  stores?: string;
  /** Added by Rassvet for images shared with the current project. */
  member_status?: "pending" | "accepted" | "rejected";
  [key: string]: unknown;
}

export interface ImageMember {
  member_id: string;
  image_id: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
  updated_at: string;
}

export interface ImageInfo {
  import_methods: string[];
  stores: { id: string; description?: string; default?: boolean }[];
}

export type ImageView = "project" | "shared" | "public" | "community" | "all";

/** Attributes shown in dedicated fields; everything else is a custom property. */
const KNOWN = new Set([
  "id", "name", "status", "visibility", "protected", "os_hidden", "disk_format", "container_format",
  "size", "virtual_size", "min_disk", "min_ram", "owner", "created_at", "updated_at", "tags",
  "checksum", "os_hash_algo", "os_hash_value", "stores", "member_status", "file", "schema", "self",
  "direct_url", "locations",
]);

export function customProperties(img: Image): [string, string][] {
  return Object.entries(img)
    .filter(([k, v]) => !KNOWN.has(k) && v != null)
    .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
}

/** States in which Glance is still working on the image; lists and details poll. */
export const TRANSITIONAL = new Set(["queued", "saving", "uploading", "importing", "pending_delete"]);

export function imageStatus(s: string): Status {
  if (s === "active") return "ok";
  if (s === "killed" || s === "deleted") return "error";
  if (TRANSITIONAL.has(s)) return "warn";
  return "off"; // deactivated
}

export const DISK_FORMATS = ["qcow2", "raw", "iso", "vmdk", "vhd", "vhdx", "vdi", "ploop", "aki", "ari", "ami"];
export const CONTAINER_FORMATS = ["bare", "ovf", "ova", "docker", "compressed", "aki", "ari", "ami"];

/** Guess the disk format from a file name. Most `.img` cloud images are qcow2. */
export function guessDiskFormat(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "img") return "qcow2";
  return DISK_FORMATS.includes(ext) ? ext : null;
}

/** Well-known properties offered as suggestions in the property editor. */
export const PROPERTY_HINTS = [
  "os_distro", "os_version", "os_type", "architecture", "os_admin_user", "hw_disk_bus", "hw_scsi_model",
  "hw_vif_model", "hw_firmware_type", "hw_machine_type", "hw_qemu_guest_agent", "hw_rng_model",
  "hw_video_model", "os_require_quiesce", "img_config_drive", "hw_cpu_policy", "hw_mem_page_size",
];

// ------------------------------------------------------------------ queries

const enc = encodeURIComponent;
const poll = (busy: boolean) => (busy ? 4000 : false);

export const useImageInfo = () =>
  useQuery({ queryKey: ["image", "info"], queryFn: () => api.get<ImageInfo>("/image/info"), staleTime: 10 * 60_000 });

export function useImages(
  view: ImageView,
  filters: { owner?: string; status?: string; hidden?: boolean; imageType?: "snapshot" | "image" } = {},
  enabled = true,
) {
  const qs = new URLSearchParams({ view });
  if (filters.owner) qs.set("owner", filters.owner);
  if (filters.status) qs.set("status", filters.status);
  if (filters.hidden) qs.set("hidden", "true");
  if (filters.imageType) qs.set("image_type", filters.imageType);
  return useQuery({
    queryKey: ["image", "list", view, filters.owner ?? "", filters.status ?? "", !!filters.hidden, filters.imageType ?? ""],
    enabled,
    queryFn: () => api.get<{ images: Image[]; truncated: boolean }>(`/image/images?${qs}`),
    refetchInterval: (q) => poll(!!q.state.data?.images.some((i) => TRANSITIONAL.has(i.status))),
  });
}

export const useImage = (id: string, enabled = true) =>
  useQuery({
    queryKey: ["image", "one", id],
    enabled: enabled && !!id,
    queryFn: () => api.get<Image>(`/image/images/${enc(id)}`),
    refetchInterval: (q) => poll(!!q.state.data && TRANSITIONAL.has(q.state.data.status)),
  });

export const useImageMembers = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: ["image", "members", id],
    queryFn: () => api.get<{ members: ImageMember[] }>(`/image/images/${enc(id)}/members`).then((r) => r.members),
    enabled,
  });

// ------------------------------------------------------------------ mutations

function useImageMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ["image"] }) });
}

export interface NewImage {
  name: string;
  disk_format: string;
  container_format: string;
  visibility: Visibility;
  min_disk: number;
  min_ram: number;
  protected: boolean;
  tags: string[];
  properties: Record<string, string>;
}

export const useCreateImage = () => useImageMutation((b: NewImage) => api.post<Image>("/image/images", b as never));

export interface ImageUpdate {
  core?: Partial<Pick<Image, "name" | "visibility" | "protected" | "min_disk" | "min_ram" | "os_hidden" | "tags">>;
  set?: Record<string, string>;
  unset?: string[];
}

export const useUpdateImage = () =>
  useImageMutation(({ id, ...body }: ImageUpdate & { id: string }) =>
    api.patch<Image>(`/image/images/${enc(id)}`, body as never),
  );

export const useDeleteImage = () => useImageMutation((id: string) => api.del(`/image/images/${enc(id)}`));

export const useImageAction = () =>
  useImageMutation(({ id, action }: { id: string; action: "deactivate" | "reactivate" }) =>
    api.post(`/image/images/${enc(id)}/${action}`),
  );

export const useImportUrl = () =>
  useImageMutation(({ id, uri, stores }: { id: string; uri: string; stores: string[] }) =>
    api.post(`/image/images/${enc(id)}/import`, { uri, stores }),
  );

export const useAddMember = () =>
  useImageMutation(({ id, member }: { id: string; member: string }) =>
    api.post(`/image/images/${enc(id)}/members`, { member }),
  );

export const useRemoveMember = () =>
  useImageMutation(({ id, member }: { id: string; member: string }) =>
    api.del(`/image/images/${enc(id)}/members/${enc(member)}`),
  );

export const useSetMemberStatus = () =>
  useImageMutation(({ id, member, status }: { id: string; member: string; status: ImageMember["status"] }) =>
    api.put(`/image/images/${enc(id)}/members/${enc(member)}`, { status }),
  );

/** Images a project can boot: its own, accepted shared ones and public ones (active only), by name. */
export function useBootImages(enabled = true) {
  const own = useImages("project", { status: "active" }, enabled);
  const pub = useImages("public", { status: "active" }, enabled);
  const shared = useImages("shared", { status: "active" }, enabled);
  const data = useMemo(() => {
    if (!own.data && !pub.data) return undefined;
    const m = new Map<string, Image>();
    for (const i of [...(own.data?.images ?? []), ...(shared.data?.images ?? []).filter((i) => i.member_status === "accepted"), ...(pub.data?.images ?? [])])
      m.set(i.id, i);
    return [...m.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [own.data, pub.data, shared.data]);
  return { data, isPending: own.isPending || pub.isPending, error: own.error ?? pub.error ?? shared.error };
}
