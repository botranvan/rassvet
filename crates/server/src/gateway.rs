//! Allowlisted gateway to Nova, Neutron, Cinder and Placement: `/api/os/{service}/{*path}`.
//!
//! The browser never talks to OpenStack directly. Every request must match a rule in
//! [`RULES`] (method + path pattern); ids in the path are validated, admin-only rules and
//! parameters require the admin role in Rassvet as well as in the service's own policy,
//! and action bodies are limited to known action names. The gateway adds the session's
//! token and the negotiated microversion, and can follow pagination (`?all_pages=1`).

use std::collections::HashMap;

use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
};
use rassvet_ext_api::{ApiError, RequestContext};
use rassvet_os_client::{Microversion, microversion};
use serde_json::{Value, json};
use tokio::sync::RwLock;

use crate::state::AppState;

/// Upper bound of items gathered when following pages.
const PAGE_CAP: usize = 5000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Svc {
    Compute,
    Network,
    Volume,
    Placement,
    /// Keystone v3 (admin-only rules: domains, regions, groups, federation).
    Identity,
    /// Glance v2, metadata definitions only (images have their own handlers in image.rs).
    Image,
    /// Barbican v1 (secrets, containers, orders, ACLs, quotas). Payloads: barbican.rs.
    KeyManager,
}

impl Svc {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "compute" => Svc::Compute,
            "network" => Svc::Network,
            "volume" => Svc::Volume,
            "placement" => Svc::Placement,
            "identity" => Svc::Identity,
            "image" => Svc::Image,
            "key-manager" => Svc::KeyManager,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Svc::Compute => "compute",
            Svc::Network => "network",
            Svc::Volume => "volume",
            Svc::Placement => "placement",
            Svc::Identity => "identity",
            Svc::Image => "image",
            Svc::KeyManager => "key-manager",
        }
    }

    fn catalog_type(self) -> &'static str {
        match self {
            Svc::Volume => "block-storage",
            other => other.name(),
        }
    }

    /// Highest microversion Rassvet is written against; the session uses
    /// `min(target, server max)`. Network has no microversions.
    fn target(self) -> Option<Microversion> {
        match self {
            // 2.100 (2026.1 era): BFV with volume_type (2.67), hostname (2.90), pinned AZ (2.96).
            Svc::Compute => Some(Microversion::new(2, 100)),
            Svc::Volume => Some(Microversion::new(3, 70)),
            Svc::Placement => Some(Microversion::new(1, 39)),
            Svc::Network | Svc::Identity | Svc::Image | Svc::KeyManager => None,
        }
    }

    fn base_url(self, endpoint: &str) -> String {
        let e = endpoint.trim_end_matches('/');
        match self {
            Svc::Network if !e.ends_with("/v2.0") => format!("{e}/v2.0"),
            Svc::Identity => rassvet_os_client::identity::v3_url(e),
            Svc::Image if !e.ends_with("/v2") => format!("{e}/v2"),
            Svc::KeyManager if !e.ends_with("/v1") => format!("{e}/v1"),
            _ => e.to_owned(),
        }
    }
}

/// Negotiated microversion per (cloud, region, service); `None` = unknown/unsupported.
#[derive(Default)]
pub struct Versions(RwLock<HashMap<String, Option<Microversion>>>);

impl Versions {
    pub async fn get(
        &self,
        ctx: &RequestContext,
        svc: Svc,
        endpoint: &str,
    ) -> Option<Microversion> {
        let target = svc.target()?;
        let key = format!(
            "{}|{}|{}",
            ctx.cloud_id,
            ctx.region.as_deref().unwrap_or(""),
            svc.name()
        );
        if let Some(v) = self.0.read().await.get(&key) {
            return *v;
        }
        let found = microversion::discover(&ctx.http, endpoint, &ctx.token.value).await;
        let v = found.and_then(|r| Microversion::negotiate(target, r));
        tracing::info!(service = svc.name(), region = ?ctx.region, microversion = ?v.map(|m| m.to_string()), "negotiated");
        self.0.write().await.insert(key, v);
        v
    }
}

// ---------------------------------------------------------------------------- rules

struct Rule {
    svc: Svc,
    method: Method,
    /// Segments; `{id}` = resource id, `{name}` = key pair / extra spec name.
    path: &'static str,
    admin: bool,
    /// For action endpoints: allowed top-level body keys (user, admin-only).
    actions: Option<(&'static [&'static str], &'static [&'static str])>,
}

const fn r(svc: Svc, method: Method, path: &'static str) -> Rule {
    Rule {
        svc,
        method,
        path,
        admin: false,
        actions: None,
    }
}
const fn admin(svc: Svc, method: Method, path: &'static str) -> Rule {
    Rule {
        svc,
        method,
        path,
        admin: true,
        actions: None,
    }
}

const SERVER_ACTIONS: &[&str] = &[
    "os-start",
    "os-stop",
    "reboot",
    "pause",
    "unpause",
    "suspend",
    "resume",
    "lock",
    "unlock",
    "shelve",
    "shelveOffload",
    "unshelve",
    "createImage",
    "os-getConsoleOutput",
    "resize",
    "confirmResize",
    "revertResize",
    "rescue",
    "unrescue",
    "addSecurityGroup",
    "removeSecurityGroup",
    "rebuild",
];
const SERVER_ADMIN_ACTIONS: &[&str] = &[
    "migrate",
    "os-migrateLive",
    "evacuate",
    "os-resetState",
    "forceDelete",
    "restore",
];
const VOLUME_ACTIONS: &[&str] = &[
    "os-extend",
    "os-set_bootable",
    "os-update_readonly_flag",
    "os-volume_upload_image",
    "os-retype",
];
const VOLUME_ADMIN_ACTIONS: &[&str] = &["os-reset_status", "os-force_delete", "os-migrate_volume"];
const GROUP_ACTIONS: &[&str] = &["delete"];
const GROUP_ADMIN_ACTIONS: &[&str] = &["reset_status"];
const GROUP_CREATE: &[&str] = &["create-from-src"];
const BACKUP_ADMIN_ACTIONS: &[&str] = &["os-reset_status", "os-force_delete"];
const SNAPSHOT_ADMIN_ACTIONS: &[&str] = &["reset_status"];
const TYPE_ADMIN_ACTIONS: &[&str] = &["addProjectAccess", "removeProjectAccess"];
const FLAVOR_ADMIN_ACTIONS: &[&str] = &["addTenantAccess", "removeTenantAccess"];
const AGGREGATE_ADMIN_ACTIONS: &[&str] = &["add_host", "remove_host", "set_metadata"];
const MIGRATION_ADMIN_ACTIONS: &[&str] = &["force_complete"];
const NONE: &[&str] = &[];

const fn act(
    svc: Svc,
    path: &'static str,
    user: &'static [&'static str],
    admin: &'static [&'static str],
) -> Rule {
    Rule {
        svc,
        method: Method::POST,
        path,
        admin: false,
        actions: Some((user, admin)),
    }
}

use Method as M;
use Svc::*;

#[rustfmt::skip]
static RULES: &[Rule] = &[
    // ---- Nova
    r(Compute, M::GET, "servers/detail"),
    // Light lists (id + name): paged tables fetch these, then each row's detail on its own.
    r(Compute, M::GET, "servers"),
    r(Compute, M::GET, "servers/{id}"),
    r(Compute, M::PUT, "servers/{id}"),
    r(Compute, M::DELETE, "servers/{id}"),
    r(Compute, M::GET, "servers/{id}/metadata"),
    r(Compute, M::PUT, "servers/{id}/metadata"),
    Rule { svc: Compute, method: M::POST, path: "servers/{id}/action", admin: false, actions: Some((SERVER_ACTIONS, SERVER_ADMIN_ACTIONS)) },
    r(Compute, M::GET, "servers/{id}/os-interface"),
    r(Compute, M::POST, "servers/{id}/os-interface"),
    r(Compute, M::GET, "servers/{id}/os-interface/{id}"),
    r(Compute, M::DELETE, "servers/{id}/os-interface/{id}"),
    r(Compute, M::GET, "servers/{id}/os-volume_attachments"),
    r(Compute, M::POST, "servers/{id}/os-volume_attachments"),
    r(Compute, M::DELETE, "servers/{id}/os-volume_attachments/{id}"),
    r(Compute, M::POST, "servers/{id}/remote-consoles"),
    r(Compute, M::GET, "servers/{id}/os-instance-actions"),
    r(Compute, M::GET, "flavors/detail"),
    r(Compute, M::GET, "flavors/{id}"),
    r(Compute, M::GET, "flavors/{id}/os-extra_specs"),
    admin(Compute, M::POST, "flavors"),
    admin(Compute, M::DELETE, "flavors/{id}"),
    admin(Compute, M::POST, "flavors/{id}/os-extra_specs"),
    admin(Compute, M::DELETE, "flavors/{id}/os-extra_specs/{name}"),
    r(Compute, M::GET, "os-keypairs"),
    r(Compute, M::GET, "os-keypairs/{name}"),
    r(Compute, M::POST, "os-keypairs"),
    r(Compute, M::DELETE, "os-keypairs/{name}"),
    r(Compute, M::GET, "os-availability-zone"),
    admin(Compute, M::GET, "os-availability-zone/detail"),
    // Server tags (2.26): the whole list is replaced at once.
    r(Compute, M::GET, "servers/{id}/tags"),
    r(Compute, M::PUT, "servers/{id}/tags"),
    r(Compute, M::GET, "os-server-groups"),
    r(Compute, M::POST, "os-server-groups"),
    r(Compute, M::GET, "os-server-groups/{id}"),
    r(Compute, M::DELETE, "os-server-groups/{id}"),
    r(Compute, M::GET, "limits"),
    admin(Compute, M::GET, "os-hypervisors/detail"),
    // Light list + one hypervisor at a time: the admin list fills rows as each detail lands.
    admin(Compute, M::GET, "os-hypervisors"),
    admin(Compute, M::GET, "os-hypervisors/{id}"),
    admin(Compute, M::GET, "os-services"),
    admin(Compute, M::PUT, "os-services/{id}"),
    admin(Compute, M::DELETE, "os-services/{id}"),
    // Host maintenance: migration history per host / instance, abort or force-complete a live migration.
    admin(Compute, M::GET, "os-migrations"),
    admin(Compute, M::GET, "servers/{id}/migrations"),
    admin(Compute, M::DELETE, "servers/{id}/migrations/{id}"),
    act(Compute, "servers/{id}/migrations/{id}/action", NONE, MIGRATION_ADMIN_ACTIONS),
    admin(Compute, M::GET, "os-aggregates"),
    admin(Compute, M::POST, "os-aggregates"),
    admin(Compute, M::GET, "os-aggregates/{id}"),
    admin(Compute, M::PUT, "os-aggregates/{id}"),
    admin(Compute, M::DELETE, "os-aggregates/{id}"),
    act(Compute, "os-aggregates/{id}/action", NONE, AGGREGATE_ADMIN_ACTIONS),
    admin(Compute, M::PUT, "flavors/{id}"),
    admin(Compute, M::GET, "flavors/{id}/os-flavor-access"),
    act(Compute, "flavors/{id}/action", NONE, FLAVOR_ADMIN_ACTIONS),
    admin(Compute, M::PUT, "flavors/{id}/os-extra_specs/{name}"),
    // Usage: all projects (admin) or one project (Nova lets members see their own).
    admin(Compute, M::GET, "os-simple-tenant-usage"),
    r(Compute, M::GET, "os-simple-tenant-usage/{id}"),
    // Quotas: anyone may read their own project's, admins edit any project's and the defaults.
    r(Compute, M::GET, "os-quota-sets/{id}"),
    r(Compute, M::GET, "os-quota-sets/{id}/detail"),
    r(Compute, M::GET, "os-quota-sets/{id}/defaults"),
    admin(Compute, M::PUT, "os-quota-sets/{id}"),
    admin(Compute, M::DELETE, "os-quota-sets/{id}"),
    admin(Compute, M::GET, "os-quota-class-sets/{id}"),
    admin(Compute, M::PUT, "os-quota-class-sets/{id}"),
    // ---- Neutron
    r(Network, M::GET, "networks"),
    r(Network, M::GET, "networks/{id}"),
    r(Network, M::POST, "networks"),
    r(Network, M::PUT, "networks/{id}"),
    r(Network, M::DELETE, "networks/{id}"),
    // Subnet pools (subnet_allocation) and address scopes; prefix ops need subnetpool-prefix-ops,
    // onboarding existing subnets needs subnet_onboard.
    r(Network, M::GET, "subnetpools"),
    r(Network, M::POST, "subnetpools"),
    r(Network, M::GET, "subnetpools/{id}"),
    r(Network, M::PUT, "subnetpools/{id}"),
    r(Network, M::DELETE, "subnetpools/{id}"),
    r(Network, M::PUT, "subnetpools/{id}/add_prefixes"),
    r(Network, M::PUT, "subnetpools/{id}/remove_prefixes"),
    r(Network, M::PUT, "subnetpools/{id}/onboard_network_subnets"),
    r(Network, M::GET, "address-scopes"),
    r(Network, M::POST, "address-scopes"),
    r(Network, M::GET, "address-scopes/{id}"),
    r(Network, M::PUT, "address-scopes/{id}"),
    r(Network, M::DELETE, "address-scopes/{id}"),
    r(Network, M::GET, "subnets"),
    r(Network, M::GET, "subnets/{id}"),
    r(Network, M::POST, "subnets"),
    r(Network, M::PUT, "subnets/{id}"),
    r(Network, M::DELETE, "subnets/{id}"),
    r(Network, M::GET, "ports"),
    r(Network, M::GET, "ports/{id}"),
    r(Network, M::POST, "ports"),
    r(Network, M::PUT, "ports/{id}"),
    r(Network, M::DELETE, "ports/{id}"),
    r(Network, M::GET, "routers"),
    r(Network, M::GET, "routers/{id}"),
    r(Network, M::POST, "routers"),
    r(Network, M::PUT, "routers/{id}"),
    r(Network, M::DELETE, "routers/{id}"),
    r(Network, M::PUT, "routers/{id}/add_router_interface"),
    r(Network, M::PUT, "routers/{id}/remove_router_interface"),
    r(Network, M::GET, "security-groups"),
    r(Network, M::GET, "security-groups/{id}"),
    r(Network, M::POST, "security-groups"),
    r(Network, M::PUT, "security-groups/{id}"),
    r(Network, M::DELETE, "security-groups/{id}"),
    r(Network, M::GET, "security-group-rules"),
    r(Network, M::POST, "security-group-rules"),
    r(Network, M::DELETE, "security-group-rules/{id}"),
    r(Network, M::GET, "floatingips"),
    r(Network, M::POST, "floatingips"),
    r(Network, M::GET, "floatingips/{id}"),
    r(Network, M::PUT, "floatingips/{id}"),
    r(Network, M::DELETE, "floatingips/{id}"),
    r(Network, M::GET, "quotas/{id}/details"),
    r(Network, M::GET, "quotas/{id}"),
    r(Network, M::GET, "quotas/{id}/default"),
    admin(Network, M::PUT, "quotas/{id}"),
    admin(Network, M::DELETE, "quotas/{id}"),
    admin(Network, M::GET, "agents"),
    admin(Network, M::GET, "agents/{id}"),
    admin(Network, M::PUT, "agents/{id}"),
    admin(Network, M::DELETE, "agents/{id}"),
    admin(Network, M::GET, "agents/{id}/l3-routers"),
    admin(Network, M::POST, "agents/{id}/l3-routers"),
    admin(Network, M::DELETE, "agents/{id}/l3-routers/{id}"),
    admin(Network, M::GET, "agents/{id}/dhcp-networks"),
    admin(Network, M::POST, "agents/{id}/dhcp-networks"),
    admin(Network, M::DELETE, "agents/{id}/dhcp-networks/{id}"),
    admin(Network, M::GET, "routers/{id}/l3-agents"),
    admin(Network, M::GET, "networks/{id}/dhcp-agents"),
    admin(Network, M::GET, "network-ip-availabilities"),
    admin(Network, M::GET, "network-ip-availabilities/{id}"),
    r(Network, M::GET, "availability_zones"),
    r(Network, M::GET, "extensions"),
    // NDP proxies (l3-ndp-proxy): publish an internal IPv6 address on a router's gateway.
    r(Network, M::GET, "ndp-proxies"),
    r(Network, M::POST, "ndp-proxies"),
    r(Network, M::GET, "ndp-proxies/{id}"),
    r(Network, M::PUT, "ndp-proxies/{id}"),
    r(Network, M::DELETE, "ndp-proxies/{id}"),
    // Trunks (VLAN-aware instances)
    r(Network, M::GET, "trunks"),
    r(Network, M::POST, "trunks"),
    r(Network, M::GET, "trunks/{id}"),
    r(Network, M::PUT, "trunks/{id}"),
    r(Network, M::DELETE, "trunks/{id}"),
    r(Network, M::GET, "trunks/{id}/get_subports"),
    r(Network, M::PUT, "trunks/{id}/add_subports"),
    r(Network, M::PUT, "trunks/{id}/remove_subports"),
    // QoS policies and rules; Neutron's policy decides who may create them (admins by default).
    r(Network, M::GET, "qos/policies"),
    r(Network, M::POST, "qos/policies"),
    r(Network, M::GET, "qos/policies/{id}"),
    r(Network, M::PUT, "qos/policies/{id}"),
    r(Network, M::DELETE, "qos/policies/{id}"),
    r(Network, M::GET, "qos/rule-types"),
    r(Network, M::GET, "qos/policies/{id}/bandwidth_limit_rules"),
    r(Network, M::POST, "qos/policies/{id}/bandwidth_limit_rules"),
    r(Network, M::PUT, "qos/policies/{id}/bandwidth_limit_rules/{id}"),
    r(Network, M::DELETE, "qos/policies/{id}/bandwidth_limit_rules/{id}"),
    r(Network, M::GET, "qos/policies/{id}/dscp_marking_rules"),
    r(Network, M::POST, "qos/policies/{id}/dscp_marking_rules"),
    r(Network, M::PUT, "qos/policies/{id}/dscp_marking_rules/{id}"),
    r(Network, M::DELETE, "qos/policies/{id}/dscp_marking_rules/{id}"),
    r(Network, M::GET, "qos/policies/{id}/minimum_bandwidth_rules"),
    r(Network, M::POST, "qos/policies/{id}/minimum_bandwidth_rules"),
    r(Network, M::PUT, "qos/policies/{id}/minimum_bandwidth_rules/{id}"),
    r(Network, M::DELETE, "qos/policies/{id}/minimum_bandwidth_rules/{id}"),
    r(Network, M::GET, "qos/policies/{id}/minimum_packet_rate_rules"),
    r(Network, M::POST, "qos/policies/{id}/minimum_packet_rate_rules"),
    r(Network, M::PUT, "qos/policies/{id}/minimum_packet_rate_rules/{id}"),
    r(Network, M::DELETE, "qos/policies/{id}/minimum_packet_rate_rules/{id}"),
    r(Network, M::GET, "qos/policies/{id}/packet_rate_limit_rules"),
    r(Network, M::POST, "qos/policies/{id}/packet_rate_limit_rules"),
    r(Network, M::PUT, "qos/policies/{id}/packet_rate_limit_rules/{id}"),
    r(Network, M::DELETE, "qos/policies/{id}/packet_rate_limit_rules/{id}"),
    // RBAC: share networks, QoS policies, security groups… with other projects
    r(Network, M::GET, "rbac-policies"),
    r(Network, M::POST, "rbac-policies"),
    r(Network, M::GET, "rbac-policies/{id}"),
    r(Network, M::PUT, "rbac-policies/{id}"),
    r(Network, M::DELETE, "rbac-policies/{id}"),
    // ---- Barbican (Barbican's own policy decides; project-quotas are admin-only).
    r(KeyManager, M::GET, "secrets"),
    r(KeyManager, M::POST, "secrets"),
    r(KeyManager, M::GET, "secrets/{id}"),
    r(KeyManager, M::DELETE, "secrets/{id}"),
    r(KeyManager, M::GET, "secrets/{id}/metadata"),
    r(KeyManager, M::PUT, "secrets/{id}/metadata"),
    r(KeyManager, M::GET, "secrets/{id}/acl"),
    r(KeyManager, M::PUT, "secrets/{id}/acl"),
    r(KeyManager, M::DELETE, "secrets/{id}/acl"),
    r(KeyManager, M::GET, "secrets/{id}/consumers"),
    r(KeyManager, M::GET, "containers"),
    r(KeyManager, M::POST, "containers"),
    r(KeyManager, M::GET, "containers/{id}"),
    r(KeyManager, M::DELETE, "containers/{id}"),
    r(KeyManager, M::POST, "containers/{id}/secrets"),
    r(KeyManager, M::DELETE, "containers/{id}/secrets"),
    r(KeyManager, M::GET, "containers/{id}/consumers"),
    r(KeyManager, M::GET, "containers/{id}/acl"),
    r(KeyManager, M::PUT, "containers/{id}/acl"),
    r(KeyManager, M::DELETE, "containers/{id}/acl"),
    r(KeyManager, M::GET, "orders"),
    r(KeyManager, M::POST, "orders"),
    r(KeyManager, M::GET, "orders/{id}"),
    r(KeyManager, M::DELETE, "orders/{id}"),
    r(KeyManager, M::GET, "quotas"),
    admin(KeyManager, M::GET, "project-quotas"),
    admin(KeyManager, M::GET, "project-quotas/{id}"),
    admin(KeyManager, M::PUT, "project-quotas/{id}"),
    admin(KeyManager, M::DELETE, "project-quotas/{id}"),
    // ---- Cinder
    r(Volume, M::GET, "volumes/detail"),
    r(Volume, M::GET, "volumes"),
    r(Volume, M::GET, "volumes/{id}"),
    r(Volume, M::POST, "volumes"),
    r(Volume, M::PUT, "volumes/{id}"),
    r(Volume, M::DELETE, "volumes/{id}"),
    Rule { svc: Volume, method: M::POST, path: "volumes/{id}/action", admin: false, actions: Some((VOLUME_ACTIONS, VOLUME_ADMIN_ACTIONS)) },
    r(Volume, M::GET, "snapshots/detail"),
    r(Volume, M::GET, "snapshots"),
    r(Volume, M::GET, "snapshots/{id}"),
    r(Volume, M::POST, "snapshots"),
    r(Volume, M::PUT, "snapshots/{id}"),
    r(Volume, M::DELETE, "snapshots/{id}"),
    r(Volume, M::GET, "types"),
    r(Volume, M::GET, "types/{id}"),
    admin(Volume, M::POST, "types"),
    admin(Volume, M::PUT, "types/{id}"),
    admin(Volume, M::DELETE, "types/{id}"),
    r(Volume, M::GET, "limits"),
    r(Volume, M::GET, "os-availability-zone"),
    // Volume type details (admin)
    admin(Volume, M::GET, "types/{id}/extra_specs"),
    admin(Volume, M::POST, "types/{id}/extra_specs"),
    admin(Volume, M::DELETE, "types/{id}/extra_specs/{name}"),
    admin(Volume, M::GET, "types/{id}/os-volume-type-access"),
    act(Volume, "types/{id}/action", NONE, TYPE_ADMIN_ACTIONS),
    admin(Volume, M::GET, "types/{id}/encryption"),
    admin(Volume, M::POST, "types/{id}/encryption"),
    admin(Volume, M::DELETE, "types/{id}/encryption/{id}"),
    // QoS specs (admin)
    admin(Volume, M::GET, "qos-specs"),
    admin(Volume, M::POST, "qos-specs"),
    admin(Volume, M::GET, "qos-specs/{id}"),
    admin(Volume, M::PUT, "qos-specs/{id}"),
    admin(Volume, M::DELETE, "qos-specs/{id}"),
    admin(Volume, M::PUT, "qos-specs/{id}/delete_keys"),
    admin(Volume, M::GET, "qos-specs/{id}/associations"),
    admin(Volume, M::GET, "qos-specs/{id}/associate"),
    admin(Volume, M::GET, "qos-specs/{id}/disassociate"),
    r(Volume, M::GET, "os-quota-sets/{id}"),
    r(Volume, M::GET, "os-quota-sets/{id}/defaults"),
    admin(Volume, M::PUT, "os-quota-sets/{id}"),
    admin(Volume, M::DELETE, "os-quota-sets/{id}"),
    admin(Volume, M::GET, "os-quota-class-sets/{id}"),
    admin(Volume, M::PUT, "os-quota-class-sets/{id}"),
    // Volume groups (3.13+), group snapshots (3.14+), group types (3.11+)
    r(Volume, M::GET, "groups/detail"),
    r(Volume, M::POST, "groups"),
    r(Volume, M::GET, "groups/{id}"),
    r(Volume, M::PUT, "groups/{id}"),
    act(Volume, "groups/{id}/action", GROUP_ACTIONS, GROUP_ADMIN_ACTIONS),
    act(Volume, "groups/action", GROUP_CREATE, NONE),
    r(Volume, M::GET, "group_snapshots/detail"),
    r(Volume, M::POST, "group_snapshots"),
    r(Volume, M::GET, "group_snapshots/{id}"),
    r(Volume, M::DELETE, "group_snapshots/{id}"),
    act(Volume, "group_snapshots/{id}/action", NONE, SNAPSHOT_ADMIN_ACTIONS),
    r(Volume, M::GET, "group_types"),
    r(Volume, M::GET, "group_types/{id}"),
    admin(Volume, M::POST, "group_types"),
    admin(Volume, M::PUT, "group_types/{id}"),
    admin(Volume, M::DELETE, "group_types/{id}"),
    admin(Volume, M::GET, "group_types/{id}/group_specs"),
    admin(Volume, M::POST, "group_types/{id}/group_specs"),
    admin(Volume, M::DELETE, "group_types/{id}/group_specs/{name}"),
    // Transfers between projects (3.55+)
    r(Volume, M::GET, "volume-transfers/detail"),
    r(Volume, M::POST, "volume-transfers"),
    r(Volume, M::GET, "volume-transfers/{id}"),
    r(Volume, M::DELETE, "volume-transfers/{id}"),
    r(Volume, M::POST, "volume-transfers/{id}/accept"),
    // Backups
    r(Volume, M::GET, "backups/detail"),
    r(Volume, M::GET, "backups"),
    r(Volume, M::POST, "backups"),
    r(Volume, M::GET, "backups/{id}"),
    r(Volume, M::PUT, "backups/{id}"),
    r(Volume, M::DELETE, "backups/{id}"),
    r(Volume, M::POST, "backups/{id}/restore"),
    act(Volume, "backups/{id}/action", NONE, BACKUP_ADMIN_ACTIONS),
    // Storage backends (admin)
    admin(Volume, M::GET, "os-services"),
    // Enable / disable a Cinder service (body {host, binary[, disabled_reason]}).
    admin(Volume, M::PUT, "os-services/enable"),
    admin(Volume, M::PUT, "os-services/disable"),
    admin(Volume, M::PUT, "os-services/disable-log-reason"),
    admin(Volume, M::GET, "scheduler-stats/get_pools"),
    // ---- Placement (admin only)
    admin(Placement, M::GET, "resource_providers"),
    admin(Placement, M::GET, "resource_providers/{id}"),
    admin(Placement, M::GET, "resource_providers/{id}/inventories"),
    admin(Placement, M::GET, "resource_providers/{id}/usages"),
    admin(Placement, M::GET, "resource_providers/{id}/traits"),
    admin(Placement, M::GET, "resource_providers/{id}/aggregates"),
    // ---- Keystone (beyond Rassvet's typed /api/identity routes)
    admin(Identity, M::GET, "domains"),
    admin(Identity, M::POST, "domains"),
    admin(Identity, M::GET, "domains/{id}"),
    admin(Identity, M::PATCH, "domains/{id}"),
    admin(Identity, M::DELETE, "domains/{id}"),
    admin(Identity, M::GET, "regions"),
    admin(Identity, M::POST, "regions"),
    admin(Identity, M::GET, "regions/{id}"),
    admin(Identity, M::PATCH, "regions/{id}"),
    admin(Identity, M::DELETE, "regions/{id}"),
    admin(Identity, M::GET, "groups"),
    admin(Identity, M::POST, "groups"),
    admin(Identity, M::PATCH, "groups/{id}"),
    admin(Identity, M::DELETE, "groups/{id}"),
    admin(Identity, M::GET, "OS-FEDERATION/identity_providers"),
    admin(Identity, M::GET, "OS-FEDERATION/identity_providers/{id}"),
    admin(Identity, M::PUT, "OS-FEDERATION/identity_providers/{id}"),
    admin(Identity, M::PATCH, "OS-FEDERATION/identity_providers/{id}"),
    admin(Identity, M::DELETE, "OS-FEDERATION/identity_providers/{id}"),
    admin(Identity, M::GET, "OS-FEDERATION/identity_providers/{id}/protocols"),
    admin(Identity, M::GET, "OS-FEDERATION/identity_providers/{id}/protocols/{id}"),
    admin(Identity, M::PUT, "OS-FEDERATION/identity_providers/{id}/protocols/{id}"),
    admin(Identity, M::PATCH, "OS-FEDERATION/identity_providers/{id}/protocols/{id}"),
    admin(Identity, M::DELETE, "OS-FEDERATION/identity_providers/{id}/protocols/{id}"),
    admin(Identity, M::GET, "OS-FEDERATION/mappings"),
    admin(Identity, M::GET, "OS-FEDERATION/mappings/{id}"),
    admin(Identity, M::PUT, "OS-FEDERATION/mappings/{id}"),
    admin(Identity, M::PATCH, "OS-FEDERATION/mappings/{id}"),
    admin(Identity, M::DELETE, "OS-FEDERATION/mappings/{id}"),
    admin(Identity, M::GET, "OS-FEDERATION/service_providers"),
    admin(Identity, M::GET, "OS-FEDERATION/service_providers/{id}"),
    admin(Identity, M::PUT, "OS-FEDERATION/service_providers/{id}"),
    admin(Identity, M::PATCH, "OS-FEDERATION/service_providers/{id}"),
    admin(Identity, M::DELETE, "OS-FEDERATION/service_providers/{id}"),
    // Groups: members, role assignments on projects, system roles.
    admin(Identity, M::GET, "groups/{id}"),
    admin(Identity, M::GET, "groups/{id}/users"),
    admin(Identity, M::PUT, "groups/{id}/users/{id}"),
    admin(Identity, M::DELETE, "groups/{id}/users/{id}"),
    admin(Identity, M::GET, "users/{id}/groups"),
    admin(Identity, M::GET, "role_assignments"),
    admin(Identity, M::PUT, "projects/{id}/groups/{id}/roles/{id}"),
    admin(Identity, M::DELETE, "projects/{id}/groups/{id}/roles/{id}"),
    admin(Identity, M::GET, "system/users/{id}/roles"),
    admin(Identity, M::PUT, "system/users/{id}/roles/{id}"),
    admin(Identity, M::DELETE, "system/users/{id}/roles/{id}"),
    admin(Identity, M::GET, "system/groups/{id}/roles"),
    admin(Identity, M::PUT, "system/groups/{id}/roles/{id}"),
    admin(Identity, M::DELETE, "system/groups/{id}/roles/{id}"),
    // Glance metadata definitions: read for everyone, managed by admins.
    r(Image, M::GET, "metadefs/namespaces"),
    r(Image, M::GET, "metadefs/namespaces/{name}"),
    admin(Image, M::POST, "metadefs/namespaces"),
    admin(Image, M::PUT, "metadefs/namespaces/{name}"),
    admin(Image, M::DELETE, "metadefs/namespaces/{name}"),
    r(Image, M::GET, "metadefs/namespaces/{name}/properties"),
    admin(Image, M::POST, "metadefs/namespaces/{name}/properties"),
    r(Image, M::GET, "metadefs/namespaces/{name}/properties/{name}"),
    admin(Image, M::PUT, "metadefs/namespaces/{name}/properties/{name}"),
    admin(Image, M::DELETE, "metadefs/namespaces/{name}/properties/{name}"),
    r(Image, M::GET, "metadefs/namespaces/{name}/objects"),
    admin(Image, M::POST, "metadefs/namespaces/{name}/objects"),
    r(Image, M::GET, "metadefs/namespaces/{name}/objects/{name}"),
    admin(Image, M::PUT, "metadefs/namespaces/{name}/objects/{name}"),
    admin(Image, M::DELETE, "metadefs/namespaces/{name}/objects/{name}"),
    r(Image, M::GET, "metadefs/resource_types"),
    r(Image, M::GET, "metadefs/namespaces/{name}/resource_types"),
    admin(Image, M::POST, "metadefs/namespaces/{name}/resource_types"),
    admin(Image, M::DELETE, "metadefs/namespaces/{name}/resource_types/{name}"),
];

/// Resource ids: UUIDs, flavor ids, numeric ids.
fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Key pair names (2.92 allows `@` and `.`) and extra spec keys (`hw:cpu_policy`).
pub fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || " _-.@:".contains(c))
}

fn matches(rule: &Rule, svc: Svc, method: &Method, segs: &[&str]) -> bool {
    if rule.svc != svc || rule.method != *method {
        return false;
    }
    let pat: Vec<&str> = rule.path.split('/').collect();
    pat.len() == segs.len()
        && pat.iter().zip(segs).all(|(p, s)| match *p {
            "{id}" => valid_id(s),
            "{name}" => valid_name(s),
            lit => lit == *s,
        })
}

fn find_rule(svc: Svc, method: &Method, path: &str) -> Option<&'static Rule> {
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    RULES.iter().find(|r| matches(r, svc, method, &segs))
}

/// Query parameters that widen the scope to other projects.
const ADMIN_PARAMS: &[&str] = &["all_tenants", "all_projects"];

// ---------------------------------------------------------------------------- calls

/// Send one request to a service (no allowlist check: for Rassvet's own typed routes).
pub async fn call(
    st: &AppState,
    ctx: &RequestContext,
    svc: Svc,
    method: Method,
    path: &str,
    query: &[(String, String)],
    body: Option<&Value>,
) -> Result<(StatusCode, Value), ApiError> {
    let endpoint = match svc {
        // Regions without their own identity endpoint use the configured auth URL.
        Identity => ctx
            .endpoint("identity")
            .unwrap_or_else(|_| ctx.auth_url.clone()),
        _ => ctx.endpoint(svc.catalog_type())?,
    };
    let mv = st.versions.get(ctx, svc, &endpoint).await;
    let encoded: Vec<String> = path
        .trim_matches('/')
        .split('/')
        .map(|s| {
            url::form_urlencoded::byte_serialize(s.as_bytes())
                .collect::<String>()
                .replace('+', "%20")
        })
        .collect();
    let url = format!("{}/{}", svc.base_url(&endpoint), encoded.join("/"));
    let mut req = ctx
        .request(method, &url)
        .header("Accept", "application/json")
        .query(query);
    if let Some(v) = mv {
        let name = match svc {
            Compute => "compute",
            Volume => "volume",
            Placement => "placement",
            Network | Identity | Image | KeyManager => "network",
        };
        req = req.header("OpenStack-API-Version", format!("{name} {v}"));
        if svc == Compute {
            req = req.header("X-OpenStack-Nova-API-Version", v.to_string());
        }
    }
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = rassvet_os_client::trace::send(svc.name(), req).await?;
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::OK);
    let bytes = resp.bytes().await?;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    Ok((status, value))
}

/// GET a list and follow `<key>_links` "next" pages with markers, up to [`PAGE_CAP`] items.
pub async fn call_all(
    st: &AppState,
    ctx: &RequestContext,
    svc: Svc,
    path: &str,
    query: &[(String, String)],
) -> Result<Value, ApiError> {
    let (_, mut first) = call(st, ctx, svc, Method::GET, path, query, None).await?;
    let Some(key) = first.as_object().and_then(|o| {
        o.iter()
            .find(|(k, v)| v.is_array() && !k.ends_with("_links"))
            .map(|(k, _)| k.clone())
    }) else {
        return Ok(first);
    };
    let mut items = first[&key].as_array().cloned().unwrap_or_default();
    let mut page = first.clone();
    let mut truncated = false;
    // Barbican pages with limit/offset and reports `total`.
    if svc == KeyManager {
        let total = first["total"].as_u64().unwrap_or(0) as usize;
        let limit = items.len().max(1);
        while items.len() < total.min(PAGE_CAP) {
            let mut q: Vec<(String, String)> = query
                .iter()
                .filter(|(k, _)| k != "offset" && k != "limit")
                .cloned()
                .collect();
            q.push(("limit".into(), limit.max(100).to_string()));
            q.push(("offset".into(), items.len().to_string()));
            let (_, next) = call(st, ctx, svc, Method::GET, path, &q, None).await?;
            let got = next[&key].as_array().cloned().unwrap_or_default();
            if got.is_empty() {
                break;
            }
            items.extend(got);
        }
        truncated = total > PAGE_CAP;
        items.truncate(PAGE_CAP);
        if let Some(o) = first.as_object_mut() {
            o.insert(key.clone(), Value::Array(items));
            o.remove("next");
            o.remove("previous");
            o.insert("truncated".into(), json!(truncated));
        }
        return Ok(first);
    }
    loop {
        let has_next = page[format!("{key}_links")]
            .as_array()
            .is_some_and(|l| l.iter().any(|x| x["rel"] == "next"));
        let marker = page[&key].as_array().and_then(|a| a.last()).and_then(|l| {
            l["id"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| l["id"].as_i64().map(|i| i.to_string()))
        });
        let (true, Some(marker)) = (has_next, marker) else {
            break;
        };
        if items.len() >= PAGE_CAP {
            truncated = true;
            break;
        }
        let mut q: Vec<(String, String)> = query
            .iter()
            .filter(|(k, _)| k != "marker")
            .cloned()
            .collect();
        q.push(("marker".into(), marker));
        let (_, next) = call(st, ctx, svc, Method::GET, path, &q, None).await?;
        let got = next[&key].as_array().cloned().unwrap_or_default();
        if got.is_empty() {
            break;
        }
        items.extend(got);
        page = next;
    }
    items.truncate(PAGE_CAP);
    if let Some(o) = first.as_object_mut() {
        o.insert(key.clone(), Value::Array(items));
        o.remove(&format!("{key}_links"));
        o.insert("truncated".into(), json!(truncated));
    }
    Ok(first)
}

/// `/api/os/{service}/{*path}`
pub async fn handle(
    State(st): State<AppState>,
    ctx: RequestContext,
    method: Method,
    Path((service, path)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
    body: Bytes,
) -> Result<Response, ApiError> {
    let svc = Svc::parse(&service).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            format!("unknown service '{service}'"),
        )
    })?;
    let rule = find_rule(svc, &method, &path).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            format!("{method} {service}/{path} is not available in Rassvet"),
        )
    })?;
    let admin_needed = |what: &str| {
        ApiError::new(
            StatusCode::FORBIDDEN,
            format!("the admin role is required to {what}"),
        )
    };
    if rule.admin && !ctx.is_admin() {
        return Err(admin_needed("use this API"));
    }

    let mut all_pages = false;
    let mut query = Vec::new();
    for (k, v) in url::form_urlencoded::parse(raw.as_deref().unwrap_or("").as_bytes()) {
        if k == "all_pages" {
            all_pages = v == "1" || v == "true";
            continue;
        }
        if ADMIN_PARAMS.contains(&k.as_ref()) && !ctx.is_admin() {
            return Err(admin_needed("list other projects' resources"));
        }
        query.push((k.into_owned(), v.into_owned()));
    }

    let body: Option<Value> = if body.is_empty() {
        None
    } else {
        Some(serde_json::from_slice(&body).map_err(|e| {
            ApiError::new(StatusCode::BAD_REQUEST, format!("invalid JSON body: {e}"))
        })?)
    };
    if let Some((user, adm)) = rule.actions {
        let action = body
            .as_ref()
            .and_then(Value::as_object)
            .filter(|o| o.len() == 1)
            .and_then(|o| o.keys().next())
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "an action body has exactly one action",
                )
            })?;
        if adm.contains(&action.as_str()) {
            if !ctx.is_admin() {
                return Err(admin_needed(&format!("run {action}")));
            }
        } else if !user.contains(&action.as_str()) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("action '{action}' is not available in Rassvet"),
            ));
        }
        tracing::info!(user = %ctx.token.user.name, service = svc.name(), %path, %action, "action");
    } else if method != Method::GET {
        tracing::info!(user = %ctx.token.user.name, service = svc.name(), %method, %path, "change");
    }

    if all_pages && method == Method::GET {
        return Ok(Json(call_all(&st, &ctx, svc, &path, &query).await?).into_response());
    }
    let (status, value) = call(&st, &ctx, svc, method, &path, &query, body.as_ref()).await?;
    Ok(if value.is_null() {
        status.into_response()
    } else {
        (status, Json(value)).into_response()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist() {
        assert!(find_rule(Compute, &M::GET, "servers/detail").is_some());
        assert!(find_rule(Compute, &M::POST, "servers/3f2a-11/action").is_some());
        assert!(find_rule(Compute, &M::DELETE, "os-keypairs/my key@lab").is_some());
        assert!(find_rule(Compute, &M::GET, "servers/../flavors").is_none());
        assert!(
            find_rule(Compute, &M::GET, "os-hypervisors/3f2a-11")
                .unwrap()
                .admin
        );
        assert!(find_rule(Compute, &M::GET, "os-hypervisors/3f2a-11/servers").is_none());
        assert!(find_rule(Compute, &M::GET, "os-migrations").unwrap().admin);
        assert!(
            find_rule(Compute, &M::DELETE, "servers/3f2a-11/migrations/42")
                .unwrap()
                .admin
        );
        assert!(find_rule(Network, &M::PUT, "subnetpools/abc/add_prefixes").is_some());
        assert!(find_rule(Network, &M::PUT, "subnetpools/abc/drop_all").is_none());
        assert!(find_rule(KeyManager, &M::DELETE, "containers/c1/secrets").is_some());
        assert!(find_rule(KeyManager, &M::GET, "secrets/s1/payload").is_none());
        assert!(
            find_rule(KeyManager, &M::PUT, "project-quotas/p1")
                .unwrap()
                .admin
        );
        for list in ["servers", "volumes", "snapshots", "backups"] {
            let svc = if list == "servers" { Compute } else { Volume };
            assert!(!find_rule(svc, &M::GET, list).unwrap().admin);
        }
        assert!(find_rule(Compute, &M::PUT, "servers/abc/tags").is_some());
        assert!(find_rule(Compute, &M::PUT, "servers/abc/tags/web").is_none());
        assert!(
            find_rule(Compute, &M::GET, "os-availability-zone/detail")
                .unwrap()
                .admin
        );
        assert!(
            find_rule(Identity, &M::PUT, "projects/p1/groups/g1/roles/r1")
                .unwrap()
                .admin
        );
        assert!(
            find_rule(Identity, &M::PUT, "system/users/u1/roles/r1")
                .unwrap()
                .admin
        );
        assert!(
            !find_rule(Image, &M::GET, "metadefs/namespaces/OS::Compute::Libvirt")
                .unwrap()
                .admin
        );
        assert!(
            find_rule(
                Image,
                &M::DELETE,
                "metadefs/namespaces/OS::Compute::Libvirt/resource_types/OS::Glance::Image"
            )
            .unwrap()
            .admin
        );
        assert!(find_rule(Image, &M::GET, "images").is_none());
        assert!(find_rule(Volume, &M::POST, "groups/action").is_some());
        assert!(find_rule(Volume, &M::POST, "volume-transfers/abc/accept").is_some());
        assert!(
            find_rule(
                Volume,
                &M::DELETE,
                "types/t1/extra_specs/capabilities:thin_provisioning_support"
            )
            .is_some()
        );
        assert!(find_rule(Volume, &M::GET, "qos-specs").is_some_and(|r| r.admin));
        assert!(find_rule(Network, &M::PUT, "routers/r1/add_router_interface").is_some());
        assert!(find_rule(Network, &M::DELETE, "networks").is_none());
        assert!(
            find_rule(
                Identity,
                &M::PUT,
                "OS-FEDERATION/identity_providers/keycloak/protocols/openid"
            )
            .unwrap()
            .admin
        );
        assert!(find_rule(Identity, &M::GET, "users").is_none());
        assert!(
            !find_rule(Compute, &M::GET, "os-quota-sets/p1")
                .unwrap()
                .admin
        );
        assert!(
            find_rule(Compute, &M::PUT, "os-quota-sets/p1")
                .unwrap()
                .admin
        );
        assert!(find_rule(Compute, &M::POST, "os-aggregates/3/action").is_some());
        assert!(find_rule(Network, &M::PUT, "trunks/t1/add_subports").is_some());
        assert!(find_rule(Network, &M::PUT, "ndp-proxies/n1").is_some());
        assert!(find_rule(Network, &M::POST, "ndp-proxies/n1").is_none());
        assert!(find_rule(Network, &M::POST, "qos/policies/q1/bandwidth_limit_rules").is_some());
        assert!(find_rule(Network, &M::POST, "qos/policies/q1/nonsense_rules").is_none());
        assert!(
            find_rule(Network, &M::DELETE, "agents/a1/l3-routers/r1")
                .unwrap()
                .admin
        );
        assert!(!find_rule(Network, &M::POST, "rbac-policies").unwrap().admin);
        assert!(find_rule(Volume, &M::POST, "volumes/v1/action").is_some());
        assert!(
            find_rule(Placement, &M::GET, "resource_providers/x/usages")
                .unwrap()
                .admin
        );
        assert!(find_rule(Compute, &M::POST, "flavors").unwrap().admin);
        assert!(
            find_rule(Volume, &M::PUT, "os-services/disable-log-reason")
                .unwrap()
                .admin
        );
        assert!(
            find_rule(Volume, &M::PUT, "os-services/enable")
                .unwrap()
                .admin
        );
        assert!(find_rule(Volume, &M::PUT, "os-services/failover_host").is_none());
        assert!(find_rule(Volume, &M::PUT, "os-services/set-log").is_none());
    }

    #[test]
    fn urls() {
        assert_eq!(
            Network.base_url("https://neutron:9696/"),
            "https://neutron:9696/v2.0"
        );
        assert_eq!(
            Network.base_url("https://x/networking/v2.0"),
            "https://x/networking/v2.0"
        );
        assert_eq!(
            Compute.base_url("https://nova:8774/v2.1/"),
            "https://nova:8774/v2.1"
        );
    }
}
