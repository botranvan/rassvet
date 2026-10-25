//! Object storage (Swift API — OpenStack Swift or Ceph RGW): `/api/object-store/*`.
//!
//! Swift speaks headers and raw bodies rather than JSON, so it has its own handlers:
//! account / container / object metadata come back as JSON, uploads and downloads are
//! streamed (never buffered), containers can be deleted with everything in them, objects
//! copied or moved, and temporary URLs signed (HMAC-SHA256, Swift's tempurl middleware).
//! Admins can read and set another project's account quota (needs the ResellerAdmin role
//! in Swift, and the account in the endpoint URL: `…/v1/AUTH_<project id>`).

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rassvet_ext_api::{ApiError, RequestContext};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::task::JoinSet;

use crate::state::AppState;

type ApiResult<T = Json<Value>> = Result<T, ApiError>;
const SVC: &str = "object-store";
/// Objects deleted at once when emptying a container.
const DELETE_PARALLEL: usize = 16;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/info", get(info))
        .route("/containers", get(list_containers))
        .route(
            "/containers/{c}",
            get(container_meta)
                .put(create_container)
                .post(update_container)
                .delete(delete_container),
        )
        .route("/containers/{c}/objects", get(list_objects))
        .route(
            "/containers/{c}/objects/{*o}",
            get(download)
                .put(upload)
                .delete(delete_object)
                .layer(DefaultBodyLimit::disable()),
        )
        .route("/containers/{c}/folders", post(create_folder))
        .route("/containers/{c}/delete-prefix", post(delete_prefix))
        .route(
            "/containers/{c}/meta/{*o}",
            get(object_meta).post(update_object),
        )
        .route("/containers/{c}/tempurl/{*o}", post(temp_url))
        .route("/copy", post(copy))
        .route(
            "/accounts/{project}",
            get(account_of).post(set_account_quota),
        )
}

// ---------------------------------------------------------------------------- helpers

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, msg)
}

fn enc(seg: &str) -> String {
    url::form_urlencoded::byte_serialize(seg.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

/// Object names keep their "/" (pseudo-folders); every other byte is encoded.
fn enc_object(o: &str) -> String {
    o.split('/').map(enc).collect::<Vec<_>>().join("/")
}

fn check_container(c: &str) -> Result<(), ApiError> {
    if c.is_empty() || c.len() > 256 || c.contains('/') || c == "." || c == ".." {
        return Err(bad("container names are 1–256 characters without “/”"));
    }
    Ok(())
}

fn check_object(o: &str) -> Result<(), ApiError> {
    if o.is_empty() || o.len() > 1024 {
        return Err(bad("object names are 1–1024 characters"));
    }
    // URL parsing would resolve "." / ".." segments (encoded or not) and the request would
    // address another container or account than the one checked.
    if o.split('/').any(|s| s == "." || s == "..") {
        return Err(bad("object names can't contain “.” or “..” path segments"));
    }
    Ok(())
}

/// Storage URL of the session's account, or of `project`'s (same endpoint, other AUTH_).
fn account_url(ctx: &RequestContext, project: Option<&str>) -> Result<String, ApiError> {
    let ep = ctx.endpoint(SVC)?.trim_end_matches('/').to_owned();
    let Some(p) = project else { return Ok(ep) };
    if !p
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(bad("invalid project id"));
    }
    let current = ctx.project_id().unwrap_or_default();
    let needle = format!("AUTH_{current}");
    if current.is_empty() || !ep.contains(&needle) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "the object-store endpoint has no AUTH_<project> account in its URL, so other projects' accounts can't be addressed",
        ));
    }
    Ok(ep.replace(&needle, &format!("AUTH_{p}")))
}

fn container_url(ctx: &RequestContext, c: &str) -> Result<String, ApiError> {
    check_container(c)?;
    Ok(format!("{}/{}", account_url(ctx, None)?, enc(c)))
}

fn object_url(ctx: &RequestContext, c: &str, o: &str) -> Result<String, ApiError> {
    check_object(o)?;
    Ok(format!("{}/{}", container_url(ctx, c)?, enc_object(o)))
}

/// `…/v1/AUTH_x` → `…/info` (Swift and RGW publish capabilities next to `/v1`).
fn info_url(ep: &str) -> Option<String> {
    let i = ep
        .find("/v1/")
        .or_else(|| ep.ends_with("/v1").then(|| ep.len() - 3))?;
    Some(format!("{}/info", &ep[..i]))
}

async fn send(rb: reqwest::RequestBuilder) -> Result<reqwest::Response, ApiError> {
    Ok(rassvet_os_client::trace::send(SVC, rb).await?)
}

fn hdr(h: &reqwest::header::HeaderMap, k: &str) -> Option<String> {
    h.get(k).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

fn num(h: &reqwest::header::HeaderMap, k: &str) -> Option<u64> {
    hdr(h, k).and_then(|v| v.parse().ok())
}

/// User metadata (`X-<kind>-Meta-*`), minus the keys Rassvet shows on their own.
fn metas(h: &reqwest::header::HeaderMap, kind: &str) -> Map<String, Value> {
    let prefix = format!("x-{kind}-meta-");
    h.iter()
        .filter_map(|(k, v)| {
            let name = k.as_str().strip_prefix(&prefix)?;
            if name.starts_with("quota-") || name.starts_with("temp-url-key") {
                return None;
            }
            Some((
                name.to_owned(),
                Value::String(String::from_utf8_lossy(v.as_bytes()).into_owned()),
            ))
        })
        .collect()
}

fn valid_meta_key(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= 128
        && k.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn header_value(v: &str) -> Result<reqwest::header::HeaderValue, ApiError> {
    reqwest::header::HeaderValue::from_str(v)
        .map_err(|_| bad("metadata values must be plain text without line breaks"))
}

fn account_json(h: &reqwest::header::HeaderMap) -> Value {
    let policies: Map<String, Value> = h
        .iter()
        .filter_map(|(k, v)| {
            let rest = k.as_str().strip_prefix("x-account-storage-policy-")?;
            let name = rest.strip_suffix("-bytes-used")?;
            Some((
                name.to_owned(),
                json!(v.to_str().ok()?.parse::<u64>().ok()?),
            ))
        })
        .collect();
    json!({
        "containers": num(h, "x-account-container-count"),
        "objects": num(h, "x-account-object-count"),
        "bytes": num(h, "x-account-bytes-used"),
        "quota_bytes": num(h, "x-account-meta-quota-bytes"),
        "has_temp_url_key": h.contains_key("x-account-meta-temp-url-key"),
        "bytes_by_policy": policies,
        "metadata": metas(h, "account"),
    })
}

/// HMAC-SHA256 (RFC 2104) with the sha2 crate already in the build.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let (mut ipad, mut opad) = ([0x36u8; 64], [0x5cu8; 64]);
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = Sha256::new()
        .chain_update(ipad)
        .chain_update(msg)
        .finalize();
    Sha256::new()
        .chain_update(opad)
        .chain_update(inner)
        .finalize()
        .into()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------------------------------------------------------------------------- account

/// `GET /info` — account usage plus the cluster's capabilities (`/info`, if published).
async fn info(ctx: RequestContext) -> ApiResult {
    let ep = account_url(&ctx, None)?;
    let resp = send(ctx.request(Method::HEAD, &ep)).await?;
    let caps = match info_url(&ep) {
        Some(u) => match ctx.http.get(&u).send().await {
            Ok(r) if r.status().is_success() => r.json::<Value>().await.unwrap_or(Value::Null),
            _ => Value::Null,
        },
        None => Value::Null,
    };
    Ok(Json(json!({
        "endpoint": ep,
        "account": account_json(resp.headers()),
        "capabilities": caps,
    })))
}

#[derive(Deserialize)]
struct ListQuery {
    prefix: Option<String>,
    marker: Option<String>,
    end_marker: Option<String>,
    limit: Option<u32>,
    delimiter: Option<String>,
}

impl ListQuery {
    fn pairs(&self) -> Vec<(&'static str, String)> {
        let mut q = vec![("format", "json".to_owned())];
        for (k, v) in [
            ("prefix", &self.prefix),
            ("marker", &self.marker),
            ("end_marker", &self.end_marker),
            ("delimiter", &self.delimiter),
        ] {
            if let Some(v) = v.as_ref().filter(|v| !v.is_empty()) {
                q.push((k, v.clone()));
            }
        }
        q.push(("limit", self.limit.unwrap_or(1000).min(10_000).to_string()));
        q
    }
}

async fn list_containers(ctx: RequestContext, Query(q): Query<ListQuery>) -> ApiResult {
    let ep = account_url(&ctx, None)?;
    let resp = send(ctx.request(Method::GET, &ep).query(&q.pairs())).await?;
    let list: Value = if resp.status() == reqwest::StatusCode::NO_CONTENT {
        json!([])
    } else {
        resp.json().await.unwrap_or(json!([]))
    };
    Ok(Json(json!({ "containers": list })))
}

// ---------------------------------------------------------------------------- containers

async fn container_meta(ctx: RequestContext, Path(c): Path<String>) -> ApiResult {
    let resp = send(ctx.request(Method::HEAD, &container_url(&ctx, &c)?)).await?;
    let h = resp.headers();
    Ok(Json(json!({
        "name": c,
        "objects": num(h, "x-container-object-count"),
        "bytes": num(h, "x-container-bytes-used"),
        "read_acl": hdr(h, "x-container-read"),
        "write_acl": hdr(h, "x-container-write"),
        "storage_policy": hdr(h, "x-storage-policy"),
        "history_location": hdr(h, "x-history-location"),
        "versions_location": hdr(h, "x-versions-location"),
        "quota_bytes": num(h, "x-container-meta-quota-bytes"),
        "quota_count": num(h, "x-container-meta-quota-count"),
        "has_temp_url_key": h.contains_key("x-container-meta-temp-url-key"),
        "last_modified": hdr(h, "last-modified"),
        "metadata": metas(h, "container"),
    })))
}

#[derive(Deserialize, Default)]
struct ContainerBody {
    /// Anyone may read objects and list the container (`.r:*,.rlistings`).
    #[serde(default)]
    public: bool,
    storage_policy: Option<String>,
    /// Keep old versions of overwritten / deleted objects in this container.
    history_location: Option<String>,
    #[serde(default)]
    metadata: Map<String, Value>,
}

async fn create_container(
    ctx: RequestContext,
    Path(c): Path<String>,
    Json(b): Json<ContainerBody>,
) -> Result<StatusCode, ApiError> {
    let url = container_url(&ctx, &c)?;
    let mut rb = ctx
        .request(Method::PUT, &url)
        .header(header::CONTENT_LENGTH.as_str(), "0");
    if b.public {
        rb = rb.header("X-Container-Read", ".r:*,.rlistings");
    }
    if let Some(p) = b.storage_policy.as_deref().filter(|p| !p.is_empty()) {
        rb = rb.header("X-Storage-Policy", header_value(p)?);
    }
    if let Some(h) = b.history_location.as_deref().filter(|h| !h.is_empty()) {
        check_container(h)?;
        // The archive container must exist; creating an existing one is a no-op.
        send(
            ctx.request(Method::PUT, &container_url(&ctx, h)?)
                .header(header::CONTENT_LENGTH.as_str(), "0"),
        )
        .await?;
        rb = rb.header("X-History-Location", enc(h));
    }
    for (k, v) in &b.metadata {
        if !valid_meta_key(k) {
            return Err(bad(format!("invalid metadata key “{k}”")));
        }
        rb = rb.header(
            format!("X-Container-Meta-{k}"),
            header_value(v.as_str().unwrap_or_default())?,
        );
    }
    send(rb).await?;
    tracing::info!(user = %ctx.token.user.name, container = %c, "container created");
    Ok(StatusCode::CREATED)
}

/// Each field: absent = unchanged, `null` = removed, value = set.
#[derive(Deserialize, Default)]
struct ContainerUpdate {
    #[serde(default, deserialize_with = "some")]
    read_acl: Option<Value>,
    #[serde(default, deserialize_with = "some")]
    write_acl: Option<Value>,
    #[serde(default, deserialize_with = "some")]
    history_location: Option<Value>,
    #[serde(default, deserialize_with = "some")]
    quota_bytes: Option<Value>,
    #[serde(default, deserialize_with = "some")]
    quota_count: Option<Value>,
    /// `{key: value | null}`; keys not listed are kept.
    #[serde(default)]
    metadata: Map<String, Value>,
}

/// Distinguishes `"field": null` (Some(Null)) from a missing field (None).
fn some<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

fn set_or_remove(
    rb: reqwest::RequestBuilder,
    name: &str,
    remove: &str,
    v: &Option<Value>,
) -> Result<reqwest::RequestBuilder, ApiError> {
    Ok(match v {
        None => rb,
        Some(Value::Null) => rb.header(remove, "x"),
        Some(Value::String(s)) if s.is_empty() => rb.header(remove, "x"),
        Some(Value::String(s)) => rb.header(name, header_value(s)?),
        Some(Value::Number(n)) => rb.header(name, n.to_string()),
        Some(_) => return Err(bad(format!("invalid value for {name}"))),
    })
}

async fn update_container(
    ctx: RequestContext,
    Path(c): Path<String>,
    Json(b): Json<ContainerUpdate>,
) -> Result<StatusCode, ApiError> {
    let url = container_url(&ctx, &c)?;
    let mut rb = ctx.request(Method::POST, &url);
    rb = set_or_remove(
        rb,
        "X-Container-Read",
        "X-Remove-Container-Read",
        &b.read_acl,
    )?;
    rb = set_or_remove(
        rb,
        "X-Container-Write",
        "X-Remove-Container-Write",
        &b.write_acl,
    )?;
    if let Some(Value::String(h)) = &b.history_location
        && !h.is_empty()
    {
        check_container(h)?;
        send(
            ctx.request(Method::PUT, &container_url(&ctx, h)?)
                .header(header::CONTENT_LENGTH.as_str(), "0"),
        )
        .await?;
        rb = rb.header("X-History-Location", enc(h));
    } else {
        rb = set_or_remove(
            rb,
            "X-History-Location",
            "X-Remove-History-Location",
            &b.history_location,
        )?;
    }
    rb = set_or_remove(
        rb,
        "X-Container-Meta-Quota-Bytes",
        "X-Remove-Container-Meta-Quota-Bytes",
        &b.quota_bytes,
    )?;
    rb = set_or_remove(
        rb,
        "X-Container-Meta-Quota-Count",
        "X-Remove-Container-Meta-Quota-Count",
        &b.quota_count,
    )?;
    for (k, v) in &b.metadata {
        if !valid_meta_key(k) {
            return Err(bad(format!("invalid metadata key “{k}”")));
        }
        rb = set_or_remove(
            rb,
            &format!("X-Container-Meta-{k}"),
            &format!("X-Remove-Container-Meta-{k}"),
            &Some(v.clone()),
        )?;
    }
    send(rb).await?;
    tracing::info!(user = %ctx.token.user.name, container = %c, "container updated");
    Ok(StatusCode::NO_CONTENT)
}

/// Every object name in a container (following pages), optionally under a prefix.
async fn all_objects(
    ctx: &RequestContext,
    url: &str,
    prefix: Option<&str>,
) -> Result<Vec<String>, ApiError> {
    let mut names = Vec::new();
    let mut marker = String::new();
    loop {
        let mut q = vec![("format", "json".to_owned()), ("limit", "10000".to_owned())];
        if let Some(p) = prefix {
            q.push(("prefix", p.to_owned()));
        }
        if !marker.is_empty() {
            q.push(("marker", marker.clone()));
        }
        let resp = send(ctx.request(Method::GET, url).query(&q)).await?;
        if resp.status() == reqwest::StatusCode::NO_CONTENT {
            break;
        }
        let page: Vec<Value> = resp.json().await.unwrap_or_default();
        let got: Vec<String> = page
            .iter()
            .filter_map(|o| o["name"].as_str().map(str::to_owned))
            .collect();
        let Some(last) = got.last().cloned() else {
            break;
        };
        names.extend(got);
        marker = last;
    }
    Ok(names)
}

/// Delete objects, a few at a time; returns how many went (404 counts as gone).
async fn delete_many(
    ctx: &RequestContext,
    container: &str,
    names: Vec<String>,
) -> Result<usize, ApiError> {
    let base = container_url(ctx, container)?;
    // Names come from the listing; skip the (legal in Swift) ones that can't be addressed safely.
    let names: Vec<String> = names
        .into_iter()
        .filter(|n| check_object(n).is_ok())
        .collect();
    let mut done = 0;
    for chunk in names.chunks(DELETE_PARALLEL) {
        let mut set = JoinSet::new();
        for n in chunk {
            let rb = ctx.request(Method::DELETE, &format!("{base}/{}", enc_object(n)));
            set.spawn(async move { rassvet_os_client::trace::send(SVC, rb).await });
        }
        while let Some(r) = set.join_next().await {
            match r.map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))? {
                Ok(_) => done += 1,
                Err(e) => {
                    let e: ApiError = e.into();
                    if e.status != StatusCode::NOT_FOUND {
                        return Err(e);
                    }
                    done += 1;
                }
            }
        }
    }
    Ok(done)
}

#[derive(Deserialize)]
struct DeleteQuery {
    #[serde(default)]
    recursive: bool,
}

async fn delete_container(
    ctx: RequestContext,
    Path(c): Path<String>,
    Query(q): Query<DeleteQuery>,
) -> ApiResult {
    let url = container_url(&ctx, &c)?;
    let mut deleted = 0;
    if q.recursive {
        let names = all_objects(&ctx, &url, None).await?;
        deleted = delete_many(&ctx, &c, names).await?;
    }
    match send(ctx.request(Method::DELETE, &url)).await {
        Ok(_) => {}
        Err(e) if e.status == StatusCode::CONFLICT => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "the container isn't empty; delete its objects first (or delete everything in it)",
            ));
        }
        Err(e) => return Err(e),
    }
    tracing::info!(user = %ctx.token.user.name, container = %c, deleted, "container deleted");
    Ok(Json(json!({ "deleted_objects": deleted })))
}

#[derive(Deserialize)]
struct PrefixBody {
    prefix: String,
}

/// Delete a pseudo-folder: every object whose name starts with the prefix.
async fn delete_prefix(
    ctx: RequestContext,
    Path(c): Path<String>,
    Json(b): Json<PrefixBody>,
) -> ApiResult {
    if b.prefix.is_empty() {
        return Err(bad(
            "a prefix is required (delete the container to remove everything)",
        ));
    }
    let url = container_url(&ctx, &c)?;
    let names = all_objects(&ctx, &url, Some(&b.prefix)).await?;
    let deleted = delete_many(&ctx, &c, names).await?;
    tracing::info!(user = %ctx.token.user.name, container = %c, prefix = %b.prefix, deleted, "objects deleted by prefix");
    Ok(Json(json!({ "deleted_objects": deleted })))
}

// ---------------------------------------------------------------------------- objects

async fn list_objects(
    ctx: RequestContext,
    Path(c): Path<String>,
    Query(q): Query<ListQuery>,
) -> ApiResult {
    let resp = send(
        ctx.request(Method::GET, &container_url(&ctx, &c)?)
            .query(&q.pairs()),
    )
    .await?;
    let list: Value = if resp.status() == reqwest::StatusCode::NO_CONTENT {
        json!([])
    } else {
        resp.json().await.unwrap_or(json!([]))
    };
    Ok(Json(json!({ "objects": list })))
}

/// Stream the browser's body to Swift. Content-Type comes from the request (or the name).
async fn upload(
    ctx: RequestContext,
    Path((c, o)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Result<StatusCode, ApiError> {
    let url = object_url(&ctx, &c, &o)?;
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty() && *v != "application/octet-stream")
        .map(str::to_owned)
        .unwrap_or_else(|| {
            mime_guess::from_path(&o)
                .first_or_octet_stream()
                .to_string()
        });
    let mut rb = ctx
        .request(Method::PUT, &url)
        .header(header::CONTENT_TYPE.as_str(), ct)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()));
    if let Some(len) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
    {
        rb = rb.header(header::CONTENT_LENGTH.as_str(), len);
    }
    send(rb).await?;
    tracing::info!(user = %ctx.token.user.name, container = %c, object = %o, "object uploaded");
    Ok(StatusCode::CREATED)
}

#[derive(Deserialize)]
struct FolderBody {
    path: String,
}

/// A pseudo-folder is a zero-byte `name/` object with content type application/directory.
async fn create_folder(
    ctx: RequestContext,
    Path(c): Path<String>,
    Json(b): Json<FolderBody>,
) -> Result<StatusCode, ApiError> {
    let p = b.path.trim_matches('/');
    if p.is_empty() || p.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
        return Err(bad("invalid folder name"));
    }
    let url = object_url(&ctx, &c, &format!("{p}/"))?;
    send(
        ctx.request(Method::PUT, &url)
            .header(header::CONTENT_TYPE.as_str(), "application/directory")
            .header(header::CONTENT_LENGTH.as_str(), "0"),
    )
    .await?;
    Ok(StatusCode::CREATED)
}

/// Always an attachment (user content must never render inside Rassvet's origin).
async fn download(
    ctx: RequestContext,
    Path((c, o)): Path<(String, String)>,
) -> ApiResult<Response> {
    let resp = send(ctx.request(Method::GET, &object_url(&ctx, &c, &o)?)).await?;
    let file = o.rsplit('/').find(|s| !s.is_empty()).unwrap_or("download");
    let ascii: String = file
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || "._-".contains(ch) {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let mut out = Response::builder()
        .header(
            header::CONTENT_TYPE,
            resp.headers()
                .get(header::CONTENT_TYPE)
                .cloned()
                .unwrap_or_else(|| header::HeaderValue::from_static("application/octet-stream")),
        )
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
                enc(file)
            ),
        )
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, "sandbox");
    if let Some(len) = resp.headers().get(header::CONTENT_LENGTH) {
        out = out.header(header::CONTENT_LENGTH, len.clone());
    }
    Ok(out
        .body(Body::from_stream(resp.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

async fn delete_object(
    ctx: RequestContext,
    Path((c, o)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    send(ctx.request(Method::DELETE, &object_url(&ctx, &c, &o)?)).await?;
    tracing::info!(user = %ctx.token.user.name, container = %c, object = %o, "object deleted");
    Ok(StatusCode::NO_CONTENT)
}

async fn object_meta(ctx: RequestContext, Path((c, o)): Path<(String, String)>) -> ApiResult {
    let resp = send(ctx.request(Method::HEAD, &object_url(&ctx, &c, &o)?)).await?;
    let h = resp.headers();
    Ok(Json(json!({
        "name": o,
        "content_type": hdr(h, "content-type"),
        "bytes": num(h, "content-length"),
        "etag": hdr(h, "etag").map(|e| e.trim_matches('"').to_owned()),
        "last_modified": hdr(h, "last-modified"),
        "delete_at": num(h, "x-delete-at"),
        "static_large_object": hdr(h, "x-static-large-object").is_some_and(|v| v == "True" || v == "true"),
        "manifest": hdr(h, "x-object-manifest"),
        "metadata": metas(h, "object"),
    })))
}

#[derive(Deserialize)]
struct ObjectUpdate {
    content_type: Option<String>,
    /// The complete metadata (Swift replaces it on POST).
    #[serde(default)]
    metadata: Map<String, Value>,
    /// Unix time to expire the object; `null` removes the expiry.
    #[serde(default, deserialize_with = "some")]
    delete_at: Option<Value>,
}

async fn update_object(
    ctx: RequestContext,
    Path((c, o)): Path<(String, String)>,
    Json(b): Json<ObjectUpdate>,
) -> Result<StatusCode, ApiError> {
    let mut rb = ctx.request(Method::POST, &object_url(&ctx, &c, &o)?);
    if let Some(ct) = b.content_type.as_deref().filter(|c| !c.is_empty()) {
        rb = rb.header(header::CONTENT_TYPE.as_str(), header_value(ct)?);
    }
    for (k, v) in &b.metadata {
        if !valid_meta_key(k) {
            return Err(bad(format!("invalid metadata key “{k}”")));
        }
        rb = rb.header(
            format!("X-Object-Meta-{k}"),
            header_value(v.as_str().unwrap_or_default())?,
        );
    }
    rb = set_or_remove(rb, "X-Delete-At", "X-Remove-Delete-At", &b.delete_at)?;
    send(rb).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Loc {
    container: String,
    object: String,
}

#[derive(Deserialize)]
struct CopyBody {
    from: Loc,
    to: Loc,
    /// Delete the source afterwards (move / rename).
    #[serde(default)]
    r#move: bool,
}

async fn copy(ctx: RequestContext, Json(b): Json<CopyBody>) -> Result<StatusCode, ApiError> {
    check_container(&b.from.container)?;
    check_object(&b.from.object)?;
    if b.from.container == b.to.container && b.from.object == b.to.object {
        return Err(bad("source and destination are the same object"));
    }
    let dest = object_url(&ctx, &b.to.container, &b.to.object)?;
    let src = format!("/{}/{}", enc(&b.from.container), enc_object(&b.from.object));
    send(
        ctx.request(Method::PUT, &dest)
            .header("X-Copy-From", src)
            .header(header::CONTENT_LENGTH.as_str(), "0"),
    )
    .await?;
    if b.r#move {
        send(ctx.request(
            Method::DELETE,
            &object_url(&ctx, &b.from.container, &b.from.object)?,
        ))
        .await?;
    }
    tracing::info!(user = %ctx.token.user.name, from = %format!("{}/{}", b.from.container, b.from.object), to = %format!("{}/{}", b.to.container, b.to.object), moved = b.r#move, "object copied");
    Ok(StatusCode::CREATED)
}

#[derive(Deserialize)]
struct TempUrlBody {
    /// Validity in seconds (1 minute … 30 days).
    seconds: u64,
}

/// Signed link that works without a token until it expires. Uses the container's
/// Temp-URL key, else the account's; creates a container key when neither exists.
async fn temp_url(
    State(_st): State<AppState>,
    ctx: RequestContext,
    Path((c, o)): Path<(String, String)>,
    Json(b): Json<TempUrlBody>,
) -> ApiResult {
    if !(60..=30 * 86_400).contains(&b.seconds) {
        return Err(bad("validity must be between 1 minute and 30 days"));
    }
    let curl = container_url(&ctx, &c)?;
    let ourl = object_url(&ctx, &c, &o)?;
    let ch = send(ctx.request(Method::HEAD, &curl)).await?;
    let mut key = hdr(ch.headers(), "x-container-meta-temp-url-key");
    if key.is_none() {
        let ah = send(ctx.request(Method::HEAD, &account_url(&ctx, None)?)).await?;
        key = hdr(ah.headers(), "x-account-meta-temp-url-key");
    }
    let key = match key {
        Some(k) => k,
        None => {
            let k = hex(&rand::random::<[u8; 24]>());
            send(
                ctx.request(Method::POST, &curl)
                    .header("X-Container-Meta-Temp-URL-Key", &k),
            )
            .await?;
            k
        }
    };
    let expires = chrono::Utc::now().timestamp() as u64 + b.seconds;
    let parsed = url::Url::parse(&ourl).map_err(|e| bad(e.to_string()))?;
    let path = urlencoding_decode(parsed.path());
    let sig = hex(&hmac_sha256(
        key.as_bytes(),
        format!("GET\n{expires}\n{path}").as_bytes(),
    ));
    tracing::info!(user = %ctx.token.user.name, container = %c, object = %o, seconds = b.seconds, "temp URL issued");
    Ok(Json(json!({
        "url": format!("{ourl}?temp_url_sig={sig}&temp_url_expires={expires}"),
        "expires": expires,
    })))
}

/// Percent-decoding of a URL path (Swift signs the decoded path).
fn urlencoding_decode(p: &str) -> String {
    let b = p.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(&p[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------- admin

fn require_admin(ctx: &RequestContext) -> Result<(), ApiError> {
    if ctx.is_admin() {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "the admin role is required for this action",
        ))
    }
}

/// Another project's account usage and quota (Swift: needs ResellerAdmin).
async fn account_of(ctx: RequestContext, Path(project): Path<String>) -> ApiResult {
    require_admin(&ctx)?;
    let url = account_url(&ctx, Some(&project))?;
    match send(ctx.request(Method::HEAD, &url)).await {
        Ok(r) => Ok(Json(
            json!({ "project_id": project, "account": account_json(r.headers()) }),
        )),
        // A project that never used object storage may have no account yet.
        Err(e) if e.status == StatusCode::NOT_FOUND => {
            Ok(Json(json!({ "project_id": project, "account": null })))
        }
        Err(e) if e.status == StatusCode::FORBIDDEN || e.status == StatusCode::UNAUTHORIZED => {
            Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "Swift refused: reading other projects' accounts needs the ResellerAdmin role (operator role in Swift's keystoneauth reseller_admin_role)",
            ))
        }
        Err(e) => Err(e),
    }
}

#[derive(Deserialize)]
struct QuotaBody {
    #[serde(default, deserialize_with = "some")]
    quota_bytes: Option<Value>,
}

async fn set_account_quota(
    ctx: RequestContext,
    Path(project): Path<String>,
    Json(b): Json<QuotaBody>,
) -> Result<StatusCode, ApiError> {
    require_admin(&ctx)?;
    let url = account_url(&ctx, Some(&project))?;
    let rb = set_or_remove(
        ctx.request(Method::POST, &url),
        "X-Account-Meta-Quota-Bytes",
        "X-Remove-Account-Meta-Quota-Bytes",
        &b.quota_bytes,
    )?;
    match send(rb).await {
        Ok(_) => {}
        Err(e) if e.status == StatusCode::FORBIDDEN || e.status == StatusCode::UNAUTHORIZED => {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "Swift refused: setting account quotas needs the ResellerAdmin role",
            ));
        }
        Err(e) => return Err(e),
    }
    tracing::info!(user = %ctx.token.user.name, %project, quota = ?b.quota_bytes, "object-store account quota set");
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_rfc4231_case2() {
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn urls() {
        assert_eq!(
            info_url("http://h:8080/v1/AUTH_x").as_deref(),
            Some("http://h:8080/info")
        );
        assert_eq!(
            info_url("http://rgw/swift/v1/AUTH_x").as_deref(),
            Some("http://rgw/swift/info")
        );
        assert_eq!(
            info_url("http://rgw/swift/v1").as_deref(),
            Some("http://rgw/swift/info")
        );
        assert_eq!(enc_object("a b/c+d/"), "a%20b/c%2Bd/");
        assert_eq!(urlencoding_decode("/v1/AUTH_x/c/a%20b"), "/v1/AUTH_x/c/a b");
        assert!(check_container("a/b").is_err());
        assert!(check_object("a/../../AUTH_other/c/o").is_err());
        assert!(check_object("./x").is_err());
        assert!(check_object("a/..b/.c").is_ok());
    }
}
