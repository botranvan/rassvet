//! Glance metadata definitions catalog: `GET /api/image/metadefs`.
//!
//! `?resource_type=` picks what the definitions describe: images (default) or Nova
//! servers, and `&target=` narrows server namespaces to `metadata` or `scheduler_hints`
//! (Glance's `properties_target`), the way Horizon's metadata dialogs do.
//! Prefers the cloud's own catalog (operators may customise it) and falls back to the
//! namespaces shipped with Glance (`metadefs/`, embedded) when the cloud has none.

use std::sync::OnceLock;

use axum::{Json, extract::Query, http::StatusCode};
use rassvet_ext_api::{ApiError, RequestContext};
use rassvet_os_client::{
    Glance,
    image::{IMAGE_RESOURCE_TYPE, normalize_namespace},
};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::task::JoinSet;

#[derive(RustEmbed)]
#[folder = "metadefs"]
struct Bundled;

pub const SERVER_RESOURCE_TYPE: &str = "OS::Nova::Server";

/// The embedded catalog for a resource type, prefixed, sorted by display name.
/// Images get every namespace (as before); other types only those associated with them.
fn bundled(resource_type: &str) -> &'static Vec<Value> {
    static IMAGES: OnceLock<Vec<Value>> = OnceLock::new();
    static SERVERS: OnceLock<Vec<Value>> = OnceLock::new();
    let (cell, only_associated) = if resource_type == SERVER_RESOURCE_TYPE {
        (&SERVERS, true)
    } else {
        (&IMAGES, false)
    };
    cell.get_or_init(|| {
        let mut list: Vec<Value> = Bundled::iter()
            .filter(|name| name.ends_with(".json"))
            .filter_map(|name| {
                let file = Bundled::get(&name)?;
                let doc: Value = serde_json::from_slice(&file.data)
                    .inspect_err(|e| tracing::warn!(%name, error = %e, "bad bundled metadef"))
                    .ok()?;
                let associated = doc["resource_type_associations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|r| r["name"] == resource_type);
                (associated || !only_associated)
                    .then(|| normalize_namespace(&doc, resource_type, true))
            })
            .collect();
        sort(&mut list);
        list
    })
}

fn sort(list: &mut [Value]) {
    list.sort_by_key(|n| {
        n["display_name"]
            .as_str()
            .or(n["namespace"].as_str())
            .unwrap_or_default()
            .to_lowercase()
    });
}

/// Describes standard image properties (architecture, os_distro, ...) but has no
/// resource type association, so the filtered listing never returns it.
const COMMON: &str = "OS::Glance::CommonImageProperties";

async fn from_cloud(
    g: &Glance,
    resource_type: &'static str,
) -> Result<Vec<Value>, rassvet_os_client::Error> {
    let names = g.metadef_namespaces(resource_type).await?;
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let mut set = JoinSet::new();
    let with_common = resource_type == IMAGE_RESOURCE_TYPE && !names.iter().any(|n| n == COMMON);
    for name in names
        .into_iter()
        .chain(with_common.then(|| COMMON.to_owned()))
    {
        let g = g.clone();
        set.spawn(async move {
            let res = g.metadef_namespace(&name, resource_type).await;
            (name, res)
        });
    }
    let mut out = Vec::new();
    while let Some(res) = set.join_next().await {
        match res {
            Ok((_, Ok(ns))) => out.push(ns),
            // Optional: clouds that never loaded it simply don't have it.
            Ok((name, Err(_))) if name == COMMON => {}
            Ok((name, Err(e))) => tracing::warn!(%name, error = %e, "skipping metadef namespace"),
            Err(e) => tracing::warn!(error = %e, "metadef task failed"),
        }
    }
    sort(&mut out);
    Ok(out)
}

#[derive(Debug, Default, Deserialize)]
pub struct MetaQuery {
    #[serde(default)]
    resource_type: Option<String>,
    /// `metadata` or `scheduler_hints` (servers only).
    #[serde(default)]
    target: Option<String>,
}

/// Keep namespaces whose properties go to `target` (no target: keep all).
fn by_target(list: Vec<Value>, target: Option<&str>) -> Vec<Value> {
    match target {
        None => list,
        Some(t) => list
            .into_iter()
            .filter(|n| n["properties_target"] == t)
            .collect(),
    }
}

pub async fn metadefs(
    ctx: RequestContext,
    Query(q): Query<MetaQuery>,
) -> Result<Json<Value>, ApiError> {
    let resource_type = match q.resource_type.as_deref() {
        None | Some("") | Some(IMAGE_RESOURCE_TYPE) => IMAGE_RESOURCE_TYPE,
        Some(SERVER_RESOURCE_TYPE) => SERVER_RESOURCE_TYPE,
        Some(other) => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("unsupported resource type {other}"),
            ));
        }
    };
    let target = q.target.as_deref().filter(|t| !t.is_empty());
    let g = ctx.glance()?;
    match from_cloud(&g, resource_type).await {
        Ok(list) if !list.is_empty() => {
            return Ok(Json(
                json!({ "source": "cloud", "namespaces": by_target(list, target) }),
            ));
        }
        Ok(_) => {}
        Err(e) if e.status() == Some(StatusCode::UNAUTHORIZED) => return Err(e.into()),
        Err(e) => tracing::info!(error = %e, "metadefs API unavailable, using bundled catalog"),
    }
    Ok(Json(json!({
        "source": "bundled",
        "namespaces": by_target(bundled(resource_type).clone(), target),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_catalog_by_target() {
        let all = bundled(SERVER_RESOURCE_TYPE).clone();
        let meta = by_target(all.clone(), Some("metadata"));
        assert_eq!(
            meta.len(),
            3,
            "software databases, runtimes and web servers"
        );
        let hints = by_target(all, Some("scheduler_hints"));
        assert!(
            hints
                .iter()
                .all(|n| n["properties_target"] == "scheduler_hints")
        );
        assert!(!hints.is_empty());
    }

    #[test]
    fn bundled_catalog_is_prefixed() {
        let list = bundled(IMAGE_RESOURCE_TYPE);
        assert!(list.len() >= 15, "only {} namespaces", list.len());
        let has = |key: &str| {
            list.iter().any(|n| {
                n["properties"].get(key).is_some()
                    || n["objects"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|o| o["properties"].get(key).is_some())
            })
        };
        assert!(has("hw_firmware_type"));
        // compute-cpu-pinning.json uses the hw_ prefix for images
        assert!(has("hw_cpu_policy"));
        assert!(has("os_distro"));
        assert!(has("architecture"));
        assert!(!has("cpu_policy"));
    }
}
