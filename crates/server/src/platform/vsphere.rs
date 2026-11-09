//! VMware vCenter and standalone ESXi hosts (client: `crates/clients/vsphere`).

use chrono::{Duration, Utc};
use rassvet_ext_api::ApiError;
use rassvet_vsphere_client::{Error, Product as VsProduct, Session, Vsphere};

use super::{Product, Stat, Summary, api_error, bytes};
use crate::{
    config::Platform,
    session::{CloudLogin, VsphereLogin},
};

/// Upper bound kept for a vSphere session in Rassvet. The endpoint ends idle sessions by
/// itself (30 minutes by default); Rassvet then signs that cloud out on the next request.
const SESSION_HOURS: i64 = 24;

fn err(e: Error) -> ApiError {
    api_error(e.status(), e.to_string())
}

pub async fn login(
    c: &Vsphere,
    product: VsProduct,
    username: &str,
    password: &str,
) -> Result<CloudLogin, ApiError> {
    let session = c
        .login(product, username, password)
        .await
        .map_err(|e| match e {
            // vCenter and ESXi word this differently; say it the same way for both.
            Error::Unauthorized(_) => ApiError::new(
                axum::http::StatusCode::UNAUTHORIZED,
                "the user name or password was not accepted",
            ),
            other => err(other),
        })?;
    Ok(CloudLogin::Vsphere(VsphereLogin {
        session,
        expires_at: Utc::now() + Duration::hours(SESSION_HOURS),
    }))
}

pub async fn summary(c: &Vsphere, s: &Session) -> Result<Summary, ApiError> {
    let about = &s.about;
    let product = Some(Product {
        name: if about.full_name.is_empty() {
            about.name.clone()
        } else {
            about.full_name.clone()
        },
        version: (!about.version.is_empty()).then(|| about.version.clone()),
        build: (!about.build.is_empty()).then(|| about.build.clone()),
    });
    if s.product == VsProduct::Esxi {
        return Ok(Summary {
            platform: Platform::Esxi,
            product,
            stats: vec![],
            warnings: vec![],
            notes: vec![
                "Standalone ESXi hosts are signed in through the vim25 SOAP API; their inventory pages come in a later version. Manage the host through its vCenter for the full inventory.".into(),
            ],
        });
    }

    let (dcs, clusters, hosts, vms, datastores, networks) = tokio::join!(
        c.datacenters(s),
        c.clusters(s),
        c.hosts(s),
        c.vms(s),
        c.datastores(s),
        c.networks(s),
    );
    let mut warnings = Vec::new();
    let mut stats = Vec::new();
    let dcs = take(&mut warnings, "Datacenters", dcs)?;
    let clusters = take(&mut warnings, "Clusters", clusters)?;
    let hosts = take(&mut warnings, "Hosts", hosts)?;
    let vms = take(&mut warnings, "Virtual machines", vms)?;
    let datastores = take(&mut warnings, "Datastores", datastores)?;
    let networks = take(&mut warnings, "Networks", networks)?;

    if let Some(vms) = vms {
        let on = vms.iter().filter(|v| v.power_state == "POWERED_ON").count();
        stats.push(Stat {
            id: "vms",
            label: "Virtual machines",
            value: vms.len() as u64,
            detail: Some(format!("{on} powered on")),
        });
    }
    if let Some(hosts) = hosts {
        let up = hosts
            .iter()
            .filter(|h| h.connection_state == "CONNECTED")
            .count();
        stats.push(Stat {
            id: "hosts",
            label: "Hosts",
            value: hosts.len() as u64,
            detail: Some(format!("{up} connected")),
        });
    }
    if let Some(clusters) = clusters {
        let drs = clusters.iter().filter(|c| c.drs_enabled).count();
        let ha = clusters.iter().filter(|c| c.ha_enabled).count();
        stats.push(Stat {
            id: "clusters",
            label: "Clusters",
            value: clusters.len() as u64,
            detail: Some(format!("{drs} with DRS, {ha} with HA")),
        });
    }
    if let Some(dcs) = dcs {
        stats.push(Stat {
            id: "datacenters",
            label: "Datacenters",
            value: dcs.len() as u64,
            detail: None,
        });
    }
    if let Some(ds) = datastores {
        let cap: u64 = ds.iter().filter_map(|d| d.capacity).sum();
        let free: u64 = ds.iter().filter_map(|d| d.free_space).sum();
        stats.push(Stat {
            id: "datastores",
            label: "Datastores",
            value: ds.len() as u64,
            detail: (cap > 0).then(|| format!("{} free of {}", bytes(free), bytes(cap))),
        });
    }
    if let Some(nets) = networks {
        let dvs = nets
            .iter()
            .filter(|n| n.kind.as_deref() == Some("DISTRIBUTED_PORTGROUP"))
            .count();
        stats.push(Stat {
            id: "networks",
            label: "Networks",
            value: nets.len() as u64,
            detail: Some(format!("{dvs} distributed port groups")),
        });
    }
    Ok(Summary {
        platform: Platform::Vcenter,
        product,
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
