use std::{collections::HashMap, sync::Arc};

use anyhow::Context;
use rassvet_ext_api::Extension;
use rassvet_os_client::Keystone;

use crate::{
    config::{CloudConfig, Config, Platform},
    session::{SessionLimits, SessionStore},
};

pub struct Cloud {
    pub cfg: CloudConfig,
    pub http: reqwest::Client,
    /// The platform's client (one crate per platform under `crates/clients/`).
    pub client: Client,
}

/// How Rassvet talks to a cloud, by platform.
pub enum Client {
    Openstack(Keystone),
    /// vCenter and standalone ESXi.
    Vsphere(rassvet_vsphere_client::Vsphere),
    Vcf(rassvet_vcf_client::Vcf),
}

impl Cloud {
    /// Keystone of an OpenStack cloud.
    pub fn keystone(&self) -> Option<&Keystone> {
        match &self.client {
            Client::Openstack(k) => Some(k),
            _ => None,
        }
    }
}

pub struct Inner {
    pub config: Config,
    /// Clouds in config order.
    pub clouds: Vec<Arc<Cloud>>,
    pub by_id: HashMap<String, Arc<Cloud>>,
    pub sessions: SessionStore,
    pub extensions: Vec<Arc<dyn Extension>>,
    /// Negotiated microversions per cloud/region/service.
    pub versions: crate::gateway::Versions,
    /// Results of nav policy probes: (cloud, region, user, project, path) → (allowed, when).
    pub probes: std::sync::Mutex<HashMap<String, (bool, std::time::Instant)>>,
    /// Failed sign-ins per account (brute-force protection).
    pub login_throttle: crate::throttle::LoginThrottle,
}

pub type AppState = Arc<Inner>;

pub fn build(config: Config, extensions: Vec<Arc<dyn Extension>>) -> anyhow::Result<AppState> {
    let mut clouds = Vec::new();
    for c in &config.clouds {
        let ca = match &c.ca_file {
            Some(p) => Some(std::fs::read(p).with_context(|| format!("reading CA file {p}"))?),
            None => None,
        };
        let http = rassvet_os_client::http_client(c.insecure_tls, ca.as_deref())
            .with_context(|| format!("HTTP client for cloud '{}'", c.id))?;
        let client = match c.platform {
            Platform::Openstack => Client::Openstack(Keystone::new(http.clone(), &c.auth_url)),
            Platform::Vcenter | Platform::Esxi => Client::Vsphere(
                rassvet_vsphere_client::Vsphere::new(http.clone(), &c.auth_url),
            ),
            Platform::Vcf => Client::Vcf(rassvet_vcf_client::Vcf::new(http.clone(), &c.auth_url)),
        };
        clouds.push(Arc::new(Cloud {
            client,
            http,
            cfg: c.clone(),
        }));
    }
    let by_id = clouds
        .iter()
        .map(|c| (c.cfg.id.clone(), c.clone()))
        .collect();
    let sessions = SessionStore::new(
        SessionLimits::from(&config.server),
        config.memcached.as_ref(),
    )?;
    sessions.spawn_reaper();
    Ok(Arc::new(Inner {
        config,
        clouds,
        by_id,
        sessions,
        extensions,
        versions: Default::default(),
        probes: Default::default(),
        login_throttle: Default::default(),
    }))
}
