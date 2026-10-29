//! The contract every rassvet extension implements.
//!
//! An extension is a crate under `extensions/<name>/` that:
//! * implements [`Extension`] (backend: manifest, nav entries, API routes), and
//! * ships its React pages in `extensions/<name>/ui/index.tsx` (frontend).
//!
//! Extensions are compiled in via Cargo features of the `rassvet` server crate and are
//! only shown to a user when every service type in [`Manifest::service_types`] has an
//! endpoint in the selected region of that user's Keystone catalog.

use std::sync::Arc;

use axum::{
    Json,
    extract::FromRequestParts,
    http::{StatusCode, request::Parts},
    response::{IntoResponse, Response},
};
use rassvet_os_client::{Catalog, Interface, Token};
use serde::Serialize;

pub mod gateway;

pub use axum;
pub use rassvet_os_client as os;

/// Static description of an extension.
#[derive(Debug, Clone, Serialize)]
pub struct Manifest {
    /// Stable id, used in URLs: `/api/ext/<id>/...` and `/ext/<id>/...` in the UI.
    pub id: &'static str,
    pub name: &'static str,
    pub version: &'static str,
    pub description: &'static str,
    /// Catalog service types that must all be present for the extension to activate.
    pub service_types: &'static [&'static str],
}

/// Which UI mode shows a navigation entry: `Project` (everyday user view) or
/// `Admin` (cloud administration, only for users with the admin role).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NavSection {
    Project,
    Admin,
}

#[derive(Debug, Clone, Serialize)]
pub struct NavItem {
    pub id: String,
    /// Group heading inside the section, e.g. "Compute" or "Network".
    pub group: String,
    pub label: String,
    /// UI route, e.g. `/compute/instances` or `/ext/octavia/load-balancers`.
    pub path: String,
    /// lucide icon name (kebab-case), e.g. `server`, `network`.
    pub icon: String,
    pub section: NavSection,
    /// Required role (case-insensitive). `None` = any authenticated user.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

/// Backend side of an extension.
pub trait Extension: Send + Sync + 'static {
    fn manifest(&self) -> Manifest;

    fn nav(&self) -> Vec<NavItem>;

    /// API routes, mounted under `/api/ext/<id>`. Handlers receive [`RequestContext`]
    /// as an extractor; it is only present for authenticated sessions.
    fn router(&self) -> axum::Router {
        axum::Router::new()
    }

    /// Whether this extension is usable with the given catalog in `region`.
    fn is_available(&self, catalog: &Catalog, region: Option<&str>) -> bool {
        self.manifest()
            .service_types
            .iter()
            .all(|s| catalog.has_service(s, region))
    }
}

/// Per-request view of the authenticated session, injected by the server for every
/// `/api/*` route (core and extension).
#[derive(Clone)]
pub struct RequestContext {
    /// Id of the configured cloud this session belongs to.
    pub cloud_id: String,
    /// Keystone URL from the dashboard config; fallback when the catalog lacks identity.
    pub auth_url: String,
    pub http: reqwest::Client,
    pub token: Arc<Token>,
    pub region: Option<String>,
    pub interface: Interface,
}

impl RequestContext {
    /// Endpoint URL for `service_type` in the session's region.
    pub fn endpoint(&self, service_type: &str) -> Result<String, ApiError> {
        self.token
            .catalog
            .endpoint(service_type, self.interface, self.region.as_deref())
            .map(str::to_owned)
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::NOT_FOUND,
                    format!("service '{service_type}' is not available in this region"),
                )
            })
    }

    /// Keystone v3 client using the catalog identity endpoint of the session's
    /// region/interface, falling back to the configured auth URL.
    pub fn identity(&self) -> rassvet_os_client::Identity {
        let ep = self
            .token
            .catalog
            .endpoint("identity", self.interface, self.region.as_deref())
            .unwrap_or(&self.auth_url);
        rassvet_os_client::Identity::new(self.http.clone(), ep, &self.token.value)
    }

    /// Glance v2 client for the session's region/interface.
    pub fn glance(&self) -> Result<rassvet_os_client::Glance, ApiError> {
        let ep = self.endpoint("image")?;
        Ok(rassvet_os_client::Glance::new(
            self.http.clone(),
            &ep,
            &self.token.value,
        ))
    }

    /// Id of the project the session is scoped to, if any.
    pub fn project_id(&self) -> Option<&str> {
        self.token.project.as_ref().map(|p| p.id.as_str())
    }

    /// Whether the session has the admin role on its current scope.
    pub fn is_admin(&self) -> bool {
        self.token.has_role("admin")
    }

    /// Request builder with the session's token already attached.
    pub fn request(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, url)
            .header("X-Auth-Token", &self.token.value)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for RequestContext {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<RequestContext>()
            .cloned()
            .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))
    }
}

/// JSON error returned by every API route: `{"error": {"message", "request_id"}}`.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
    pub request_id: Option<String>,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            request_id: None,
        }
    }
}

impl From<rassvet_os_client::Error> for ApiError {
    fn from(e: rassvet_os_client::Error) -> Self {
        let status = match e.status() {
            Some(s) => StatusCode::from_u16(s.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            None => StatusCode::BAD_GATEWAY,
        };
        Self {
            status,
            request_id: e.request_id().map(str::to_owned),
            message: match &e {
                rassvet_os_client::Error::Api { message, .. } => message.clone(),
                other => other.to_string(),
            },
        }
    }
}

impl From<reqwest::Error> for ApiError {
    fn from(e: reqwest::Error) -> Self {
        rassvet_os_client::Error::from(e).into()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = serde_json::json!({"error": {
            "message": self.message,
            "request_id": self.request_id,
        }});
        (self.status, Json(body)).into_response()
    }
}
