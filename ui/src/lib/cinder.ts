/**
 * Cinder beyond volumes and snapshots: volume groups and group snapshots, group types,
 * transfers between projects, backups, and the admin side (QoS specs, volume type
 * details, services and pools). All through the gateway (`os.*`).
 */
import { useQuery } from "@tanstack/react-query";
import { os, useOsList, volumeBusy } from "./os";
import { tr } from "@/lib/i18n";

type Query = Record<string, string | number | boolean | undefined>;

// =========================================================================== groups

export interface VolumeGroup {
  id: string;
  name: string | null;
  description?: string | null;
  status: string;
  availability_zone?: string;
  group_type: string;
  volume_types: string[];
  /** 3.25+ with list_volume=True */
  volumes?: string[];
  group_snapshot_id?: string | null;
  source_group_id?: string | null;
  created_at: string;
  project_id?: string;
  replication_status?: string;
}

export interface GroupType {
  id: string;
  name: string;
  description?: string | null;
  is_public?: boolean;
  group_specs?: Record<string, string>;
}

export interface GroupSnapshot {
  id: string;
  name: string | null;
  description?: string | null;
  status: string;
  group_id: string;
  group_type_id?: string;
  created_at: string;
  project_id?: string;
}

const GROUP_BUSY = /^(creating|deleting|updating)$/;
export const groupBusy = (g: { status: string }) => GROUP_BUSY.test(g.status);

export const useVolumeGroups = (q?: Query) =>
  useOsList<VolumeGroup>("volume", "groups/detail", "groups", { list_volume: "True", ...q }, { poll: (rows) => rows.some(groupBusy) });
export const useGroupTypes = () => useOsList<GroupType>("volume", "group_types", "group_types");
export const useGroupSnapshots = (q?: Query) =>
  useOsList<GroupSnapshot>("volume", "group_snapshots/detail", "group_snapshots", q, { poll: (rows) => rows.some(volumeBusy) });

/**
 * Cinder's built-in group type for consistency groups migrated to groups
 * (`DEFAULT_CGSNAPSHOT_TYPE`): the groups API refuses it ("reserved for migrating CGs to
 * groups"), so it can't be offered for new groups. Groups of that type are hidden from
 * group lists by Cinder itself.
 */
export const CG_MIGRATION_TYPE = "default_cgsnapshot_type";
export const reservedGroupType = (t?: GroupType) => t?.name === CG_MIGRATION_TYPE;

/** Does this group type allow consistent (crash-consistent, all-at-once) group snapshots? */
export const consistentSnapshots = (t?: GroupType) => /<is>\s*true/i.test(t?.group_specs?.consistent_group_snapshot_enabled ?? "");

// =========================================================================== transfers

export interface Transfer {
  id: string;
  name: string | null;
  volume_id: string;
  created_at: string;
  /** Only in the create response, shown once. */
  auth_key?: string;
  source_project_id?: string;
  destination_project_id?: string;
  accepted?: boolean;
  no_snapshots?: boolean;
}

export const useTransfers = () => useOsList<Transfer>("volume", "volume-transfers/detail", "transfers");

// =========================================================================== backups

export interface Backup {
  id: string;
  name: string | null;
  description?: string | null;
  status: string;
  size: number;
  volume_id: string;
  snapshot_id?: string | null;
  is_incremental?: boolean;
  has_dependent_backups?: boolean;
  container?: string | null;
  availability_zone?: string | null;
  created_at: string;
  updated_at?: string;
  data_timestamp?: string;
  object_count?: number;
  fail_reason?: string | null;
  "os-backup-project-attr:project_id"?: string;
}

const BACKUP_BUSY = /^(creating|deleting|restoring)$/;
export const backupBusy = (b: { status: string }) => BACKUP_BUSY.test(b.status);

export const useBackups = (q?: Query) => useOsList<Backup>("volume", "backups/detail", "backups", q, { poll: (rows) => rows.some(backupBusy) });

// =========================================================================== admin

export interface QosSpec {
  id: string;
  name: string;
  consumer: "front-end" | "back-end" | "both";
  specs: Record<string, string>;
}

export interface QosAssociation {
  association_type: string;
  name: string;
  id: string;
}

export const useQosSpecs = (enabled = true) =>
  useQuery({
    queryKey: ["os", "volume", "qos-specs"],
    queryFn: () => os.get<{ qos_specs: QosSpec[] }>("volume", "qos-specs").then((r) => r.qos_specs),
    enabled,
  });

export const useQosAssociations = (id: string, enabled = true) =>
  useQuery({
    queryKey: ["os", "volume", "qos-specs", id, "associations"],
    queryFn: () => os.get<{ qos_associations: QosAssociation[] }>("volume", `qos-specs/${id}/associations`).then((r) => r.qos_associations),
    enabled: enabled && !!id,
  });

export interface Encryption {
  encryption_id?: string;
  provider?: string;
  cipher?: string | null;
  key_size?: number | null;
  control_location?: "front-end" | "back-end";
}

export interface Pool {
  name: string;
  capabilities: {
    volume_backend_name?: string;
    vendor_name?: string;
    driver_version?: string;
    storage_protocol?: string;
    total_capacity_gb?: number | string;
    free_capacity_gb?: number | string;
    allocated_capacity_gb?: number;
    provisioned_capacity_gb?: number;
    max_over_subscription_ratio?: number | string;
    reserved_percentage?: number;
    thin_provisioning_support?: boolean;
    thick_provisioning_support?: boolean;
    multiattach?: boolean;
    timestamp?: string;
  };
}

export interface CinderService {
  binary: string;
  host: string;
  zone: string;
  status: "enabled" | "disabled";
  state: "up" | "down";
  updated_at?: string | null;
  disabled_reason?: string | null;
  cluster?: string | null;
  backend_state?: string;
}

/** Cinder reports "infinite"/"unknown" capacities for some backends. */
export const capacityGb = (v: number | string | undefined) => (typeof v === "number" ? v : Number.isFinite(Number(v)) ? Number(v) : null);

// =========================================================================== suggestions

/** Common volume type extra specs (scheduler capabilities and driver keys). */
export const EXTRA_SPEC_KEYS = [
  { key: "volume_backend_name", hint: tr("Schedule onto the backend with this name") },
  { key: "multiattach", hint: tr("Allow attaching to several instances"), values: ["<is> True", "<is> False"] },
  { key: "provisioning:type", hint: tr("Thin or thick provisioning"), values: ["thin", "thick"] },
  { key: "replication_enabled", hint: tr("Only backends with replication"), values: ["<is> True"] },
  { key: "RESKEY:availability_zones", hint: tr("Comma-separated zones the type can be used in") },
  { key: "compression", hint: tr("Backend compression"), values: ["<is> True", "<is> False"] },
  { key: "dedup", hint: tr("Backend deduplication"), values: ["<is> True", "<is> False"] },
  { key: "thin_provisioning_support", hint: tr("Only thin-capable backends"), values: ["<is> True"] },
  { key: "storage_protocol", hint: tr("Only backends with this protocol"), values: ["ceph", "iSCSI", "FC", "nfs", "NVMe-oF"] },
];

/** QoS spec keys understood by Nova's libvirt driver (front-end) and common back-ends. */
export const QOS_KEYS = [
  { key: "total_iops_sec", hint: tr("Read + write IOPS limit") },
  { key: "read_iops_sec", hint: tr("Read IOPS limit") },
  { key: "write_iops_sec", hint: tr("Write IOPS limit") },
  { key: "total_bytes_sec", hint: tr("Read + write throughput limit, bytes/s") },
  { key: "read_bytes_sec", hint: tr("Read throughput limit, bytes/s") },
  { key: "write_bytes_sec", hint: tr("Write throughput limit, bytes/s") },
  { key: "total_iops_sec_max", hint: tr("Burst IOPS (front-end)") },
  { key: "total_bytes_sec_max", hint: tr("Burst throughput, bytes/s (front-end)") },
  { key: "size_iops_sec", hint: tr("I/O size counted as one operation, bytes") },
  { key: "total_iops_sec_per_gb", hint: tr("IOPS limit per GiB of volume size") },
  { key: "total_bytes_sec_per_gb", hint: tr("Throughput limit per GiB of volume size") },
  { key: "minIOPS", hint: tr("Guaranteed IOPS (back-end drivers that support it)") },
  { key: "maxIOPS", hint: tr("Maximum IOPS (back-end)") },
  { key: "burstIOPS", hint: tr("Burst IOPS (back-end)") },
];

export const GROUP_SPEC_KEYS = [
  { key: "consistent_group_snapshot_enabled", hint: tr("Snapshot all volumes at the same instant"), values: ["<is> True", "<is> False"] },
  { key: "group_replication_enabled", hint: tr("Replicate the group as a whole"), values: ["<is> True"] },
];
