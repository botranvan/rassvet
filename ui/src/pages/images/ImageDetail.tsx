import { ComboInput } from "@/components/ComboInput";
import { useState } from "react";
import { useParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { ConfirmDialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { useUploads } from "@/components/UploadTray";
import { Badge, Button, Card, Detail, ErrorNotice, Icon, Mono, PageHeader, StatusDot } from "@/components/ui";
import { fmtBytes, fmtDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import {
  TRANSITIONAL,
  customProperties,
  imageStatus,
  useAddMember,
  useDeleteImage,
  useImage,
  useImageAction,
  useImageMembers,
  useRemoveMember,
  useSetMemberStatus,
} from "@/lib/image";
import { indexMetadefs, propLabel, useMetadefs } from "@/lib/metadefs";
import { useSession } from "@/lib/session";
import { EditImageDialog, UploadDataDialog } from "./ImageDialogs";
import { useProjectName } from "./ImageList";
import { tr, trx } from "@/lib/i18n";

const STATUS_HELP: Record<string, string> = {
  queued: tr("The image has no data yet. Upload a file or import from a URL."),
  saving: tr("Glance is storing the uploaded data."),
  uploading: tr("Data is being staged for import."),
  importing: tr("Glance is importing the data. This can take a few minutes for large images."),
  deactivated: tr("Servers can't be created from this image and its data can't be downloaded until an admin reactivates it."),
  killed: tr("Storing the data failed. Delete the image and create it again."),
};

export default function ImageDetail({ admin = false }: { admin?: boolean }) {
  const { id = "" } = useParams();
  const image = useImage(id);
  const session = useSession().data!;
  const projectName = useProjectName(admin);
  const del = useDeleteImage();
  const action = useImageAction();
  const toast = useToast();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<false | "details" | "metadata">(false);
  const [deleting, setDeleting] = useState(false);
  const [addingData, setAddingData] = useState(false);
  const base = admin ? "/admin/compute/images" : "/compute/images";

  const img = image.data;
  const upload = useUploads().items.find((u) => u.imageId === id && u.state === "uploading");
  const pct = upload?.total ? Math.round((upload.loaded / upload.total) * 100) : 0;
  const owner = !!img && img.owner === session.project?.id;
  const canEdit = owner || session.is_admin;
  const props = img ? customProperties(img) : [];

  return (
    <>
      <Link to={base} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Images")}
      </Link>
      <PageHeader
        title={img ? img.name || tr("Unnamed image") : tr("Image")}
        description={img ? tr("{v} image, {v2}, owned by {projectName}", { v: img.disk_format ?? tr("unknown"), v2: fmtBytes(img.size) ?? tr("no data yet"), projectName: projectName(img.owner) }) : undefined}
        actions={
          img && (
            <>
              {canEdit && img.status === "queued" && !upload && (
                <Button variant="primary" onClick={() => setAddingData(true)}>
                  <Icon name="upload" />
                  {tr("Add data")}
                </Button>
              )}
              {canEdit && (
                <Button onClick={() => setEditing("details")}>
                  <Icon name="pencil" />
                  {tr("Edit")}
                </Button>
              )}
              {img.status === "active" && (
                <a
                  href={`/api/image/images/${encodeURIComponent(img.id)}/file`}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-panel px-3.5 text-sm font-medium hover:bg-surface"
                >
                  <Icon name="download" />
                  {tr("Download")}
                </a>
              )}
              {session.is_admin && (img.status === "active" || img.status === "deactivated") && (
                <Button
                  busy={action.isPending}
                  onClick={() =>
                    action.mutate(
                      { id: img.id, action: img.status === "active" ? "deactivate" : "reactivate" },
                      { onSuccess: () => toast(`${img.name} ${img.status === "active" ? tr("deactivated") : tr("reactivated")}`) },
                    )
                  }
                >
                  <Icon name={img.status === "active" ? "lock" : "lock-open"} />
                  {img.status === "active" ? tr("Deactivate") : tr("Reactivate")}
                </Button>
              )}
              {canEdit && (
                <Button
                  onClick={() => setDeleting(true)}
                  disabled={img.protected}
                  title={img.protected ? tr("Turn off Protected (Edit) before deleting") : undefined}
                  className="text-led-red"
                >
                  <Icon name="trash" />
                  {tr("Delete")}
                </Button>
              )}
            </>
          )
        }
      />
      <ErrorNotice error={image.error ?? action.error} className="mb-4" />

      {img && upload && (
        <div className="mb-6 rounded-lg border border-line bg-panel px-4 py-3 text-sm">
          <p>
            <span className="font-medium">{trx("Uploading from this browser, {pct}%.", { pct })}</span>{" "}
            <span className="text-muted">{tr("Keep this tab open until it finishes; you can use other pages meanwhile.")}</span>
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/8">
            <div className="h-full rounded-full bg-cable transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {img && !upload && STATUS_HELP[img.status] && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-line bg-panel px-4 py-3 text-sm">
          <StatusDot status={imageStatus(img.status)} />
          <p>
            <span className="font-medium capitalize">{img.status.replace("_", " ")}.</span> {STATUS_HELP[img.status]}
            {TRANSITIONAL.has(img.status) && <span className="text-muted">{" "}{tr("This page refreshes on its own.")}</span>}
          </p>
        </div>
      )}

      {img && (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Card title={tr("Details")}>
            <dl>
              <Detail label={tr("Status")}>
                <StatusDot status={imageStatus(img.status)} label={img.status.replace("_", " ")} />
              </Detail>
              <Detail label="ID">
                <Mono>{img.id}</Mono>
              </Detail>
              <Detail label={tr("Visibility")}>
                <span className="capitalize">{img.visibility}</span>
                {img.os_hidden && <span className="text-muted">{" "}{tr("(hidden from lists)")}</span>}
              </Detail>
              <Detail label={tr("Protected")}>{img.protected ? tr("Yes, can't be deleted") : tr("No")}</Detail>
              <Detail label={tr("Owner")}>{projectName(img.owner)}</Detail>
              <Detail label={tr("Format")}>
                {img.disk_format ?? "—"} / {img.container_format ?? "—"}
              </Detail>
              <Detail label={tr("Size")}>{fmtBytes(img.size) ?? tr("No data yet")}</Detail>
              {img.virtual_size != null && <Detail label={tr("Virtual size")}>{fmtBytes(img.virtual_size)}</Detail>}
              <Detail label={tr("Minimum disk")}>{img.min_disk ? `${img.min_disk} GB` : tr("Not set")}</Detail>
              <Detail label={tr("Minimum RAM")}>{img.min_ram ? `${img.min_ram} MB` : tr("Not set")}</Detail>
              {img.stores && <Detail label={tr("Stores")}>{img.stores.split(",").join(", ")}</Detail>}
              {img.os_hash_value && (
                <Detail label={img.os_hash_algo ?? tr("Hash")}>
                  <Mono>{img.os_hash_value}</Mono>
                </Detail>
              )}
              <Detail label={tr("Created")}>{fmtDate(img.created_at)}</Detail>
              <Detail label={tr("Updated")}>{fmtDate(img.updated_at)}</Detail>
            </dl>
          </Card>

          <div className="space-y-6">
            <MetadataCard
              entries={props}
              onEdit={canEdit ? () => setEditing("metadata") : undefined}
            />
            {img.tags.length > 0 && (
              <Card title={tr("Tags")}>
                <div className="flex flex-wrap gap-1.5">
                  {img.tags.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
              </Card>
            )}
            <Sharing imageId={img.id} visibility={img.visibility} owner={owner || session.is_admin} admin={admin} />
          </div>
        </div>
      )}

      {img && editing && <EditImageDialog image={img} initialTab={editing} onClose={() => setEditing(false)} />}
      {img && <UploadDataDialog image={img} open={addingData} onClose={() => setAddingData(false)} href={`${base}/${img.id}`} />}
      <ConfirmDialog
        open={deleting}
        onClose={() => {
          del.reset();
          setDeleting(false);
        }}
        title={tr("Delete image?")}
        confirmLabel={tr("Delete image")}
        busy={del.isPending}
        error={del.error}
        onConfirm={() =>
          del.mutate(id, {
            onSuccess: () => {
              toast(tr("Image {name} deleted", { name: img?.name }));
              navigate(base);
            },
          })
        }
      >
        <strong className="font-medium">{img?.name}</strong>{" "}{tr("and its data are deleted. Running servers keep working, but they can't be rebuilt from it. This can't be undone.")}
      </ConfirmDialog>
    </>
  );
}

/** Members of a shared image (owner view) or this project's own membership (recipient view). */
function Sharing({ imageId, visibility, owner, admin }: { imageId: string; visibility: string; owner: boolean; admin: boolean }) {
  const session = useSession().data!;
  const members = useImageMembers(imageId, visibility === "shared");
  const add = useAddMember();
  const remove = useRemoveMember();
  const setStatus = useSetMemberStatus();
  const projectName = useProjectName(admin);
  const toast = useToast();
  const [member, setMember] = useState("");
  // Admins get project suggestions (name + ID) in the share box.
  const shareProjects = useProjects(admin);

  if (visibility !== "shared") {
    return owner ? (
      <Card title={tr("Sharing")}>
        <p className="text-sm text-muted">
          {tr("To share this image with specific projects, set its visibility to Shared, then add them here.")}
        </p>
      </Card>
    ) : null;
  }

  if (!owner) {
    const mine = members.data?.find((m) => m.member_id === session.project?.id);
    return (
      <Card title={tr("Shared with your project")}>
        <ErrorNotice error={members.error ?? setStatus.error} />
        {mine && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>
              {tr("Status:")}{" "}<Badge tone={mine.status === "accepted" ? "accent" : "neutral"}>{mine.status}</Badge>
            </span>
            <div className="ml-auto flex gap-2">
              {mine.status !== "accepted" && (
                <Button
                  variant="primary"
                  className="h-8"
                  busy={setStatus.isPending}
                  onClick={() =>
                    setStatus.mutate({ id: imageId, member: mine.member_id, status: "accepted" }, { onSuccess: () => toast(tr("Image accepted")) })
                  }
                >
                  {tr("Accept")}
                </Button>
              )}
              {mine.status !== "rejected" && (
                <Button
                  className="h-8"
                  onClick={() =>
                    setStatus.mutate({ id: imageId, member: mine.member_id, status: "rejected" }, { onSuccess: () => toast(tr("Image rejected")) })
                  }
                >
                  {tr("Reject")}
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card title={tr("Shared with {v}", { v: members.data ? tr("{length} project{s}", { length: members.data.length, s: members.data.length === 1 ? "" : "s" }) : tr("projects") })} flush>
      <ErrorNotice error={members.error ?? add.error ?? remove.error} className="m-4" />
      <ul>
        {members.data?.map((m) => (
          <li key={m.member_id} className="flex items-center gap-3 border-b border-line px-5 py-2.5 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium" title={m.member_id}>
              {projectName(m.member_id)}
            </span>
            <Badge tone={m.status === "accepted" ? "accent" : m.status === "pending" ? "warn" : "neutral"}>{m.status}</Badge>
            <button
              onClick={() => remove.mutate({ id: imageId, member: m.member_id }, { onSuccess: () => toast(tr("Project removed")) })}
              aria-label={tr("Stop sharing with {projectName}", { projectName: projectName(m.member_id) })}
              className="rounded-md p-1.5 text-muted hover:bg-led-red/10 hover:text-led-red"
            >
              <Icon name="trash" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2 px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!member.trim()) return;
          add.mutate(
            { id: imageId, member: member.trim() },
            {
              onSuccess: () => {
                toast(tr("Project added. It must accept the image before using it."));
                setMember("");
              },
            },
          );
        }}
      >
        <ComboInput
          aria-label={tr("Project ID")}
          mono
          value={member}
          onChange={setMember}
          placeholder={tr("Project ID to share with")}
          className="h-9"
          wrapClassName="flex-1"
          options={(shareProjects.data ?? []).filter((p) => !p.is_domain).map((p) => ({ value: p.id, description: p.name }))}
        />
        <Button type="submit" className="h-9 shrink-0" busy={add.isPending} disabled={!member.trim()}>
          {tr("Share")}
        </Button>
      </form>
    </Card>
  );
}

/** Image metadata with titles and descriptions from the Glance metadata catalog. */
function MetadataCard({ entries, onEdit }: { entries: [string, string][]; onEdit?: () => void }) {
  const defs = useMetadefs();
  const index = indexMetadefs(defs.data);
  const [open, setOpen] = useState<string | null>(null);
  const rows = [...entries].sort(([a], [b]) => (index.get(a)?.title ?? a).localeCompare(index.get(b)?.title ?? b));
  return (
    <Card
      title={tr("Metadata ({length})", { length: entries.length })}
      flush
      actions={
        onEdit && (
          <Button onClick={onEdit} className="h-8">
            <Icon name="pencil" />
            {tr("Edit metadata")}
          </Button>
        )
      }
    >
      {rows.length ? (
        <ul>
          {rows.map(([k, v]) => {
            const def = index.get(k);
            const expanded = open === k;
            return (
              <li key={k} className="border-b border-line last:border-0">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : k)}
                  aria-expanded={expanded}
                  className="grid w-full grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] items-center gap-4 px-5 py-2.5 text-left text-sm hover:bg-surface/60"
                >
                  <span className="min-w-0">
                    <span className="block truncate" title={propLabel(k, def)}>
                      {def?.title ?? k}
                    </span>
                    {def?.title && <span className="block truncate font-mono text-[11.5px] text-muted">{k}</span>}
                  </span>
                  <span className="truncate font-mono text-[13px]" title={v}>
                    {v}
                  </span>
                </button>
                {expanded && (
                  <div className="bg-surface/60 px-5 pt-1 pb-3 text-sm">
                    {def?.description ? (
                      <p className="whitespace-pre-line text-muted">{def.description}</p>
                    ) : (
                      <p className="text-muted">{tr("Custom key, not described in the metadata catalog.")}</p>
                    )}
                    <p className="mt-1.5 font-mono text-[12.5px] break-all">{v}</p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-5 py-6 text-center text-sm text-muted">
          {tr("No metadata. Properties such as Firmware Type (hw_firmware_type) or Disk Bus (hw_disk_bus) tune how Nova boots the image.")}
        </p>
      )}
    </Card>
  );
}
