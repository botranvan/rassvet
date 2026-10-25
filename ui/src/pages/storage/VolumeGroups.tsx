/**
 * Generic volume groups (Cinder 3.13+): volumes managed together, snapshotted together
 * (consistently, when the group type allows) and cloned as a whole.
 */
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { Link, useInAdmin, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { type MenuEntry, ActionMenu } from "@/components/Menu";
import { MultiPicker, Picker } from "@/components/Picker";
import { Badge, Button, Card, Detail, ErrorNotice, Field, Icon, Input, Mono, PageHeader, StatusDot, Switch, Tabs, Textarea } from "@/components/ui";
import {
  type GroupSnapshot,
  type GroupType,
  type VolumeGroup,
  consistentSnapshots,
  groupBusy,
  reservedGroupType,
  useGroupSnapshots,
  useGroupTypes,
  useVolumeGroups,
} from "@/lib/cinder";
import { datedName, fmtDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import { type Snapshot, type Volume, os, useInvalidate, useOsGet, useSnapshots, useVolumeAZs, useVolumeTypes, useVolumes, volumeStatus } from "@/lib/os";
import { useSession } from "@/lib/session";
import { useTab } from "@/lib/useTab";
import { CreateVolumeDialog } from "./volumeActions";
import { tr, trx } from "@/lib/i18n";

const gName = (g: { name: string | null; id: string }) => g.name || g.id;
const groupStatus = (g: { status: string }) => (groupBusy(g) ? "warn" : volumeStatus(g));

/**
 * Why a group can't be snapshotted right now (null = it can): Cinder snapshots groups that
 * are available or in-use and have volumes. `volumes` is only known with list_volume (3.25+);
 * when missing, let Cinder decide.
 */
function snapshotBlocker(g: VolumeGroup): string | null {
  if (g.status !== "available" && g.status !== "in-use") return tr("Not possible while {status}", { status: g.status });
  if (g.volumes && g.volumes.length === 0) return tr("The group has no volumes");
  return null;
}

function useTypeNames() {
  const types = useVolumeTypes();
  const groupTypes = useGroupTypes();
  return useMemo(() => {
    const vt = new Map(types.data?.map((t) => [t.id, t.name]));
    const gt = new Map(groupTypes.data?.map((t) => [t.id, t]));
    return {
      volumeType: (id: string) => vt.get(id) ?? id,
      groupType: (id: string) => gt.get(id)?.name ?? id,
      groupTypeOf: (id: string) => gt.get(id),
    };
  }, [types.data, groupTypes.data]);
}

/** Admin screens list every project's groups (all_tenants). */
const scopeOf = (admin: boolean) => (admin ? { all_tenants: 1 } : undefined);

export default function VolumeGroups({ admin = false }: { admin?: boolean }) {
  const groups = useVolumeGroups(scopeOf(admin));
  const projects = useProjects(admin);
  const projectName = (id?: string) => (id ? (projects.data?.find((p) => p.id === id)?.name ?? id) : "—");
  const names = useTypeNames();
  const invalidate = useInvalidate();
  const actions = useGroupActions();
  const [creating, setCreating] = useState(false);

  const vtypes = (g: VolumeGroup) => g.volume_types.map(names.volumeType).join(", ");
  const columns: Column<VolumeGroup>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (g) => (
        <Link to={`/storage/groups/${g.id}`} className="font-medium text-cable hover:underline">
          {gName(g)}
        </Link>
      ),
      value: gName,
    },
    ...(admin
      ? [{ key: "project", header: tr("Project"), width: "9rem", hideBelow: "md", cell: (g: VolumeGroup) => projectName(g.project_id), value: (g: VolumeGroup) => projectName(g.project_id) } as Column<VolumeGroup>]
      : []),
    { key: "status", header: tr("Status"), width: "8rem", cell: (g) => <StatusDot status={groupStatus(g)} label={g.status} />, value: (g) => g.status },
    { key: "volumes", header: tr("Volumes"), width: "6rem", className: "text-right", cell: (g) => <span className="tabular-nums">{g.volumes?.length ?? "—"}</span>, value: (g) => g.volumes?.length ?? 0 },
    { key: "group_type", header: tr("Group type"), width: "9rem", hideBelow: "md", cell: (g) => names.groupType(g.group_type), value: (g) => names.groupType(g.group_type) },
    { key: "types", header: tr("Volume types"), hideBelow: "lg", cell: vtypes, value: vtypes },
    { key: "az", header: tr("Zone"), width: "6.5rem", hideBelow: "xl", cell: (g) => g.availability_zone ?? "", value: (g) => g.availability_zone ?? "" },
    { key: "description", header: tr("Description"), hideBelow: "2xl", cell: (g) => <span className="text-muted">{g.description || "—"}</span>, value: (g) => g.description ?? "" },
  ];

  return (
    <>
      <PageHeader
        title={admin ? tr("All volume groups") : tr("Volume groups")}
        description={admin ? tr("Volume groups of every project. Groups you create here belong to your current project.") : tr("Volumes managed as one unit. A group snapshot captures every volume at once (crash-consistent when the group type enables it), and a group can be cloned or rebuilt from a group snapshot.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Create group")}
          </Button>
        }
      />
      <ErrorNotice error={groups.error} className="mb-4" />
      <DataTable
        rows={groups.data}
        columns={columns}
        rowKey={(g) => g.id}
        loading={groups.isPending}
        tableId={admin ? "admin-volume-groups" : "volume-groups"}
        noun={tr("groups")}
        rowLabel={gName}
        empty={admin ? tr("No volume groups in the cloud.") : tr("No volume groups yet.")}
        onRefresh={() => groups.refetch()}
        refreshing={groups.isFetching}
        onBulkDone={() => invalidate("volume")}
        rowActions={(g) => actions.items(g)}
      />
      {creating && <CreateGroupDialog onClose={() => setCreating(false)} />}
      {actions.dialogs}
    </>
  );
}

// =========================================================================== actions

type Kind = "edit" | "manage" | "snapshot" | "clone" | "reset" | "delete";

export function useGroupActions({ onDeleted }: { onDeleted?: () => void } = {}) {
  const session = useSession().data!;
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ kind: Kind; g: VolumeGroup } | null>(null);
  const close = () => setOpen(null);
  const dlg = (g: VolumeGroup, kind: Kind) => () => setOpen({ kind, g });
  const items = (g: VolumeGroup, where: "list" | "detail" = "list"): MenuEntry[] => {
    const ready = g.status === "available" ? false : tr("Not possible while {status}", { status: g.status });
    return [
      where === "list" && { label: tr("View details"), icon: "eye", onSelect: () => navigate(`/storage/groups/${g.id}`) },
      where === "list" && "-",
      { label: tr("Edit group"), icon: "edit", onSelect: dlg(g, "edit") },
      { label: tr("Add or remove volumes"), icon: "list-plus", disabled: ready, onSelect: dlg(g, "manage") },
      { label: tr("Create group snapshot"), icon: "camera", disabled: snapshotBlocker(g) ?? false, onSelect: dlg(g, "snapshot") },
      { label: tr("Clone group"), icon: "copy-plus", disabled: ready, onSelect: dlg(g, "clone") },
      session.is_admin && "-",
      session.is_admin && { heading: tr("Admin") },
      session.is_admin && { label: tr("Reset status"), icon: "rotate-ccw", onSelect: dlg(g, "reset") },
      "-",
      { label: tr("Delete group"), icon: "trash", danger: true, disabled: groupBusy(g) ? tr("Busy ({status})", { status: g.status }) : false, onSelect: dlg(g, "delete") },
    ];
  };
  const o = open;
  const dialogs = o && (
    <>
      {o.kind === "edit" && <EditGroupDialog group={o.g} onClose={close} />}
      {o.kind === "manage" && <ManageVolumesDialog group={o.g} onClose={close} />}
      {o.kind === "snapshot" && <GroupSnapshotDialog group={o.g} onClose={close} />}
      {o.kind === "clone" && <CreateGroupDialog onClose={close} from={{ group: o.g }} />}
      {o.kind === "reset" && <ResetGroupDialog group={o.g} onClose={close} />}
      {o.kind === "delete" && <DeleteGroupDialog group={o.g} onClose={close} onDone={onDeleted} />}
    </>
  );
  return { items, dialogs, openDialog: (g: VolumeGroup, kind: Kind) => setOpen({ kind, g }) };
}

/**
 * Create a group: new (group type + volume types, like Horizon's two-tab form), or as a
 * copy of an existing group or a group snapshot (`create-from-src`).
 */
export function CreateGroupDialog({ onClose, from }: { onClose: () => void; from?: { group?: VolumeGroup; snapshot?: GroupSnapshot } }) {
  const navigate = useNavigate();
  const groupTypes = useGroupTypes();
  const volumeTypes = useVolumeTypes();
  const azs = useVolumeAZs();
  const groups = useVolumeGroups();
  const gsnaps = useGroupSnapshots();
  const names = useTypeNames();
  const [source, setSource] = useState<"new" | "snapshot" | "group">(from?.group ? "group" : from?.snapshot ? "snapshot" : "new");
  const [srcId, setSrcId] = useState(from?.group?.id ?? from?.snapshot?.id ?? "");
  const [tab, setTab] = useState<"info" | "types">("info");
  const [name, setName] = useState(from?.group ? `${gName(from.group)}-clone` : from?.snapshot ? `${gName(from.snapshot)}-group` : "");
  const [description, setDescription] = useState("");
  const [groupType, setGroupType] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [az, setAz] = useState("");
  const usable = (groupTypes.data ?? []).filter((t) => !reservedGroupType(t));
  const gt = groupType || usable[0]?.id || "";
  const fixed = !!from;

  return (
    <ActionDialog<{ group: { id: string } }>
      onClose={onClose}
      size="md"
      title={from?.group ? tr("Clone {gName}", { gName: gName(from.group) }) : from?.snapshot ? tr("Create group from snapshot") : tr("Create volume group")}
      description={
        source === "new"
          ? tr("Volumes added to the group must use one of its volume types.")
          : tr("Cinder creates a new volume for every volume of the source, with the same types.")
      }
      submitLabel={tr("Create group")}
      canSubmit={source === "new" ? !!gt && types.length > 0 : !!srcId}
      done={tr("Creating group {name}", { name }).trim()}
      refresh={["volume"]}
      onDone={(r) => navigate(`/storage/groups/${r.group.id}`)}
      run={() =>
        source === "new"
          ? os.post("volume", "groups", {
              group: { name: name.trim() || undefined, description: description || undefined, group_type: gt, volume_types: types, availability_zone: az || undefined },
            })
          : os.post("volume", "groups/action", {
              "create-from-src": {
                name: name.trim() || undefined,
                description: description || undefined,
                ...(source === "group" ? { source_group_id: srcId } : { group_snapshot_id: srcId }),
              },
            })
      }
    >
      {!fixed && (
        <Tabs
          value={source}
          onChange={(s) => {
            setSource(s);
            setSrcId("");
          }}
          tabs={[
            { id: "new", label: tr("New group") },
            { id: "snapshot", label: tr("From group snapshot") },
            { id: "group", label: tr("Clone a group") },
          ]}
        />
      )}
      {source !== "new" && !fixed && (
        <Field label={source === "group" ? tr("Source group") : tr("Group snapshot")}>
          {(id) => (
            <Picker
              id={id}
              value={srcId}
              onChange={setSrcId}
              searchable
              placeholder={tr("Choose…")}
              loading={source === "group" ? groups.isPending : gsnaps.isPending}
              options={
                source === "group"
                  ? (groups.data ?? []).map((g) => ({
                      value: g.id,
                      label: gName(g),
                      icon: "layers",
                      meta: tr("{v} volumes", { v: g.volumes?.length ?? 0 }),
                      disabled: g.status === "available" ? false : g.status,
                    }))
                  : (gsnaps.data ?? []).map((s) => ({
                      value: s.id,
                      label: gName(s),
                      icon: "camera",
                      meta: fmtDate(s.created_at, false),
                      description: gName(groups.data?.find((g) => g.id === s.group_id) ?? { id: s.group_id, name: null }),
                      disabled: s.status === "available" ? false : s.status,
                    }))
              }
            />
          )}
        </Field>
      )}
      {source === "new" && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "info", label: tr("Group information") },
            { id: "types", label: tr("Volume types{v}", { v: types.length ? ` (${types.length})` : "" }) },
          ]}
        />
      )}
      {(source !== "new" || tab === "info") && (
        <>
          <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        </>
      )}
      {source === "new" && tab === "info" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("Group type")} hint={consistentSnapshots(names.groupTypeOf(gt)) ? tr("Consistent group snapshots") : undefined}>
            {(id) => (
              <Picker
                id={id}
                value={gt}
                onChange={setGroupType}
                loading={groupTypes.isPending}
                placeholder={tr("No group types")}
                options={usable.map((t) => ({ value: t.id, label: t.name, description: t.description ?? undefined }))}
              />
            )}
          </Field>
          <Field label={tr("Availability zone")}>
            {(id) => <Picker id={id} value={az} onChange={setAz} options={[{ value: "", label: tr("Any") }, ...(azs.data ?? []).map((z) => ({ value: z, label: z }))]} />}
          </Field>
        </div>
      )}
      {source === "new" && tab === "types" && (
        <Field label={tr("Volume types")} hint={tr("At least one. Only volumes of these types can join the group.")}>
          {(id) => (
            <MultiPicker
              id={id}
              values={types}
              onChange={setTypes}
              loading={volumeTypes.isPending}
              placeholder={tr("Choose volume types")}
              options={(volumeTypes.data ?? []).map((t) => ({ value: t.id, label: t.name, description: t.description ?? undefined }))}
            />
          )}
        </Field>
      )}
      {source === "new" && tab === "info" && types.length === 0 && (
        <p className="text-sm text-muted">
          {tr("Next, choose the group's volume types on the")}
          <button type="button" className="text-cable hover:underline" onClick={() => setTab("types")}>
            {tr("Volume types")}
          </button>{" "}{tr("tab.")}
        </p>
      )}
    </ActionDialog>
  );
}

function EditGroupDialog({ group, onClose }: { group: VolumeGroup; onClose: () => void }) {
  const [name, setName] = useState(group.name ?? "");
  const [description, setDescription] = useState(group.description ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit {gName}", { gName: gName(group) })}
      submitLabel={tr("Save")}
      done={tr("Group updated")}
      refresh={["volume"]}
      run={() => os.put("volume", `groups/${group.id}`, { group: { name: name.trim(), description } })}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

/** Add volumes of the group's types, or take members out (the volumes are kept). */
function ManageVolumesDialog({ group, onClose }: { group: VolumeGroup; onClose: () => void }) {
  const volumes = useVolumes();
  const names = useTypeNames();
  const allowed = new Set(group.volume_types.map(names.volumeType));
  const members = new Set(group.volumes ?? (volumes.data ?? []).filter((v) => v.group_id === group.id).map((v) => v.id));
  const [chosen, setChosen] = useState<string[]>([...members]);
  const add = chosen.filter((v) => !members.has(v));
  const remove = [...members].filter((v) => !chosen.includes(v));
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Volumes in {gName}", { gName: gName(group) })}
      description={tr("Volumes of type {join} that aren't in another group can join. Removing a volume keeps it.", { join: [...allowed].join(", ") })}
      submitLabel={tr("Save{v}", { v: add.length || remove.length ? ` (+${add.length} −${remove.length})` : "" })}
      canSubmit={add.length + remove.length > 0}
      done={tr("Group membership updated")}
      refresh={["volume"]}
      run={() => os.put("volume", `groups/${group.id}`, { group: { add_volumes: add.join(",") || undefined, remove_volumes: remove.join(",") || undefined } })}
    >
      <Field label={tr("Member volumes")}>
        {(id) => (
          <MultiPicker
            id={id}
            values={chosen}
            onChange={setChosen}
            searchable
            loading={volumes.isPending}
            placeholder={tr("No volumes")}
            options={(volumes.data ?? []).map((v) => ({
              value: v.id,
              label: v.name || v.id,
              icon: "hard-drive",
              meta: tr("{size} GiB", { size: v.size }),
              description: v.volume_type ?? undefined,
              disabled: members.has(v.id)
                ? false
                : v.group_id
                  ? tr("In another group")
                  : !allowed.has(v.volume_type ?? "")
                    ? tr("Type {v} isn't in the group", { v: v.volume_type ?? tr("none") })
                    : !["available", "in-use"].includes(v.status)
                      ? tr("Not possible while {status}", { status: v.status })
                      : false,
            }))}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

function GroupSnapshotDialog({ group, onClose }: { group: VolumeGroup; onClose: () => void }) {
  const names = useTypeNames();
  const [name, setName] = useState(datedName(group.name || `group-${group.id.slice(0, 8)}`));
  const [description, setDescription] = useState("");
  const consistent = consistentSnapshots(names.groupTypeOf(group.group_type));
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Create group snapshot")}
      description={
        consistent
          ? tr("All volumes are snapshotted at the same instant (consistent group snapshot).")
          : tr("Each volume is snapshotted in turn; the group type doesn't enable consistent snapshots.")
      }
      submitLabel={tr("Create snapshot")}
      done={tr("Creating group snapshot {name}", { name })}
      refresh={["volume"]}
      run={() => os.post("volume", "group_snapshots", { group_snapshot: { group_id: group.id, name: name.trim() || undefined, description: description || undefined } })}
    >
      <Field label={tr("Snapshot name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

function DeleteGroupDialog({ group, onClose, onDone }: { group: VolumeGroup; onClose: () => void; onDone?: () => void }) {
  const n = group.volumes?.length ?? 0;
  const [withVolumes, setWithVolumes] = useState(false);
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Delete {gName}?", { gName: gName(group) })}
      submitLabel={withVolumes ? tr("Delete group and {n} volume{s}", { n, s: n === 1 ? "" : "s" }) : tr("Delete group")}
      canSubmit={n === 0 || withVolumes}
      done={tr("Deleting {gName}", { gName: gName(group) })}
      refresh={["volume"]}
      onDone={onDone}
      run={() => os.action("volume", `groups/${group.id}`, { delete: { "delete-volumes": withVolumes } })}
    >
      {n > 0 ? (
        <>
          <p className="text-sm">
            {trx("The group has {n} volume{s}. Remove them from the group first to keep them, or delete them with the group. Attached volumes must be detached.", { n, s: n === 1 ? "" : "s" })}
          </p>
          <Switch checked={withVolumes} onChange={setWithVolumes} label={tr("Also delete the volumes")} hint={tr("Their data is destroyed. This can't be undone.")} />
        </>
      ) : (
        <p className="text-sm">{tr("The group is empty. Its group snapshots must be deleted first.")}</p>
      )}
    </ActionDialog>
  );
}

const GROUP_STATUSES = ["available", "error", "creating", "deleting", "updating", "error_deleting"];

function ResetGroupDialog({ group, onClose }: { group: VolumeGroup; onClose: () => void }) {
  const [status, setStatus] = useState("available");
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Reset status of {gName}?", { gName: gName(group) })}
      description={tr("Now {status}. Only changes what Cinder records.", { status: group.status })}
      submitLabel={tr("Reset status")}
      done={tr("Status set to {status}", { status })}
      refresh={["volume"]}
      run={() => os.action("volume", `groups/${group.id}`, { reset_status: { status } })}
    >
      <Field label={tr("Status")}>{(id) => <Picker id={id} value={status} onChange={setStatus} options={GROUP_STATUSES.map((s) => ({ value: s, label: s }))} />}</Field>
    </ActionDialog>
  );
}

// =========================================================================== detail

const TABS = ["overview", "volumes", "snapshots"] as const;

export function VolumeGroupDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const group = useOsGet<VolumeGroup>("volume", `groups/${id}`, (r: { group: VolumeGroup }) => r.group, { poll: groupBusy, q: { list_volume: "True" } });
  // Admin screens: the group may belong to another project.
  const scope = scopeOf(useInAdmin());
  const volumes = useVolumes(scope);
  const gsnaps = useGroupSnapshots({ group_id: id, ...scope });
  const names = useTypeNames();
  const invalidate = useInvalidate();
  const actions = useGroupActions({ onDeleted: () => navigate("/storage/groups") });
  const [tab, setTab] = useTab(TABS, "overview");
  const [newVolume, setNewVolume] = useState(false);
  const snapActions = useGroupSnapshotActions();
  const g = group.data;
  const memberIds = new Set(g?.volumes ?? []);
  const members = (volumes.data ?? []).filter((v) => memberIds.has(v.id) || v.group_id === id);
  const snaps = (gsnaps.data ?? []).filter((s) => s.group_id === id);
  const gtype: GroupType | undefined = g && names.groupTypeOf(g.group_type);

  const volCols: Column<Volume>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (v) => (
        <Link to={`/storage/volumes/${v.id}`} className="font-medium text-cable hover:underline">
          {v.name || v.id}
        </Link>
      ),
      value: (v) => v.name || v.id,
    },
    { key: "size", header: tr("Size"), width: "5.5rem", className: "text-right", cell: (v) => tr("{size} GiB", { size: v.size }), value: (v) => v.size },
    { key: "status", header: tr("Status"), width: "7.5rem", cell: (v) => <StatusDot status={volumeStatus(v)} label={v.status} />, value: (v) => v.status },
    { key: "type", header: tr("Type"), width: "8rem", hideBelow: "md", cell: (v) => v.volume_type ?? "—", value: (v) => v.volume_type ?? "" },
  ];
  const snapCols: Column<GroupSnapshot>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (s) => (
        <Link to={`/storage/group-snapshots/${s.id}`} className="font-medium text-cable hover:underline">
          {gName(s)}
        </Link>
      ),
      value: gName,
    },
    { key: "status", header: tr("Status"), width: "8rem", cell: (s) => <StatusDot status={groupStatus(s)} label={s.status} />, value: (s) => s.status },
    { key: "created", header: tr("Created"), width: "10rem", hideBelow: "sm", cell: (s) => fmtDate(s.created_at), value: (s) => s.created_at },
    { key: "description", header: tr("Description"), hideBelow: "lg", cell: (s) => <span className="text-muted">{s.description || "—"}</span>, value: (s) => s.description ?? "" },
  ];

  return (
    <>
      <Link to="/storage/groups" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Volume groups")}
      </Link>
      <PageHeader
        title={g ? gName(g) : tr("Volume group")}
        description={g ? tr("{length} volume{s} · group type {groupType}", { length: members.length, s: members.length === 1 ? "" : "s", groupType: names.groupType(g.group_type) }) : undefined}
        actions={g && <ActionMenu variant="button" items={() => actions.items(g, "detail")} />}
      />
      <ErrorNotice error={group.error} className="mb-4" />
      {g && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "volumes", label: tr("Volumes ({length})", { length: members.length }) },
              { id: "snapshots", label: tr("Group snapshots ({v})", { v: gsnaps.isPending ? "…" : snaps.length }) },
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <Card title={tr("Details")}>
                <dl>
                  <Detail label={tr("Name")}>{g.name || "—"}</Detail>
                  <Detail label="ID">
                    <Mono>{g.id}</Mono>
                  </Detail>
                  {g.description && (
                    <Detail label={tr("Description")} wrap>
                      {g.description}
                    </Detail>
                  )}
                  <Detail label={tr("Status")}>
                    <StatusDot status={groupStatus(g)} label={g.status} />
                  </Detail>
                  <Detail label={tr("Zone")}>{g.availability_zone ?? "—"}</Detail>
                  <Detail label={tr("Created")}>{fmtDate(g.created_at)}</Detail>
                  {g.source_group_id && (
                    <Detail label={tr("Cloned from")}>
                      <Link to={`/storage/groups/${g.source_group_id}`} className="text-cable hover:underline">
                        <Mono>{g.source_group_id}</Mono>
                      </Link>
                    </Detail>
                  )}
                  {g.group_snapshot_id && (
                    <Detail label={tr("From snapshot")}>
                      <Link to={`/storage/group-snapshots/${g.group_snapshot_id}`} className="text-cable hover:underline">
                        <Mono>{g.group_snapshot_id}</Mono>
                      </Link>
                    </Detail>
                  )}
                </dl>
              </Card>
              <Card title={tr("Types")}>
                <dl>
                  <Detail label={tr("Group type")}>{names.groupType(g.group_type)}</Detail>
                  <Detail label={tr("Snapshots")}>{consistentSnapshots(gtype) ? <Badge tone="accent">{tr("consistent")}</Badge> : tr("Per volume")}</Detail>
                  <Detail label={tr("Volume types")} wrap>
                    <span className="flex flex-wrap gap-1">
                      {g.volume_types.map((t) => (
                        <Badge key={t}>{names.volumeType(t)}</Badge>
                      ))}
                    </span>
                  </Detail>
                </dl>
              </Card>
            </div>
          )}
          {tab === "volumes" && (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                <Button onClick={() => actions.openDialog(g, "manage")} disabled={g.status !== "available"}>
                  <Icon name="list-plus" />
                  {tr("Add or remove volumes")}
                </Button>
                <Button onClick={() => setNewVolume(true)} disabled={g.status !== "available"}>
                  <Icon name="plus" />
                  {tr("New volume in group")}
                </Button>
              </div>
              <DataTable
                rows={volumes.isPending ? undefined : members}
                columns={volCols}
                rowKey={(v) => v.id}
                loading={volumes.isPending}
                tableId="group-volumes"
                noun={tr("volumes")}
                rowLabel={(v) => v.name || v.id}
                empty={tr("No volumes in this group.")}
                onRefresh={() => volumes.refetch()}
                refreshing={volumes.isFetching}
                onBulkDone={() => invalidate("volume")}
                bulkActions={[
                  {
                    id: "remove",
                    label: tr("Remove from group"),
                    icon: "list-minus",
                    title: tr("Remove volumes from the group?"),
                    past: tr("removed"),
                    body: tr("The volumes are kept; they just leave the group."),
                    run: (v) => os.put("volume", `groups/${id}`, { group: { remove_volumes: v.id } }),
                  },
                ]}
              />
            </>
          )}
          {tab === "snapshots" && (
            <DataTable
              rows={gsnaps.isPending ? undefined : snaps}
              columns={snapCols}
              rowKey={(s) => s.id}
              loading={gsnaps.isPending}
              tableId="group-snapshots"
              noun={tr("group snapshots")}
              rowLabel={gName}
              empty={tr("No group snapshots. Create one from the group's ⋮ menu.")}
              onRefresh={() => gsnaps.refetch()}
              refreshing={gsnaps.isFetching}
              onBulkDone={() => invalidate("volume")}
              rowActions={(s) => snapActions.items(s)}
              bulkActions={[
                {
                  id: "delete",
                  label: tr("Delete"),
                  icon: "trash",
                  danger: true,
                  title: tr("Delete group snapshots?"),
                  past: tr("deleted"),
                  body: tr("The snapshot of every member volume is deleted too. Groups created from them are not affected."),
                  run: (s) => os.del("volume", `group_snapshots/${s.id}`),
                },
              ]}
            />
          )}
        </>
      )}
      {g && newVolume && (
        <CreateVolumeDialog open onClose={() => setNewVolume(false)} group={{ id: g.id, name: gName(g), types: g.volume_types.map(names.volumeType), az: g.availability_zone }} />
      )}
      {snapActions.dialogs}
      {actions.dialogs}
    </>
  );
}

// =========================================================================== group snapshots page

/** Group snapshots of the project (or, on admin screens, of every project). */
export function GroupSnapshots({ admin = false }: { admin?: boolean }) {
  const scope = scopeOf(admin);
  const snaps = useGroupSnapshots(scope);
  const groups = useVolumeGroups(scope);
  const projects = useProjects(admin);
  const invalidate = useInvalidate();
  const [creating, setCreating] = useState(false);
  const actions = useGroupSnapshotActions();
  const groupOf = (id: string) => groups.data?.find((g) => g.id === id);
  const projectName = (id?: string) => (id ? (projects.data?.find((p) => p.id === id)?.name ?? id) : "—");

  const columns: Column<GroupSnapshot>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (s) => (
        <span className="flex min-w-0 flex-col">
          <Link to={`/storage/group-snapshots/${s.id}`} className="truncate font-medium text-cable hover:underline" title={s.description || undefined}>
            {gName(s)}
          </Link>
          <span className="truncate text-xs text-muted">
            {tr("of")}
            <Link to={`/storage/groups/${s.group_id}`} className="text-ink/80 hover:text-cable hover:underline">
              {groupOf(s.group_id) ? gName(groupOf(s.group_id)!) : tr("{group_id}… (deleted)", { group_id: s.group_id.slice(0, 8) })}
            </Link>
          </span>
        </span>
      ),
      value: (s) => `${gName(s)} ${groupOf(s.group_id)?.name ?? ""}`,
      csv: gName,
    },
    ...(admin
      ? [{ key: "project", header: tr("Project"), width: "9rem", hideBelow: "md", cell: (s: GroupSnapshot) => projectName(s.project_id), value: (s: GroupSnapshot) => projectName(s.project_id) } as Column<GroupSnapshot>]
      : []),
    { key: "status", header: tr("Status"), width: "8rem", cell: (s) => <StatusDot status={groupStatus(s)} label={s.status} />, value: (s) => s.status },
    { key: "created", header: tr("Created"), width: "10rem", hideBelow: "sm", cell: (s) => fmtDate(s.created_at), value: (s) => s.created_at },
  ];

  return (
    <>
      <PageHeader
        title={admin ? tr("All group snapshots") : tr("Group snapshots")}
        description={tr("Snapshots of every volume in a volume group, taken together (at the same instant when the group type enables consistent snapshots). Create a new group from one to restore the whole set.")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)} disabled={groups.isPending}>
            <Icon name="plus" />
            {tr("Create group snapshot")}
          </Button>
        }
      />
      <ErrorNotice error={snaps.error} className="mb-4" />
      <DataTable
        rows={snaps.data}
        columns={columns}
        rowKey={(s) => s.id}
        loading={snaps.isPending}
        tableId={admin ? "admin-group-snapshots" : "group-snapshots-page"}
        noun={tr("group snapshots")}
        rowLabel={gName}
        empty={admin ? tr("No group snapshots in the cloud.") : tr("No group snapshots yet. Create one from a volume group.")}
        onRefresh={() => snaps.refetch()}
        refreshing={snaps.isFetching}
        onBulkDone={() => invalidate("volume")}
        rowActions={(s) => actions.items(s, "list")}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete group snapshots?"),
            past: tr("deleted"),
            body: tr("The snapshot of every member volume is deleted too. Groups created from them are not affected."),
            check: (s) => (groupBusy(s) ? tr("Busy ({status})", { status: s.status }) : true),
            run: (s) => os.del("volume", `group_snapshots/${s.id}`),
          },
        ]}
      />
      {creating && <NewGroupSnapshotDialog groups={groups.data ?? []} admin={admin} onClose={() => setCreating(false)} />}
      {actions.dialogs}
    </>
  );
}

/** Every group of the view is listed; the ones Cinder would refuse are greyed out with the reason. */
function NewGroupSnapshotDialog({ groups, admin, onClose }: { groups: VolumeGroup[]; admin: boolean; onClose: () => void }) {
  const names = useTypeNames();
  const usable = groups.filter((g) => !snapshotBlocker(g));
  const [groupId, setGroupId] = useState(usable[0]?.id ?? "");
  const group = groups.find((g) => g.id === groupId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const shownName = name || (group ? datedName(group.name || `group-${group.id.slice(0, 8)}`) : "");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Create group snapshot")}
      description={
        group && (consistentSnapshots(names.groupTypeOf(group.group_type))
          ? tr("All volumes are snapshotted at the same instant (consistent group snapshot).")
          : tr("Each volume is snapshotted in turn; the group type doesn't enable consistent snapshots."))
      }
      submitLabel={tr("Create snapshot")}
      canSubmit={!!group && !snapshotBlocker(group)}
      done={tr("Creating group snapshot {shownName}", { shownName })}
      refresh={["volume"]}
      run={() => os.post("volume", "group_snapshots", { group_snapshot: { group_id: groupId, name: shownName.trim() || undefined, description: description || undefined } })}
    >
      {groups.length === 0 ? (
        <p className="text-sm text-muted">
          {admin ? tr("There are no volume groups in the cloud.") : tr("This project has no volume groups yet.")}{" "}
          <Link to="/storage/groups" className="text-cable hover:underline">
            {tr("Create a volume group")}
          </Link>
        </p>
      ) : (
        <Field label={tr("Volume group")} hint={usable.length === 0 ? tr("None of the groups can be snapshotted right now; the reason is shown next to each.") : undefined}>
          {(id) => (
            <Picker
              id={id}
              value={groupId}
              onChange={setGroupId}
              searchable={groups.length > 8}
              placeholder={tr("Choose a volume group")}
              options={groups.map((g) => ({
                value: g.id,
                label: gName(g),
                description: tr("{v} volume(s) · {groupType}", { v: g.volumes?.length ?? "?", groupType: names.groupType(g.group_type) }),
                icon: "layers",
                disabled: snapshotBlocker(g) ?? false,
              }))}
            />
          )}
        </Field>
      )}
      <Field label={tr("Snapshot name")}>{(id) => <Input id={id} value={shownName} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

// =========================================================================== group snapshot actions + detail

/** Statuses an admin can set on a group snapshot (Cinder `reset_status`). */
const GSNAP_RESET_STATUSES = [
  { value: "available", label: tr("available"), description: tr("Usable again") },
  { value: "error", label: tr("error"), description: tr("Failed; can only be deleted") },
  { value: "error_deleting", label: "error_deleting", description: tr("A delete failed") },
];

/** Menu entries and dialogs for group snapshots (lists, the group page and the detail page). */
export function useGroupSnapshotActions({ onDeleted }: { onDeleted?: () => void } = {}) {
  const session = useSession().data!;
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ kind: "from" | "reset" | "delete"; s: GroupSnapshot } | null>(null);
  const close = () => setOpen(null);
  const items = (s: GroupSnapshot, where: "list" | "detail" = "list"): MenuEntry[] => [
    where === "list" && { label: tr("View details"), icon: "eye", onSelect: () => navigate(`/storage/group-snapshots/${s.id}`) },
    where === "list" && "-",
    { label: tr("Create group from snapshot"), icon: "layers", disabled: s.status === "available" ? false : tr("Not possible while {status}", { status: s.status }), onSelect: () => setOpen({ kind: "from", s }) },
    { label: tr("Open volume group"), icon: "layers", onSelect: () => navigate(`/storage/groups/${s.group_id}`) },
    session.is_admin && "-",
    session.is_admin && { heading: tr("Admin") },
    session.is_admin && { label: tr("Reset status"), icon: "rotate-ccw", onSelect: () => setOpen({ kind: "reset", s }) },
    "-",
    { label: tr("Delete group snapshot"), icon: "trash", danger: true, disabled: groupBusy(s) ? tr("Busy ({status})", { status: s.status }) : false, onSelect: () => setOpen({ kind: "delete", s }) },
  ];
  const o = open;
  const dialogs = o && (
    <>
      {o.kind === "from" && <CreateGroupDialog onClose={close} from={{ snapshot: o.s }} />}
      {o.kind === "reset" && <ResetGroupSnapshotDialog snap={o.s} onClose={close} />}
      {o.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete group snapshot {gName}?", { gName: gName(o.s) })}
          submitLabel={tr("Delete")}
          done={tr("Deleting group snapshot")}
          refresh={["volume"]}
          onDone={onDeleted}
          run={() => os.del("volume", `group_snapshots/${o.s.id}`)}
        >
          <p className="text-sm">{tr("The snapshot of every member volume is deleted too. Groups created from it are not affected.")}</p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs };
}

function ResetGroupSnapshotDialog({ snap, onClose }: { snap: GroupSnapshot; onClose: () => void }) {
  const [status, setStatus] = useState("available");
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Reset status of {gName}?", { gName: gName(snap) })}
      description={tr("Now {status}. Only changes what Cinder records; nothing happens on the backend.", { status: snap.status })}
      submitLabel={tr("Reset status")}
      canSubmit={status !== snap.status}
      done={tr("Status reset")}
      refresh={["volume"]}
      run={() => os.action("volume", `group_snapshots/${snap.id}`, { reset_status: { status } })}
    >
      <Field label={tr("New status")}>{(id) => <Picker id={id} value={status} onChange={setStatus} options={GSNAP_RESET_STATUSES} />}</Field>
    </ActionDialog>
  );
}

const GSNAP_TABS = ["overview", "snapshots", "groups"] as const;

/** One group snapshot: details, the snapshot of each member volume, groups created from it. */
export function GroupSnapshotDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const admin = useInAdmin();
  const scope = scopeOf(admin);
  const gsnap = useOsGet<GroupSnapshot>("volume", `group_snapshots/${id}`, (r: { group_snapshot: GroupSnapshot }) => r.group_snapshot, { poll: groupBusy });
  const s = gsnap.data;
  const group = useOsGet<VolumeGroup>("volume", `groups/${s?.group_id ?? ""}`, (r: { group: VolumeGroup }) => r.group, { enabled: !!s?.group_id });
  const snapshots = useSnapshots(scope);
  const volumes = useVolumes(scope);
  const groups = useVolumeGroups(scope);
  const projects = useProjects(admin);
  const names = useTypeNames();
  const invalidate = useInvalidate();
  const actions = useGroupSnapshotActions({ onDeleted: () => navigate("/storage/group-snapshots") });
  const [tab, setTab] = useTab(GSNAP_TABS, "overview");
  const members = (snapshots.data ?? []).filter((x) => x.group_snapshot_id === id);
  const restored = (groups.data ?? []).filter((g) => g.group_snapshot_id === id);
  const volName = (vid: string) => {
    const v = volumes.data?.find((x) => x.id === vid);
    return v ? v.name || v.id : `${vid.slice(0, 8)}…`;
  };
  const gtype = s && names.groupTypeOf(s.group_type_id ?? group.data?.group_type ?? "");

  const memberCols: Column<Snapshot>[] = [
    {
      key: "name",
      header: tr("Snapshot"),
      cell: (x) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{x.name || x.id}</span>
          <span className="truncate font-mono text-xs text-muted">{x.id}</span>
        </span>
      ),
      value: (x) => `${x.name ?? ""} ${x.id}`,
      csv: (x) => x.name || x.id,
    },
    {
      key: "volume",
      header: tr("Volume"),
      cell: (x) => (
        <Link to={`/storage/volumes/${x.volume_id}`} className="truncate text-cable hover:underline">
          {volName(x.volume_id)}
        </Link>
      ),
      value: (x) => volName(x.volume_id),
    },
    { key: "size", header: tr("Size"), width: "5.5rem", className: "text-right", cell: (x) => <span className="tabular-nums">{trx("{size} GiB", { size: x.size })}</span>, value: (x) => x.size },
    { key: "status", header: tr("Status"), width: "8rem", cell: (x) => <StatusDot status={volumeStatus(x)} label={x.status} />, value: (x) => x.status },
  ];
  const groupCols: Column<VolumeGroup>[] = [
    {
      key: "name",
      header: tr("Group"),
      cell: (g) => (
        <Link to={`/storage/groups/${g.id}`} className="font-medium text-cable hover:underline">
          {gName(g)}
        </Link>
      ),
      value: gName,
    },
    { key: "volumes", header: tr("Volumes"), width: "6rem", className: "text-right", cell: (g) => g.volumes?.length ?? "—", value: (g) => g.volumes?.length ?? 0 },
    { key: "status", header: tr("Status"), width: "8rem", cell: (g) => <StatusDot status={groupStatus(g)} label={g.status} />, value: (g) => g.status },
    { key: "created", header: tr("Created"), width: "10rem", hideBelow: "sm", cell: (g) => fmtDate(g.created_at), value: (g) => g.created_at },
  ];

  return (
    <>
      <Link to="/storage/group-snapshots" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {admin ? tr("All group snapshots") : tr("Group snapshots")}
      </Link>
      <PageHeader
        title={s ? gName(s) : tr("Group snapshot")}
        description={s ? tr("Snapshot of group {v} · {length} volume snapshot{s}", { v: group.data ? gName(group.data) : s.group_id, length: members.length, s: members.length === 1 ? "" : "s" }) : undefined}
        actions={s && <ActionMenu variant="button" items={() => actions.items(s, "detail")} />}
      />
      <ErrorNotice error={gsnap.error} className="mb-4" />
      {s && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "snapshots", label: tr("Volume snapshots ({v})", { v: snapshots.isPending ? "…" : members.length }) },
              { id: "groups", label: tr("Groups created from it ({v})", { v: groups.isPending ? "…" : restored.length }) },
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <Card title={tr("Details")}>
                <dl>
                  <Detail label={tr("Name")}>{s.name || "—"}</Detail>
                  <Detail label="ID">
                    <Mono>{s.id}</Mono>
                  </Detail>
                  <Detail label={tr("Description")} wrap>
                    {s.description || "—"}
                  </Detail>
                  <Detail label={tr("Status")}>
                    <StatusDot status={groupStatus(s)} label={s.status} />
                  </Detail>
                  <Detail label={tr("Created")}>{fmtDate(s.created_at)}</Detail>
                  {admin && s.project_id && <Detail label={tr("Project")}>{projects.data?.find((p) => p.id === s.project_id)?.name ?? s.project_id}</Detail>}
                </dl>
              </Card>
              <Card title={tr("Source group")}>
                <dl>
                  <Detail label={tr("Group")}>
                    {group.data ? (
                      <Link to={`/storage/groups/${s.group_id}`} className="text-cable hover:underline">
                        {gName(group.data)}
                      </Link>
                    ) : (
                      <span className="text-muted">
                        <Mono>{s.group_id}</Mono> {group.isPending ? "" : tr("(deleted)")}
                      </span>
                    )}
                  </Detail>
                  <Detail label={tr("Group type")}>{names.groupType(s.group_type_id ?? group.data?.group_type ?? "") || "—"}</Detail>
                  <Detail label={tr("Snapshots")}>{consistentSnapshots(gtype) ? <Badge tone="accent">{tr("consistent")}</Badge> : tr("Per volume")}</Detail>
                  {group.data && (
                    <Detail label={tr("Volume types")} wrap>
                      <span className="flex flex-wrap gap-1">
                        {group.data.volume_types.map((t) => (
                          <Badge key={t}>{names.volumeType(t)}</Badge>
                        ))}
                      </span>
                    </Detail>
                  )}
                </dl>
              </Card>
            </div>
          )}
          {tab === "snapshots" && (
            <DataTable
              rows={snapshots.isPending ? undefined : members}
              columns={memberCols}
              rowKey={(x) => x.id}
              loading={snapshots.isPending}
              tableId="group-snapshot-members"
              noun={tr("volume snapshots")}
              rowLabel={(x) => x.name || x.id}
              empty={tr("No volume snapshots belong to this group snapshot.")}
              onRefresh={() => snapshots.refetch()}
              refreshing={snapshots.isFetching}
              onBulkDone={() => invalidate("volume")}
            />
          )}
          {tab === "groups" && (
            <DataTable
              rows={groups.isPending ? undefined : restored}
              columns={groupCols}
              rowKey={(g) => g.id}
              loading={groups.isPending}
              tableId="group-snapshot-groups"
              noun={tr("groups")}
              rowLabel={gName}
              empty={tr("No group was created from this snapshot yet. Use “Create group from snapshot” in the Actions menu.")}
              onRefresh={() => groups.refetch()}
              refreshing={groups.isFetching}
            />
          )}
        </>
      )}
      {actions.dialogs}
    </>
  );
}
