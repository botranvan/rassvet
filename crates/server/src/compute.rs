//! Typed compute endpoints that need more than a pass-through:
//! `POST /api/compute/launch` and `GET /api/placement/capacity`.

use std::collections::BTreeMap;

use axum::{
    Json,
    extract::State,
    http::{Method, StatusCode},
};
use base64::Engine;
use rassvet_ext_api::{ApiError, RequestContext};
use rassvet_os_client::{Microversion, identity::seg};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::task::JoinSet;

use crate::{
    gateway::{self, Svc},
    state::AppState,
};

#[derive(Debug, Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    /// Glance image. With `boot_from_volume` (the default) Nova asks Cinder to create
    /// the root volume from the image; otherwise the image boots on local disk.
    Image,
    /// Existing bootable Cinder volume.
    Volume,
    /// Cinder volume snapshot; Nova creates a new volume from it.
    VolumeSnapshot,
}

fn yes() -> bool {
    true
}
fn one() -> u32 {
    1
}

/// One network interface of the new instance, in order (the first is the primary one).
#[derive(Debug, Deserialize, Default, Clone)]
pub struct Nic {
    /// New port on this network…
    #[serde(default)]
    pub network_id: Option<String>,
    /// …with this address (optional).
    #[serde(default)]
    pub fixed_ip: Option<String>,
    /// …or an existing, unattached port.
    #[serde(default)]
    pub port_id: Option<String>,
    /// Security groups of this interface only, overriding the instance's list.
    /// Existing port: set on it before boot (Nova ignores the instance's groups for
    /// ports it didn't create). Network: Rassvet creates the port with these groups
    /// and deletes it again when the instance is deleted through Rassvet.
    #[serde(default)]
    pub security_groups: Option<Vec<String>>,
}

/// Values Nova accepts for `disk_bus` and `device_type` in block device mappings.
pub const DISK_BUSES: &[&str] = &[
    "virtio", "scsi", "sata", "ide", "usb", "fdc", "uml", "xen", "lxc",
];
pub const DEVICE_TYPES: &[&str] = &["disk", "cdrom", "floppy", "lun"];

/// Marks ports Rassvet created for an instance (deleted with it).
pub const PORT_MARK: &str = "Created by Rassvet for instance ";

/// Optional placement of a disk in the guest. Unset fields are left to Nova/libvirt.
#[derive(Debug, Deserialize, Default, Clone)]
pub struct DiskPlacement {
    /// e.g. "/dev/vdb" (libvirt may still pick its own name).
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub disk_bus: Option<String>,
    #[serde(default)]
    pub device_type: Option<String>,
}

impl DiskPlacement {
    fn apply(&self, d: &mut Value) -> Result<(), ApiError> {
        if let Some(n) = self
            .device_name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
        {
            let bare = n.strip_prefix("/dev/").unwrap_or(n);
            let ok = (2..=16).contains(&bare.len())
                && bare.starts_with(|c: char| c.is_ascii_lowercase())
                && bare
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
            if !ok {
                return Err(bad(format!("“{n}” isn't a device name like /dev/vdb")));
            }
            d["device_name"] = json!(format!("/dev/{bare}"));
        }
        if let Some(b) = self.disk_bus.as_deref().filter(|b| !b.is_empty()) {
            if !DISK_BUSES.contains(&b) {
                return Err(bad(format!("unknown disk bus “{b}”")));
            }
            d["disk_bus"] = json!(b);
        }
        if let Some(t) = self.device_type.as_deref().filter(|t| !t.is_empty()) {
            if !DEVICE_TYPES.contains(&t) {
                return Err(bad(format!("unknown device type “{t}”")));
            }
            d["device_type"] = json!(t);
        }
        Ok(())
    }

    fn is_set(&self) -> bool {
        [&self.device_name, &self.disk_bus, &self.device_type]
            .iter()
            .any(|v| v.as_deref().is_some_and(|s| !s.trim().is_empty()))
    }
}

/// An additional data volume attached at boot.
#[derive(Debug, Deserialize, Default, Clone)]
pub struct ExtraVolume {
    /// Existing available volume…
    #[serde(default)]
    pub volume_id: Option<String>,
    /// …or a new volume from this image (e.g. an ISO as a CD-ROM), of `size` GiB…
    #[serde(default)]
    pub image_id: Option<String>,
    /// …or a new blank one of this size (GiB).
    #[serde(default)]
    pub size: Option<u32>,
    #[serde(default)]
    pub volume_type: Option<String>,
    #[serde(default)]
    pub delete_on_termination: bool,
    #[serde(flatten)]
    pub placement: DiskPlacement,
}

#[derive(Debug, Deserialize)]
pub struct Launch {
    pub name: String,
    #[serde(default = "one")]
    pub count: u32,
    pub flavor_id: String,
    pub source: SourceKind,
    pub source_id: String,
    /// Image source only: create a Cinder root volume (default) instead of local disk.
    #[serde(default = "yes")]
    pub boot_from_volume: bool,
    /// Root volume size in GiB (image and snapshot sources with a new volume).
    #[serde(default)]
    pub volume_size: Option<u32>,
    #[serde(default)]
    pub volume_type: Option<String>,
    #[serde(default = "yes")]
    pub delete_on_termination: bool,
    /// Bus of the root disk (`virtio`, `scsi`, …); unset = Nova's/the image's default.
    #[serde(default)]
    pub root_disk_bus: Option<String>,
    /// Network ids; empty = let Nova pick (`auto`). Superseded by `nics`.
    #[serde(default)]
    pub networks: Vec<String>,
    /// Interfaces in order: networks and/or existing ports.
    #[serde(default)]
    pub nics: Vec<Nic>,
    /// Data volumes attached at boot, after the root disk.
    #[serde(default)]
    pub volumes: Vec<ExtraVolume>,
    /// Security group ids.
    #[serde(default)]
    pub security_groups: Vec<String>,
    #[serde(default)]
    pub key_name: Option<String>,
    /// Plain-text cloud-init user data; base64-encoded here.
    #[serde(default)]
    pub user_data: Option<String>,
    #[serde(default)]
    pub availability_zone: Option<String>,
    #[serde(default)]
    pub config_drive: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
    /// Server group id; becomes the `group` scheduler hint.
    #[serde(default)]
    pub server_group: Option<String>,
    /// Extra scheduler hints (`different_host`, `same_host`, `query`, custom filters…).
    /// Values are strings or lists of strings.
    #[serde(default)]
    pub scheduler_hints: BTreeMap<String, Value>,
}

/// Nova's limits for server metadata (key 1–255, value ≤255; quota default 128 items).
fn check_metadata(m: &BTreeMap<String, String>) -> Result<(), ApiError> {
    if m.len() > 128 {
        return Err(bad("at most 128 metadata items"));
    }
    for (k, v) in m {
        if k.trim().is_empty() || k.len() > 255 {
            return Err(bad("metadata keys must be 1–255 characters"));
        }
        if v.len() > 255 {
            return Err(bad(format!(
                "the value of “{k}” is longer than 255 characters"
            )));
        }
    }
    Ok(())
}

/// Scheduler hints: the server group plus validated extra hints.
fn scheduler_hints(req: &Launch) -> Result<serde_json::Map<String, Value>, ApiError> {
    let mut out = serde_json::Map::new();
    for (k, v) in &req.scheduler_hints {
        let key_ok = (1..=255).contains(&k.len())
            && k.chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c));
        if !key_ok {
            return Err(bad(format!("“{k}” isn't a valid scheduler hint name")));
        }
        let ok = match v {
            Value::String(s) => s.len() <= 4096,
            Value::Array(a) => {
                a.len() <= 100 && a.iter().all(|x| x.as_str().is_some_and(|s| s.len() <= 255))
            }
            _ => false,
        };
        if !ok {
            return Err(bad(format!(
                "the scheduler hint “{k}” must be text or a list of texts"
            )));
        }
        // Instance lists must be ids.
        if matches!(k.as_str(), "same_host" | "different_host") {
            let ids: Vec<&str> = match v {
                Value::String(s) => vec![s.as_str()],
                Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
                _ => vec![],
            };
            for id in ids {
                seg(id)?;
            }
        }
        if k == "group" && req.server_group.is_some() {
            return Err(bad("choose the server group once, not also as a hint"));
        }
        if !(matches!(v, Value::String(s) if s.is_empty())
            || matches!(v, Value::Array(a) if a.is_empty()))
        {
            out.insert(k.clone(), v.clone());
        }
    }
    if let Some(g) = req.server_group.as_deref().filter(|g| !g.is_empty()) {
        seg(g)?;
        out.insert("group".into(), json!(g));
    }
    Ok(out)
}

impl Launch {
    /// Interfaces from `nics`, or from the older `networks` list.
    pub fn nics(&self) -> Vec<Nic> {
        if !self.nics.is_empty() {
            return self.nics.clone();
        }
        self.networks
            .iter()
            .map(|n| Nic {
                network_id: Some(n.clone()),
                ..Default::default()
            })
            .collect()
    }
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, msg)
}

/// Build the Nova `POST /servers` body. `mv` is the negotiated compute microversion.
pub fn build_server(req: &Launch, mv: Option<Microversion>) -> Result<Value, ApiError> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(bad("the instance needs a name"));
    }
    if !(1..=50).contains(&req.count) {
        return Err(bad("launch between 1 and 50 instances at a time"));
    }
    seg(&req.flavor_id)?;
    seg(&req.source_id)?;
    if req.source == SourceKind::Volume && req.count > 1 {
        return Err(bad(
            "an existing volume can boot only one instance; use an image or snapshot for several",
        ));
    }
    let nics = req.nics();
    for n in &nics {
        match (&n.network_id, &n.port_id) {
            (Some(id), None) | (None, Some(id)) => seg(id)?,
            _ => return Err(bad("each interface needs either a network or a port")),
        };
    }
    if req.count > 1
        && nics.iter().any(|n| {
            n.port_id.is_some()
                || n.fixed_ip.as_deref().is_some_and(|i| !i.trim().is_empty())
                || n.security_groups.as_ref().is_some_and(|g| !g.is_empty())
        })
    {
        return Err(bad(
            "existing ports, fixed IPs and per-interface security groups can only be used when launching one instance",
        ));
    }
    if req.count > 1 && req.volumes.iter().any(|v| v.volume_id.is_some()) {
        return Err(bad(
            "an existing volume can be attached to one instance only; use new blank volumes for several",
        ));
    }
    if req.volumes.len() > 16 {
        return Err(bad("attach at most 16 volumes at launch"));
    }
    check_metadata(&req.metadata)?;
    let hints = scheduler_hints(req)?;
    if req.user_data.as_ref().is_some_and(|u| u.len() > 49_000) {
        // 65535 bytes once base64-encoded.
        return Err(bad("user data is limited to about 48 KiB"));
    }
    let at_least = |v: Microversion| mv.is_some_and(|m| m >= v);
    let size = |what: &str| -> Result<u32, ApiError> {
        req.volume_size
            .filter(|s| *s > 0)
            .ok_or_else(|| bad(format!("choose a size for the {what} volume")))
    };

    let root = DiskPlacement {
        disk_bus: req.root_disk_bus.clone(),
        ..Default::default()
    };
    let mut bdm = Vec::new();
    let mut image_ref = None;
    match req.source {
        SourceKind::Image if req.boot_from_volume => {
            let mut d = json!({
                "boot_index": 0,
                "uuid": req.source_id,
                "source_type": "image",
                "destination_type": "volume",
                "volume_size": size("root")?,
                "delete_on_termination": req.delete_on_termination,
            });
            if let Some(t) = req.volume_type.as_deref().filter(|t| !t.is_empty()) {
                if !at_least(Microversion::new(2, 67)) {
                    return Err(bad(
                        "this cloud's compute API is too old to choose a volume type (needs 2.67)",
                    ));
                }
                d["volume_type"] = json!(t);
            }
            bdm.push(d);
        }
        SourceKind::Image => image_ref = Some(req.source_id.clone()),
        SourceKind::Volume => bdm.push(json!({
            "boot_index": 0,
            "uuid": req.source_id,
            "source_type": "volume",
            "destination_type": "volume",
            "delete_on_termination": req.delete_on_termination,
        })),
        SourceKind::VolumeSnapshot => {
            let mut d = json!({
                "boot_index": 0,
                "uuid": req.source_id,
                "source_type": "snapshot",
                "destination_type": "volume",
                "volume_size": size("root")?,
                "delete_on_termination": req.delete_on_termination,
            });
            if let Some(t) = req.volume_type.as_deref().filter(|t| !t.is_empty())
                && at_least(Microversion::new(2, 67))
            {
                d["volume_type"] = json!(t);
            }
            bdm.push(d);
        }
    }

    if let Some(boot) = bdm.first_mut() {
        root.apply(boot)?;
    }

    // Data volumes: boot_index -1 keeps them out of the boot order.
    for v in &req.volumes {
        let mut d = match (&v.volume_id, &v.image_id, v.size) {
            (Some(id), _, _) => {
                seg(id)?;
                json!({ "uuid": id, "source_type": "volume", "destination_type": "volume" })
            }
            (None, Some(img), Some(size)) if size > 0 => {
                seg(img)?;
                json!({ "uuid": img, "source_type": "image", "destination_type": "volume", "volume_size": size })
            }
            (None, None, Some(size)) if size > 0 => {
                json!({ "source_type": "blank", "destination_type": "volume", "volume_size": size })
            }
            _ => return Err(bad("each extra volume needs an existing volume, or a size")),
        };
        v.placement.apply(&mut d)?;
        d["boot_index"] = json!(-1);
        d["delete_on_termination"] = json!(v.delete_on_termination);
        if v.volume_id.is_none()
            && let Some(t) = v.volume_type.as_deref().filter(|t| !t.is_empty())
        {
            if !at_least(Microversion::new(2, 67)) {
                return Err(bad(
                    "this cloud's compute API is too old to choose a volume type (needs 2.67)",
                ));
            }
            d["volume_type"] = json!(t);
        }
        bdm.push(d);
    }
    // Local-disk boot plus data volumes or a root disk bus: the image needs its own
    // mapping at index 0.
    if let Some(img) = &image_ref
        && (!bdm.is_empty() || root.is_set())
    {
        let mut d = json!({
            "boot_index": 0,
            "uuid": img,
            "source_type": "image",
            "destination_type": "local",
            "delete_on_termination": true,
        });
        root.apply(&mut d)?;
        bdm.insert(0, d);
    }

    let mut server = json!({
        "name": name,
        "flavorRef": req.flavor_id,
        "min_count": req.count,
        "max_count": req.count,
    });
    if let Some(i) = image_ref {
        server["imageRef"] = json!(i);
    }
    if !bdm.is_empty() {
        server["block_device_mapping_v2"] = json!(bdm);
    }
    // 2.37+: networks is required; "auto" lets Nova use the project's only network.
    server["networks"] = if nics.is_empty() {
        if at_least(Microversion::new(2, 37)) {
            json!("auto")
        } else {
            Value::Null
        }
    } else {
        json!(
            nics.iter()
                .map(|n| match (&n.port_id, &n.network_id) {
                    (Some(p), _) => json!({ "port": p }),
                    (None, Some(net)) => {
                        let mut e = json!({ "uuid": net });
                        if let Some(ip) = n
                            .fixed_ip
                            .as_deref()
                            .map(str::trim)
                            .filter(|i| !i.is_empty())
                        {
                            e["fixed_ip"] = json!(ip);
                        }
                        e
                    }
                    _ => Value::Null,
                })
                .collect::<Vec<_>>()
        )
    };
    if server["networks"].is_null() {
        server.as_object_mut().map(|o| o.remove("networks"));
    }
    if !req.security_groups.is_empty() {
        server["security_groups"] = json!(
            req.security_groups
                .iter()
                .map(|s| json!({ "name": s }))
                .collect::<Vec<_>>()
        );
    }
    if let Some(k) = req.key_name.as_deref().filter(|k| !k.is_empty()) {
        server["key_name"] = json!(k);
    }
    if let Some(u) = req.user_data.as_deref().filter(|u| !u.trim().is_empty()) {
        server["user_data"] = json!(base64::engine::general_purpose::STANDARD.encode(u));
    }
    if let Some(az) = req.availability_zone.as_deref().filter(|a| !a.is_empty()) {
        server["availability_zone"] = json!(az);
    }
    if req.config_drive {
        server["config_drive"] = json!(true);
    }
    if let Some(d) = req
        .description
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        && at_least(Microversion::new(2, 19))
    {
        server["description"] = json!(d.replace('\n', " "));
    }
    if !req.metadata.is_empty() {
        server["metadata"] = json!(req.metadata);
    }
    let mut body = json!({ "server": server });
    if !hints.is_empty() {
        body["os:scheduler_hints"] = Value::Object(hints);
    }
    Ok(body)
}

pub async fn launch(
    State(st): State<AppState>,
    ctx: RequestContext,
    Json(req): Json<Launch>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let endpoint = ctx.endpoint("compute")?;
    let mv = st.versions.get(&ctx, Svc::Compute, &endpoint).await;
    // Validate everything before touching Neutron.
    build_server(&req, mv)?;
    let mut req = req;
    let mut nics = req.nics();
    for n in &nics {
        for g in n.security_groups.iter().flatten() {
            seg(g)?;
        }
    }

    // Existing ports keep their own security groups; apply the requested ones first.
    for n in &nics {
        if let (Some(port), Some(groups)) = (&n.port_id, &n.security_groups) {
            gateway::call(
                &st,
                &ctx,
                Svc::Network,
                Method::PUT,
                &format!("ports/{port}"),
                &[],
                Some(&json!({ "port": { "security_groups": groups } })),
            )
            .await?;
        }
    }
    // A network with its own security groups: Nova applies one list to every port it
    // creates, so create this port here with the interface's groups.
    let name = req.name.trim().to_owned();
    let mut created_ports = Vec::new();
    for (i, n) in nics.iter_mut().enumerate() {
        let (Some(net), Some(groups)) = (&n.network_id, &n.security_groups) else {
            continue;
        };
        if groups.is_empty() || n.port_id.is_some() {
            continue;
        }
        let mut port = json!({
            "network_id": net,
            "name": format!("{name}-eth{i}"),
            "description": format!("{PORT_MARK}{name}; deleted with it"),
            "security_groups": groups,
        });
        if let Some(ip) = n
            .fixed_ip
            .as_deref()
            .map(str::trim)
            .filter(|i| !i.is_empty())
        {
            port["fixed_ips"] = json!([{ "ip_address": ip }]);
        }
        let res = gateway::call(
            &st,
            &ctx,
            Svc::Network,
            Method::POST,
            "ports",
            &[],
            Some(&json!({ "port": port })),
        )
        .await;
        match res {
            Ok((_, p)) => {
                let id = p["port"]["id"].as_str().unwrap_or_default().to_owned();
                created_ports.push(id.clone());
                *n = Nic {
                    port_id: Some(id),
                    ..Default::default()
                };
            }
            Err(e) => {
                delete_ports(&st, &ctx, &created_ports).await;
                return Err(e);
            }
        }
    }
    req.nics = nics;
    req.networks.clear();
    let body = build_server(&req, mv)?;
    let (status, created) = match gateway::call(
        &st,
        &ctx,
        Svc::Compute,
        Method::POST,
        "servers",
        &[],
        Some(&body),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            delete_ports(&st, &ctx, &created_ports).await;
            return Err(e);
        }
    };
    tracing::info!(
        user = %ctx.token.user.name,
        name = %req.name,
        count = req.count,
        source = ?req.source,
        boot_from_volume = req.boot_from_volume,
        nics = req.nics().len(),
        volumes = req.volumes.len(),
        "instance launched"
    );
    Ok((status, Json(created)))
}

async fn delete_ports(st: &AppState, ctx: &RequestContext, ids: &[String]) {
    for id in ids {
        if let Err(e) = gateway::call(
            st,
            ctx,
            Svc::Network,
            Method::DELETE,
            &format!("ports/{id}"),
            &[],
            None,
        )
        .await
        {
            tracing::warn!(port = %id, error = %e.message, "could not delete a port Rassvet created");
        }
    }
}

/// `DELETE /api/compute/servers/{id}`: delete an instance and the ports Rassvet created
/// for it at launch (Nova only deletes ports it created itself).
pub async fn delete_server(
    State(st): State<AppState>,
    ctx: RequestContext,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<StatusCode, ApiError> {
    seg(&id)?;
    let ours: Vec<String> = match gateway::call(
        &st,
        &ctx,
        Svc::Network,
        Method::GET,
        "ports",
        &[("device_id".into(), id.clone())],
        None,
    )
    .await
    {
        Ok((_, v)) => v["ports"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| {
                p["description"]
                    .as_str()
                    .is_some_and(|d| d.starts_with(PORT_MARK))
            })
            .filter_map(|p| p["id"].as_str().map(str::to_owned))
            .collect(),
        Err(_) => Vec::new(),
    };
    let (status, _) = gateway::call(
        &st,
        &ctx,
        Svc::Compute,
        Method::DELETE,
        &format!("servers/{id}"),
        &[],
        None,
    )
    .await?;
    delete_ports(&st, &ctx, &ours).await;
    Ok(status)
}

/// Every resource provider with its inventories and usages, fetched concurrently.
pub async fn capacity(
    State(st): State<AppState>,
    ctx: RequestContext,
) -> Result<Json<Value>, ApiError> {
    if !ctx.is_admin() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "the admin role is required to view capacity",
        ));
    }
    let (_, list) = gateway::call(
        &st,
        &ctx,
        Svc::Placement,
        Method::GET,
        "resource_providers",
        &[],
        None,
    )
    .await?;
    let providers = list["resource_providers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut set = JoinSet::new();
    for (i, rp) in providers.iter().enumerate() {
        let Some(uuid) = rp["uuid"].as_str().map(str::to_owned) else {
            continue;
        };
        let (st, ctx) = (st.clone(), ctx.clone());
        set.spawn(async move {
            let inv = gateway::call(
                &st,
                &ctx,
                Svc::Placement,
                Method::GET,
                &format!("resource_providers/{uuid}/inventories"),
                &[],
                None,
            )
            .await;
            let usage = gateway::call(
                &st,
                &ctx,
                Svc::Placement,
                Method::GET,
                &format!("resource_providers/{uuid}/usages"),
                &[],
                None,
            )
            .await;
            (i, inv.map(|r| r.1), usage.map(|r| r.1))
        });
    }
    let mut out = providers;
    while let Some(Ok((i, inv, usage))) = set.join_next().await {
        out[i]["inventories"] = inv.map(|v| v["inventories"].clone()).unwrap_or(Value::Null);
        out[i]["usages"] = usage.map(|v| v["usages"].clone()).unwrap_or(Value::Null);
    }
    Ok(Json(json!({ "resource_providers": out })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Launch {
        serde_json::from_value(json!({
            "name": "web-1", "flavor_id": "m1.small", "source": "image",
            "source_id": "img-1", "volume_size": 20, "networks": ["net-1"],
            "security_groups": ["sg-1"], "key_name": "laptop", "user_data": "#cloud-config\n"
        }))
        .unwrap()
    }

    #[test]
    fn boot_from_volume_is_default() {
        let b = build_server(&base(), Some(Microversion::new(2, 100))).unwrap();
        let s = &b["server"];
        assert!(s.get("imageRef").is_none());
        let d = &s["block_device_mapping_v2"][0];
        assert_eq!(d["source_type"], "image");
        assert_eq!(d["destination_type"], "volume");
        assert_eq!(d["volume_size"], 20);
        assert_eq!(d["delete_on_termination"], true);
        assert_eq!(s["networks"][0]["uuid"], "net-1");
        assert_eq!(s["security_groups"][0]["name"], "sg-1");
        assert_eq!(s["user_data"], "I2Nsb3VkLWNvbmZpZwo=");
    }

    #[test]
    fn variants_and_validation() {
        let mut l = base();
        l.boot_from_volume = false;
        let b = build_server(&l, Some(Microversion::new(2, 100))).unwrap();
        assert_eq!(b["server"]["imageRef"], "img-1");
        assert!(b["server"].get("block_device_mapping_v2").is_none());

        let mut l = base();
        l.volume_size = None;
        assert!(build_server(&l, None).is_err());

        let mut l = base();
        l.volume_type = Some("ssd".into());
        assert!(build_server(&l, Some(Microversion::new(2, 60))).is_err());
        let b = build_server(&l, Some(Microversion::new(2, 67))).unwrap();
        assert_eq!(
            b["server"]["block_device_mapping_v2"][0]["volume_type"],
            "ssd"
        );

        let mut l = base();
        l.source = SourceKind::Volume;
        l.count = 2;
        assert!(build_server(&l, None).is_err());

        let mut l = base();
        l.networks.clear();
        let b = build_server(&l, Some(Microversion::new(2, 100))).unwrap();
        assert_eq!(b["server"]["networks"], "auto");
        let b = build_server(&l, Some(Microversion::new(2, 1))).unwrap();
        assert!(b["server"].get("networks").is_none());
    }

    #[test]
    fn nics_and_extra_volumes() {
        let mut l = base();
        l.nics = vec![
            Nic {
                network_id: Some("net-1".into()),
                fixed_ip: Some("10.0.0.5".into()),
                ..Default::default()
            },
            Nic {
                port_id: Some("port-9".into()),
                security_groups: Some(vec!["sg-2".into()]),
                ..Default::default()
            },
        ];
        l.volumes = vec![
            ExtraVolume {
                volume_id: Some("vol-7".into()),
                ..Default::default()
            },
            ExtraVolume {
                size: Some(50),
                volume_type: Some("ssd".into()),
                delete_on_termination: true,
                ..Default::default()
            },
        ];
        let b = build_server(&l, Some(Microversion::new(2, 100))).unwrap();
        let s = &b["server"];
        assert_eq!(s["networks"][0]["uuid"], "net-1");
        assert_eq!(s["networks"][0]["fixed_ip"], "10.0.0.5");
        assert_eq!(s["networks"][1]["port"], "port-9");
        let bdm = s["block_device_mapping_v2"].as_array().unwrap();
        assert_eq!(bdm.len(), 3);
        assert_eq!(bdm[1]["uuid"], "vol-7");
        assert_eq!(bdm[1]["boot_index"], -1);
        assert_eq!(bdm[2]["source_type"], "blank");
        assert_eq!(bdm[2]["volume_size"], 50);
        assert_eq!(bdm[2]["volume_type"], "ssd");

        // Local boot with data volumes gets an explicit image mapping first.
        l.boot_from_volume = false;
        let b = build_server(&l, Some(Microversion::new(2, 100))).unwrap();
        let bdm = b["server"]["block_device_mapping_v2"].as_array().unwrap();
        assert_eq!(bdm[0]["destination_type"], "local");
        assert_eq!(b["server"]["imageRef"], "img-1");

        // Disk placement: device name, bus, type; root bus.
        let mut l = base();
        l.root_disk_bus = Some("scsi".into());
        l.volumes = vec![ExtraVolume {
            image_id: Some("iso-1".into()),
            size: Some(2),
            placement: DiskPlacement {
                device_name: Some("vdc".into()),
                disk_bus: Some("sata".into()),
                device_type: Some("cdrom".into()),
            },
            ..Default::default()
        }];
        let b = build_server(&l, Some(Microversion::new(2, 100))).unwrap();
        let bdm = b["server"]["block_device_mapping_v2"].as_array().unwrap();
        assert_eq!(bdm[0]["disk_bus"], "scsi");
        assert_eq!(bdm[1]["source_type"], "image");
        assert_eq!(bdm[1]["device_name"], "/dev/vdc");
        assert_eq!(bdm[1]["device_type"], "cdrom");
        // Root bus on local boot creates the image mapping.
        let mut l = base();
        l.boot_from_volume = false;
        l.root_disk_bus = Some("ide".into());
        let b = build_server(&l, Some(Microversion::new(2, 100))).unwrap();
        assert_eq!(b["server"]["block_device_mapping_v2"][0]["disk_bus"], "ide");
        l.root_disk_bus = Some("floppy-ish".into());
        assert!(build_server(&l, None).is_err());
        let mut l = base();
        l.volumes = vec![ExtraVolume {
            size: Some(1),
            placement: DiskPlacement {
                device_name: Some("/dev/../sda".into()),
                ..Default::default()
            },
            ..Default::default()
        }];
        assert!(build_server(&l, None).is_err());
        // Per-interface security groups only for one instance.
        let mut l = base();
        l.count = 2;
        l.nics = vec![Nic {
            network_id: Some("n".into()),
            security_groups: Some(vec!["g".into()]),
            ..Default::default()
        }];
        assert!(build_server(&l, None).is_err());

        // Server group, scheduler hints and metadata.
        let mut l = base();
        l.server_group = Some("sg-1".into());
        l.scheduler_hints
            .insert("different_host".into(), json!(["srv-1", "srv-2"]));
        l.scheduler_hints
            .insert("query".into(), json!("[\"=\", \"$free_ram_mb\", 1024]"));
        l.scheduler_hints.insert("same_host".into(), json!([]));
        l.metadata.insert("role".into(), "web".into());
        let b = build_server(&l, Some(Microversion::new(2, 100))).unwrap();
        assert_eq!(b["os:scheduler_hints"]["group"], "sg-1");
        assert_eq!(b["os:scheduler_hints"]["different_host"][1], "srv-2");
        assert!(
            b["os:scheduler_hints"].get("same_host").is_none(),
            "empty hints are dropped"
        );
        assert_eq!(b["server"]["metadata"]["role"], "web");
        l.scheduler_hints.insert("group".into(), json!("other"));
        assert!(build_server(&l, None).is_err());
        let mut l = base();
        l.scheduler_hints.insert("bad key".into(), json!("x"));
        assert!(build_server(&l, None).is_err());
        let mut l = base();
        l.scheduler_hints
            .insert("different_host".into(), json!(["../x"]));
        assert!(build_server(&l, None).is_err());
        let mut l = base();
        l.metadata.insert("k".into(), "v".repeat(256));
        assert!(build_server(&l, None).is_err());
        let b = build_server(&base(), None).unwrap();
        assert!(b.get("os:scheduler_hints").is_none());

        // Ports and existing volumes only for a single instance.
        let mut l = base();
        l.nics = vec![Nic {
            port_id: Some("p".into()),
            ..Default::default()
        }];
        l.volumes = vec![ExtraVolume {
            volume_id: Some("vol-7".into()),
            ..Default::default()
        }];
        l.count = 2;
        assert!(build_server(&l, None).is_err());
        let mut l = base();
        l.nics = vec![Nic::default()];
        assert!(build_server(&l, None).is_err());
    }
}
