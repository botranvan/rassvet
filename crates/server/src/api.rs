//! Core JSON API: clouds, login/logout, session, project/region switching, navigation.

use std::{collections::BTreeMap, sync::Arc};

use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use axum_extra::extract::{
    CookieJar,
    cookie::{Cookie, SameSite},
};
use chrono::Utc;
use rassvet_ext_api::{ApiError, Manifest, NavItem, RequestContext};
use rassvet_os_client::{AuthMethod, IdName, ProjectRef, Scope};
use serde::{Deserialize, Serialize};

use crate::{
    nav,
    session::{COOKIE, Session},
    state::AppState,
};

/// Header the UI sends on every mutating request (CSRF defence in depth on top of
/// the SameSite=Strict cookie).
pub const CSRF_HEADER: &str = "x-rassvet-csrf";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/clouds", get(clouds))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/session", get(session))
        .route("/session/project", post(switch_project))
        .route("/session/region", post(switch_region))
        .route("/session/prefs/{key}", put(put_pref))
        .route("/nav", get(nav_items))
        .nest("/identity", crate::identity::router())
        .nest("/image", crate::image::router())
        .nest("/key-manager", crate::barbican::router())
        .nest("/object-store", crate::swift::router())
        .route(
            "/os/{service}/{*path}",
            axum::routing::any(crate::gateway::handle),
        )
        .route("/compute/launch", post(crate::compute::launch))
        .route("/compute/keypairs", post(crate::keypair::create))
        .route(
            "/compute/servers/{id}",
            axum::routing::delete(crate::compute::delete_server),
        )
        .route("/placement/capacity", get(crate::compute::capacity))
}

/// Middleware for `/api/*`: CSRF header check + inject [`RequestContext`] for live sessions.
pub async fn session_layer(
    State(st): State<AppState>,
    jar: CookieJar,
    mut req: Request,
    next: Next,
) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS)
        && req.headers().get(CSRF_HEADER).is_none()
    {
        return ApiError::new(StatusCode::FORBIDDEN, "missing CSRF header").into_response();
    }
    if let Some(sid) = jar.get(COOKIE).map(|c| c.value().to_owned())
        && let Some(s) = st.sessions.get(&sid).await
        && let Some(cloud) = st.by_id.get(&s.cloud_id)
    {
        req.extensions_mut().insert(RequestContext {
            cloud_id: cloud.cfg.id.clone(),
            auth_url: cloud.cfg.auth_url.clone(),
            http: cloud.http.clone(),
            token: s.token.clone(),
            region: s.region.clone(),
            interface: cloud.cfg.interface,
        });
        req.extensions_mut().insert(SessionId(sid));
    }
    next.run(req).await
}

#[derive(Clone)]
pub struct SessionId(pub String);

fn sid(req_sid: Option<axum::Extension<SessionId>>) -> Result<String, ApiError> {
    req_sid
        .map(|e| e.0.0)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))
}

// ---------------------------------------------------------------------------

/// Rassvet's version: `RASSVET_VERSION` at build time (e.g. a release tag), else the crate version.
pub const VERSION: &str = match option_env!("RASSVET_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

#[derive(Serialize)]
struct CloudInfo<'a> {
    id: &'a str,
    name: &'a str,
    default_domain: &'a str,
}

async fn clouds(State(st): State<AppState>) -> Json<serde_json::Value> {
    let list: Vec<CloudInfo> = st
        .clouds
        .iter()
        .map(|c| CloudInfo {
            id: &c.cfg.id,
            name: &c.cfg.name,
            default_domain: &c.cfg.default_domain,
        })
        .collect();
    Json(serde_json::json!({ "clouds": list, "version": VERSION }))
}

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
enum LoginRequest {
    Password {
        cloud: String,
        domain: Option<String>,
        username: String,
        password: String,
        project_id: Option<String>,
    },
    ApplicationCredential {
        cloud: String,
        id: String,
        secret: String,
    },
}

#[derive(Serialize)]
pub struct SessionInfo {
    cloud: IdName,
    user: ProjectRef,
    project: Option<ProjectRef>,
    roles: Vec<IdName>,
    is_admin: bool,
    expires_at: chrono::DateTime<Utc>,
    region: Option<String>,
    regions: Vec<String>,
    projects: Vec<ProjectRef>,
    services: Vec<String>,
    can_switch_project: bool,
    prefs: BTreeMap<String, serde_json::Value>,
    /// Rassvet's own version, shown in the UI.
    version: &'static str,
}

fn info(st: &AppState, s: &Session) -> SessionInfo {
    let cloud = &st.by_id[&s.cloud_id].cfg;
    SessionInfo {
        cloud: IdName {
            id: cloud.id.clone(),
            name: cloud.name.clone(),
        },
        user: s.token.user.clone(),
        project: s.token.project.clone(),
        roles: s.token.roles.clone(),
        is_admin: s.token.has_role("admin"),
        expires_at: s.token.expires_at,
        region: s.region.clone(),
        regions: s.token.catalog.regions(),
        projects: s.projects.clone(),
        services: s.token.catalog.service_types(s.region.as_deref()),
        can_switch_project: s.unscoped.is_some(),
        prefs: s.prefs.clone(),
        version: VERSION,
    }
}

fn session_cookie(st: &AppState, value: String) -> Cookie<'static> {
    Cookie::build((COOKIE, value))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Strict)
        .secure(st.config.server.secure_cookies)
        .build()
}

/// Configured default region if the catalog has it, else the region with most services.
fn pick_region(
    cloud_default: Option<&str>,
    catalog: &rassvet_os_client::Catalog,
) -> Option<String> {
    match cloud_default {
        Some(r) if catalog.regions().iter().any(|x| x == r) => Some(r.to_owned()),
        _ => catalog.primary_region(),
    }
}

async fn login(
    State(st): State<AppState>,
    jar: CookieJar,
    Json(req): Json<LoginRequest>,
) -> Result<(CookieJar, Json<SessionInfo>), ApiError> {
    let cloud_id = match &req {
        LoginRequest::Password { cloud, .. }
        | LoginRequest::ApplicationCredential { cloud, .. } => cloud,
    };
    let cloud = st
        .by_id
        .get(cloud_id)
        .cloned()
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "unknown cloud"))?;
    let ks = &cloud.keystone;

    let (unscoped, token, projects) = match req {
        LoginRequest::Password {
            domain,
            username,
            password,
            project_id,
            ..
        } => {
            let method = AuthMethod::Password {
                username,
                password,
                user_domain: domain
                    .filter(|d| !d.trim().is_empty())
                    .unwrap_or_else(|| cloud.cfg.default_domain.clone()),
            };
            let unscoped = ks.authenticate(&method, &Scope::Unscoped).await?;
            let projects = ks.list_auth_projects(&unscoped.value).await?;
            let target = project_id
                .filter(|id| projects.iter().any(|p| &p.id == id))
                .or_else(|| projects.first().map(|p| p.id.clone()));
            let token = match target {
                Some(pid) => {
                    ks.authenticate(
                        &AuthMethod::Token(unscoped.value.clone()),
                        &Scope::ProjectId(pid),
                    )
                    .await?
                }
                None => unscoped.clone(),
            };
            (Some(unscoped.value), token, projects)
        }
        LoginRequest::ApplicationCredential { id, secret, .. } => {
            let token = ks
                .authenticate(
                    &AuthMethod::ApplicationCredential { id, secret },
                    &Scope::Unscoped,
                )
                .await?;
            let projects = token.project.clone().into_iter().collect();
            (None, token, projects)
        }
    };

    let s = Session {
        cloud_id: cloud.cfg.id.clone(),
        unscoped,
        region: pick_region(cloud.cfg.default_region.as_deref(), &token.catalog),
        token: Arc::new(token),
        projects,
        last_seen: Utc::now(),
        created_at: Utc::now(),
        prefs: Default::default(),
    };
    tracing::info!(cloud = %s.cloud_id, user = %s.token.user.name, "login");
    let body = info(&st, &s);
    let id = st.sessions.create(s).await;
    Ok((jar.add(session_cookie(&st, id)), Json(body)))
}

async fn logout(
    State(st): State<AppState>,
    jar: CookieJar,
    sid_ext: Option<axum::Extension<SessionId>>,
) -> (CookieJar, StatusCode) {
    if let Some(axum::Extension(SessionId(id))) = sid_ext
        && let Some(s) = st.sessions.remove(&id).await
        && let Some(cloud) = st.by_id.get(&s.cloud_id)
    {
        // Best effort: revoke both tokens so they can't be reused.
        let _ = cloud.keystone.revoke(&s.token.value).await;
        if let Some(u) = &s.unscoped {
            let _ = cloud.keystone.revoke(u).await;
        }
    }
    (
        jar.remove(Cookie::build(COOKIE).path("/")),
        StatusCode::NO_CONTENT,
    )
}

async fn session(
    State(st): State<AppState>,
    sid_ext: Option<axum::Extension<SessionId>>,
) -> Result<Json<SessionInfo>, ApiError> {
    let id = sid(sid_ext)?;
    let s = st
        .sessions
        .get(&id)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    Ok(Json(info(&st, &s)))
}

#[derive(Deserialize)]
struct SwitchProject {
    project_id: String,
}

async fn switch_project(
    State(st): State<AppState>,
    sid_ext: Option<axum::Extension<SessionId>>,
    Json(req): Json<SwitchProject>,
) -> Result<Json<SessionInfo>, ApiError> {
    let id = sid(sid_ext)?;
    let s = st
        .sessions
        .get(&id)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    let unscoped = s.unscoped.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "application credential sessions are bound to one project",
        )
    })?;
    if !s.projects.iter().any(|p| p.id == req.project_id) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "no access to that project",
        ));
    }
    let cloud = &st.by_id[&s.cloud_id];
    let token = cloud
        .keystone
        .authenticate(
            &AuthMethod::Token(unscoped),
            &Scope::ProjectId(req.project_id),
        )
        .await?;
    let old = s.token.value.clone();
    let regions = token.catalog.regions();
    let s = st
        .sessions
        .update(&id, |s| {
            if !s.region.as_ref().is_some_and(|r| regions.contains(r)) {
                s.region = pick_region(cloud.cfg.default_region.as_deref(), &token.catalog);
            }
            s.token = Arc::new(token);
        })
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    let _ = cloud.keystone.revoke(&old).await;
    Ok(Json(info(&st, &s)))
}

#[derive(Deserialize)]
struct SwitchRegion {
    region: String,
}

async fn switch_region(
    State(st): State<AppState>,
    sid_ext: Option<axum::Extension<SessionId>>,
    Json(req): Json<SwitchRegion>,
) -> Result<Json<SessionInfo>, ApiError> {
    let id = sid(sid_ext)?;
    let s = st
        .sessions
        .get(&id)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    if !s.token.catalog.regions().contains(&req.region) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "unknown region"));
    }
    let s = st
        .sessions
        .update(&id, |s| s.region = Some(req.region))
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    Ok(Json(info(&st, &s)))
}

/// Limits for UI preferences kept in the session (and so in memcached).
const PREF_KEY_MAX: usize = 120;
const PREF_VALUE_MAX: usize = 4096;
const PREFS_MAX: usize = 200;

/// `PUT /api/session/prefs/{key}` with any JSON value (null removes it). Used by the UI to
/// remember each table's last filter while the login lasts, across pages and instances.
async fn put_pref(
    State(st): State<AppState>,
    sid_ext: Option<axum::Extension<SessionId>>,
    Path(key): Path<String>,
    Json(value): Json<serde_json::Value>,
) -> Result<StatusCode, ApiError> {
    let id = sid(sid_ext)?;
    let ok_key = !key.is_empty()
        && key.len() <= PREF_KEY_MAX
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-:".contains(&b));
    if !ok_key {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid preference key",
        ));
    }
    if value.to_string().len() > PREF_VALUE_MAX {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "preference value too large",
        ));
    }
    st.sessions
        .update(&id, |s| {
            if value.is_null() {
                s.prefs.remove(&key);
            } else {
                if !s.prefs.contains_key(&key) && s.prefs.len() >= PREFS_MAX {
                    let first = s.prefs.keys().next().cloned();
                    if let Some(k) = first {
                        s.prefs.remove(&k);
                    }
                }
                s.prefs.insert(key, value);
            }
        })
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    Ok(StatusCode::NO_CONTENT)
}

/// How long a policy probe result is reused (per cloud, region, user, project and path).
const PROBE_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// Whether the token may call `GET <path>?limit=1` on the entry's service: hidden only on
/// 401/403 (policy) or 404 (API or extension not offered). Other failures keep the entry,
/// so a slow or broken service still shows its pages (with their own error).
async fn probe(st: &AppState, ctx: &RequestContext, service_type: &str, path: &str) -> bool {
    let svc = match service_type {
        "block-storage" => crate::gateway::Svc::Volume,
        other => match crate::gateway::Svc::parse(other) {
            Some(s) => s,
            None => return true,
        },
    };
    let key = format!(
        "{}|{}|{}|{}|{service_type}|{path}",
        ctx.token.catalog.regions().join(","),
        ctx.region.as_deref().unwrap_or(""),
        ctx.token.user.id,
        ctx.project_id().unwrap_or("")
    );
    if let Some((ok, at)) = st.probes.lock().unwrap().get(&key).copied()
        && at.elapsed() < PROBE_TTL
    {
        return ok;
    }
    let q = [("limit".to_owned(), "1".to_owned())];
    let ok = match crate::gateway::call(st, ctx, svc, reqwest::Method::GET, path, &q, None).await {
        Ok(_) => true,
        Err(e) => !matches!(e.status.as_u16(), 401 | 403 | 404),
    };
    if !ok {
        tracing::debug!(path, "nav entry hidden: not allowed by the cloud's policy");
    }
    st.probes
        .lock()
        .unwrap()
        .insert(key, (ok, std::time::Instant::now()));
    ok
}

#[derive(Serialize)]
struct NavResponse {
    items: Vec<NavItem>,
    extensions: Vec<Manifest>,
}

async fn nav_items(
    State(st): State<AppState>,
    ctx: RequestContext,
) -> Result<Json<NavResponse>, ApiError> {
    let catalog = &ctx.token.catalog;
    let region = ctx.region.as_deref();
    let allowed = |role: &Option<String>| role.as_deref().is_none_or(|r| ctx.token.has_role(r));

    let mut items: Vec<NavItem> = Vec::new();
    for c in nav::core()
        .into_iter()
        .filter(|c| catalog.has_service(c.service_type, region) && allowed(&c.item.role))
    {
        if let Some(path) = c.probe
            && !probe(&st, &ctx, c.service_type, path).await
        {
            continue;
        }
        items.push(c.item);
    }
    let mut extensions = Vec::new();
    for ext in st
        .extensions
        .iter()
        .filter(|e| e.is_available(catalog, region))
    {
        extensions.push(ext.manifest());
        items.extend(ext.nav().into_iter().filter(|i| allowed(&i.role)));
    }
    Ok(Json(NavResponse { items, extensions }))
}
