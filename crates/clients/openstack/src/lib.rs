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
        // Every request carries an X-Auth-Token header, which reqwest (unlike Authorization)
        // would forward on a redirect to another host. Follow redirects only within the same
        // origin, so a misconfigured or hostile endpoint can't collect the token.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let same = attempt
                .previous()
                .first()
                .is_some_and(|first| same_origin(first, attempt.url()));
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if same {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .danger_accept_invalid_certs(insecure_tls);
    if let Some(pem) = ca_pem {
        for cert in reqwest::Certificate::from_pem_bundle(pem)? {
            b = b.add_root_certificate(cert);
        }
    }
    Ok(b.build()?)
}

/// Same scheme, host and port.
fn same_origin(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// A `next` link from a paginated response, joined to `root` only when it is a plain
/// absolute path (`/v2/images?marker=…`). Anything else (`//host`, `@host`, a full URL)
/// is refused, so a crafted link can't send the token to another server.
pub fn join_next(root: &str, next: &str) -> Option<String> {
    (next.starts_with('/') && !next.starts_with("//") && !next.contains('\\'))
        .then(|| format!("{root}{next}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_links_stay_on_the_endpoint() {
        assert_eq!(
            join_next("https://g:9292", "/v2/images?marker=a").as_deref(),
            Some("https://g:9292/v2/images?marker=a")
        );
        assert!(join_next("https://g:9292", "@evil.example/v2/images").is_none());
        assert!(join_next("https://g:9292", "//evil.example/v2").is_none());
        assert!(join_next("https://g:9292", "https://evil.example/v2").is_none());
        let a = reqwest::Url::parse("https://k:5000/v3").unwrap();
        assert!(!same_origin(&a, &reqwest::Url::parse("https://k/x").unwrap()));
        assert!(same_origin(&a, &reqwest::Url::parse("https://k:5000/y").unwrap()));
    }
}
