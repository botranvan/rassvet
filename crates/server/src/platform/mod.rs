//! Clouds that are not OpenStack: sign-in, sign-out and the overview page, one module per
//! platform (each backed by its client crate under `crates/clients/`). OpenStack keeps its
//! own handlers (`api.rs`, `gateway.rs`, …).

pub mod vcf;
pub mod vsphere;

use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use rassvet_ext_api::ApiError;
use serde::Serialize;

use crate::{
    api::{SelectedCloud, SessionId},
    config::Platform,
    session::CloudLogin,
    state::{AppState, Client, Cloud},
};

pub fn router() -> Router<AppState> {
    Router::new().route("/summary", get(summary))
}

/// API paths a non-OpenStack cloud may call; everything else is OpenStack's.
pub fn allowed_path(path: &str) -> bool {
    matches!(
        path,
        "/clouds"
            | "/auth/login"
            | "/auth/logout"
            | "/session"
            | "/session/clouds"
            | "/session/cloud"
            | "/nav"
    ) || ["/session/clouds/", "/session/prefs/", "/platform/"]
        .iter()
        .any(|p| path.starts_with(p))
}

/// What the overview page of a non-OpenStack cloud shows.
#[derive(Debug, Serialize)]
pub struct Summary {
    pub platform: Platform,
    pub product: Option<Product>,
    /// Counters shown as tiles (virtual machines, hosts, …).
    pub stats: Vec<Stat>,
    /// Parts that could not be read (e.g. not allowed for this user).
    pub warnings: Vec<String>,
    /// Remarks about what this platform shows.
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Product {
    pub name: String,
    pub version: Option<String>,
    pub build: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Stat {
    pub id: &'static str,
    pub label: &'static str,
    pub value: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Sign in to a vCenter, ESXi host or SDDC Manager with a user name and password.
pub async fn authenticate(
    cloud: &Cloud,
    username: &str,
    password: &str,
) -> Result<CloudLogin, ApiError> {
    if username.trim().is_empty() || password.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "user name and password are required",
        ));
    }
    match (&cloud.client, cloud.cfg.platform) {
        (Client::Vsphere(c), Platform::Vcenter) => {
            vsphere::login(
                c,
                rassvet_vsphere_client::Product::Vcenter,
                username,
                password,
            )
            .await
        }
        (Client::Vsphere(c), Platform::Esxi) => {
            vsphere::login(c, rassvet_vsphere_client::Product::Esxi, username, password).await
        }
        (Client::Vcf(c), _) => vcf::login(c, username, password).await,
        _ => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "this cloud does not sign in with a user name and password here",
        )),
    }
}

/// Best effort: end the session on the platform's side.
pub async fn revoke(cloud: &Cloud, login: &CloudLogin) {
    match (&cloud.client, login) {
        (Client::Vsphere(c), CloudLogin::Vsphere(l)) => {
            if let Err(e) = c.logout(&l.session).await {
                tracing::debug!(error = %e, "vSphere logout failed");
            }
        }
        (Client::Vcf(c), CloudLogin::Vcf(l)) => {
            if let Err(e) = c.logout(&l.tokens).await {
                tracing::debug!(error = %e, "SDDC Manager logout failed");
            }
        }
        _ => {}
    }
}

/// `GET /api/platform/summary`: the overview of the request's (non-OpenStack) cloud. When the
/// platform says the session is gone, that cloud is signed out and the answer is 401.
async fn summary(
    State(st): State<AppState>,
    sid_ext: Option<axum::Extension<SessionId>>,
    selected: Option<axum::Extension<SelectedCloud>>,
) -> Result<Json<Summary>, ApiError> {
    let sid = sid_ext
        .map(|e| e.0.0)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let s = st
        .sessions
        .get(&sid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    let cloud_id = selected
        .map(|e| e.0.0)
        .filter(|c| s.logins.contains_key(c))
        .unwrap_or_else(|| s.active.clone());
    let cloud = st
        .by_id
        .get(&cloud_id)
        .cloned()
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "not logged in"))?;
    let result = match (&cloud.client, &s.logins[&cloud_id]) {
        (Client::Vsphere(c), CloudLogin::Vsphere(l)) => vsphere::summary(c, &l.session).await,
        (Client::Vcf(c), CloudLogin::Vcf(l)) => vcf::summary(&st, &sid, &cloud_id, c, l).await,
        _ => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "this is an OpenStack cloud: use its own pages",
            ));
        }
    };
    match result {
        Err(e) if e.status == StatusCode::UNAUTHORIZED => {
            tracing::info!(cloud = %cloud_id, "platform session ended; cloud signed out");
            crate::api::drop_cloud(&st, &sid, &cloud_id, false).await;
            Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                format!("your session on {} ended: sign in again", cloud.cfg.name),
            ))
        }
        other => other.map(Json),
    }
}

/// An error of a platform client as an API answer: refusals keep their status, an endpoint
/// that can't be reached is a 502.
pub(crate) fn api_error(status: Option<reqwest::StatusCode>, message: String) -> ApiError {
    let status = status
        .and_then(|s| StatusCode::from_u16(s.as_u16()).ok())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    ApiError::new(status, message)
}

/// `1.2 TiB`-style size.
pub(crate) fn bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_session_paths_for_other_platforms() {
        for ok in [
            "/clouds",
            "/session",
            "/session/clouds/vc",
            "/session/prefs/x",
            "/nav",
            "/platform/summary",
            "/auth/logout",
        ] {
            assert!(allowed_path(ok), "{ok}");
        }
        for no in [
            "/os/compute/servers",
            "/session/project",
            "/session/region",
            "/image/images",
            "/identity/cli",
        ] {
            assert!(!allowed_path(no), "{no}");
        }
        assert_eq!(bytes(512), "512 B");
        assert_eq!(bytes(3 * 1024 * 1024 * 1024 * 1024 / 2), "1.5 TiB");
    }
}
