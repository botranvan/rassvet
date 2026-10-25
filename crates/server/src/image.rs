//! Glance feature: `/api/image/*`.
//!
//! Lists, creates, edits, shares, uploads, imports and downloads images with the
//! session's token. Upload and download are streamed, never buffered in memory.

use std::collections::BTreeMap;

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Query},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use rassvet_ext_api::{ApiError, RequestContext};
use rassvet_os_client::{
    Glance,
    identity::seg,
    image::{ImageUpdate, build_patch, check_property},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::state::AppState;

type ApiResult<T = Json<Value>> = Result<T, ApiError>;

/// Upper bound of images returned by one list call (following Glance's pages).
const LIST_CAP: usize = 2000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/info", get(info))
        .route("/metadefs", get(crate::metadefs::metadefs))
        .route("/images", get(list).post(create))
        .route("/images/{id}", get(show).patch(update).delete(remove))
        .route("/images/{id}/deactivate", post(deactivate))
        .route("/images/{id}/reactivate", post(reactivate))
        .route(
            "/images/{id}/file",
            put(upload).get(download).layer(DefaultBodyLimit::disable()),
        )
        .route("/images/{id}/import", post(import_url))
        .route("/images/{id}/members", get(members).post(add_member))
        .route(
            "/images/{id}/members/{member}",
            put(set_member_status).delete(remove_member),
        )
}

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

async fn info(ctx: RequestContext) -> ApiResult {
    let (methods, stores) = ctx.glance()?.info().await?;
    Ok(Json(json!({ "import_methods": methods, "stores": stores })))
}

#[derive(Deserialize)]
struct ListQuery {
    /// `project` (owned by the current project), `shared` (shared with it),
    /// `public`, `community`, or `all` (everything the token can see; for admins
    /// that is every image in the cloud).
    #[serde(default)]
    view: Option<String>,
    /// Admin filter by owner project.
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    status: Option<String>,
    /// List hidden images (`os_hidden=true`) instead of visible ones.
    #[serde(default)]
    hidden: bool,
    /// `snapshot` (instance snapshots, Nova sets `image_type=snapshot`) or `image`.
    #[serde(default)]
    image_type: Option<String>,
}

async fn list(ctx: RequestContext, Query(q): Query<ListQuery>) -> ApiResult {
    let g = ctx.glance()?;
    let project = ctx.project_id().unwrap_or_default().to_owned();
    let mut base: Vec<(&str, &str)> = Vec::new();
    if let Some(s) = q.status.as_deref().filter(|s| !s.is_empty()) {
        base.push(("status", s));
    }
    if q.hidden {
        base.push(("os_hidden", "true"));
    }
    match q.image_type.as_deref() {
        None | Some("") => {}
        Some(t @ ("snapshot" | "image")) => base.push(("image_type", t)),
        Some(other) => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("unknown image_type '{other}'"),
            ));
        }
    }

    let (images, truncated) = match q.view.as_deref().unwrap_or("all") {
        "project" => {
            base.push(("owner", &project));
            g.list_all(&base, LIST_CAP).await?
        }
        "public" | "community" => {
            let v = q.view.as_deref().unwrap_or_default();
            base.push(("visibility", v));
            g.list_all(&base, LIST_CAP).await?
        }
        // Glance has no member status on the image itself: ask once per status and annotate.
        "shared" => {
            let mut out = Vec::new();
            let mut cut = false;
            for status in ["pending", "accepted", "rejected"] {
                let mut qs = base.clone();
                qs.extend([("visibility", "shared"), ("member_status", status)]);
                let (imgs, c) = g.list_all(&qs, LIST_CAP).await?;
                cut |= c;
                out.extend(
                    imgs.into_iter()
                        .filter(|i| i["owner"].as_str() != Some(project.as_str()))
                        .map(|mut i| {
                            i["member_status"] = json!(status);
                            i
                        }),
                );
            }
            (out, cut)
        }
        "all" => {
            if let Some(o) = q.owner.as_deref().filter(|o| !o.is_empty()) {
                base.push(("owner", o));
            }
            g.list_all(&base, LIST_CAP).await?
        }
        other => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("unknown view '{other}'"),
            ));
        }
    };
    Ok(Json(json!({ "images": images, "truncated": truncated })))
}

async fn show(ctx: RequestContext, Path(id): Path<String>) -> ApiResult {
    Ok(Json(ctx.glance()?.get(&id).await?))
}

#[derive(Deserialize)]
struct CreateImage {
    name: String,
    disk_format: String,
    #[serde(default = "bare")]
    container_format: String,
    #[serde(default = "private")]
    visibility: String,
    #[serde(default)]
    min_disk: u64,
    #[serde(default)]
    min_ram: u64,
    #[serde(default)]
    protected: bool,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    properties: BTreeMap<String, String>,
}

fn bare() -> String {
    "bare".into()
}
fn private() -> String {
    "private".into()
}

async fn create(ctx: RequestContext, Json(req): Json<CreateImage>) -> ApiResult {
    if req.name.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "an image needs a name",
        ));
    }
    if req.visibility == "public" {
        require_admin(&ctx)?;
    }
    let mut body = json!({
        "name": req.name.trim(),
        "disk_format": req.disk_format,
        "container_format": req.container_format,
        "visibility": req.visibility,
        "min_disk": req.min_disk,
        "min_ram": req.min_ram,
        "protected": req.protected,
        "tags": req.tags,
    });
    for (k, v) in &req.properties {
        check_property(k)?;
        body[k] = json!(v);
    }
    let created = ctx.glance()?.create(&body).await?;
    tracing::info!(user = %ctx.token.user.name, image = %req.name, "image created");
    Ok(Json(created))
}

async fn update(
    ctx: RequestContext,
    Path(id): Path<String>,
    Json(upd): Json<ImageUpdate>,
) -> ApiResult {
    if upd.core.get("visibility").and_then(Value::as_str) == Some("public") {
        require_admin(&ctx)?;
    }
    let g = ctx.glance()?;
    let current = g.get(&id).await?;
    let ops = build_patch(&current, &upd)?;
    if ops.is_empty() {
        return Ok(Json(current));
    }
    Ok(Json(g.patch(&id, &ops).await?))
}

async fn remove(ctx: RequestContext, Path(id): Path<String>) -> ApiResult<StatusCode> {
    ctx.glance()?.delete(&id).await?;
    tracing::info!(user = %ctx.token.user.name, image = %id, "image deleted");
    Ok(StatusCode::NO_CONTENT)
}

async fn deactivate(ctx: RequestContext, Path(id): Path<String>) -> ApiResult<StatusCode> {
    ctx.glance()?.action(&id, "deactivate").await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn reactivate(ctx: RequestContext, Path(id): Path<String>) -> ApiResult<StatusCode> {
    ctx.glance()?.action(&id, "reactivate").await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct StoreQuery {
    /// Comma-separated store ids (multi-store clouds).
    #[serde(default)]
    stores: Option<String>,
}

fn store_list(q: &StoreQuery) -> Result<Vec<String>, ApiError> {
    q.stores
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|s| seg(s).map(str::to_owned).map_err(Into::into))
        .collect()
}

/// `PUT /api/image/images/{id}/file` — the browser streams the file here and we stream
/// it on to Glance (staging + glance-direct import when enabled, else direct upload).
async fn upload(
    ctx: RequestContext,
    Path(id): Path<String>,
    Query(q): Query<StoreQuery>,
    body: Body,
) -> ApiResult<StatusCode> {
    let g = ctx.glance()?;
    let stores = store_list(&q)?;
    let (methods, _) = g.info().await?;
    let glance_direct = methods.iter().any(|m| m == "glance-direct");
    let stream = reqwest::Body::wrap_stream(body.into_data_stream());
    g.upload(&id, stream, glance_direct, &stores).await?;
    tracing::info!(user = %ctx.token.user.name, image = %id, glance_direct, "image data uploaded");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ImportUrl {
    uri: String,
    #[serde(default)]
    stores: Vec<String>,
}

/// Ask Glance to fetch the image itself (`web-download` import).
async fn import_url(
    ctx: RequestContext,
    Path(id): Path<String>,
    Json(req): Json<ImportUrl>,
) -> ApiResult<StatusCode> {
    if !(req.uri.starts_with("http://") || req.uri.starts_with("https://")) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "the URL must start with http:// or https://",
        ));
    }
    for s in &req.stores {
        seg(s)?;
    }
    ctx.glance()?
        .import(
            &id,
            json!({"name": "web-download", "uri": req.uri}),
            &req.stores,
        )
        .await?;
    Ok(StatusCode::ACCEPTED)
}

/// Stream the image data to the browser as a file download.
async fn download(ctx: RequestContext, Path(id): Path<String>) -> ApiResult<Response> {
    let g = ctx.glance()?;
    let img = g.get(&id).await?;
    let resp = g.download(&id).await?;
    if resp.status() == reqwest::StatusCode::NO_CONTENT {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "this image has no data to download",
        ));
    }
    let name: String = img["name"]
        .as_str()
        .unwrap_or(&id)
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let ext = img["disk_format"].as_str().unwrap_or("img");
    let mut out = Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{name}.{ext}\""),
        );
    if let Some(len) = resp.headers().get(header::CONTENT_LENGTH) {
        out = out.header(header::CONTENT_LENGTH, len.clone());
    }
    Ok(out
        .body(Body::from_stream(resp.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

async fn members(ctx: RequestContext, Path(id): Path<String>) -> ApiResult {
    let g = ctx.glance()?;
    Ok(Json(g.0.get(&Glance::members_path(&id)?, &[]).await?))
}

#[derive(Deserialize)]
struct AddMember {
    member: String,
}

async fn add_member(
    ctx: RequestContext,
    Path(id): Path<String>,
    Json(req): Json<AddMember>,
) -> ApiResult {
    seg(&req.member)?;
    let g = ctx.glance()?;
    Ok(Json(
        g.0.post(
            &Glance::members_path(&id)?,
            &json!({ "member": req.member }),
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct MemberStatus {
    status: String,
}

/// Accept or reject an image shared with the current project.
async fn set_member_status(
    ctx: RequestContext,
    Path((id, member)): Path<(String, String)>,
    Json(req): Json<MemberStatus>,
) -> ApiResult {
    if !matches!(req.status.as_str(), "accepted" | "rejected" | "pending") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "status must be accepted, rejected or pending",
        ));
    }
    let g = ctx.glance()?;
    let path = format!("{}/{}", Glance::members_path(&id)?, seg(&member)?);
    Ok(Json(
        g.0.put(&path, &json!({ "status": req.status })).await?,
    ))
}

async fn remove_member(
    ctx: RequestContext,
    Path((id, member)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let g = ctx.glance()?;
    g.0.delete(&format!("{}/{}", Glance::members_path(&id)?, seg(&member)?))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
