//! Barbican secret payloads: `/api/key-manager/secrets/{id}/payload`.
//!
//! Everything else in Barbican is JSON and goes through the gateway (`/api/os/key-manager/…`);
//! payloads are raw bytes with their own content type, so they are fetched and stored here
//! and handed to the browser as JSON (`text` for text/plain, otherwise base64).

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::get,
};
use base64::Engine;
use rassvet_ext_api::{ApiError, RequestContext};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::gateway::Svc;
use crate::state::AppState;

/// Barbican's default `max_allowed_secret_in_bytes` is 10 kB; leave room for larger setups.
const MAX_PAYLOAD: usize = 1 << 20;

pub fn router() -> Router<AppState> {
    Router::new().route("/secrets/{id}/payload", get(payload).put(store))
}

fn secret_url(ctx: &RequestContext, id: &str) -> Result<String, ApiError> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid secret id"));
    }
    let ep = ctx.endpoint("key-manager")?;
    let e = ep.trim_end_matches('/');
    let base = if e.ends_with("/v1") {
        e.to_owned()
    } else {
        format!("{e}/v1")
    };
    Ok(format!("{base}/secrets/{id}"))
}

/// `GET …/payload` → `{content_type, encoding: "text"|"base64", payload}`.
async fn payload(
    State(_st): State<AppState>,
    ctx: RequestContext,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let url = secret_url(&ctx, &id)?;
    let meta: Value = rassvet_os_client::trace::send(
        Svc::KeyManager.name(),
        ctx.request(Method::GET, &url)
            .header("Accept", "application/json"),
    )
    .await?
    .json()
    .await
    .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, e.to_string()))?;
    let ct = meta["content_types"]["default"]
        .as_str()
        .unwrap_or("application/octet-stream")
        .to_owned();
    if meta["content_types"].is_null() {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "this secret has no payload yet",
        ));
    }
    let resp = rassvet_os_client::trace::send(
        Svc::KeyManager.name(),
        ctx.request(Method::GET, &format!("{url}/payload"))
            .header("Accept", &ct),
    )
    .await?;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, e.to_string()))?;
    tracing::info!(user = %ctx.token.user.name, secret = %id, "secret payload read");
    let text = ct
        .starts_with("text/")
        .then(|| String::from_utf8(bytes.to_vec()).ok())
        .flatten();
    Ok(Json(match text {
        Some(t) => json!({ "content_type": ct, "encoding": "text", "payload": t }),
        None => json!({
            "content_type": ct,
            "encoding": "base64",
            "payload": base64::engine::general_purpose::STANDARD.encode(&bytes),
        }),
    }))
}

#[derive(Deserialize)]
struct StorePayload {
    payload: String,
    /// "text" (stored as text/plain) or "base64" (decoded, stored as octet-stream).
    encoding: String,
}

/// `PUT …/payload` — fill a secret that was created without one (e.g. its metadata first).
async fn store(
    State(_st): State<AppState>,
    ctx: RequestContext,
    Path(id): Path<String>,
    Json(b): Json<StorePayload>,
) -> Result<StatusCode, ApiError> {
    let url = secret_url(&ctx, &id)?;
    let (ct, body) = match b.encoding.as_str() {
        "text" => ("text/plain", b.payload.into_bytes()),
        "base64" => (
            "application/octet-stream",
            base64::engine::general_purpose::STANDARD
                .decode(b.payload.trim())
                .map_err(|e| {
                    ApiError::new(StatusCode::BAD_REQUEST, format!("invalid base64: {e}"))
                })?,
        ),
        _ => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "encoding must be text or base64",
            ));
        }
    };
    if body.len() > MAX_PAYLOAD {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload too large",
        ));
    }
    rassvet_os_client::trace::send(
        Svc::KeyManager.name(),
        ctx.request(Method::PUT, &url)
            .header("Content-Type", ct)
            .body(body),
    )
    .await?;
    tracing::info!(user = %ctx.token.user.name, secret = %id, "secret payload stored");
    Ok(StatusCode::NO_CONTENT)
}
