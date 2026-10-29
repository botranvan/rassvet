//! Magnum (container infrastructure) extension: Kubernetes clusters built by the Cluster API
//! driver `magnum-capi-helm` (`k8s_capi_helm_v1`). The Heat driver is not supported.
//!
//! Backend: an allowlisted gateway to the Magnum v1 API at `/api/ext/magnum/os/{*path}`
//! (paths are relative to `<endpoint>/v1/`, e.g. `clusters/<id>/nodegroups`), using the
//! negotiated `container-infra` microversion. Every request must match a rule in [`RULES`];
//! JSON-Patch bodies are checked before they are forwarded, and admin-only rules (quotas of
//! other projects, Magnum services) require the admin role in Rassvet as well as in Magnum's
//! own policy. Admins see the clusters of every project (Magnum widens the scope itself).
//!
//! `GET /api/ext/magnum/info` reports the negotiated microversion, so the UI can hide what the
//! cloud's Magnum doesn't have (e.g. renewing credentials needs 1.12).
//!
//! `POST /api/ext/magnum/clusters/{id}/kubeconfig` builds a kubeconfig like
//! `openstack coe cluster config`: a new key and CSR are made here, signed by the cluster CA
//! through Magnum, and returned once; nothing is kept on the server.

mod kubeconfig;

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
    os::Microversion,
};
use serde_json::Value;

pub struct Magnum;

const ID: &str = "magnum";

/// 1.14 (2024.2): node groups (1.9), zero-node groups (1.10), node labels / taints (1.14).
const SERVICE: Service = Service {
    service_type: "container-infra",
    version: "v1",
    microversion: Some(Microversion::new(1, 14)),
};

impl Extension for Magnum {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: ID,
            name: "Kubernetes",
            version: env!("CARGO_PKG_VERSION"),
            description: "Manage Magnum Kubernetes clusters, cluster templates, node groups, certificates (kubeconfig), quotas and services",
            service_types: &["container-infra"],
        }
    }

    fn nav(&self) -> Vec<NavItem> {
        let item = |id: &str, label: &str, path: &str, icon: &str, section: NavSection| NavItem {
            id: format!("{ID}.{id}"),
            group: "Container".into(),
            label: label.into(),
            path: path.into(),
            icon: icon.into(),
            section,
            role: (section == NavSection::Admin).then(|| "admin".into()),
        };
        vec![
            item(
                "clusters",
                "Kubernetes clusters",
                &format!("/ext/{ID}/clusters"),
                "container",
                NavSection::Project,
            ),
            item(
                "templates",
                "Cluster templates",
                &format!("/ext/{ID}/templates"),
                "file-code",
                NavSection::Project,
            ),
            item(
                "admin-clusters",
                "All Kubernetes clusters",
                &format!("/admin/ext/{ID}/clusters"),
                "container",
                NavSection::Admin,
            ),
            item(
                "admin-templates",
                "Cluster templates",
                &format!("/admin/ext/{ID}/templates"),
                "file-code",
                NavSection::Admin,
            ),
            item(
                "settings",
                "Kubernetes service",
                &format!("/admin/ext/{ID}/settings"),
                "sliders-horizontal",
                NavSection::Admin,
            ),
        ]
    }

    fn router(&self) -> Router {
        Router::new()
            .route("/os/{*path}", any(handle))
            .route("/info", get(info))
            .route("/clusters/{id}/kubeconfig", post(kubeconfig::handle))
    }
}

// ---------------------------------------------------------------------------- rules

use Method as M;

static RULES: &[Rule] = &[
    // Cluster templates (public / hidden flags are enforced by Magnum's policy)
    r(M::GET, "clustertemplates"),
    r(M::GET, "clustertemplates/detail"),
    r(M::POST, "clustertemplates"),
    r(M::GET, "clustertemplates/{id}"),
    r(M::PATCH, "clustertemplates/{id}"),
    r(M::DELETE, "clustertemplates/{id}"),
    // Clusters
    r(M::GET, "clusters"),
    r(M::GET, "clusters/detail"),
    r(M::POST, "clusters"),
    r(M::GET, "clusters/{id}"),
    r(M::PATCH, "clusters/{id}"),
    r(M::DELETE, "clusters/{id}"),
    r(M::POST, "clusters/{id}/actions/resize"),
    r(M::POST, "clusters/{id}/actions/upgrade"),
    // Node groups
    r(M::GET, "clusters/{id}/nodegroups"),
    r(M::POST, "clusters/{id}/nodegroups"),
    r(M::GET, "clusters/{id}/nodegroups/{id}"),
    r(M::PATCH, "clusters/{id}/nodegroups/{id}"),
    r(M::DELETE, "clusters/{id}/nodegroups/{id}"),
    // Certificates: CA of a cluster. Signing goes through the kubeconfig route; the CAPI
    // driver can't rotate the CA (Magnum answers NotSupported), so that isn't offered.
    r(M::GET, "certificates/{id}"),
    // New application credential for the cluster (1.12; e.g. when its owner leaves).
    r(M::PATCH, "credentials/{id}"),
    // Usage and quotas: a project reads its own; admins list and change any.
    r(M::GET, "stats"),
    r(M::GET, "quotas/{id}/{name}"),
    admin(M::GET, "quotas"),
    admin(M::POST, "quotas"),
    admin(M::PATCH, "quotas/{id}/{name}"),
    admin(M::DELETE, "quotas/{id}/{name}"),
    // Magnum services (admin)
    admin(M::GET, "mservices"),
];

/// JSON-Patch body of a cluster / template / node group update: a non-empty list of
/// `add | replace | remove` operations on top-level attributes or label keys.
fn check_body(method: &Method, path: &str, body: &Value) -> Result<(), ApiError> {
    if *method != Method::PATCH || path.starts_with("quotas/") || path.starts_with("credentials/") {
        return Ok(());
    }
    let bad = |m: &str| Err(ApiError::new(StatusCode::BAD_REQUEST, m.to_owned()));
    let Some(ops) = body.as_array().filter(|a| !a.is_empty()) else {
        return bad("the body must be a non-empty JSON-Patch list");
    };
    for op in ops {
        let kind = op["op"].as_str().unwrap_or_default();
        if !matches!(kind, "add" | "replace" | "remove") {
            return bad("only add, replace and remove operations are allowed");
        }
        let p = op["path"].as_str().unwrap_or_default();
        let valid = p.len() > 1
            && p.len() <= 255
            && p.starts_with('/')
            && p[1..].split('/').count() <= 2
            && p[1..].split('/').all(|s| {
                !s.is_empty()
                    && s.chars()
                        .all(|c| c.is_ascii_alphanumeric() || "_-.~".contains(c))
            });
        if !valid {
            return bad(&format!("invalid patch path '{p}'"));
        }
        if kind != "remove" && op.get("value").is_none() {
            return bad(&format!("a value is required for '{p}'"));
        }
    }
    Ok(())
}

/// `GET /api/ext/magnum/info`: `{"microversion": "1.11"}` (null when Magnum has none).
async fn info(ctx: RequestContext) -> Result<Json<Value>, ApiError> {
    let endpoint = ctx.endpoint(SERVICE.service_type)?;
    let v = gateway::negotiated(&ctx, &SERVICE, &endpoint).await;
    Ok(Json(
        serde_json::json!({ "microversion": v.map(|m| m.to_string()) }),
    ))
}

/// `/api/ext/magnum/os/{*path}`
async fn handle(
    ctx: RequestContext,
    method: Method,
    Path(path): Path<String>,
    Query(raw): Query<Vec<(String, String)>>,
    body: Bytes,
) -> Result<Response, ApiError> {
    gateway::proxy(
        &ctx,
        &SERVICE,
        RULES,
        Some(check_body),
        method,
        &path,
        raw,
        body,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn find(method: &Method, path: &str) -> Option<&'static Rule> {
        gateway::find_rule(RULES, method, path)
    }

    #[test]
    fn allowlist() {
        assert!(find(&M::GET, "clusters/detail").is_some());
        assert!(find(&M::POST, "clusters/abc-1/actions/resize").is_some());
        assert!(find(&M::PATCH, "clusters/abc-1/nodegroups/default-worker").is_some());
        assert!(find(&M::GET, "certificates/abc-1").is_some());
        assert!(find(&M::PATCH, "certificates/abc-1").is_none());
        assert!(find(&M::PATCH, "credentials/abc-1").is_some());
        assert!(!find(&M::GET, "quotas/p1/Cluster").unwrap().admin);
        assert!(find(&M::PATCH, "quotas/p1/Cluster").unwrap().admin);
        assert!(find(&M::GET, "quotas").unwrap().admin);
        assert!(find(&M::GET, "mservices").unwrap().admin);
        // Signing is only done by the kubeconfig route.
        assert!(find(&M::POST, "certificates").is_none());
        assert!(find(&M::POST, "clusters/x/actions/delete").is_none());
        assert!(find(&M::GET, "clusters/../x").is_none());
        assert!(find(&M::PUT, "clusters/x").is_none());
        assert!(find(&M::GET, "federations").is_none());
    }

    #[test]
    fn urls() {
        assert_eq!(SERVICE.base_url("http://h:9511/v1"), "http://h:9511/v1");
        assert_eq!(SERVICE.base_url("http://h:9511"), "http://h:9511/v1");
        assert_eq!(
            SERVICE.base_url("https://h/container-infra/v1/"),
            "https://h/container-infra/v1"
        );
    }

    #[test]
    fn patches() {
        let ok = |p: &str, b: Value| check_body(&M::PATCH, p, &b).is_ok();
        assert!(ok(
            "clusters/x",
            json!([{"op": "replace", "path": "/node_count", "value": 3}])
        ));
        assert!(ok(
            "clustertemplates/x",
            json!([{"op": "add", "path": "/labels/octavia_provider", "value": "ovn"}, {"op": "remove", "path": "/dns_nameserver"}])
        ));
        assert!(ok("quotas/p/Cluster", json!({"hard_limit": 5})));
        assert!(ok("credentials/x", json!({})));
        assert!(!ok("clusters/x", json!([])));
        assert!(!ok("clusters/x", json!({"node_count": 3})));
        assert!(!ok(
            "clusters/x",
            json!([{"op": "move", "from": "/a", "path": "/b"}])
        ));
        assert!(!ok(
            "clusters/x",
            json!([{"op": "replace", "path": "/a/b/c", "value": 1}])
        ));
        assert!(!ok("clusters/x", json!([{"op": "replace", "path": "/a"}])));
        assert!(!ok(
            "clusters/x",
            json!([{"op": "replace", "path": "/", "value": 1}])
        ));
        // Other methods are not patch documents.
        assert!(check_body(&M::POST, "clusters", &json!({"name": "k"})).is_ok());
    }
}
