//! Octavia (load-balancer) extension — reference implementation of the extension model.
//!
//! Backend: an allowlisted gateway to the Octavia v2 API at `/api/ext/octavia/os/{*path}`
//! (paths are relative to `<endpoint>/v2/`, e.g. `lbaas/loadbalancers/<id>`). Every request
//! must match a rule in [`RULES`]; ids in the path are validated and admin-only rules
//! (amphorae, flavor / availability zone profiles, quotas of other projects, failover)
//! require the admin role in Rassvet as well as in Octavia's own policy. `?all_pages=1`
//! follows `<key>_links` "next" pages. The UI uses it through the SDK's `os` helpers with
//! the service name `ext:octavia`.

use rassvet_ext_api::{
    ApiError, Extension, Manifest, NavItem, NavSection, RequestContext,
    axum::{
        Json, Router,
        body::Bytes,
        extract::{Path, Query},
        http::{Method, StatusCode},
        response::{IntoResponse, Response},
        routing::any,
    },
    os,
};
use serde_json::{Value, json};

pub struct Octavia;

const ID: &str = "octavia";
/// Upper bound of items gathered when following pages.
const PAGE_CAP: usize = 5000;

impl Extension for Octavia {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: ID,
            name: "Load Balancers",
            version: env!("CARGO_PKG_VERSION"),
            description: "Manage Octavia load balancers, listeners, pools, members, health monitors, L7 policies, amphorae, flavors, availability zones and quotas",
            service_types: &["load-balancer"],
        }
    }

    fn nav(&self) -> Vec<NavItem> {
        let item = |id: &str, label: &str, path: &str, icon: &str, section: NavSection| NavItem {
            id: format!("{ID}.{id}"),
            group: "Network".into(),
            label: label.into(),
            path: path.into(),
            icon: icon.into(),
            section,
            role: (section == NavSection::Admin).then(|| "admin".into()),
        };
        vec![
            item(
                "load-balancers",
                "Load balancers",
                &format!("/ext/{ID}/load-balancers"),
                "split",
                NavSection::Project,
            ),
            item(
                "admin-load-balancers",
                "All load balancers",
                &format!("/admin/ext/{ID}/load-balancers"),
                "split",
                NavSection::Admin,
            ),
            item(
                "amphorae",
                "Amphorae",
                &format!("/admin/ext/{ID}/amphorae"),
                "container",
                NavSection::Admin,
            ),
            item(
                "settings",
                "Load balancing",
                &format!("/admin/ext/{ID}/settings"),
                "sliders-horizontal",
                NavSection::Admin,
            ),
        ]
    }

    fn router(&self) -> Router {
        Router::new().route("/os/{*path}", any(handle))
    }
}

// ---------------------------------------------------------------------------- rules

struct Rule {
    method: Method,
    /// Segments relative to `/v2/`; `{id}` = resource id, `{name}` = provider name.
    path: &'static str,
    admin: bool,
}

const fn r(method: Method, path: &'static str) -> Rule {
    Rule {
        method,
        path,
        admin: false,
    }
}
const fn admin(method: Method, path: &'static str) -> Rule {
    Rule {
        method,
        path,
        admin: true,
    }
}

use Method as M;

static RULES: &[Rule] = &[
    // Load balancers
    r(M::GET, "lbaas/loadbalancers"),
    r(M::POST, "lbaas/loadbalancers"),
    r(M::GET, "lbaas/loadbalancers/{id}"),
    r(M::PUT, "lbaas/loadbalancers/{id}"),
    r(M::DELETE, "lbaas/loadbalancers/{id}"),
    r(M::GET, "lbaas/loadbalancers/{id}/stats"),
    r(M::GET, "lbaas/loadbalancers/{id}/status"),
    admin(M::PUT, "lbaas/loadbalancers/{id}/failover"),
    // Listeners
    r(M::GET, "lbaas/listeners"),
    r(M::POST, "lbaas/listeners"),
    r(M::GET, "lbaas/listeners/{id}"),
    r(M::PUT, "lbaas/listeners/{id}"),
    r(M::DELETE, "lbaas/listeners/{id}"),
    r(M::GET, "lbaas/listeners/{id}/stats"),
    // Pools and members
    r(M::GET, "lbaas/pools"),
    r(M::POST, "lbaas/pools"),
    r(M::GET, "lbaas/pools/{id}"),
    r(M::PUT, "lbaas/pools/{id}"),
    r(M::DELETE, "lbaas/pools/{id}"),
    r(M::GET, "lbaas/pools/{id}/members"),
    r(M::POST, "lbaas/pools/{id}/members"),
    r(M::PUT, "lbaas/pools/{id}/members"),
    r(M::GET, "lbaas/pools/{id}/members/{id}"),
    r(M::PUT, "lbaas/pools/{id}/members/{id}"),
    r(M::DELETE, "lbaas/pools/{id}/members/{id}"),
    // Health monitors
    r(M::GET, "lbaas/healthmonitors"),
    r(M::POST, "lbaas/healthmonitors"),
    r(M::GET, "lbaas/healthmonitors/{id}"),
    r(M::PUT, "lbaas/healthmonitors/{id}"),
    r(M::DELETE, "lbaas/healthmonitors/{id}"),
    // L7 policies and rules
    r(M::GET, "lbaas/l7policies"),
    r(M::POST, "lbaas/l7policies"),
    r(M::GET, "lbaas/l7policies/{id}"),
    r(M::PUT, "lbaas/l7policies/{id}"),
    r(M::DELETE, "lbaas/l7policies/{id}"),
    r(M::GET, "lbaas/l7policies/{id}/rules"),
    r(M::POST, "lbaas/l7policies/{id}/rules"),
    r(M::GET, "lbaas/l7policies/{id}/rules/{id}"),
    r(M::PUT, "lbaas/l7policies/{id}/rules/{id}"),
    r(M::DELETE, "lbaas/l7policies/{id}/rules/{id}"),
    // Quotas: a project reads its own; admins list and change any.
    r(M::GET, "lbaas/quotas/{id}"),
    admin(M::GET, "lbaas/quotas"),
    admin(M::PUT, "lbaas/quotas/{id}"),
    admin(M::DELETE, "lbaas/quotas/{id}"),
    // Providers, flavors, availability zones (read for everyone, managed by admins)
    r(M::GET, "lbaas/providers"),
    admin(M::GET, "lbaas/providers/{name}/flavor_capabilities"),
    admin(
        M::GET,
        "lbaas/providers/{name}/availability_zone_capabilities",
    ),
    r(M::GET, "lbaas/flavors"),
    r(M::GET, "lbaas/flavors/{id}"),
    admin(M::POST, "lbaas/flavors"),
    admin(M::PUT, "lbaas/flavors/{id}"),
    admin(M::DELETE, "lbaas/flavors/{id}"),
    admin(M::GET, "lbaas/flavorprofiles"),
    admin(M::POST, "lbaas/flavorprofiles"),
    admin(M::GET, "lbaas/flavorprofiles/{id}"),
    admin(M::PUT, "lbaas/flavorprofiles/{id}"),
    admin(M::DELETE, "lbaas/flavorprofiles/{id}"),
    r(M::GET, "lbaas/availabilityzones"),
    r(M::GET, "lbaas/availabilityzones/{name}"),
    admin(M::POST, "lbaas/availabilityzones"),
    admin(M::PUT, "lbaas/availabilityzones/{name}"),
    admin(M::DELETE, "lbaas/availabilityzones/{name}"),
    admin(M::GET, "lbaas/availabilityzoneprofiles"),
    admin(M::POST, "lbaas/availabilityzoneprofiles"),
    admin(M::GET, "lbaas/availabilityzoneprofiles/{id}"),
    admin(M::PUT, "lbaas/availabilityzoneprofiles/{id}"),
    admin(M::DELETE, "lbaas/availabilityzoneprofiles/{id}"),
    // Amphorae (admin)
    admin(M::GET, "octavia/amphorae"),
    admin(M::GET, "octavia/amphorae/{id}"),
    admin(M::GET, "octavia/amphorae/{id}/stats"),
    admin(M::PUT, "octavia/amphorae/{id}/failover"),
    admin(M::PUT, "octavia/amphorae/{id}/config"),
    admin(M::DELETE, "octavia/amphorae/{id}"),
];

/// Resource ids: UUIDs (and anything made of the same characters).
fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Provider and availability zone names.
fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || " _-.:".contains(c))
}

fn find_rule(method: &Method, path: &str) -> Option<&'static Rule> {
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    RULES.iter().find(|rule| {
        let pat: Vec<&str> = rule.path.split('/').collect();
        rule.method == *method
            && pat.len() == segs.len()
            && pat.iter().zip(&segs).all(|(p, s)| match *p {
                "{id}" => valid_id(s),
                "{name}" => valid_name(s),
                lit => lit == *s,
            })
    })
}

// ---------------------------------------------------------------------------- calls

/// Octavia API v2 base: the catalog endpoint when it already ends with `/v2` (or `/v2.0`),
/// otherwise the endpoint plus `/v2` (`…:9876` → `…:9876/v2`, `…/load-balancer` → `…/load-balancer/v2`).
fn base_url(endpoint: &str) -> String {
    let e = endpoint.trim_end_matches('/');
    // Already versioned (`…/v2`, or the `…/v2.0` alias some deployments register): use as is.
    if e.ends_with("/v2") || e.ends_with("/v2.0") {
        e.to_owned()
    } else {
        format!("{e}/v2")
    }
}

fn encode(path: &str) -> String {
    path.trim_matches('/')
        .split('/')
        .map(|s| {
            s.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        (b as char).to_string()
                    }
                    _ => format!("%{b:02X}"),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

async fn call(
    ctx: &RequestContext,
    method: Method,
    path: &str,
    query: &[(String, String)],
    body: Option<&Value>,
) -> Result<(StatusCode, Value), ApiError> {
    let url = format!(
        "{}/{}",
        base_url(&ctx.endpoint("load-balancer")?),
        encode(path)
    );
    let mut req = ctx
        .request(method, &url)
        .header("Accept", "application/json")
        .query(query);
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = os::trace::send("load-balancer", req).await?;
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
async fn call_all(
    ctx: &RequestContext,
    path: &str,
    query: &[(String, String)],
) -> Result<Value, ApiError> {
    let (_, mut first) = call(ctx, Method::GET, path, query, None).await?;
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
    loop {
        let has_next = page[format!("{key}_links")]
            .as_array()
            .is_some_and(|l| l.iter().any(|x| x["rel"] == "next"));
        let marker = page[&key]
            .as_array()
            .and_then(|a| a.last())
            .and_then(|l| l["id"].as_str().map(str::to_owned));
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
        let (_, next) = call(ctx, Method::GET, path, &q, None).await?;
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

/// `/api/ext/octavia/os/{*path}`
async fn handle(
    ctx: RequestContext,
    method: Method,
    Path(path): Path<String>,
    Query(raw): Query<Vec<(String, String)>>,
    body: Bytes,
) -> Result<Response, ApiError> {
    let rule = find_rule(&method, &path).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            format!("{method} load-balancer/{path} is not available in Rassvet"),
        )
    })?;
    if rule.admin && !ctx.is_admin() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "the admin role is required to use this API",
        ));
    }
    let mut all_pages = false;
    let mut query = Vec::new();
    for (k, v) in raw {
        if k == "all_pages" {
            all_pages = v == "1" || v == "true";
        } else {
            query.push((k, v));
        }
    }
    let body: Option<Value> = if body.is_empty() {
        None
    } else {
        Some(serde_json::from_slice(&body).map_err(|e| {
            ApiError::new(StatusCode::BAD_REQUEST, format!("invalid JSON body: {e}"))
        })?)
    };
    if method != Method::GET {
        tracing::info!(user = %ctx.token.user.name, service = "load-balancer", %method, %path, "change");
    }
    if all_pages && method == Method::GET {
        return Ok(Json(call_all(&ctx, &path, &query).await?).into_response());
    }
    let (status, value) = call(&ctx, method, &path, &query, body.as_ref()).await?;
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
        assert!(find_rule(&M::GET, "lbaas/loadbalancers").is_some());
        assert!(find_rule(&M::PUT, "lbaas/pools/abc-1/members/def-2").is_some());
        assert!(find_rule(&M::PUT, "lbaas/pools/abc-1/members").is_some());
        assert!(
            find_rule(&M::GET, "lbaas/providers/amphora/flavor_capabilities")
                .unwrap()
                .admin
        );
        assert!(
            find_rule(&M::PUT, "lbaas/loadbalancers/x/failover")
                .unwrap()
                .admin
        );
        assert!(find_rule(&M::GET, "octavia/amphorae").unwrap().admin);
        assert!(find_rule(&M::GET, "lbaas/quotas").unwrap().admin);
        assert!(!find_rule(&M::GET, "lbaas/quotas/p1").unwrap().admin);
        assert!(find_rule(&M::GET, "lbaas/loadbalancers/../x").is_none());
        assert!(find_rule(&M::PATCH, "lbaas/loadbalancers/x").is_none());
        assert!(find_rule(&M::GET, "lbaas/secrets").is_none());
    }

    #[test]
    fn urls() {
        assert_eq!(base_url("http://h:9876"), "http://h:9876/v2");
        assert_eq!(
            base_url("http://h/load-balancer/"),
            "http://h/load-balancer/v2"
        );
        assert_eq!(base_url("http://h:9876/v2"), "http://h:9876/v2");
        assert_eq!(base_url("http://h:9876/v2/"), "http://h:9876/v2");
        assert_eq!(base_url("http://h:9876/v2.0"), "http://h:9876/v2.0");
        assert_eq!(
            base_url("https://h/load-balancer/v2"),
            "https://h/load-balancer/v2"
        );
        assert_eq!(
            encode("lbaas/availabilityzones/az 1"),
            "lbaas/availabilityzones/az%201"
        );
    }
}
