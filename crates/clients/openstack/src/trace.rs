//! Request correlation and logging of OpenStack calls.
//!
//! Each browser request handled by Rassvet gets an id like `req-<uuid>` ([`new_request_id`]),
//! kept in a task-local while the request runs ([`scope`]). Every OpenStack call made for it
//! sends that id as `X-OpenStack-Request-ID` — oslo.middleware records it as the
//! `global_request_id` in the services' logs — and logs one line with the service's own
//! request id (`x-openstack-request-id` / `x-compute-request-id`), status and duration, so
//! a Rassvet log line can be matched with Nova, Neutron, Cinder… logs.

use std::{future::Future, time::Instant};

use reqwest::{RequestBuilder, Response, header::HeaderMap};

use crate::error::{Result, check};

tokio::task_local! {
    static GLOBAL_ID: String;
}

/// A new id in the format oslo.middleware accepts as a global request id.
pub fn new_request_id() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40; // UUID v4
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "req-{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// Run `f` with `id` as the current request id.
pub async fn scope<F: Future>(id: String, f: F) -> F::Output {
    GLOBAL_ID.scope(id, f).await
}

/// The request id of the browser request being handled, if any.
pub fn current() -> Option<String> {
    GLOBAL_ID.try_with(Clone::clone).ok()
}

/// The service's own request id from a response.
pub fn upstream_id(h: &HeaderMap) -> Option<&str> {
    h.get("x-openstack-request-id")
        .or_else(|| h.get("x-compute-request-id"))
        .and_then(|v| v.to_str().ok())
}

/// Send an OpenStack request (with the global request id) and log it; no status check.
pub async fn exec(service: &str, rb: RequestBuilder) -> reqwest::Result<Response> {
    let rb = match current() {
        Some(id) => rb.header("X-OpenStack-Request-ID", id),
        None => rb,
    };
    let (client, req) = rb.build_split();
    let req = req?;
    let method = req.method().clone();
    let path = match req.url().query() {
        Some(q) => format!("{}?{q}", req.url().path()),
        None => req.url().path().to_owned(),
    };
    let start = Instant::now();
    let res = client.execute(req).await;
    let ms = start.elapsed().as_millis() as u64;
    match &res {
        Ok(r) => {
            let status = r.status().as_u16();
            let upstream = upstream_id(r.headers()).unwrap_or("-");
            if status >= 500 {
                tracing::warn!(target: "rassvet::openstack", service, %method, path, status, ms, upstream_request_id = upstream, "OpenStack call");
            } else {
                tracing::info!(target: "rassvet::openstack", service, %method, path, status, ms, upstream_request_id = upstream, "OpenStack call");
            }
        }
        Err(e) => {
            tracing::warn!(target: "rassvet::openstack", service, %method, path, ms, error = %e, "OpenStack call failed");
        }
    }
    res
}

/// [`exec`], then turn non-2xx into [`crate::Error::Api`].
pub async fn send(service: &str, rb: RequestBuilder) -> Result<Response> {
    check(service, exec(service, rb).await?).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_look_like_oslo_ones() {
        let a = new_request_id();
        let b = new_request_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 40);
        assert!(a.starts_with("req-"));
        let parts: Vec<_> = a[4..].split('-').map(str::len).collect();
        assert_eq!(parts, [8, 4, 4, 4, 12]);
        assert_eq!(&a[18..19], "4");
    }

    #[tokio::test]
    async fn scope_sets_current() {
        assert_eq!(current(), None);
        let got = scope("req-x".into(), async { current() }).await;
        assert_eq!(got.as_deref(), Some("req-x"));
    }
}
