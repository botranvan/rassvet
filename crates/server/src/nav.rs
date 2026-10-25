//! Core navigation for both UI modes (Project / Admin). Entries are filtered per
//! session by service availability in the current region and by role.

use rassvet_ext_api::{NavItem, NavSection};

pub struct CoreNav {
    pub service_type: &'static str,
    pub item: NavItem,
    /// A cheap GET (block-storage path) the user's token must be allowed to call for the
    /// entry to show: hides features the cloud's policy doesn't grant (see api::nav_items).
    pub probe: Option<&'static str>,
}

impl CoreNav {
    fn probe(mut self, path: &'static str) -> Self {
        self.probe = Some(path);
        self
    }
}

#[allow(clippy::too_many_arguments)]
fn entry(
    service_type: &'static str,
    section: NavSection,
    group: &str,
    id: &str,
    label: &str,
    path: &str,
    icon: &str,
    role: Option<&str>,
) -> CoreNav {
    CoreNav {
        service_type,
        item: NavItem {
            id: id.into(),
            group: group.into(),
            label: label.into(),
            path: path.into(),
            icon: icon.into(),
            section,
            role: role.map(Into::into),
        },
        probe: None,
    }
}

#[rustfmt::skip]
pub fn core() -> Vec<CoreNav> {
    use NavSection::*;
    let admin = Some("admin");
    vec![
        // Project mode
        entry("compute", Project, "Compute", "instances", "Instances", "/compute/instances", "server", None),
        entry("image", Project, "Compute", "images", "Images", "/compute/images", "disc-3", None),
        entry("image", Project, "Compute", "instance-snapshots", "Instance snapshots", "/compute/instance-snapshots", "camera", None),
        entry("compute", Project, "Compute", "keypairs", "Key pairs", "/compute/keypairs", "key-round", None),
        entry("compute", Project, "Compute", "flavors-user", "Flavors", "/compute/flavors", "layers", None),
        entry("compute", Project, "Compute", "server-groups", "Server groups", "/compute/server-groups", "boxes", None),
        entry("compute", Project, "Compute", "usage", "Usage", "/compute/usage", "chart-bar", None),
        entry("block-storage", Project, "Storage", "volumes", "Volumes", "/storage/volumes", "hard-drive", None),
        entry("block-storage", Project, "Storage", "snapshots", "Snapshots", "/storage/snapshots", "camera", None),
        entry("block-storage", Project, "Storage", "backups", "Backups", "/storage/backups", "database-backup", None),
        entry("block-storage", Project, "Storage", "volume-groups", "Volume groups", "/storage/groups", "layers", None).probe("groups/detail"),
        entry("block-storage", Project, "Storage", "group-snapshots", "Group snapshots", "/storage/group-snapshots", "camera", None).probe("group_snapshots/detail"),
        entry("block-storage", Project, "Storage", "transfers", "Transfers", "/storage/transfers", "arrow-right-left", None),
        entry("network", Project, "Network", "topology", "Topology", "/network/topology", "waypoints", None),
        entry("network", Project, "Network", "networks", "Networks", "/network/networks", "network", None),
        entry("network", Project, "Network", "routers", "Routers", "/network/routers", "router", None),
        entry("network", Project, "Network", "security-groups", "Security groups", "/network/security-groups", "shield", None),
        entry("network", Project, "Network", "floating-ips", "Floating IPs", "/network/floating-ips", "globe", None),
        entry("network", Project, "Network", "ports", "Ports", "/network/ports", "ethernet-port", None),
        entry("network", Project, "Network", "subnet-pools", "Subnet pools", "/network/subnet-pools", "split", None).probe("subnetpools"),
        entry("network", Project, "Network", "trunks", "Trunks", "/network/trunks", "cable", None),
        entry("network", Project, "Network", "qos-policies", "QoS policies", "/network/qos", "gauge", None),
        entry("network", Project, "Network", "rbac", "Sharing (RBAC)", "/network/rbac", "share", None),
        entry("object-store", Project, "Object storage", "object-containers", "Containers", "/object-store/containers", "archive", None),
        entry("key-manager", Project, "Key manager", "secrets", "Secrets", "/key-manager/secrets", "lock-keyhole", None),
        entry("key-manager", Project, "Key manager", "containers", "Secret containers", "/key-manager/containers", "package", None),
        entry("key-manager", Project, "Key manager", "orders", "Orders", "/key-manager/orders", "key-round", None),
        entry("identity", Project, "Identity", "app-credentials", "Application credentials", "/identity/application-credentials", "key-square", None),
        entry("identity", Project, "Identity", "api-access", "API access", "/identity/api-access", "terminal", None),
        entry("identity", Project, "Identity", "ec2-credentials", "EC2 credentials", "/identity/ec2-credentials", "key", None),
        entry("compute", Project, "Operations", "cleanup", "Cleanup", "/operations/cleanup", "eraser", None),
        entry("compute", Project, "Operations", "terraform", "Export to Terraform", "/operations/terraform", "file-code", None),
        // Admin mode
        entry("identity", Admin, "Identity", "admin-projects", "Projects", "/admin/identity/projects", "folder-tree", admin),
        entry("identity", Admin, "Identity", "admin-users", "Users", "/admin/identity/users", "users", admin),
        entry("identity", Admin, "Identity", "admin-quotas", "Quotas", "/admin/quotas", "gauge", admin),
        entry("identity", Admin, "Identity", "admin-roles", "Roles", "/admin/identity/roles", "badge-check", admin),
        entry("identity", Admin, "Identity", "admin-groups", "Groups", "/admin/identity/groups", "users-round", admin),
        entry("identity", Admin, "Identity", "admin-domains", "Domains", "/admin/identity/domains", "globe", admin),
        entry("identity", Admin, "Identity", "admin-regions", "Regions", "/admin/identity/regions", "map-pin", admin),
        entry("identity", Admin, "Identity", "admin-federation", "Federation (SSO)", "/admin/identity/federation", "fingerprint", admin),
        entry("identity", Admin, "Identity", "admin-catalog", "Services & endpoints", "/admin/identity/endpoints", "plug", admin),
        entry("image", Admin, "Compute", "admin-images", "Images", "/admin/compute/images", "disc-3", admin),
        entry("image", Admin, "Compute", "admin-instance-snapshots", "Instance snapshots", "/admin/compute/instance-snapshots", "camera", admin),
        entry("image", Admin, "Compute", "metadefs", "Metadata definitions", "/admin/compute/metadata-definitions", "tags", admin),
        entry("compute", Admin, "Compute", "hypervisors", "Hypervisors", "/admin/compute/hypervisors", "cpu", admin),
        entry("compute", Admin, "Compute", "flavors", "Flavors", "/admin/compute/flavors", "layers", admin),
        entry("compute", Admin, "Compute", "aggregates", "Host aggregates", "/admin/compute/aggregates", "group", admin),
        entry("compute", Admin, "Compute", "availability-zones", "Availability zones", "/admin/compute/availability-zones", "map-pin", admin),
        entry("compute", Admin, "Compute", "all-server-groups", "Server groups", "/admin/compute/server-groups", "boxes", admin),
        entry("compute", Admin, "Compute", "all-instances", "All instances", "/admin/compute/instances", "server-cog", admin),
        entry("compute", Admin, "Compute", "compute-services", "Compute services", "/admin/compute/services", "activity", admin),
        entry("compute", Admin, "Compute", "admin-usage", "Usage", "/admin/compute/usage", "chart-bar", admin),
        entry("block-storage", Admin, "Storage", "all-volumes", "All volumes", "/admin/storage/volumes", "hard-drive", admin),
        entry("block-storage", Admin, "Storage", "all-backups", "All backups", "/admin/storage/backups", "database-backup", admin),
        entry("block-storage", Admin, "Storage", "all-volume-groups", "All volume groups", "/admin/storage/groups", "layers", admin).probe("groups/detail"),
        entry("block-storage", Admin, "Storage", "all-group-snapshots", "All group snapshots", "/admin/storage/group-snapshots", "camera", admin).probe("group_snapshots/detail"),
        entry("block-storage", Admin, "Storage", "volume-types", "Volume types", "/admin/storage/volume-types", "tags", admin),
        entry("block-storage", Admin, "Storage", "qos-specs", "QoS specs", "/admin/storage/qos", "gauge", admin),
        entry("block-storage", Admin, "Storage", "group-types", "Group types", "/admin/storage/group-types", "group", admin),
        entry("block-storage", Admin, "Storage", "backends", "Storage backends", "/admin/storage/backends", "server-cog", admin),
        entry("network", Admin, "Network", "all-networks", "All networks", "/admin/network/networks", "network", admin),
        entry("network", Admin, "Network", "all-routers", "All routers", "/admin/network/routers", "router", admin),
        entry("network", Admin, "Network", "all-fips", "Floating IPs", "/admin/network/floating-ips", "globe", admin),
        entry("network", Admin, "Network", "all-ports", "Ports", "/admin/network/ports", "ethernet-port", admin),
        entry("network", Admin, "Network", "all-subnet-pools", "Subnet pools", "/admin/network/subnet-pools", "split", admin).probe("subnetpools"),
        entry("network", Admin, "Network", "all-security-groups", "Security groups", "/admin/network/security-groups", "shield", admin),
        entry("network", Admin, "Network", "ndp-proxies", "NDP proxies", "/admin/network/ndp-proxies", "radio", admin),
        entry("network", Admin, "Network", "ip-availability", "IP availability", "/admin/network/ip-availability", "chart-bar", admin),
        entry("network", Admin, "Network", "all-qos", "QoS policies", "/admin/network/qos", "gauge", admin),
        entry("network", Admin, "Network", "all-rbac", "RBAC policies", "/admin/network/rbac", "share", admin),
        entry("network", Admin, "Network", "agents", "Network agents", "/admin/network/agents", "activity", admin),
        entry("object-store", Admin, "Object storage", "object-storage", "Object storage", "/admin/object-store", "archive", admin),
        entry("key-manager", Admin, "Key manager", "key-manager-quotas", "Key manager quotas", "/admin/key-manager/quotas", "lock-keyhole", admin),
        entry("compute", Admin, "Operations", "admin-cleanup", "Cleanup", "/admin/operations/cleanup", "eraser", admin),
    ]
}
