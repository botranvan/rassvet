//! Core JSON API: clouds, login/logout, session, cloud/project/region switching, navigation.
//!
//! A session can be signed in to several clouds at once (`POST /session/clouds` adds one);
//! each request names its cloud, so switching clouds needs no new sign-in.

use std::{collections::BTreeMap, sync::Arc};

use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
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
    session::{COOKIE, CloudLogin, Session},
    state::AppState,
};

/// Header the UI sends on every mutating request (CSRF defence in depth on top of
/// the SameSite=Strict cookie).
pub const CSRF_HEADER: &str = "x-rassvet-csrf";

/// Header naming the cloud of a request: each browser tab works on one of the session's clouds.
pub const CLOUD_HEADER: &str = "x-rassvet-cloud";
/// Query parameter doing the same for plain links (downloads), which can't send headers.
const CLOUD_PARAM: &str = "rassvet_cloud";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/clouds", get(clouds))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/session", get(session))
        .route("/session/clouds", post(add_cloud))
        .route("/session/clouds/{cloud}", delete(sign_out_cloud))
        .route("/session/cloud", post(switch_cloud))
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

/// Whether a state-changing request may come from where the browser says it comes from.
/// `Sec-Fetch-Site` is set by every current browser and can't be forged by page script;
/// only the UI's own origin (or no browser context, e.g. curl) is accepted.
fn cross_site(req: &Request) -> bool {
    req.headers()
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| !matches!(v, "same-origin" | "none"))
}

/// Middleware for `/api/*`: CSRF checks + inject [`RequestContext`] for live sessions.
/// API responses are never cached (they carry secrets: keys, credentials, payloads).
pub async fn session_layer(
    State(st): State<AppState>,
    jar: CookieJar,
    req: Request,
    next: Next,
) -> Response {
    let mut res = session_layer_inner(st, jar, req, next).await;
    res.headers_mut()
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    res
}

async fn session_layer_inner(
    st: AppState,
    jar: CookieJar,
    mut req: Request,
    next: Next,
) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        if req.headers().get(CSRF_HEADER).is_none() {
            return ApiError::new(StatusCode::FORBIDDEN, "missing CSRF header").into_response();
        }
        if cross_site(&req) {
            return ApiError::new(StatusCode::FORBIDDEN, "cross-site request refused")
                .into_response();
        }
    }
    let requested = requested_cloud(&mut req);
    if let Some(sid) = jar.get(COOKIE).map(|c| c.value().to_owned())
        && let Some(s) = st.sessions.get(&sid).await
    {
        // A request for a cloud this session isn't signed in to gets no context (401),
        // never another cloud's: the tab's cached ids and names belong to that cloud.
        let cloud_id = requested.unwrap_or_else(|| s.active.clone());
        if let Some(login) = s.logins.get(&cloud_id)
            && let Some(cloud) = st.by_id.get(&cloud_id)
        {
            req.extensions_mut().insert(RequestContext {
                cloud_id: cloud.cfg.id.clone(),
                auth_url: cloud.cfg.auth_url.clone(),
                http: cloud.http.clone(),
                token: login.token.clone(),
                region: login.region.clone(),
                interface: cloud.cfg.interface,
            });
        }
        req.extensions_mut().insert(SessionId(sid));
        req.extensions_mut().insert(SelectedCloud(cloud_id));
    }
    next.run(req).await
}

/// The cloud a request is for: the `X-Rassvet-Cloud` header the UI sends from each tab, or
/// `?rassvet_cloud=` on plain links (downloads), which is removed before routing.
fn requested_cloud(req: &mut Request) -> Option<String> {
    if let Some(v) = req.headers().get(CLOUD_HEADER) {
        return v.to_str().ok().map(str::to_owned);
    }
    let query = req.uri().query()?;
    let mut found = None;
    let rest: Vec<&str> = query
        .split('&')
        .filter(|kv| {
            match kv
                .strip_prefix(CLOUD_PARAM)
                .and_then(|v| v.strip_prefix('='))
            {
                Some(v) => {
                    found = Some(v.to_owned());
                    false
                }
                None => true,
            }
        })
        .collect();
    let found = found?;
    let path = req.uri().path();
    let pq = match rest.is_empty() {
        true => path.to_owned(),
        false => format!("{path}?{}", rest.join("&")),
    };
    let mut parts = req.uri().clone().into_parts();
    parts.path_and_query = pq.parse().ok();
    if let Ok(uri) = axum::http::Uri::from_parts(parts) {
        *req.uri_mut() = uri;
    }
    Some(found)
}

#[derive(Clone)]
pub struct SessionId(pub String);

/// The cloud the request is for (see [`requested_cloud`]), whether or not the session is
/// signed in to it.
#[derive(Clone)]
pub struct SelectedCloud(pub String);

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
    /// Every cloud this session is signed in to (`cloud` is one of them).
    clouds: Vec<SignedInCloud>,
    prefs: BTreeMap<String, serde_json::Value>,
    /// Rassvet's own version, shown in the UI.
    version: &'static str,
}

#[derive(Serialize)]
struct SignedInCloud {
    id: String,
    name: String,
    user: ProjectRef,
    project: Option<ProjectRef>,
    expires_at: chrono::DateTime<Utc>,
}

fn cloud_name(st: &AppState, id: &str) -> String {
    st.by_id
        .get(id)
        .map_or_else(|| id.to_owned(), |c| c.cfg.name.clone())
}

/// The session as seen from `cloud_id`, which must be one of its clouds.
fn info(st: &AppState, s: &Session, cloud_id: &str) -> SessionInfo {
    let l = &s.logins[cloud_id];
    SessionInfo {
        cloud: IdName {
            id: cloud_id.to_owned(),
            name: cloud_name(st, cloud_id),
        },
        user: l.token.user.clone(),
        project: l.token.project.clone(),
        roles: l.token.roles.clone(),
        is_admin: l.token.has_role("admin"),
        expires_at: l.token.expires_at,
        region: l.region.clone(),
        regions: l.token.catalog.regions(),
        projects: l.projects.clone(),
        services: l.token.catalog.service_types(l.region.as_deref()),
        can_switch_project: l.unscoped.is_some(),
        clouds: s
            .logins
            .iter()
            .map(|(id, l)| SignedInCloud {
                id: id.clone(),
                name: cloud_name(st, id),
                user: l.token.user.clone(),
                project: l.token.project.clone(),
                expires_at: l.token.expires_at,
            })
            .collect(),
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

/// Best effort: revoke a cloud's tokens so they can't be reused.
async fn revoke(st: &AppState, cloud_id: &str, l: &CloudLogin) {
    if let Some(c) = st.by_id.get(cloud_id) {
        let _ = c.keystone.revoke(&l.token.value).await;
        if let Some(u) = &l.unscoped {
            let _ = c.keystone.revoke(u).await;
        }
    }
}

/// `POST /api/auth/login`: a new session signed in to one cloud. Signing in again from the
/// same browser ends the previous session (and its tokens) instead of leaving it alive
/// under a cookie the browser no longer sends.
async fn login(
    State(st): State<AppState>,
    jar: CookieJar,
    Json(req): Json<LoginRequest>,
) -> Response {
    let (cloud_id, login) = match sign_in(&st, req).await {
        Ok(ok) => ok,
        Err(res) => return *res,
    };
    if let Some(old) = jar.get(COOKIE).map(|c| c.value().to_owned())
        && let Some(prev) = st.sessions.remove(&old).await
    {
        for (id, l) in &prev.logins {
            revoke(&st, id, l).await;
        }
    }
    let s = Session::new(cloud_id.clone(), login);
    let body = info(&st, &s, &cloud_id);
    let id = st.sessions.create(s).await;
    (jar.add(session_cookie(&st, id)), Json(body)).into_response()
}

/// `POST /api/session/clouds` (same body as login): sign this session in to one more cloud,
/// or again to one it has (e.g. as another user), which becomes the active cloud.
async fn add_cloud(
    State(st): State<AppState>,
    sid_ext: Option<axum::Extension<SessionId>>,
    Json(req): Json<LoginRequest>,
) -> Response {
    let id = match sid(sid_ext) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let (cloud_id, login) = match sign_in(&st, req).await {
        Ok(ok) => ok,
        Err(res) => return *res,
    };
    let mut replaced = None;
    let updated = st
        .sessions
        .update(&id, |s| {
            replaced = s.logins.insert(cloud_id.clone(), login.clone());
            s.active = cloud_id.clone();
        })
        .await;
    let Some(s) = updated else {
        // The session ended meanwhile: don't leave the new tokens behind.
        revoke(&st, &cloud_id, &login).await;
        return ApiError::new(StatusCode::UNAUTHORIZED, "session expired").into_response();
    };
    if let Some(old) = &replaced {
        revoke(&st, &cloud_id, old).await;
    }
    Json(info(&st, &s, &cloud_id)).into_response()
}

/// Authenticate to one cloud, with per-account throttling of failed attempts.
async fn sign_in(st: &AppState, req: LoginRequest) -> Result<(String, CloudLogin), Box<Response>> {
    let key = match &req {
        LoginRequest::Password {
            cloud,
            domain,
            username,
            ..
        } => {
            let default = st
                .by_id
                .get(cloud)
                .map(|c| c.cfg.default_domain.as_str())
                .unwrap_or("");
            let domain = domain.as_deref().filter(|d| !d.trim().is_empty());
            crate::throttle::password_key(cloud, domain.unwrap_or(default), username)
        }
        LoginRequest::ApplicationCredential { cloud, id, .. } => {
            crate::throttle::app_cred_key(cloud, id)
        }
    };
    if let Some(wait) = st.login_throttle.retry_after(&key) {
        let mut res = ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too many failed sign-ins for this account; try again later",
        )
        .into_response();
        res.headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from(wait));
        return Err(Box::new(res));
    }
    match authenticate(st, req).await {
        Ok(ok) => {
            st.login_throttle.success(&key);
            tracing::info!(cloud = %ok.0, user = %ok.1.token.user.name, "login");
            Ok(ok)
        }
        Err(e) => {
            if e.status == StatusCode::UNAUTHORIZED {
                st.login_throttle.failure(&key);
                tracing::info!(account = %key, "sign-in failed");
            }
            Err(Box::new(e.into_response()))
        }
    }
}

async fn authenticate(st: &AppState, req: LoginRequest) -> Result<(String, CloudLogin), ApiError> {
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

    Ok((
        cloud.cfg.id.clone(),
        CloudLogin {
            unscoped,
            region: pick_region(cloud.cfg.default_region.as_deref(), &token.catalog),
            token: Arc::new(token),
            projects,
        },
    ))
}

/// `POST /api/auth/logout`: end the session and every cloud's tokens.
async fn logout(
    State(st): State<AppState>,
    jar: CookieJar,
    sid_ext: Option<axum::Extension<SessionId>>,
) -> (CookieJar, StatusCode) {
    if let Some(axum::Extension(SessionId(id))) = sid_ext
        && let Some(s) = st.sessions.remove(&id).await
    {
        for (cloud_id, l) in &s.logins {
            revoke(&st, cloud_id, l).await;
        }
    }
    (
        jar.remove(Cookie::build(COOKIE).path("/")),
        StatusCode::NO_CONTENT,
    )
}

/// Sign the session out of one cloud, revoking its tokens unless Keystone already did (e.g.
/// after a password change). The session ends with its last cloud: then None.
pub async fn drop_cloud(
    st: &AppState,
    sid: &str,
    cloud_id: &str,
    revoke_tokens: bool,
) -> Option<Session> {
    let mut gone = None;
    let s = st
        .sessions
        .update(sid, |s| gone = s.sign_out(cloud_id))
        .await;
    if revoke_tokens && let Some(l) = &gone {
        revoke(st, cloud_id, l).await;
    }
    match s {
        Some(s) if !s.logins.is_empty() => Some(s),
        Some(_) => {
            st.sessions.remove(sid).await;
            None
        }
        None => None,
    }
}

/// `DELETE /api/session/clouds/{cloud}`: sign out of one cloud. Answers the session as seen
/// from its active cloud, or 204 and no cookie when that was the last one.
async fn sign_out_cloud(
    State(st): State<AppState>,
    jar: CookieJar,
    sid_ext: Option<axum::Extension<SessionId>>,
    Path(cloud): Path<String>,
) -> Result<Response, ApiError> {
    let id = sid(sid_ext)?;
    tracing::info!(cloud = %cloud, "signed out of one cloud");
    Ok(match drop_cloud(&st, &id, &cloud, true).await {
        Some(s) => Json(info(&st, &s, &s.active)).into_response(),
        None => (
            jar.remove(Cookie::build(COOKIE).path("/")),
            StatusCode::NO_CONTENT,
        )
            .into_response(),
    })
}

/// `GET /api/session`: the session as seen from the request's cloud, or from the active
/// cloud when the request's cloud was signed out (the UI then moves the tab there).
async fn session(
    State(st): State<AppState>,
    sid_ext: Option<axum::Extension<SessionId>>,
    selected: Option<axum::Extension<SelectedCloud>>,
) -> Result<Json<SessionInfo>, ApiError> {
    let id = sid(sid_ext)?;
    let s = st
        .sessions
        .get(&id)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    let cloud = selected
        .map(|e| e.0.0)
        .filter(|c| s.logins.contains_key(c))
        .unwrap_or_else(|| s.active.clone());
    Ok(Json(info(&st, &s, &cloud)))
}

#[derive(Deserialize)]
struct SwitchCloud {
    cloud: String,
}

/// `POST /api/session/cloud`: make one of the session's clouds the active one (the default
/// for new tabs) and answer the session as seen from it. No sign-in involved.
async fn switch_cloud(
    State(st): State<AppState>,
    sid_ext: Option<axum::Extension<SessionId>>,
    Json(req): Json<SwitchCloud>,
) -> Result<Json<SessionInfo>, ApiError> {
    let id = sid(sid_ext)?;
    let s = st
        .sessions
        .get(&id)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    if !s.logins.contains_key(&req.cloud) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "not signed in to that cloud",
        ));
    }
    let s = st
        .sessions
        .update(&id, |s| s.active = req.cloud.clone())
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    Ok(Json(info(&st, &s, &req.cloud)))
}

/// Session id and the request's cloud, which the session must be signed in to.
fn session_cloud(
    sid_ext: Option<axum::Extension<SessionId>>,
    ctx: Option<axum::Extension<RequestContext>>,
) -> Result<(String, String), ApiError> {
    let id = sid(sid_ext)?;
    let ctx = ctx.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    Ok((id, ctx.0.cloud_id))
}

#[derive(Deserialize)]
struct SwitchProject {
    project_id: String,
}

async fn switch_project(
    State(st): State<AppState>,
    sid_ext: Option<axum::Extension<SessionId>>,
    ctx: Option<axum::Extension<RequestContext>>,
    Json(req): Json<SwitchProject>,
) -> Result<Json<SessionInfo>, ApiError> {
    let (id, cloud_id) = session_cloud(sid_ext, ctx)?;
    let s = st
        .sessions
        .get(&id)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    let l = s
        .logins
        .get(&cloud_id)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let unscoped = l.unscoped.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "application credential sessions are bound to one project",
        )
    })?;
    if !l.projects.iter().any(|p| p.id == req.project_id) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "no access to that project",
        ));
    }
    let cloud = &st.by_id[&cloud_id];
    let token = cloud
        .keystone
        .authenticate(
            &AuthMethod::Token(unscoped),
            &Scope::ProjectId(req.project_id),
        )
        .await?;
    let old = l.token.value.clone();
    let regions = token.catalog.regions();
    let s = st
        .sessions
        .update(&id, |s| {
            if let Some(l) = s.logins.get_mut(&cloud_id) {
                if !l.region.as_ref().is_some_and(|r| regions.contains(r)) {
                    l.region = pick_region(cloud.cfg.default_region.as_deref(), &token.catalog);
                }
                l.token = Arc::new(token);
            }
        })
        .await
        .filter(|s| s.logins.contains_key(&cloud_id))
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    let _ = cloud.keystone.revoke(&old).await;
    Ok(Json(info(&st, &s, &cloud_id)))
}

#[derive(Deserialize)]
struct SwitchRegion {
    region: String,
}

async fn switch_region(
    State(st): State<AppState>,
    sid_ext: Option<axum::Extension<SessionId>>,
    ctx: Option<axum::Extension<RequestContext>>,
    Json(req): Json<SwitchRegion>,
) -> Result<Json<SessionInfo>, ApiError> {
    let (id, cloud_id) = session_cloud(sid_ext, ctx)?;
    let s = st
        .sessions
        .get(&id)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    let l = s
        .logins
        .get(&cloud_id)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    if !l.token.catalog.regions().contains(&req.region) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "unknown region"));
    }
    let s = st
        .sessions
        .update(&id, |s| {
            if let Some(l) = s.logins.get_mut(&cloud_id) {
                l.region = Some(req.region);
            }
        })
        .await
        .filter(|s| s.logins.contains_key(&cloud_id))
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    Ok(Json(info(&st, &s, &cloud_id)))
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
        "{}|{}|{}|{}|{}|{service_type}|{path}",
        ctx.cloud_id,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn req(uri: &str, header: Option<&str>) -> Request {
        let mut b = Request::builder().uri(uri);
        if let Some(h) = header {
            b = b.header(CLOUD_HEADER, h);
        }
        b.body(axum::body::Body::empty()).unwrap()
    }

    #[test]
    fn cloud_comes_from_the_header_or_a_link_parameter() {
        let mut r = req("/image/images/x/file?a=1", Some("stg2"));
        assert_eq!(requested_cloud(&mut r).as_deref(), Some("stg2"));
        assert_eq!(r.uri(), "/image/images/x/file?a=1");

        // Downloads: the parameter is taken out before the request reaches the handler.
        let mut r = req(
            "/object-store/containers/c/objects/o?rassvet_cloud=stg1&x=2",
            None,
        );
        assert_eq!(requested_cloud(&mut r).as_deref(), Some("stg1"));
        assert_eq!(r.uri(), "/object-store/containers/c/objects/o?x=2");
        let mut r = req("/image/images/x/file?rassvet_cloud=stg1", None);
        assert_eq!(requested_cloud(&mut r).as_deref(), Some("stg1"));
        assert_eq!(r.uri(), "/image/images/x/file");

        let mut r = req("/nav?rassvet_cloudy=1", None);
        assert_eq!(requested_cloud(&mut r), None);
        assert_eq!(r.uri(), "/nav?rassvet_cloudy=1");
    }
}
