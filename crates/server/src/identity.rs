//! Keystone feature: `/api/identity/*`.
//!
//! User routes act on the signed-in user (catalog, CLI credentials, password,
//! application credentials). `/api/identity/admin/*` requires the admin role and
//! manages domains, users, projects, roles, assignments and the service catalog.
//! Keystone's own policy is still enforced on every call with the user's token.

use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use axum_extra::extract::{CookieJar, cookie::Cookie};
use rassvet_ext_api::{ApiError, RequestContext};
use rassvet_os_client::{Interface, identity::seg, identity::v3_url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{api::SessionId, session::COOKIE, state::AppState};

type ApiResult<T = Json<Value>> = Result<T, ApiError>;

pub fn router() -> Router<AppState> {
    let admin = Router::new()
        .route("/domains", get(list_domains))
        .route("/users", get(list_users).post(create_user))
        .route(
            "/users/{id}",
            get(get_user).patch(update_user).delete(delete_user),
        )
        .route("/users/{id}/assignments", get(user_assignments))
        .route("/users/{id}/application-credentials", get(user_app_creds))
        .route(
            "/users/{id}/application-credentials/{cid}",
            axum::routing::delete(delete_user_app_cred),
        )
        .route("/projects", get(list_projects).post(create_project))
        .route(
            "/projects/{id}",
            get(get_project)
                .patch(update_project)
                .delete(delete_project),
        )
        .route("/projects/{id}/assignments", get(project_assignments))
        .route(
            "/projects/{pid}/users/{uid}/roles/{rid}",
            put(grant_role).delete(revoke_role),
        )
        .route("/roles", get(list_roles).post(create_role))
        .route(
            "/roles/{id}",
            axum::routing::patch(update_role).delete(delete_role),
        )
        .route("/catalog", get(admin_catalog))
        .layer(middleware::from_fn(require_admin));

    Router::new()
        .route("/me", get(me))
        .route("/catalog", get(my_catalog))
        .route("/cli", get(cli_info))
        .route("/password", axum::routing::post(change_password))
        .route(
            "/application-credentials",
            get(my_app_creds).post(create_app_cred),
        )
        .route(
            "/application-credentials/{id}",
            axum::routing::delete(delete_my_app_cred),
        )
        .route("/ec2-credentials", get(my_ec2_creds).post(create_ec2_cred))
        .route(
            "/ec2-credentials/{access}",
            axum::routing::delete(delete_ec2_cred),
        )
        .nest("/admin", admin)
}

async fn require_admin(req: Request, next: Next) -> Response {
    match req.extensions().get::<RequestContext>() {
        None => ApiError::new(StatusCode::UNAUTHORIZED, "not logged in").into_response(),
        Some(ctx) if !ctx.is_admin() => ApiError::new(
            StatusCode::FORBIDDEN,
            "the admin role is required for this page",
        )
        .into_response(),
        Some(_) => next.run(req).await,
    }
}

/// Serialize a typed request into Keystone's `{"<wrapper>": {...}}` envelope.
fn wrap<T: Serialize>(key: &str, body: &T) -> Value {
    json!({ key: body })
}

fn no_content() -> ApiResult<StatusCode> {
    Ok(StatusCode::NO_CONTENT)
}

// =========================================================================== user

/// The signed-in user's own Keystone record (Keystone lets every user read themselves),
/// for the profile page. Falls back to what the token says when the read is refused.
async fn me(ctx: RequestContext) -> ApiResult {
    let id = ctx.token.user.id.clone();
    match ctx
        .identity()
        .get(&format!("/users/{}", seg(&id)?), &[])
        .await
    {
        Ok(v) => Ok(Json(v)),
        Err(e) if matches!(e.status().map(|s| s.as_u16()), Some(403 | 404)) => Ok(Json(json!({
            "user": {
                "id": id,
                "name": ctx.token.user.name,
                "domain_id": ctx.token.user.domain.as_ref().map(|d| d.id.clone()),
            },
            "partial": true,
        }))),
        Err(e) => Err(e.into()),
    }
}

/// Full service catalog of the current token (all regions; the UI filters).
async fn my_catalog(ctx: RequestContext) -> ApiResult {
    Ok(Json(json!({ "catalog": ctx.token.catalog })))
}

#[derive(Serialize)]
struct CliInfo {
    cloud_id: String,
    cloud_name: String,
    auth_url: String,
    region: Option<String>,
    interface: &'static str,
    user_name: String,
    user_domain_name: Option<String>,
    project_id: Option<String>,
    project_name: Option<String>,
    project_domain_id: Option<String>,
    project_domain_name: Option<String>,
}

/// Everything the UI needs to render `openrc` and `clouds.yaml` for this session.
async fn cli_info(State(st): State<AppState>, ctx: RequestContext) -> ApiResult<Json<CliInfo>> {
    let cloud = st
        .by_id
        .get(&ctx.cloud_id)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    let t = &ctx.token;
    let auth_url = cloud
        .cfg
        .public_auth_url
        .clone()
        .or_else(|| {
            t.catalog
                .endpoint("identity", Interface::Public, ctx.region.as_deref())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| cloud.cfg.auth_url.clone());
    let project = t.project.as_ref();
    Ok(Json(CliInfo {
        cloud_id: cloud.cfg.id.clone(),
        cloud_name: cloud.cfg.name.clone(),
        auth_url: v3_url(&auth_url),
        region: ctx.region.clone(),
        interface: ctx.interface.as_str(),
        user_name: t.user.name.clone(),
        user_domain_name: t.user.domain.as_ref().map(|d| d.name.clone()),
        project_id: project.map(|p| p.id.clone()),
        project_name: project.map(|p| p.name.clone()),
        project_domain_id: project
            .and_then(|p| p.domain.as_ref())
            .map(|d| d.id.clone()),
        project_domain_name: project
            .and_then(|p| p.domain.as_ref())
            .map(|d| d.name.clone()),
    }))
}

#[derive(Deserialize)]
struct ChangePassword {
    original_password: String,
    password: String,
}

/// Change the signed-in user's password. Keystone revokes the user's tokens, so the
/// session ends here and the user signs in again with the new password.
async fn change_password(
    State(st): State<AppState>,
    ctx: RequestContext,
    jar: CookieJar,
    sid: Option<axum::Extension<SessionId>>,
    Json(req): Json<ChangePassword>,
) -> ApiResult<(CookieJar, StatusCode)> {
    if req.password.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "the new password is empty",
        ));
    }
    let uid = seg(&ctx.token.user.id)?;
    ctx.identity()
        .post(
            &format!("/users/{uid}/password"),
            &json!({"user": {
                "original_password": req.original_password,
                "password": req.password,
            }}),
        )
        .await?;
    if let Some(axum::Extension(SessionId(id))) = sid {
        st.sessions.remove(&id).await;
    }
    tracing::info!(user = %ctx.token.user.name, "password changed");
    Ok((
        jar.remove(Cookie::build(COOKIE).path("/")),
        StatusCode::NO_CONTENT,
    ))
}

async fn my_app_creds(ctx: RequestContext) -> ApiResult {
    let uid = seg(&ctx.token.user.id)?;
    Ok(Json(
        ctx.identity()
            .get(&format!("/users/{uid}/application_credentials"), &[])
            .await?,
    ))
}

#[derive(Deserialize, Serialize)]
struct CreateAppCred {
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    /// ISO 8601; omitted = never expires.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    /// Role names to delegate; omitted = all roles of the current project scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    roles: Option<Vec<String>>,
    #[serde(default)]
    unrestricted: bool,
}

/// Create an application credential for the current project. The response contains
/// the secret, which Keystone never returns again.
async fn create_app_cred(ctx: RequestContext, Json(req): Json<CreateAppCred>) -> ApiResult {
    let uid = seg(&ctx.token.user.id)?;
    let mut body = serde_json::to_value(&req).unwrap_or_default();
    if let Some(roles) = &req.roles {
        body["roles"] = roles.iter().map(|r| json!({ "name": r })).collect();
    }
    let created = ctx
        .identity()
        .post(
            &format!("/users/{uid}/application_credentials"),
            &json!({ "application_credential": body }),
        )
        .await?;
    tracing::info!(user = %ctx.token.user.name, name = %req.name, "application credential created");
    Ok(Json(created))
}

async fn delete_my_app_cred(ctx: RequestContext, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let uid = seg(&ctx.token.user.id)?;
    ctx.identity()
        .delete(&format!(
            "/users/{uid}/application_credentials/{}",
            seg(&id)?
        ))
        .await?;
    no_content()
}

// ---- EC2 credentials (S3 access keys for object storage)

/// The signed-in user's EC2 credentials (access + secret pairs, one per project at most
/// by convention). Swift's s3api and Ceph RGW check S3 requests against these.
async fn my_ec2_creds(ctx: RequestContext) -> ApiResult {
    let uid = seg(&ctx.token.user.id)?;
    Ok(Json(
        ctx.identity()
            .get(&format!("/users/{uid}/credentials/OS-EC2"), &[])
            .await?,
    ))
}

/// New access/secret pair for the current project.
async fn create_ec2_cred(ctx: RequestContext) -> ApiResult {
    let uid = seg(&ctx.token.user.id)?;
    let project = ctx.token.project.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "EC2 credentials belong to a project: switch to one first",
        )
    })?;
    let created = ctx
        .identity()
        .post(
            &format!("/users/{uid}/credentials/OS-EC2"),
            &json!({ "tenant_id": project.id }),
        )
        .await?;
    tracing::info!(user = %ctx.token.user.name, project = %project.name, "EC2 credential created");
    Ok(Json(created))
}

async fn delete_ec2_cred(ctx: RequestContext, Path(access): Path<String>) -> ApiResult<StatusCode> {
    let uid = seg(&ctx.token.user.id)?;
    ctx.identity()
        .delete(&format!(
            "/users/{uid}/credentials/OS-EC2/{}",
            seg(&access)?
        ))
        .await?;
    tracing::info!(user = %ctx.token.user.name, "EC2 credential deleted");
    no_content()
}

// =========================================================================== admin

#[derive(Deserialize)]
struct DomainFilter {
    domain_id: Option<String>,
    /// Name search done by Keystone (`name__icontains`), so big LDAP/SQL backends don't
    /// have to return every user or project to the browser.
    q: Option<String>,
}

fn domain_query(f: &DomainFilter) -> Vec<(&'static str, &str)> {
    let mut out = Vec::new();
    if let Some(d) = f.domain_id.as_deref().filter(|d| !d.is_empty()) {
        out.push(("domain_id", d));
    }
    if let Some(q) = f.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        out.push(("name__icontains", q));
    }
    out
}

async fn list_domains(ctx: RequestContext) -> ApiResult {
    Ok(Json(ctx.identity().get("/domains", &[]).await?))
}

// ---- users

async fn list_users(ctx: RequestContext, Query(f): Query<DomainFilter>) -> ApiResult {
    Ok(Json(ctx.identity().get("/users", &domain_query(&f)).await?))
}

#[derive(Deserialize, Serialize)]
struct CreateUser {
    name: String,
    domain_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_project_id: Option<String>,
    #[serde(default = "yes")]
    enabled: bool,
}

fn yes() -> bool {
    true
}

async fn create_user(ctx: RequestContext, Json(req): Json<CreateUser>) -> ApiResult {
    let created = ctx.identity().post("/users", &wrap("user", &req)).await?;
    tracing::info!(admin = %ctx.token.user.name, user = %req.name, "user created");
    Ok(Json(created))
}

async fn get_user(ctx: RequestContext, Path(id): Path<String>) -> ApiResult {
    Ok(Json(
        ctx.identity()
            .get(&format!("/users/{}", seg(&id)?), &[])
            .await?,
    ))
}

#[derive(Deserialize, Serialize)]
struct UpdateUser {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    /// Admin password reset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    /// `""` clears the default project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_project_id: Option<String>,
}

async fn update_user(
    ctx: RequestContext,
    Path(id): Path<String>,
    Json(req): Json<UpdateUser>,
) -> ApiResult {
    let mut body = serde_json::to_value(&req).unwrap_or_default();
    if req.default_project_id.as_deref() == Some("") {
        body["default_project_id"] = Value::Null;
    }
    let updated = ctx
        .identity()
        .patch(&format!("/users/{}", seg(&id)?), &json!({ "user": body }))
        .await?;
    if req.password.is_some() {
        tracing::info!(admin = %ctx.token.user.name, user = %id, "password reset by admin");
    }
    Ok(Json(updated))
}

async fn delete_user(ctx: RequestContext, Path(id): Path<String>) -> ApiResult<StatusCode> {
    if id == ctx.token.user.id {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "you can't delete the account you are signed in with",
        ));
    }
    ctx.identity()
        .delete(&format!("/users/{}", seg(&id)?))
        .await?;
    tracing::info!(admin = %ctx.token.user.name, user = %id, "user deleted");
    no_content()
}

async fn user_assignments(ctx: RequestContext, Path(id): Path<String>) -> ApiResult {
    Ok(Json(
        ctx.identity()
            .get(
                "/role_assignments",
                &[("user.id", seg(&id)?), ("include_names", "true")],
            )
            .await?,
    ))
}

async fn user_app_creds(ctx: RequestContext, Path(id): Path<String>) -> ApiResult {
    Ok(Json(
        ctx.identity()
            .get(
                &format!("/users/{}/application_credentials", seg(&id)?),
                &[],
            )
            .await?,
    ))
}

async fn delete_user_app_cred(
    ctx: RequestContext,
    Path((id, cid)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    ctx.identity()
        .delete(&format!(
            "/users/{}/application_credentials/{}",
            seg(&id)?,
            seg(&cid)?
        ))
        .await?;
    no_content()
}

// ---- projects

async fn list_projects(ctx: RequestContext, Query(f): Query<DomainFilter>) -> ApiResult {
    Ok(Json(
        ctx.identity().get("/projects", &domain_query(&f)).await?,
    ))
}

#[derive(Deserialize, Serialize)]
struct CreateProject {
    name: String,
    domain_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_id: Option<String>,
    #[serde(default = "yes")]
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
}

async fn create_project(ctx: RequestContext, Json(req): Json<CreateProject>) -> ApiResult {
    let created = ctx
        .identity()
        .post("/projects", &wrap("project", &req))
        .await?;
    tracing::info!(admin = %ctx.token.user.name, project = %req.name, "project created");
    Ok(Json(created))
}

async fn get_project(ctx: RequestContext, Path(id): Path<String>) -> ApiResult {
    Ok(Json(
        ctx.identity()
            .get(&format!("/projects/{}", seg(&id)?), &[])
            .await?,
    ))
}

#[derive(Deserialize, Serialize)]
struct UpdateProject {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    /// Replaces every tag of the project (Keystone tags: no "/" or ",", at most 255 chars).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
}

async fn update_project(
    ctx: RequestContext,
    Path(id): Path<String>,
    Json(req): Json<UpdateProject>,
) -> ApiResult {
    Ok(Json(
        ctx.identity()
            .patch(&format!("/projects/{}", seg(&id)?), &wrap("project", &req))
            .await?,
    ))
}

async fn delete_project(ctx: RequestContext, Path(id): Path<String>) -> ApiResult<StatusCode> {
    if ctx.token.project.as_ref().is_some_and(|p| p.id == id) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "switch to another project before deleting the one you are working in",
        ));
    }
    ctx.identity()
        .delete(&format!("/projects/{}", seg(&id)?))
        .await?;
    tracing::info!(admin = %ctx.token.user.name, project = %id, "project deleted");
    no_content()
}

async fn project_assignments(ctx: RequestContext, Path(id): Path<String>) -> ApiResult {
    Ok(Json(
        ctx.identity()
            .get(
                "/role_assignments",
                &[("scope.project.id", seg(&id)?), ("include_names", "true")],
            )
            .await?,
    ))
}

async fn grant_role(
    ctx: RequestContext,
    Path((pid, uid, rid)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    ctx.identity()
        .put(&format!(
            "/projects/{}/users/{}/roles/{}",
            seg(&pid)?,
            seg(&uid)?,
            seg(&rid)?
        ))
        .await?;
    tracing::info!(admin = %ctx.token.user.name, project = %pid, user = %uid, role = %rid, "role granted");
    no_content()
}

async fn revoke_role(
    ctx: RequestContext,
    Path((pid, uid, rid)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    ctx.identity()
        .delete(&format!(
            "/projects/{}/users/{}/roles/{}",
            seg(&pid)?,
            seg(&uid)?,
            seg(&rid)?
        ))
        .await?;
    tracing::info!(admin = %ctx.token.user.name, project = %pid, user = %uid, role = %rid, "role revoked");
    no_content()
}

// ---- roles

async fn list_roles(ctx: RequestContext) -> ApiResult {
    Ok(Json(ctx.identity().get("/roles", &[]).await?))
}

#[derive(Deserialize, Serialize)]
struct RoleBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

async fn create_role(ctx: RequestContext, Json(req): Json<RoleBody>) -> ApiResult {
    if req.name.as_deref().is_none_or(|n| n.trim().is_empty()) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "a role needs a name",
        ));
    }
    Ok(Json(
        ctx.identity().post("/roles", &wrap("role", &req)).await?,
    ))
}

async fn update_role(
    ctx: RequestContext,
    Path(id): Path<String>,
    Json(req): Json<RoleBody>,
) -> ApiResult {
    Ok(Json(
        ctx.identity()
            .patch(&format!("/roles/{}", seg(&id)?), &wrap("role", &req))
            .await?,
    ))
}

async fn delete_role(ctx: RequestContext, Path(id): Path<String>) -> ApiResult<StatusCode> {
    ctx.identity()
        .delete(&format!("/roles/{}", seg(&id)?))
        .await?;
    tracing::info!(admin = %ctx.token.user.name, role = %id, "role deleted");
    no_content()
}

// ---- service catalog

/// Services, endpoints and regions as registered in Keystone (all of them,
/// including disabled ones and every interface).
async fn admin_catalog(ctx: RequestContext) -> ApiResult {
    let ks = ctx.identity();
    let (services, endpoints, regions) = tokio::try_join!(
        ks.get("/services", &[]),
        ks.get("/endpoints", &[]),
        ks.get("/regions", &[]),
    )?;
    Ok(Json(json!({
        "services": services["services"],
        "endpoints": endpoints["endpoints"],
        "regions": regions["regions"],
    })))
}
