//! Minimal, typed OpenStack client used by the dashboard server and extensions.
//!
//! Target API baseline: OpenStack 2026.2 (Hibiscus), oldest supported: 2026.1 (Gazpacho).
//! Microversions are negotiated per cloud at runtime instead of being hardcoded per release.

pub mod auth;
pub mod catalog;
pub mod error;
pub mod identity;
pub mod image;
pub mod microversion;
pub mod rest;
pub mod trace;

pub use auth::{AuthMethod, IdName, Keystone, ProjectRef, Scope, Token};
pub use catalog::{Catalog, Endpoint, Interface, ServiceEntry};
pub use error::{Error, Result};
pub use identity::Identity;
pub use image::Glance;
pub use microversion::Microversion;
pub use rest::Rest;

/// Build the shared HTTP client used for all OpenStack calls.
pub fn http_client(insecure_tls: bool, ca_pem: Option<&[u8]>) -> Result<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .user_agent(concat!("rassvet/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .danger_accept_invalid_certs(insecure_tls);
    if let Some(pem) = ca_pem {
        for cert in reqwest::Certificate::from_pem_bundle(pem)? {
            b = b.add_root_certificate(cert);
        }
    }
    Ok(b.build()?)
}
