//! Building blocks for an extension's allowlisted gateway (`/api/ext/<id>/os/{*path}`).
//!
//! An extension describes its service once ([`Service`]: catalog type, API version segment,
//! highest microversion it is written against) and the requests it allows ([`Rule`]s), then
//! hands every request to [`proxy`]. The gateway checks the allowlist and the admin role,
//! adds the session's token and the negotiated microversion, and can follow pagination
//! (`?all_pages=1`, `<key>_links` or a top-level `next` link, both with markers).

use std::{
    collections::HashMap,
    sync::{OnceLock, RwLock},
};

use axum::{
    Json,
    body::Bytes,
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
};
use rassvet_os_client::{Microversion, microversion};
use serde_json::{Value, json};

use crate::{ApiError, RequestContext};

/// Upper bound of items gathered when following pages.
pub const PAGE_CAP: usize = 5000;

/// The OpenStack service behind an extension gateway.
#[derive(Debug, Clone, Copy)]
pub struct Service {
    /// Catalog service type, e.g. `load-balancer` or `container-infra`.
    pub service_type: &'static str,
    /// API version segment appended to the catalog endpoint when missing, e.g. `v2`.
    pub version: &'static str,
    /// Highest microversion the extension is written against; the session uses
    /// `min(target, server max)`. `None` = the service has no microversions.
    pub microversion: Option<Microversion>,
}

impl Service {
    /// API base: the catalog endpoint when it already ends with the version segment (or its
    /// `.0` alias, e.g. `/v2.0`), otherwise the endpoint plus `/<version>`.
    pub fn base_url(&self, endpoint: &str) -> String {
        let e = endpoint.trim_end_matches('/');
        let v = self.version;
        if e.ends_with(&format!("/{v}")) || e.ends_with(&format!("/{v}.0")) {
            e.to_owned()
        } else {
            format!("{e}/{v}")
        }
    }
}

// ---------------------------------------------------------------------------- rules

/// One allowed request: method + path pattern relative to the API base.
pub struct Rule {
    pub method: Method,
    /// Segments; `{id}` = resource id, `{name}` = name (provider, availability zone, …).
    pub path: &'static str,
    pub admin: bool,
}

/// A rule open to every authenticated user (the service's own policy still applies).
pub const fn rule(method: Method, path: &'static str) -> Rule {
    Rule {
        method,
        path,
        admin: false,
    }
}

/// A rule that also requires the admin role in Rassvet.
pub const fn admin(method: Method, path: &'static str) -> Rule {
    Rule {
        method,
        path,
        admin: true,
    }
}

/// Resource ids: UUIDs (and anything made of the same characters).
pub fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Names such as providers, availability zones or quota resources.
pub fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || " _-.:".contains(c))
}

pub fn find_rule<'a>(rules: &'a [Rule], method: &Method, path: &str) -> Option<&'a Rule> {
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    rules.iter().find(|rule| {
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

/// Percent-encode every path segment.
pub fn encode(path: &str) -> String {
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

// ---------------------------------------------------------------------------- microversions

type VersionCache = RwLock<HashMap<String, Option<Microversion>>>;

fn versions() -> &'static VersionCache {
    static CACHE: OnceLock<VersionCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Microversion negotiated for `svc` in the session's cloud and region (cached per process).
pub async fn negotiated(
    ctx: &RequestContext,
    svc: &Service,
    endpoint: &str,
) -> Option<Microversion> {
    let target = svc.microversion?;
    let key = format!(
        "{}|{}|{}",
        ctx.cloud_id,
        ctx.region.as_deref().unwrap_or(""),
        svc.service_type
    );
    if let Some(v) = versions().read().ok().and_then(|m| m.get(&key).copied()) {
        return v;
    }
    let found = microversion::discover(&ctx.http, endpoint, &ctx.token.value).await;
    let v = found.and_then(|r| Microversion::negotiate(target, r));
    tracing::info!(service = svc.service_type, region = ?ctx.region, microversion = ?v.map(|m| m.to_string()), "negotiated");
    if let Ok(mut m) = versions().write() {
        m.insert(key, v);
    }
    v
}

// ---------------------------------------------------------------------------- calls

/// Send one request (no allowlist check: for an extension's own typed routes).
pub async fn call(
    ctx: &RequestContext,
    svc: &Service,
    method: Method,
    path: &str,
    query: &[(String, String)],
    body: Option<&Value>,
) -> Result<(StatusCode, Value), ApiError> {
    let endpoint = ctx.endpoint(svc.service_type)?;
    let url = format!("{}/{}", svc.base_url(&endpoint), encode(path));
    let mut req = ctx
        .request(method, &url)
        .header("Accept", "application/json")
        .query(query);
    if let Some(v) = negotiated(ctx, svc, &endpoint).await {
        let (name, value) = v.header(svc.service_type);
        req = req.header(name, value);
    }
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = rassvet_os_client::trace::send(svc.service_type, req).await?;
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::OK);
    let bytes = resp.bytes().await?;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    Ok((status, value))
}

/// Whether a list page says there is a next one: a `<key>_links` entry with `rel: next`
/// (Octavia, Nova style) or a non-empty top-level `next` link (Magnum style).
fn has_next(page: &Value, key: &str) -> bool {
    page[format!("{key}_links")]
        .as_array()
        .is_some_and(|l| l.iter().any(|x| x["rel"] == "next"))
        || page["next"].as_str().is_some_and(|s| !s.is_empty())
}

/// Marker for the page after `page`: the last item's `id`, else its `uuid`.
fn marker(page: &Value, key: &str) -> Option<String> {
    let last = page[key].as_array()?.last()?;
    last["id"]
        .as_str()
        .or_else(|| last["uuid"].as_str())
        .map(str::to_owned)
}

/// GET a list and follow next pages with markers, up to [`PAGE_CAP`] items.
pub async fn call_all(
    ctx: &RequestContext,
    svc: &Service,
    path: &str,
    query: &[(String, String)],
) -> Result<Value, ApiError> {
    let (_, mut first) = call(ctx, svc, Method::GET, path, query, None).await?;
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
    while let (true, Some(marker)) = (has_next(&page, &key), marker(&page, &key)) {
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
        let (_, next) = call(ctx, svc, Method::GET, path, &q, None).await?;
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
        o.remove("next");
        o.insert("truncated".into(), json!(truncated));
    }
    Ok(first)
}

/// Checks a request body before it is forwarded; `Err` is returned to the browser as is.
pub type BodyCheck = fn(&Method, &str, &Value) -> Result<(), ApiError>;

/// Handle one gateway request: allowlist + admin check, optional body check, logging of
/// changes, `?all_pages=1`, then forward to the service.
#[allow(clippy::too_many_arguments)]
pub async fn proxy(
    ctx: &RequestContext,
    svc: &Service,
    rules: &[Rule],
    check_body: Option<BodyCheck>,
    method: Method,
    path: &str,
    raw_query: Vec<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    let rule = find_rule(rules, &method, path).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            format!(
                "{method} {}/{path} is not available in Rassvet",
                svc.service_type
            ),
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
    for (k, v) in raw_query {
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
    if let (Some(check), Some(b)) = (check_body, &body) {
        check(&method, path, b)?;
    }
    if method != Method::GET {
        tracing::info!(user = %ctx.token.user.name, service = svc.service_type, %method, %path, "change");
    }
    if all_pages && method == Method::GET {
        return Ok(Json(call_all(ctx, svc, path, &query).await?).into_response());
    }
    let (status, value) = call(ctx, svc, method, path, &query, body.as_ref()).await?;
    Ok(if value.is_null() {
        status.into_response()
    } else {
        (status, Json(value)).into_response()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SVC: Service = Service {
        service_type: "load-balancer",
        version: "v2",
        microversion: None,
    };

    #[test]
    fn urls() {
        assert_eq!(SVC.base_url("http://h:9876"), "http://h:9876/v2");
        assert_eq!(
            SVC.base_url("http://h/load-balancer/"),
            "http://h/load-balancer/v2"
        );
        assert_eq!(SVC.base_url("http://h:9876/v2/"), "http://h:9876/v2");
        assert_eq!(SVC.base_url("http://h:9876/v2.0"), "http://h:9876/v2.0");
        assert_eq!(encode("a/az 1/"), "a/az%201");
    }

    #[test]
    fn rules() {
        static RULES: &[Rule] = &[
            rule(Method::GET, "things/{id}"),
            admin(Method::GET, "zones/{name}"),
        ];
        assert!(
            !find_rule(RULES, &Method::GET, "things/abc-1")
                .unwrap()
                .admin
        );
        assert!(find_rule(RULES, &Method::GET, "zones/az 1").unwrap().admin);
        assert!(find_rule(RULES, &Method::GET, "things/..").is_none());
        assert!(find_rule(RULES, &Method::GET, "things/a/b").is_none());
        assert!(find_rule(RULES, &Method::POST, "things/a").is_none());
    }

    #[test]
    fn pages() {
        let octavia =
            json!({"pools": [{"id": "a"}], "pools_links": [{"rel": "next", "href": "x"}]});
        assert!(has_next(&octavia, "pools"));
        assert_eq!(marker(&octavia, "pools").as_deref(), Some("a"));
        let magnum =
            json!({"clusters": [{"uuid": "u1"}], "next": "http://h/v1/clusters?marker=u1"});
        assert!(has_next(&magnum, "clusters"));
        assert_eq!(marker(&magnum, "clusters").as_deref(), Some("u1"));
        assert!(!has_next(&json!({"clusters": [], "next": ""}), "clusters"));
    }
}
