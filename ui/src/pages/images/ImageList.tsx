import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type BulkAction, type Column, DataTable } from "@/components/DataTable";
import { Picker } from "@/components/Picker";
import { api } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { Badge, Button, Checkbox, ErrorNotice, Icon, PageHeader, StatusDot, Tabs } from "@/components/ui";
import { fmtBytes, fmtDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import { type Image, type ImageView, imageStatus, useImages, useSetMemberStatus } from "@/lib/image";
import { useSession } from "@/lib/session";
import { CreateVolumeDialog, useServerNames } from "../storage/volumeActions";
import { CreateImageDialog, EditImageDialog } from "./ImageDialogs";
import { tr, trx } from "@/lib/i18n";

const STATUSES = ["active", "queued", "saving", "importing", "uploading", "deactivated", "killed", "pending_delete"];

/** Project name lookup: the user's own projects, plus every project for admins. */
export function useProjectName(admin: boolean) {
  const session = useSession().data;
  const all = useProjects(admin || !!session?.is_admin);
  return useMemo(() => {
    const m = new Map(session?.projects.map((p) => [p.id, p.name]));
    for (const p of all.data ?? []) m.set(p.id, p.name);
    return (id: string) => m.get(id) ?? id;
  }, [session, all.data]);
}

/**
 * Images, or with `snapshots` the instance snapshots (images Nova made from instances,
 * `image_type=snapshot`): same actions, plus the instance they were taken from.
 */
export default function ImageList({ admin = false, snapshots = false }: { admin?: boolean; snapshots?: boolean }) {
  const session = useSession().data!;
  const [view, setView] = useState<ImageView>(admin ? "all" : "project");
  const [owner, setOwner] = useState("");
  const [status, setStatus] = useState(() => new URLSearchParams(location.search).get("status") ?? "");
  const [hidden, setHidden] = useState(false);
  const [creating, setCreating] = useState(false);
  const [volumeFrom, setVolumeFrom] = useState<Image | null>(null);
  const [editing, setEditing] = useState<{ image: Image; tab: "details" | "metadata" } | null>(null);
  const [deleting, setDeleting] = useState<Image | null>(null);
  const navigate = useNavigate();
  const images = useImages(view, { owner: admin ? owner : undefined, status, hidden, imageType: snapshots ? "snapshot" : undefined });
  const servers = useServerNames();
  const projectName = useProjectName(admin);
  const projects = useProjects(admin);
  const setMember = useSetMemberStatus();
  const toast = useToast();
  const base = admin ? "/admin/compute/images" : "/compute/images";
  const qc = useQueryClient();
  const enc = encodeURIComponent;
  const mine = (i: Image) => i.owner === session.project?.id || session.is_admin;

  const bulk: BulkAction<Image>[] =
    view === "shared"
      ? (["accepted", "rejected"] as const).map((status) => ({
          id: status,
          label: status === "accepted" ? tr("Accept") : tr("Reject"),
          icon: status === "accepted" ? "check" : "x",
          title: status === "accepted" ? tr("Accept shared images?") : tr("Reject shared images?"),
          past: status,
          body:
            status === "accepted"
              ? tr("Accepted images appear in this project's image lists and can be used to launch servers.")
              : tr("Rejected images are hidden from this project. You can accept them later from this tab."),
          check: (i) => (i.member_status === status ? tr("Already {status}", { status }) : true),
          run: (i) =>
            api.put(`/image/images/${enc(i.id)}/members/${enc(session.project!.id)}`, { status }),
        }))
      : [
          ...(session.is_admin
            ? [
                {
                  id: "deactivate",
                  label: tr("Deactivate"),
                  icon: "lock",
                  title: tr("Deactivate images?"),
                  past: tr("deactivated"),
                  body: tr("New servers can't boot from deactivated images and their data can't be downloaded. Running servers are not affected."),
                  check: (i: Image) => (i.status === "active" ? true : tr("Status is {status}", { status: i.status })),
                  run: (i: Image) => api.post(`/image/images/${enc(i.id)}/deactivate`),
                },
                {
                  id: "reactivate",
                  label: tr("Reactivate"),
                  icon: "lock-open",
                  title: tr("Reactivate images?"),
                  past: tr("reactivated"),
                  check: (i: Image) => (i.status === "deactivated" ? true : tr("Not deactivated")),
                  run: (i: Image) => api.post(`/image/images/${enc(i.id)}/reactivate`),
                },
              ]
            : []),
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete images?"),
            past: tr("deleted"),
            body: tr("Image data is removed permanently. Running servers keep working but can't be rebuilt from these images."),
            check: (i) => (i.protected ? tr("Protected; turn protection off first") : mine(i) ? true : tr("Owned by another project")),
            run: (i) => api.del(`/image/images/${enc(i.id)}`),
          },
        ];

  const columns: Column<Image>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (i) => (
        <span className="inline-flex max-w-full items-center gap-1.5">
          <Link to={`${base}/${i.id}`} className="truncate font-medium text-cable hover:underline">
            {i.name || <span className="text-muted italic">{tr("unnamed")}</span>}
          </Link>
          {i.protected && <Icon name="lock" className="size-3.5 shrink-0 text-muted" />}
        </span>
      ),
      value: (i) => i.name ?? "",
    },
    {
      key: "status", width: "8.5rem",
      header: tr("Status"),
      cell: (i) => <StatusDot status={imageStatus(i.status)} label={i.status.replace("_", " ")} />,
      value: (i) => i.status,
    },
    ...(view === "shared"
      ? [
          {
            key: "member", width: "10.5rem",
            header: tr("Shared with you"),
            wrap: true,
            cell: (i: Image) =>
              i.member_status === "pending" ? (
                <div className="flex gap-1.5">
                  <Button
                    className="h-7 px-2.5 text-xs"
                    variant="primary"
                    onClick={() =>
                      setMember.mutate(
                        { id: i.id, member: session.project!.id, status: "accepted" },
                        { onSuccess: () => toast(tr("{name} accepted", { name: i.name })) },
                      )
                    }
                  >
                    {tr("Accept")}
                  </Button>
                  <Button
                    className="h-7 px-2.5 text-xs"
                    onClick={() =>
                      setMember.mutate(
                        { id: i.id, member: session.project!.id, status: "rejected" },
                        { onSuccess: () => toast(tr("{name} rejected", { name: i.name })) },
                      )
                    }
                  >
                    {tr("Reject")}
                  </Button>
                </div>
              ) : (
                <Badge tone={i.member_status === "accepted" ? "accent" : "neutral"}>{i.member_status}</Badge>
              ),
            value: (i: Image) => i.member_status ?? "",
          } satisfies Column<Image>,
        ]
      : []),
    ...(snapshots
      ? [
          {
            key: "instance",
            header: tr("Instance"),
            width: "11rem",
            hideBelow: "sm",
            cell: (i: Image) =>
              typeof i.instance_uuid === "string" ? (
                <Link to={`/compute/instances/${i.instance_uuid}`} className="text-cable hover:underline">
                  {servers(i.instance_uuid)}
                </Link>
              ) : (
                <span className="text-muted">—</span>
              ),
            value: (i: Image) => (typeof i.instance_uuid === "string" ? servers(i.instance_uuid) : ""),
          } satisfies Column<Image>,
        ]
      : []),
    { key: "visibility", width: "6.5rem", hideBelow: "md", header: tr("Visibility"), cell: (i) => i.visibility, value: (i) => i.visibility },
    ...(admin || view !== "project"
      ? [
          {
            key: "owner", width: "9rem", hideBelow: "lg",
            header: tr("Owner"),
            cell: (i: Image) => projectName(i.owner),
            value: (i: Image) => projectName(i.owner),
          } satisfies Column<Image>,
        ]
      : []),
    { key: "format", width: "5.5rem", hideBelow: "xl", header: tr("Format"), cell: (i) => i.disk_format ?? "", value: (i) => i.disk_format ?? "" },
    {
      key: "size", width: "6rem", hideBelow: "sm",
      header: tr("Size"),
      className: "text-right",
      cell: (i) => <span className="tabular-nums">{fmtBytes(i.size) ?? "—"}</span>,
      value: (i) => i.size ?? -1,
      csv: (i) => i.size ?? "",
    },
    {
      key: "created", width: "8.5rem", hideBelow: "lg",
      header: tr("Created"),
      cell: (i) => fmtDate(i.created_at, false),
      value: (i) => i.created_at,
    },
  ];

  const tabs: { id: ImageView; label: string }[] = snapshots
    ? admin
      ? []
      : [
          { id: "project", label: tr("This project") },
          { id: "shared", label: tr("Shared with me") },
        ]
    : admin
    ? [
        { id: "all", label: tr("All images") },
        { id: "public", label: tr("Public") },
        { id: "community", label: tr("Community") },
      ]
    : [
        { id: "project", label: tr("This project") },
        { id: "shared", label: tr("Shared with me") },
        { id: "public", label: tr("Public") },
        { id: "community", label: tr("Community") },
      ];

  const pending = view === "shared" ? (images.data?.images.filter((i) => i.member_status === "pending").length ?? 0) : 0;

  return (
    <>
      <PageHeader
        title={snapshots ? (admin ? tr("All instance snapshots") : tr("Instance snapshots")) : tr("Images")}
        description={
          snapshots
            ? admin
              ? tr("Images Nova created from instances, in every project.")
              : tr("Images taken from instances with “Create snapshot”. Launch new instances from them, or make a volume.")
            : admin
              ? tr("Every image in the cloud, across all projects.")
              : tr("Operating system and appliance images that servers boot from.")
        }
        actions={
          !snapshots && (
            <Button variant="primary" onClick={() => setCreating(true)} disabled={!session.project}>
              <Icon name="plus" />
              {tr("Create image")}
            </Button>
          )
        }
      />
      {tabs.length > 0 && <Tabs value={view} onChange={setView} tabs={tabs} className="mb-4" />}
      {pending > 0 && (
        <p className="mb-4 rounded-md border border-led-amber/40 bg-led-amber/8 px-4 py-2.5 text-sm">
          {trx("{v} waiting for you to accept or reject. Accepted images appear when launching servers.", { v: pending === 1 ? tr("1 image is") : tr("{pending} images are", { pending }) })}
        </p>
      )}
      {images.data?.truncated && (
        <p className="mb-4 text-sm text-muted">
          {trx("Showing the first {length} images. Narrow the list with the filters.", { length: images.data.images.length })}
        </p>
      )}
      <ErrorNotice error={images.error ?? setMember.error} className="mb-4" />
      <DataTable
        rows={images.data?.images}
        columns={columns}
        rowKey={(i) => i.id}
        loading={images.isPending}
        tableId={`${admin ? "admin-" : ""}${snapshots ? "instance-snapshots" : "images"}`}
        noun={snapshots ? tr("snapshots") : tr("images")}
        rowLabel={(i) => i.name || i.id}
        bulkActions={view === "public" && !session.is_admin ? undefined : bulk}
        rowActions={(i) => [
          { label: tr("View details"), icon: "eye", onSelect: () => navigate(`${base}/${i.id}`) },
          "-",
          {
            label: tr("Launch instance"),
            icon: "rocket",
            disabled: i.status !== "active" ? tr("Status is {status}", { status: i.status }) : !session.project ? tr("No project selected") : false,
            onSelect: () => navigate(`/compute/instances/launch?source=image&id=${i.id}`),
          },
          { label: tr("Create volume"), icon: "hard-drive", disabled: i.status !== "active" ? tr("Status is {status}", { status: i.status }) : false, onSelect: () => setVolumeFrom(i) },
          { label: tr("Edit image"), icon: "edit", disabled: mine(i) ? false : tr("Owned by another project"), onSelect: () => setEditing({ image: i, tab: "details" }) },
          { label: tr("Edit metadata"), icon: "tags", disabled: mine(i) ? false : tr("Owned by another project"), onSelect: () => setEditing({ image: i, tab: "metadata" }) },
          {
            label: tr("Download"),
            icon: "download",
            disabled: i.status !== "active" ? tr("Status is {status}", { status: i.status }) : false,
            onSelect: () => window.open(`/api/image/images/${encodeURIComponent(i.id)}/file`, "_self"),
          },
          view === "shared" && i.member_status !== "accepted" && { label: tr("Accept"), icon: "check", onSelect: () => setMember.mutate({ id: i.id, member: session.project!.id, status: "accepted" }) },
          view === "shared" && i.member_status !== "rejected" && { label: tr("Reject"), icon: "x", onSelect: () => setMember.mutate({ id: i.id, member: session.project!.id, status: "rejected" }) },
          "-",
          {
            label: tr("Delete image"),
            icon: "trash",
            danger: true,
            disabled: !mine(i) ? tr("Owned by another project") : i.protected ? tr("Protected; turn it off in Edit image first") : false,
            onSelect: () => setDeleting(i),
          },
        ]}
        onRefresh={() => images.refetch()}
        refreshing={images.isFetching}
        onBulkDone={() => qc.invalidateQueries({ queryKey: ["image"] })}
        filterPlaceholder={tr("Filter by name, format or owner")}
        empty={
          snapshots
            ? tr("No instance snapshots. Use “Create snapshot” on an instance to make one.")
            : view === "project"
            ? tr("This project has no images of its own yet. Create one, or use a public image.")
            : view === "shared"
              ? tr("No other project has shared an image with this one.")
              : tr("No images here.")
        }
        toolbar={
          <>
            {admin && (
              <Picker
                aria-label={tr("Owner")}
                size="sm"
                className="h-9 w-52"
                value={owner}
                onChange={setOwner}
                searchPlaceholder={tr("Search projects")}
                options={[
                  { value: "", label: tr("All projects") },
                  ...(projects.data ?? [])
                    .filter((p) => !p.is_domain)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            )}
            <Checkbox checked={hidden} onChange={setHidden}>
              {tr("Hidden only")}
            </Checkbox>
            <Picker
              aria-label={tr("Status")}
              size="sm"
              className="h-9 w-40"
              value={status}
              onChange={setStatus}
              options={[{ value: "", label: tr("Any status") }, ...STATUSES.map((s) => ({ value: s, label: s.replace("_", " ") }))]}
            />
          </>
        }
      />
      <CreateImageDialog open={creating} onClose={() => setCreating(false)} detailBase={base} />
      {volumeFrom && (
        <CreateVolumeDialog
          open
          onClose={() => setVolumeFrom(null)}
          initial={{
            source: "image",
            id: volumeFrom.id,
            size: Math.max(volumeFrom.min_disk ?? 0, Math.ceil((volumeFrom.virtual_size ?? volumeFrom.size ?? 0) / 1024 ** 3), 1),
            name: `${volumeFrom.name ?? "image"}-volume`,
          }}
        />
      )}
      {editing && <EditImageDialog image={editing.image} initialTab={editing.tab} onClose={() => setEditing(null)} />}
      {deleting && (
        <ActionDialog
          onClose={() => setDeleting(null)}
          danger
          title={tr("Delete {v}?", { v: deleting.name || tr("image") })}
          submitLabel={tr("Delete image")}
          done={tr("Image {v} deleted", { v: deleting.name || deleting.id })}
          onDone={() => qc.invalidateQueries({ queryKey: ["image"] })}
          run={() => api.del(`/image/images/${enc(deleting.id)}`)}
        >
          <p className="text-sm">{tr("The image data is removed from Glance. Instances already running from it keep working. This can't be undone.")}</p>
        </ActionDialog>
      )}
    </>
  );
}
