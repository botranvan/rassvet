//! VMware Cloud Foundation through its SDDC Manager (client: `crates/clients/vcf`).

use axum::http::StatusCode;
use chrono::{Duration, Utc};
use rassvet_ext_api::ApiError;
use rassvet_vcf_client::{Error, Tokens, Vcf};

use super::{Product, Stat, Summary, api_error};
use crate::{
    config::Platform,
    session::{CloudLogin, VcfLogin},
    state::AppState,
};

/// SDDC Manager refresh tokens last 24 hours by default: the login lasts as long.
const REFRESH_HOURS: i64 = 24;

fn err(e: Error) -> ApiError {
    match e {
        Error::Unauthorized(m) => ApiError::new(StatusCode::UNAUTHORIZED, m),
        other => api_error(other.status(), other.to_string()),
    }
}

pub async fn login(c: &Vcf, username: &str, password: &str) -> Result<CloudLogin, ApiError> {
    let tokens = c.login(username, password).await.map_err(|e| match e {
        Error::Unauthorized(_) => ApiError::new(
            StatusCode::UNAUTHORIZED,
            "the user name or password was not accepted",
        ),
        other => err(other),
    })?;
    Ok(CloudLogin::Vcf(VcfLogin {
        user: username.to_owned(),
        tokens,
        expires_at: Utc::now() + Duration::hours(REFRESH_HOURS),
    }))
}

/// A valid access token: the session's, or a refreshed one (then saved in the session).
async fn access(
    st: &AppState,
    sid: &str,
    cloud_id: &str,
    c: &Vcf,
    l: &VcfLogin,
) -> Result<Tokens, ApiError> {
    if !l.tokens.access_expired() {
        return Ok(l.tokens.clone());
    }
    let fresh = c.refresh(&l.tokens).await.map_err(err)?;
    st.sessions
        .update(sid, |s| {
            if let Some(CloudLogin::Vcf(v)) = s.logins.get_mut(cloud_id) {
                v.tokens = fresh.clone();
            }
        })
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "session expired"))?;
    Ok(fresh)
}

pub async fn summary(
    st: &AppState,
    sid: &str,
    cloud_id: &str,
    c: &Vcf,
    l: &VcfLogin,
) -> Result<Summary, ApiError> {
    let t = access(st, sid, cloud_id, c, l).await?;
    let (managers, domains, clusters, hosts, vcenters, nsx) = tokio::join!(
        c.sddc_managers(&t),
        c.domains(&t),
        c.clusters(&t),
        c.hosts(&t),
        c.vcenters(&t),
        c.nsxt_clusters(&t),
    );
    let mut warnings = Vec::new();
    let managers = take(&mut warnings, "SDDC Manager", managers)?;
    let domains = take(&mut warnings, "Workload domains", domains)?;
    let clusters = take(&mut warnings, "Clusters", clusters)?;
    let hosts = take(&mut warnings, "Hosts", hosts)?;
    let vcenters = take(&mut warnings, "vCenter Servers", vcenters)?;
    let nsx = take(&mut warnings, "NSX Managers", nsx)?;

    let mut stats = Vec::new();
    if let Some(d) = domains {
        let mgmt = d
            .iter()
            .filter(|x| x.kind.as_deref() == Some("MANAGEMENT"))
            .count();
        stats.push(Stat {
            id: "domains",
            label: "Workload domains",
            value: d.len() as u64,
            detail: Some(format!("{mgmt} management, {} VI", d.len() - mgmt)),
        });
    }
    if let Some(c) = clusters {
        stats.push(Stat {
            id: "clusters",
            label: "Clusters",
            value: c.len() as u64,
            detail: None,
        });
    }
    if let Some(h) = hosts {
        let assigned = h
            .iter()
            .filter(|x| x.status.as_deref() == Some("ASSIGNED"))
            .count();
        stats.push(Stat {
            id: "hosts",
            label: "Hosts",
            value: h.len() as u64,
            detail: Some(format!("{assigned} assigned, {} free", h.len() - assigned)),
        });
    }
    if let Some(v) = vcenters {
        stats.push(Stat {
            id: "vcenters",
            label: "vCenter Servers",
            value: v.len() as u64,
            detail: None,
        });
    }
    if let Some(n) = nsx {
        stats.push(Stat {
            id: "nsx",
            label: "NSX Managers",
            value: n.len() as u64,
            detail: None,
        });
    }
    let manager = managers.and_then(|m| m.into_iter().next());
    Ok(Summary {
        platform: Platform::Vcf,
        product: Some(Product {
            name: match manager.as_ref().and_then(|m| m.fqdn.clone()) {
                Some(fqdn) => format!("SDDC Manager {fqdn}"),
                None => "SDDC Manager".into(),
            },
            version: manager.and_then(|m| m.version),
            build: None,
        }),
        stats,
        warnings,
        notes: vec![],
    })
}

/// A list for the summary: an error becomes a warning, except a session the endpoint no
/// longer knows, which stops the summary (the caller signs the cloud out).
fn take<T>(
    warnings: &mut Vec<String>,
    label: &str,
    r: Result<T, Error>,
) -> Result<Option<T>, ApiError> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(Error::Unauthorized(m)) => Err(ApiError::new(axum::http::StatusCode::UNAUTHORIZED, m)),
        Err(e) => {
            warnings.push(format!("{label}: {e}"));
            Ok(None)
        }
    }
}
