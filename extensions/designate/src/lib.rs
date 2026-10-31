//! Designate (DNS as a Service) extension: zones, record sets, zone imports / exports /
//! transfers / shares, reverse DNS of floating IPs, and the admin side (TLDs, TSIG keys,
//! blacklists, quotas, pools, service statuses).
//!
//! Backend: an allowlisted gateway to the Designate v2 API at `/api/ext/designate/os/{*path}`
//! (paths are relative to `<endpoint>/v2/`, e.g. `zones/<id>/recordsets`). Designate has no
//! microversions; it pages with `links.next` and markers. Two query parameters are turned into
//! Designate's headers, admins only: `all_projects=1` (`X-Auth-All-Projects`, the admin view of
//! every project's zones) and `sudo_project_id=<id>` (`X-Auth-Sudo-Project-ID`, act in another
//! project, e.g. create a zone for it).
//!
//! Zone files aren't JSON, so they have their own routes:
//! `POST /api/ext/designate/zones/import` (`{"zonefile"}` → an import task) and
//! `GET /api/ext/designate/exports/{id}/zonefile` (→ `{"zonefile"}` of a finished export).

use rassvet_ext_api::{
    ApiError, Extension, Manifest, NavItem, NavSection, RequestContext,
    axum::{
        Json, Router,
        body::Bytes,
        extract::{Path, Query},
        http::{Method, StatusCode},
        response::Response,
        routing::{any, get, post},
    },
    gateway::{self, Rule, Service, admin, rule as r},
    os::trace,
};
use serde::Deserialize;
use serde_json::{Value, json};

pub struct Designate;

const ID: &str = "designate";

const SERVICE: Service = Service {
    service_type: "dns",
    version: "v2",
    microversion: None,
};

/// Largest zone file accepted for an import.
const MAX_ZONEFILE: usize = 1024 * 1024;

impl Extension for Designate {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: ID,
            name: "DNS",
            version: env!("CARGO_PKG_VERSION"),
            description: "Manage Designate DNS zones, record sets, zone imports, exports, transfers and shares, reverse DNS of floating IPs, and DNS service settings",
            service_types: &["dns"],
        }
    }

    fn nav(&self) -> Vec<NavItem> {
        let item = |id: &str, label: &str, path: &str, icon: &str, section: NavSection| NavItem {
            id: format!("{ID}.{id}"),
            group: "DNS".into(),
            label: label.into(),
            path: path.into(),
            icon: icon.into(),
            section,
            role: (section == NavSection::Admin).then(|| "admin".into()),
        };
        vec![
            item(
                "zones",
                "DNS zones",
                &format!("/ext/{ID}/zones"),
                "globe",
                NavSection::Project,
            ),
            item(
                "reverse",
                "Reverse DNS",
                &format!("/ext/{ID}/reverse"),
                "arrow-right-left",
                NavSection::Project,
            ),
            item(
                "admin-zones",
                "All DNS zones",
                &format!("/admin/ext/{ID}/zones"),
                "globe",
                NavSection::Admin,
            ),
            item(
                "settings",
                "DNS service",
                &format!("/admin/ext/{ID}/settings"),
                "sliders-horizontal",
                NavSection::Admin,
            ),
        ]
    }

    fn router(&self) -> Router {
        Router::new()
            .route("/os/{*path}", any(handle))
            .route("/zones/import", post(import))
            .route("/exports/{id}/zonefile", get(zonefile))
    }
}

// ---------------------------------------------------------------------------- rules

use Method as M;

static RULES: &[Rule] = &[
    // Zones
    r(M::GET, "zones"),
    r(M::POST, "zones"),
    r(M::GET, "zones/{id}"),
    r(M::PATCH, "zones/{id}"),
    r(M::DELETE, "zones/{id}"),
    r(M::GET, "zones/{id}/nameservers"),
    // Zone tasks: pull a secondary zone from its primaries now, export, offer to a project.
    r(M::POST, "zones/{id}/tasks/xfr"),
    r(M::POST, "zones/{id}/tasks/export"),
    r(M::POST, "zones/{id}/tasks/transfer_requests"),
    admin(M::POST, "zones/{id}/tasks/abandon"),
    admin(M::POST, "zones/{id}/tasks/pool_move"),
    // Record sets
    r(M::GET, "zones/{id}/recordsets"),
    r(M::POST, "zones/{id}/recordsets"),
    r(M::GET, "zones/{id}/recordsets/{id}"),
    r(M::PUT, "zones/{id}/recordsets/{id}"),
    r(M::DELETE, "zones/{id}/recordsets/{id}"),
    r(M::GET, "recordsets"),
    r(M::GET, "recordsets/{id}"),
    // Shared zones (2023.1)
    r(M::GET, "zones/{id}/shares"),
    r(M::POST, "zones/{id}/shares"),
    r(M::GET, "zones/{id}/shares/{id}"),
    r(M::DELETE, "zones/{id}/shares/{id}"),
    // Imports (created by the import route: the body is a zone file) and exports
    r(M::GET, "zones/tasks/imports"),
    r(M::GET, "zones/tasks/imports/{id}"),
    r(M::DELETE, "zones/tasks/imports/{id}"),
    r(M::GET, "zones/tasks/exports"),
    r(M::GET, "zones/tasks/exports/{id}"),
    r(M::DELETE, "zones/tasks/exports/{id}"),
    // Transfers between projects
    r(M::GET, "zones/tasks/transfer_requests"),
    r(M::GET, "zones/tasks/transfer_requests/{id}"),
    r(M::PATCH, "zones/tasks/transfer_requests/{id}"),
    r(M::DELETE, "zones/tasks/transfer_requests/{id}"),
    r(M::GET, "zones/tasks/transfer_accepts"),
    r(M::POST, "zones/tasks/transfer_accepts"),
    r(M::GET, "zones/tasks/transfer_accepts/{id}"),
    // Reverse DNS (PTR) of floating IPs; the id is `<region>:<floating IP id>`.
    r(M::GET, "reverse/floatingips"),
    r(M::GET, "reverse/floatingips/{name}"),
    r(M::PATCH, "reverse/floatingips/{name}"),
    // TLDs: everyone may read which ones are allowed; admins manage them.
    r(M::GET, "tlds"),
    r(M::GET, "tlds/{id}"),
    admin(M::POST, "tlds"),
    admin(M::PATCH, "tlds/{id}"),
    admin(M::DELETE, "tlds/{id}"),
    // TSIG keys, blacklists, pools (admin)
    admin(M::GET, "tsigkeys"),
    admin(M::POST, "tsigkeys"),
    admin(M::GET, "tsigkeys/{id}"),
    admin(M::PATCH, "tsigkeys/{id}"),
    admin(M::DELETE, "tsigkeys/{id}"),
    admin(M::GET, "blacklists"),
    admin(M::POST, "blacklists"),
    admin(M::GET, "blacklists/{id}"),
    admin(M::PATCH, "blacklists/{id}"),
    admin(M::DELETE, "blacklists/{id}"),
    admin(M::GET, "pools"),
    admin(M::GET, "pools/{id}"),
    // Quotas: a project reads its own; admins change any. Limits apply to everyone.
    r(M::GET, "quotas/{id}"),
    admin(M::PATCH, "quotas/{id}"),
    admin(M::DELETE, "quotas/{id}"),
    r(M::GET, "limits"),
    // Designate services (admin)
    admin(M::GET, "service_statuses"),
    admin(M::GET, "service_statuses/{id}"),
];

/// Query parameters that become Designate headers (admins only).
const HEADER_PARAMS: &[(&str, &str)] = &[
    ("all_projects", "X-Auth-All-Projects"),
    ("sudo_project_id", "X-Auth-Sudo-Project-ID"),
];

/// Split Rassvet's header parameters off the query: `(query, headers)`.
#[allow(clippy::type_complexity)]
fn split_query(
    ctx_admin: bool,
    raw: Vec<(String, String)>,
) -> Result<(Vec<(String, String)>, Vec<(&'static str, String)>), ApiError> {
    let mut query = Vec::new();
    let mut headers = Vec::new();
    for (k, v) in raw {
        let Some((_, header)) = HEADER_PARAMS.iter().find(|(p, _)| *p == k) else {
            query.push((k, v));
            continue;
        };
        if !ctx_admin {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                format!("the admin role is required to use '{k}'"),
            ));
        }
        let value = if k == "all_projects" {
            let on = matches!(v.as_str(), "1" | "true" | "True");
            if !on {
                continue;
            }
            "true".to_owned()
        } else {
            if !gateway::valid_id(&v) {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    format!("invalid project id '{v}'"),
                ));
            }
            v
        };
        headers.push((*header, value));
    }
    Ok((query, headers))
}

/// `/api/ext/designate/os/{*path}`
async fn handle(
    ctx: RequestContext,
    method: Method,
    Path(path): Path<String>,
    Query(raw): Query<Vec<(String, String)>>,
    body: Bytes,
) -> Result<Response, ApiError> {
    let (query, headers) = split_query(ctx.is_admin(), raw)?;
    gateway::proxy_with(
        &ctx, &SERVICE, RULES, None, &headers, method, &path, query, body,
    )
    .await
}

// ---------------------------------------------------------------------------- zone files

#[derive(Deserialize)]
struct ImportBody {
    zonefile: String,
}

/// `POST /api/ext/designate/zones/import` `{"zonefile"}`: start a zone import (Designate
/// answers 202 with the import task; the zone appears once the task is `COMPLETE`).
async fn import(
    ctx: RequestContext,
    Query(raw): Query<Vec<(String, String)>>,
    Json(body): Json<ImportBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (_, headers) = split_query(ctx.is_admin(), raw)?;
    let text = body.zonefile.trim();
    if text.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "the zone file is empty",
        ));
    }
    if text.len() > MAX_ZONEFILE {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("zone files are limited to {} KiB", MAX_ZONEFILE / 1024),
        ));
    }
    let endpoint = ctx.endpoint(SERVICE.service_type)?;
    let url = format!("{}/zones/tasks/imports", SERVICE.base_url(&endpoint));
    let mut req = ctx
        .request(Method::POST, &url)
        .header("Accept", "application/json")
        .header("Content-Type", "text/dns")
        .body(format!("{text}\n"));
    for (name, value) in &headers {
        req = req.header(*name, value);
    }
    tracing::info!(user = %ctx.token.user.name, service = SERVICE.service_type, "zone import");
    let resp = trace::send(SERVICE.service_type, req).await?;
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::ACCEPTED);
    let value: Value = resp.json().await.unwrap_or(Value::Null);
    Ok((status, Json(value)))
}

/// `GET /api/ext/designate/exports/{id}/zonefile`: the zone file of a finished export.
async fn zonefile(ctx: RequestContext, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    if !gateway::valid_id(&id) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid export id"));
    }
    let endpoint = ctx.endpoint(SERVICE.service_type)?;
    let url = format!(
        "{}/zones/tasks/exports/{}/export",
        SERVICE.base_url(&endpoint),
        gateway::encode(&id)
    );
    let req = ctx.request(Method::GET, &url).header("Accept", "text/dns");
    let resp = trace::send(SERVICE.service_type, req).await?;
    Ok(Json(json!({ "zonefile": resp.text().await? })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(method: &Method, path: &str) -> Option<&'static Rule> {
        gateway::find_rule(RULES, method, path)
    }

    #[test]
    fn allowlist() {
        assert!(find(&M::GET, "zones").is_some());
        assert!(find(&M::PUT, "zones/z1/recordsets/r1").is_some());
        assert!(find(&M::GET, "zones/tasks/imports").is_some());
        assert!(find(&M::GET, "zones/tasks/exports/e1").is_some());
        assert!(find(&M::POST, "zones/tasks/transfer_accepts").is_some());
        assert!(find(&M::PATCH, "reverse/floatingips/RegionOne:fip-1").is_some());
        assert!(!find(&M::GET, "tlds").unwrap().admin);
        assert!(find(&M::POST, "tlds").unwrap().admin);
        assert!(find(&M::GET, "tsigkeys").unwrap().admin);
        assert!(find(&M::POST, "zones/z1/tasks/abandon").unwrap().admin);
        assert!(!find(&M::GET, "quotas/p1").unwrap().admin);
        assert!(find(&M::PATCH, "quotas/p1").unwrap().admin);
        assert!(find(&M::GET, "service_statuses").unwrap().admin);
        // Imports go through the import route (text/dns body); export files through theirs.
        assert!(find(&M::POST, "zones/tasks/imports").is_none());
        assert!(find(&M::GET, "zones/tasks/exports/e1/export").is_none());
        assert!(find(&M::PATCH, "zones/z1/recordsets/r1").is_none());
        assert!(find(&M::GET, "zones/../x").is_none());
        assert!(find(&M::DELETE, "pools/p1").is_none());
    }

    #[test]
    fn urls() {
        assert_eq!(SERVICE.base_url("http://h:9001"), "http://h:9001/v2");
        assert_eq!(SERVICE.base_url("http://h:9001/"), "http://h:9001/v2");
        assert_eq!(SERVICE.base_url("https://h/dns/v2"), "https://h/dns/v2");
    }

    #[test]
    fn header_params() {
        let q = |v: &[(&str, &str)]| {
            v.iter()
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect::<Vec<_>>()
        };
        let (query, headers) =
            split_query(true, q(&[("all_projects", "1"), ("name", "a.")])).unwrap();
        assert_eq!(query, q(&[("name", "a.")]));
        assert_eq!(headers, vec![("X-Auth-All-Projects", "true".to_owned())]);
        let (_, headers) = split_query(true, q(&[("all_projects", "0")])).unwrap();
        assert!(headers.is_empty());
        let (_, headers) = split_query(true, q(&[("sudo_project_id", "p-2")])).unwrap();
        assert_eq!(headers, vec![("X-Auth-Sudo-Project-ID", "p-2".to_owned())]);
        assert!(split_query(true, q(&[("sudo_project_id", "a\nb")])).is_err());
        assert!(split_query(false, q(&[("all_projects", "1")])).is_err());
        assert!(split_query(false, q(&[("name", "a.")])).is_ok());
    }
}
