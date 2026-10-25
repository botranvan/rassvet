/**
 * Everything you can do to an instance, shared by the instance list (⋮ per row) and the
 * instance detail page (Actions ▾). `useServerActions()` returns the menu entries for a
 * server and the dialogs they open.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import type { MenuEntry } from "@/components/Menu";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Field, Input, Switch, Textarea } from "@/components/ui";
import { MetadataEditor, useMetadataErrors } from "@/components/MetadataEditor";
import { useBootImages } from "@/lib/image";
import { SERVER_METADATA } from "@/lib/metadefs";
import {
  deleteServer,
  type Server,
  gib,
  os,
  portLabel,
  serverAction,
  useFlavors,
  useFloatingIps,
  useInvalidate,
  useNetworks,
  usePorts,
  useSubnets,
  useVolumes,
} from "@/lib/os";
import { datedName } from "@/lib/format";
import { useSession } from "@/lib/session";
import { AssociateFipDialog, SgPicker, useNetName } from "../network/networkActions";
import { tr, trx } from "@/lib/i18n";
import { TagInput } from "@/components/TagInput";

type Kind =
  | "confirm"
  | "edit"
  | "metadata"
  | "tags"
  | "snapshot"
  | "attachVolume"
  | "detachVolume"
  | "attachIface"
  | "detachIface"
  | "sgs"
  | "fip"
  | "unfip"
  | "resize"
  | "rebuild"
  | "rescue"
  | "liveMigrate"
  | "migrate"
  | "resetState"
  | "delete";

interface Simple {
  label: string;
  body: object;
  done: string;
  /** Text of the confirmation; without it the action runs straight away. */
  confirm?: string;
  danger?: boolean;
}

const POWERED = ["ACTIVE", "SHUTOFF", "PAUSED", "SUSPENDED"];

export function useServerActions({ admin = false, base = "/compute/instances", onDeleted }: { admin?: boolean; base?: string; onDeleted?: () => void } = {}) {
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidate();
  const session = useSession().data!;
  const isAdmin = admin || session.is_admin;
  const [open, setOpen] = useState<{ kind: Kind; server: Server; simple?: Simple } | null>(null);
  const close = () => setOpen(null);

  const run = useMutation({
    mutationFn: ({ server, simple }: { server: Server; simple: Simple }) => serverAction(server.id, simple.body),
    onSuccess: (_, { server, simple }) => {
      toast(`${server.name}: ${simple.done}`);
      invalidate("compute");
    },
    onError: (e, { server }) => toast(`${server.name}: ${(e as Error).message}`, "error"),
  });

  const simple = (s: Server, a: Simple, opts: { disabled?: boolean | string; icon: string; hint?: string }): MenuEntry => ({
    label: a.label,
    icon: opts.icon,
    hint: opts.hint,
    danger: a.danger,
    disabled: opts.disabled,
    onSelect: () => (a.confirm ? setOpen({ kind: "confirm", server: s, simple: a }) : run.mutate({ server: s, simple: a })),
  });
  const dlg = (s: Server, kind: Kind) => () => setOpen({ kind, server: s });

  const items = (s: Server, where: "list" | "detail" = "list"): MenuEntry[] => {
    const st = s.status;
    const locked = s.locked ? tr("Unlock the instance first") : false;
    const lockOr = (cond: boolean, why: string) => locked || (cond ? false : why);
    const bfv = s.image === "";
    return [
      where === "list" && { label: tr("View details"), icon: "eye", onSelect: () => navigate(`${base}/${s.id}`) },
      { label: tr("Console"), icon: "terminal", disabled: st === "ACTIVE" ? false : tr("The instance isn't running"), onSelect: () => navigate(`${base}/${s.id}?tab=console`) },
      { label: tr("View log"), icon: "scroll-text", onSelect: () => navigate(`${base}/${s.id}?tab=log`) },
      "-",
      { heading: tr("Manage") },
      { label: tr("Edit instance"), icon: "edit", onSelect: dlg(s, "edit") },
      { label: tr("Edit tags"), icon: "tags", hint: s.tags?.length ? String(s.tags.length) : undefined, onSelect: dlg(s, "tags") },
      { label: tr("Edit metadata"), icon: "tags", hint: Object.keys(s.metadata ?? {}).length ? String(Object.keys(s.metadata ?? {}).length) : undefined, onSelect: dlg(s, "metadata") },
      { label: tr("Attach volume"), icon: "hard-drive", disabled: locked, onSelect: dlg(s, "attachVolume") },
      {
        label: tr("Detach volume"),
        icon: "hard-drive",
        disabled: locked || ((s["os-extended-volumes:volumes_attached"]?.length ?? 0) <= (bfv ? 1 : 0) ? tr("No data volumes attached") : false),
        onSelect: dlg(s, "detachVolume"),
      },
      { label: tr("Attach interface"), icon: "cable", disabled: locked, onSelect: dlg(s, "attachIface") },
      { label: tr("Detach interface"), icon: "unplug", disabled: locked, onSelect: dlg(s, "detachIface") },
      { label: tr("Edit security groups"), icon: "shield", onSelect: dlg(s, "sgs") },
      { label: tr("Associate floating IP"), icon: "globe", onSelect: dlg(s, "fip") },
      { label: tr("Disassociate floating IP"), icon: "unlink", onSelect: dlg(s, "unfip") },
      { label: tr("Create snapshot"), icon: "camera", disabled: lockOr(POWERED.includes(st), tr("Not possible in this state")), onSelect: dlg(s, "snapshot") },
      "-",
      { heading: tr("Power") },
      st === "SHUTOFF" && simple(s, { label: tr("Start"), body: { "os-start": null }, done: tr("starting") }, { icon: "play", disabled: locked }),
      st === "ACTIVE" &&
        simple(
          s,
          { label: tr("Stop"), body: { "os-stop": null }, done: tr("stopping"), confirm: tr("The guest OS is asked to shut down, then the instance is powered off. It keeps its resources.") },
          { icon: "power", disabled: locked },
        ),
      st === "ACTIVE" && simple(s, { label: tr("Soft reboot"), body: { reboot: { type: "SOFT" } }, done: tr("rebooting") }, { icon: "refresh", disabled: locked }),
      simple(
        s,
        {
          label: tr("Hard reboot"),
          body: { reboot: { type: "HARD" } },
          done: tr("hard rebooting"),
          confirm: tr("Like pulling the power cord and plugging it back in. Unsaved data in the guest may be lost."),
        },
        { icon: "rotate-ccw", disabled: lockOr([...POWERED, "ERROR", "REBOOT", "HARD_REBOOT"].includes(st), tr("Not possible in this state")) },
      ),
      st === "ACTIVE" && simple(s, { label: tr("Pause"), body: { pause: null }, done: tr("pausing") }, { icon: "pause", disabled: locked, hint: tr("in memory") }),
      st === "PAUSED" && simple(s, { label: tr("Unpause"), body: { unpause: null }, done: tr("unpausing") }, { icon: "play", disabled: locked }),
      st === "ACTIVE" && simple(s, { label: tr("Suspend"), body: { suspend: null }, done: tr("suspending") }, { icon: "moon", disabled: locked, hint: tr("to disk") }),
      st === "SUSPENDED" && simple(s, { label: tr("Resume"), body: { resume: null }, done: tr("resuming") }, { icon: "play", disabled: locked }),
      POWERED.includes(st) &&
        simple(
          s,
          {
            label: tr("Shelve"),
            body: { shelve: null },
            done: tr("shelving"),
            confirm: tr("The instance is powered off and its CPU and RAM are given back to the cloud. Volumes and addresses are kept. Unshelve it to run again."),
          },
          { icon: "archive", disabled: locked },
        ),
      st.startsWith("SHELVED") && simple(s, { label: tr("Unshelve"), body: { unshelve: null }, done: tr("unshelving") }, { icon: "play", disabled: locked }),
      s.locked
        ? simple(s, { label: tr("Unlock"), body: { unlock: null }, done: tr("unlocked") }, { icon: "lock-open" })
        : simple(s, { label: tr("Lock"), body: { lock: null }, done: tr("locked") }, { icon: "lock", hint: tr("prevents changes") }),
      "-",
      { heading: tr("Change") },
      st === "VERIFY_RESIZE"
        ? simple(s, { label: tr("Confirm resize"), body: { confirmResize: null }, done: tr("resize confirmed") }, { icon: "check" })
        : { label: tr("Resize"), icon: "scaling", disabled: lockOr(["ACTIVE", "SHUTOFF"].includes(st), tr("Start or stop the instance first")), onSelect: dlg(s, "resize") },
      st === "VERIFY_RESIZE" && simple(s, { label: tr("Revert resize"), body: { revertResize: null }, done: tr("reverting resize") }, { icon: "undo" }),
      { label: tr("Rebuild"), icon: "hammer", disabled: lockOr(["ACTIVE", "SHUTOFF", "ERROR"].includes(st), tr("Not possible in this state")), onSelect: dlg(s, "rebuild") },
      st === "RESCUE"
        ? simple(s, { label: tr("Unrescue"), body: { unrescue: null }, done: tr("leaving rescue mode") }, { icon: "life-buoy" })
        : { label: tr("Rescue"), icon: "life-buoy", disabled: lockOr(["ACTIVE", "SHUTOFF", "ERROR"].includes(st), tr("Not possible in this state")), onSelect: dlg(s, "rescue") },
      isAdmin && "-",
      isAdmin && { heading: tr("Admin") },
      isAdmin && { label: tr("Live migrate"), icon: "arrow-right-left", disabled: st === "ACTIVE" || st === "PAUSED" ? false : tr("Only running instances"), onSelect: dlg(s, "liveMigrate") },
      isAdmin && { label: tr("Migrate"), icon: "move-right", disabled: ["ACTIVE", "SHUTOFF"].includes(st) ? false : tr("Not possible in this state"), onSelect: dlg(s, "migrate") },
      isAdmin && { label: tr("Reset state"), icon: "rotate-ccw", onSelect: dlg(s, "resetState") },
      "-",
      { label: tr("Delete instance"), icon: "trash", danger: true, disabled: locked, onSelect: dlg(s, "delete") },
    ];
  };

  const o = open;
  const dialogs = o && (
    <>
      {o.kind === "confirm" && o.simple && (
        <ActionDialog
          onClose={close}
          title={`${o.simple.label} ${o.server.name}?`}
          submitLabel={o.simple.label}
          danger={o.simple.danger}
          done={`${o.server.name}: ${o.simple.done}`}
          refresh={["compute"]}
          run={() => serverAction(o.server.id, o.simple!.body)}
        >
          <p className="text-sm">{o.simple.confirm}</p>
        </ActionDialog>
      )}
      {o.kind === "edit" && <EditServerDialog server={o.server} onClose={close} />}
      {o.kind === "metadata" && <EditMetadataDialog server={o.server} onClose={close} />}
      {o.kind === "tags" && <EditServerTagsDialog server={o.server} onClose={close} />}
      {o.kind === "snapshot" && <SnapshotDialog server={o.server} onClose={close} />}
      {o.kind === "attachVolume" && <AttachVolumeDialog server={o.server} onClose={close} />}
      {o.kind === "detachVolume" && <DetachVolumeDialog server={o.server} onClose={close} />}
      {o.kind === "attachIface" && <AttachInterfaceDialog server={o.server} onClose={close} />}
      {o.kind === "detachIface" && <DetachInterfaceDialog server={o.server} onClose={close} />}
      {o.kind === "sgs" && <ServerSecurityGroups server={o.server} onClose={close} />}
      {o.kind === "fip" && <ServerFip server={o.server} onClose={close} />}
      {o.kind === "unfip" && <ServerUnfip server={o.server} onClose={close} />}
      {o.kind === "resize" && <ResizeDialog server={o.server} onClose={close} />}
      {o.kind === "rebuild" && <RebuildDialog server={o.server} onClose={close} />}
      {o.kind === "rescue" && <RescueDialog server={o.server} onClose={close} />}
      {o.kind === "liveMigrate" && <MigrateDialog server={o.server} live onClose={close} />}
      {o.kind === "migrate" && <MigrateDialog server={o.server} onClose={close} />}
      {o.kind === "resetState" && <ResetStateDialog server={o.server} onClose={close} />}
      {o.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete {name}?", { name: o.server.name })}
          submitLabel={tr("Delete instance")}
          done={tr("Deleting {name}", { name: o.server.name })}
          refresh={["compute", "volume", "network"]}
          onDone={onDeleted}
          run={() => deleteServer(o.server.id)}
        >
          <p className="text-sm">
            {tr("The instance is destroyed. A root volume created with “delete on termination” is deleted with it; other volumes are detached and kept. This can't be undone.")}
          </p>
        </ActionDialog>
      )}
    </>
  );
  /** Open one of the dialogs directly (e.g. from a tab's toolbar). */
  const openDialog = (kind: Exclude<Kind, "confirm">, server: Server) => setOpen({ kind, server });
  return { items, dialogs, openDialog };
}

// =========================================================================== dialogs

/** Replace the instance's metadata (PUT /servers/{id}/metadata), with the Glance catalog's server definitions. */
export function EditServerTagsDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const [tags, setTags] = useState<string[]>(server.tags ?? []);
  const changed = JSON.stringify(tags) !== JSON.stringify(server.tags ?? []);
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Tags of {name}", { name: server.name })}
      description={tr("Labels for finding and grouping instances (the Instances list filters by them). Up to 50 tags of 60 characters; saving replaces the whole set.")}
      submitLabel={tr("Save tags")}
      canSubmit={changed && tags.length <= 50}
      done={tr("Tags of {name} saved", { name: server.name })}
      refresh={["compute"]}
      run={() => os.put("compute", `servers/${server.id}/tags`, { tags })}
    >
      <Field label={tr("Tags")}>{(id) => <TagInput id={id} value={tags} onChange={setTags} maxLength={60} maxTags={50} placeholder={tr("e.g. production, web, team-a")} />}</Field>
    </ActionDialog>
  );
}

function EditMetadataDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const [meta, setMeta] = useState<Record<string, string>>(server.metadata ?? {});
  const errors = useMetadataErrors(meta, SERVER_METADATA);
  const before = JSON.stringify(Object.entries(server.metadata ?? {}).sort());
  const changed = JSON.stringify(Object.entries(meta).sort()) !== before;
  const count = Object.keys(meta).length;
  return (
    <ActionDialog
      onClose={onClose}
      size="xl"
      title={tr("Metadata of {name}", { name: server.name })}
      description={tr("Key–value pairs stored with the instance and visible to the guest through the metadata service or config drive. Saving replaces the whole set.")}
      submitLabel={tr("Save metadata")}
      canSubmit={changed && Object.keys(errors).length === 0 && count <= 128 && !Object.keys(meta).some((k) => !k.trim())}
      done={tr("Metadata of {name} saved", { name: server.name })}
      refresh={["compute"]}
      run={() => os.put("compute", `servers/${server.id}/metadata`, { metadata: meta })}
    >
      <MetadataEditor value={meta} onChange={setMeta} scope={SERVER_METADATA} />
      {count > 128 && <p className="text-sm text-led-red">{tr("At most 128 items.")}</p>}
    </ActionDialog>
  );
}

function EditServerDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit {name}", { name: server.name })}
      submitLabel={tr("Save")}
      canSubmit={!!name.trim()}
      done={tr("Instance updated")}
      refresh={["compute"]}
      run={() => os.put("compute", `servers/${server.id}`, { server: { name: name.trim(), description: description.replace(/\n/g, " ") } })}
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

export function SnapshotDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const [name, setName] = useState(datedName(`${server.name}-snapshot`));
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Create snapshot")}
      description={
        server.image === ""
          ? tr("The root volume is snapshotted in Cinder and an image pointing at it is created in Glance.")
          : tr("The instance's disk is saved as a new image in Glance.")
      }
      submitLabel={tr("Create snapshot")}
      canSubmit={!!name.trim()}
      done={tr("Creating snapshot {name}", { name })}
      refresh={["volume"]}
      run={() => serverAction(server.id, { createImage: { name: name.trim() } })}
    >
      <Field label={tr("Snapshot name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

export function AttachVolumeDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const volumes = useVolumes();
  const [volumeId, setVolumeId] = useState("");
  const [dot, setDot] = useState(false);
  const free = (volumes.data ?? []).filter((v) => v.status === "available" || (v.multiattach && v.status === "in-use"));
  const v = free.find((x) => x.id === volumeId);
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Attach a volume to {name}", { name: server.name })}
      submitLabel={tr("Attach volume")}
      canSubmit={!!volumeId}
      done={tr("Attaching {v}", { v: v?.name || volumeId })}
      refresh={["compute", "volume"]}
      run={() =>
        os.post("compute", `servers/${server.id}/os-volume_attachments`, {
          volumeAttachment: { volumeId, ...(dot ? { delete_on_termination: true } : {}) },
        })
      }
    >
      <Field label={tr("Volume")} hint={volumes.data && !free.length ? tr("No available volumes. Create one under Storage → Volumes.") : undefined}>
        {(id) => (
          <Picker
            inlineDescription
            id={id}
            value={volumeId}
            onChange={setVolumeId}
            loading={volumes.isPending}
            searchable
            placeholder={tr("Choose a volume")}
            searchPlaceholder={tr("Search volumes")}
            emptyText={tr("No available volumes.")}
            options={free.map((x) => ({
              value: x.id,
              label: x.name || x.id,
              icon: "hard-drive",
              description: [x.volume_type, x.bootable === "true" && "bootable", x.multiattach && "multi-attach", x.description].filter(Boolean).join(" · ") || undefined,
              meta: tr("{size} GiB", { size: x.size }),
            }))}
          />
        )}
      </Field>
      <Switch checked={dot} onChange={setDot} label={tr("Delete the volume with the instance")} hint={tr("Off: the volume is detached and kept when the instance is deleted.")} />
    </ActionDialog>
  );
}

function DetachVolumeDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const volumes = useVolumes();
  const [volumeId, setVolumeId] = useState("");
  const attached = server["os-extended-volumes:volumes_attached"] ?? [];
  const byId = new Map(volumes.data?.map((v) => [v.id, v]));
  const opts = attached.map((a) => {
    const v = byId.get(a.id);
    const dev = v?.attachments.find((x) => x.server_id === server.id)?.device;
    const root = server.image === "" && !!dev && /[sv]da$/.test(dev);
    return {
      value: a.id,
      label: v?.name || a.id,
      icon: "hard-drive",
      description: [dev, v?.volume_type].filter(Boolean).join(" · ") || undefined,
      meta: v ? tr("{size} GiB", { size: v.size }) : undefined,
      disabled: root ? tr("Root volume; can't be detached") : false,
    };
  });
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Detach a volume from {name}", { name: server.name })}
      description={tr("Unmount it in the guest first to avoid data loss.")}
      submitLabel={tr("Detach volume")}
      canSubmit={!!volumeId}
      done={tr("Detaching volume")}
      refresh={["compute", "volume"]}
      run={() => os.del("compute", `servers/${server.id}/os-volume_attachments/${volumeId}`)}
    >
      <Field label={tr("Volume")}>{(id) => <Picker id={id} inlineDescription value={volumeId} onChange={setVolumeId} placeholder={tr("Choose a volume")} options={opts} emptyText={tr("No volumes attached.")} />}</Field>
    </ActionDialog>
  );
}

function AttachInterfaceDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const session = useSession().data!;
  const networks = useNetworks();
  const freePorts = usePorts({ device_id: "", project_id: session.project?.id });
  const [mode, setMode] = useState<"network" | "port">("network");
  const [netId, setNetId] = useState("");
  const [ip, setIp] = useState("");
  const [portId, setPortId] = useState("");
  const subnets = useSubnets({ network_id: netId });
  const netName = useNetName();
  const usable = (networks.data ?? []).filter((n) => n.status === "ACTIVE" && !n["router:external"]);
  const unbound = (freePorts.data ?? []).filter((p) => !p.device_id && !p.device_owner);
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Attach an interface to {name}", { name: server.name })}
      description={tr("The guest sees a new network card; most Linux images bring it up automatically.")}
      submitLabel={tr("Attach interface")}
      canSubmit={mode === "network" ? !!netId : !!portId}
      done={tr("Interface attached")}
      refresh={["compute", "network"]}
      run={() =>
        os.post("compute", `servers/${server.id}/os-interface`, {
          interfaceAttachment:
            mode === "network" ? { net_id: netId, ...(ip.trim() ? { fixed_ips: [{ ip_address: ip.trim() }] } : {}) } : { port_id: portId },
        })
      }
    >
      <Field label={tr("Attach")}>
        {(id) => (
          <Picker
            id={id}
            value={mode}
            onChange={(v) => setMode(v as "network" | "port")}
            options={[
              { value: "network", label: tr("New port on a network"), icon: "network" },
              { value: "port", label: tr("Existing port"), icon: "cable", description: tr("{length} unattached", { length: unbound.length }) },
            ]}
          />
        )}
      </Field>
      {mode === "network" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("Network")}>
            {(id) => (
              <Picker
                id={id}
                value={netId}
                onChange={setNetId}
                searchable
                loading={networks.isPending}
                placeholder={tr("Choose a network")}
                options={usable.map((n) => ({ value: n.id, label: n.name || n.id, description: n.shared ? tr("shared") : undefined }))}
              />
            )}
          </Field>
          <Field label={tr("Fixed IP")} hint={netId && subnets.data?.length ? tr("In {map}", { map: subnets.data.map((s) => s.cidr).join(", ") }) : tr("Optional")}>
            {(id) => <Input id={id} value={ip} onChange={(e) => setIp(e.target.value)} placeholder={tr("Automatic")} className="font-mono text-[13px]" />}
          </Field>
        </div>
      ) : (
        <Field label={tr("Port")}>
          {(id) => (
            <Picker
              inlineDescription
              id={id}
              value={portId}
              onChange={setPortId}
              searchable
              loading={freePorts.isPending}
              placeholder={tr("Choose a port")}
              emptyText={tr("No unattached ports. Create one on a network's Ports tab.")}
              options={unbound.map((p) => ({
                value: p.id,
                label: portLabel(p),
                description: `${netName(p.network_id)} · ${p.fixed_ips.map((f) => f.ip_address).join(", ")}`,
              }))}
            />
          )}
        </Field>
      )}
    </ActionDialog>
  );
}

function DetachInterfaceDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const ports = usePorts({ device_id: server.id });
  const netName = useNetName();
  const [portId, setPortId] = useState("");
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Detach an interface from {name}", { name: server.name })}
      submitLabel={tr("Detach interface")}
      canSubmit={!!portId}
      done={tr("Interface detached")}
      refresh={["compute", "network"]}
      run={() => os.del("compute", `servers/${server.id}/os-interface/${portId}`)}
    >
      <Field label={tr("Interface")}>
        {(id) => (
          <Picker
            inlineDescription
            id={id}
            value={portId}
            onChange={setPortId}
            loading={ports.isPending}
            placeholder={tr("Choose an interface")}
            options={(ports.data ?? []).map((p) => ({
              value: p.id,
              label: portLabel(p),
              description: `${netName(p.network_id)} · ${p.fixed_ips.map((f) => f.ip_address).join(", ")}`,
              keywords: p.mac_address,
            }))}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

/** One security group picker per port of the instance; saves the ports that changed. */
function ServerSecurityGroups({ server, onClose }: { server: Server; onClose: () => void }) {
  const ports = usePorts({ device_id: server.id });
  const netName = useNetName();
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const list = ports.data ?? [];
  const changed = list.filter((p) => edits[p.id] && edits[p.id].join() !== (p.security_groups ?? []).join());
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Security groups of {name}", { name: server.name })}
      description={tr("Security groups are set per interface (port). Changes apply immediately to running traffic.")}
      submitLabel={changed.length > 1 ? tr("Save {length} interfaces", { length: changed.length }) : tr("Save")}
      canSubmit={changed.length > 0}
      done={tr("Security groups updated")}
      refresh={["network", "compute"]}
      run={() => Promise.all(changed.map((p) => os.put("network", `ports/${p.id}`, { port: { security_groups: edits[p.id] } })))}
    >
      {ports.isPending && <p className="text-sm text-muted">{tr("Loading interfaces…")}</p>}
      {ports.data && list.length === 0 && <p className="text-sm text-muted">{tr("This instance has no network interfaces.")}</p>}
      {list.map((p) => (
        <div key={p.id} className="space-y-2 rounded-lg border border-line p-3">
          <p className="flex min-w-0 items-baseline gap-2 text-sm">
            <span className="font-mono text-[13px]">{p.fixed_ips.map((f) => f.ip_address).join(", ")}</span>
            <span className="truncate text-muted">
              {trx("on {netName} · {portLabel}", { netName: netName(p.network_id), portLabel: portLabel(p) })}
            </span>
          </p>
          {p.port_security_enabled === false ? (
            <p className="text-xs text-muted">{tr("Port security is off for this port, so security groups don't apply.")}</p>
          ) : (
            <SgPicker value={edits[p.id] ?? p.security_groups ?? []} onChange={(v) => setEdits((e) => ({ ...e, [p.id]: v }))} projectId={p.project_id} />
          )}
        </div>
      ))}
    </ActionDialog>
  );
}

function ServerFip({ server, onClose }: { server: Server; onClose: () => void }) {
  const ports = usePorts({ device_id: server.id });
  if (!ports.data) return null;
  if (!ports.data.length)
    return (
      <ActionDialog onClose={onClose} title={tr("Associate floating IP")} submitLabel={tr("Close")} canSubmit={false} run={async () => undefined}>
        <p className="text-sm">{trx("{name} has no network interfaces.", { name: server.name })}</p>
      </ActionDialog>
    );
  return <AssociateFipDialog ports={ports.data} serverName={server.name} onClose={onClose} />;
}

function ServerUnfip({ server, onClose }: { server: Server; onClose: () => void }) {
  const ports = usePorts({ device_id: server.id });
  const fips = useFloatingIps();
  const mine = (fips.data ?? []).filter((f) => ports.data?.some((p) => p.id === f.port_id));
  const [fipId, setFipId] = useState("");
  const chosen = fipId || (mine.length === 1 ? mine[0].id : "");
  const [release, setRelease] = useState(false);
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Disassociate a floating IP from {name}", { name: server.name })}
      submitLabel={release ? tr("Disassociate and release") : tr("Disassociate")}
      danger={release}
      canSubmit={!!chosen}
      done={release ? tr("Floating IP released") : tr("Floating IP disassociated")}
      refresh={["network", "compute"]}
      run={() => (release ? os.del("network", `floatingips/${chosen}`) : os.put("network", `floatingips/${chosen}`, { floatingip: { port_id: null } }))}
    >
      <Field label={tr("Floating IP")}>
        {(id) => (
          <Picker
            id={id}
            value={chosen}
            onChange={setFipId}
            loading={fips.isPending || ports.isPending}
            placeholder={tr("Choose an address")}
            emptyText={tr("No floating IP points to this instance.")}
            options={mine.map((f) => ({ value: f.id, label: f.floating_ip_address, icon: "globe", meta: f.fixed_ip_address ?? undefined }))}
          />
        )}
      </Field>
      <Switch checked={release} onChange={setRelease} label={tr("Release it too")} hint={tr("Give the address back to the pool instead of keeping it in the project.")} />
    </ActionDialog>
  );
}

function ResizeDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const flavors = useFlavors();
  const [flavorId, setFlavorId] = useState("");
  const current = server.flavor.original_name;
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Resize {name}", { name: server.name })}
      description={tr("Now {v} ({v2} vCPU, {v3}). The instance restarts on the new size; confirm or revert afterwards.", { v: current ?? tr("unknown"), v2: server.flavor.vcpus ?? "?", v3: server.flavor.ram != null ? gib(server.flavor.ram) : "?" })}
      submitLabel={tr("Resize")}
      canSubmit={!!flavorId}
      done={tr("{name}: resizing", { name: server.name })}
      refresh={["compute"]}
      run={() => serverAction(server.id, { resize: { flavorRef: flavorId } })}
    >
      <Field label={tr("New flavor")}>
        {(id) => (
          <Picker
            id={id}
            value={flavorId}
            onChange={setFlavorId}
            searchable
            loading={flavors.isPending}
            placeholder={tr("Choose a flavor")}
            searchPlaceholder={tr("Search flavors")}
            options={[...(flavors.data ?? [])]
              .sort((a, b) => a.vcpus - b.vcpus || a.ram - b.ram)
              .map((f) => ({
                value: f.id,
                label: f.name,
                description: tr("{vcpus} vCPU · {ram} · {v}", { vcpus: f.vcpus, ram: gib(f.ram), v: f.disk ? tr("{disk} GB disk", { disk: f.disk }) : tr("volume root") }),
                disabled: f.name === current ? tr("Current flavor") : server.image !== "" && f.disk < (server.flavor.disk ?? 0) ? tr("Root disk can't shrink") : false,
              }))}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

function RebuildDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const images = useBootImages();
  const [imageId, setImageId] = useState(server.image && typeof server.image === "object" ? server.image.id : "");
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      danger
      size="md"
      title={tr("Rebuild {name}", { name: server.name })}
      description={tr("The root disk is wiped and re-created from the image. Addresses, volumes and flavor stay. Volume-backed instances need compute API 2.93.")}
      submitLabel={tr("Rebuild")}
      canSubmit={!!imageId && !!name.trim()}
      done={tr("{name}: rebuilding", { name: server.name })}
      refresh={["compute"]}
      run={() => serverAction(server.id, { rebuild: { imageRef: imageId, name: name.trim(), ...(description ? { description } : {}) } })}
    >
      <Field label={tr("Image")}>
        {(id) => (
          <Picker
            id={id}
            value={imageId}
            onChange={setImageId}
            searchable
            loading={images.isPending}
            placeholder={tr("Choose an image")}
            searchPlaceholder={tr("Search images")}
            options={(images.data ?? []).map((i) => ({ value: i.id, label: i.name || i.id, icon: "disc-3", description: [i.os_distro, i.os_version, i.visibility].filter(Boolean).join(" · ") }))}
          />
        )}
      </Field>
      <Field label={tr("Name")}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

function RescueDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const images = useBootImages();
  const [imageId, setImageId] = useState("");
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Rescue {name}", { name: server.name })}
      description={tr("Boots a rescue image with the instance's disk attached as a second disk, so you can repair it. Unrescue to boot normally again.")}
      submitLabel={tr("Rescue")}
      done={tr("{name}: entering rescue mode", { name: server.name })}
      refresh={["compute"]}
      run={() => serverAction(server.id, { rescue: imageId ? { rescue_image_ref: imageId } : null })}
    >
      <Field label={tr("Rescue image")} hint={tr("Empty uses the instance's own image (or the cloud's default).")}>
        {(id) => (
          <Picker
            id={id}
            value={imageId}
            onChange={setImageId}
            clearable
            searchable
            loading={images.isPending}
            placeholder={tr("Default")}
            options={(images.data ?? []).map((i) => ({ value: i.id, label: i.name || i.id, icon: "disc-3" }))}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

interface Hyp {
  hypervisor_hostname: string;
  state: string;
  status: string;
  service?: { host: string };
}

function MigrateDialog({ server, live, onClose }: { server: Server; live?: boolean; onClose: () => void }) {
  const hv = useQuery({
    queryKey: ["os", "compute", "os-hypervisors", "detail"],
    queryFn: () => os.list<Hyp>("compute", "os-hypervisors/detail", "hypervisors"),
  });
  const [host, setHost] = useState("");
  const here = server["OS-EXT-SRV-ATTR:host"];
  return (
    <ActionDialog
      onClose={onClose}
      title={`${live ? tr("Live migrate") : tr("Migrate")} ${server.name}`}
      description={tr("Currently on {v}.{v2}", { v: here ?? tr("unknown host"), v2: live ? tr(" The instance keeps running while it moves.") : tr(" The instance is moved while powered off; confirm afterwards.") })}
      submitLabel={live ? tr("Live migrate") : tr("Migrate")}
      done={tr("{name}: migrating", { name: server.name })}
      refresh={["compute"]}
      run={() =>
        serverAction(server.id, live ? { "os-migrateLive": { host: host || null, block_migration: "auto" } } : { migrate: host ? { host } : null })
      }
    >
      <Field label={tr("Destination host")} hint={tr("Automatic lets the scheduler pick a host with room.")}>
        {(id) => (
          <Picker
            id={id}
            value={host}
            onChange={setHost}
            searchable
            loading={hv.isPending}
            options={[
              { value: "", label: tr("Automatic"), icon: "gauge" },
              ...(hv.data ?? [])
                .filter((h) => h.service?.host && h.service.host !== here)
                .map((h) => ({
                  value: h.service!.host,
                  label: h.service!.host,
                  description: h.hypervisor_hostname,
                  disabled: h.state !== "up" ? tr("Down") : h.status !== "enabled" ? tr("Disabled") : false,
                })),
            ]}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

function ResetStateDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const [state, setState] = useState("active");
  return (
    <ActionDialog
      onClose={onClose}
      danger
      title={tr("Reset state of {name}?", { name: server.name })}
      description={tr("Only changes what Nova records; the hypervisor isn't touched. Use it to recover an instance stuck in a task.")}
      submitLabel={tr("Reset state")}
      done={tr("{name}: state reset to {state}", { name: server.name, state })}
      refresh={["compute"]}
      run={() => serverAction(server.id, { "os-resetState": { state } })}
    >
      <Field label={tr("New state")}>
        {(id) => (
          <Picker
            id={id}
            value={state}
            onChange={setState}
            options={[
              { value: "active", label: tr("Active") },
              { value: "error", label: tr("Error") },
            ]}
          />
        )}
      </Field>
    </ActionDialog>
  );
}

