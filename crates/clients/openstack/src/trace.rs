//! Request correlation and logging of OpenStack calls.
//!
//! Each browser request handled by Rassvet gets an id like `req-<uuid>` ([`new_request_id`]),
//! kept in a task-local while the request runs ([`scope`]). Every OpenStack call made for it
//! sends that id as `X-OpenStack-Request-ID` — oslo.middleware records it as the
//! `global_request_id` in the services' logs — and logs one line with the service's own
//! request id (`x-openstack-request-id` / `x-compute-request-id`), status and duration, so
//! a Rassvet log line can be matched with Nova, Neutron, Cinder… logs.
//!
//! At debug level two more targets log what is exchanged, for troubleshooting:
//! * `rassvet::openstack::request`: method, URL and JSON body sent to OpenStack;
//! * `rassvet::openstack::response`: status and JSON body OpenStack answered.
//!
//! Secrets (passwords, application credential and EC2 secrets, TOTP codes, Barbican payloads,
//! private keys, user data…) are replaced by `"***"`; tokens travel in headers, which aren't
//! logged. Bodies that aren't JSON (images, objects, secret payloads) are logged as their size
//! only and are never buffered, so downloads still stream. Logged bodies are cut after
//! [`BODY_LOG_MAX`] bytes.

use std::{future::Future, time::Instant};

use reqwest::{
    RequestBuilder, Response, ResponseBuilderExt,
    header::{CONTENT_LENGTH, CONTENT_TYPE, HeaderMap},
};
use serde_json::Value;

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
    if tracing::enabled!(target: "rassvet::openstack::request", tracing::Level::DEBUG) {
        let body = match req.body() {
            None => "-".to_owned(),
            Some(b) => match b.as_bytes() {
                Some(bytes) => describe(content_type(req.headers()), bytes),
                None => "<streamed body>".to_owned(),
            },
        };
        tracing::debug!(target: "rassvet::openstack::request", service, %method, url = %req.url(), body, "OpenStack request");
    }
    let start = Instant::now();
    let mut res = client.execute(req).await;
    let ms = start.elapsed().as_millis() as u64;
    if tracing::enabled!(target: "rassvet::openstack::response", tracing::Level::DEBUG) {
        res = match res {
            Ok(r) => log_response(service, &method, &path, r).await,
            Err(e) => Err(e),
        };
    }
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

/// Most bytes of a body written to the debug log; the rest is cut (the size is still given).
pub const BODY_LOG_MAX: usize = 16 * 1024;

/// JSON keys whose (non-object) values are never logged, compared without case and `_`.
const SECRET_KEYS: &[&str] = &[
    "password",
    "originalpassword",
    "secret",
    "passcode",
    "adminpass",
    "privatekey",
    "payload",
    "blob",
    "userdata",
    "accesstoken",
    "refreshtoken",
    "authtoken",
    "token",
    "key",
    "credential",
];

fn content_type(h: &HeaderMap) -> &str {
    h.get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

fn is_json(content_type: &str) -> bool {
    content_type.contains("json")
}

/// Hide the values of secret keys, at any depth. Objects and arrays under them are kept
/// (`{"token": {...}}` is Keystone's whole answer), only their secret leaves go.
fn redact(v: &mut Value) {
    match v {
        Value::Object(m) => {
            for (k, x) in m.iter_mut() {
                let norm: String = k
                    .chars()
                    .filter(|c| *c != '_' && *c != '-')
                    .collect::<String>()
                    .to_ascii_lowercase();
                if !x.is_object()
                    && !x.is_array()
                    && !x.is_null()
                    && SECRET_KEYS.contains(&norm.as_str())
                {
                    *x = Value::String("***".into());
                } else {
                    // Keystone token auth (switching project): {"token": {"id": "<the token>"}}.
                    if norm == "token"
                        && let Some(id) = x.get_mut("id")
                        && id.is_string()
                    {
                        *id = Value::String("***".into());
                    }
                    redact(x);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(redact),
        _ => {}
    }
}

/// A body for the log: redacted JSON cut after [`BODY_LOG_MAX`] bytes, or only its size.
fn describe(content_type: &str, bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "-".into();
    }
    let parsed =
        (is_json(content_type) || bytes.first() == Some(&b'{') || bytes.first() == Some(&b'['))
            .then(|| serde_json::from_slice::<Value>(bytes).ok())
            .flatten();
    let Some(mut v) = parsed else {
        let ct = if content_type.is_empty() {
            "unknown type"
        } else {
            content_type
        };
        return format!("<{} bytes, {ct}>", bytes.len());
    };
    redact(&mut v);
    let mut text = v.to_string();
    if text.len() > BODY_LOG_MAX {
        let mut cut = BODY_LOG_MAX;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str(&format!("… ({} bytes)", bytes.len()));
    }
    text
}

/// Log a response's status and body. A JSON body is read and put back into an equivalent
/// response; any other body is left untouched (it may be a large download).
async fn log_response(
    service: &str,
    method: &reqwest::Method,
    path: &str,
    r: Response,
) -> reqwest::Result<Response> {
    let status = r.status().as_u16();
    let upstream = upstream_id(r.headers()).unwrap_or("-").to_owned();
    let ct = content_type(r.headers()).to_owned();
    if !is_json(&ct) {
        let size = r
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .map_or_else(|| "?".to_owned(), str::to_owned);
        let body = if size == "0" || status == 204 {
            "-".to_owned()
        } else {
            format!(
                "<{size} bytes, {}>",
                if ct.is_empty() { "unknown type" } else { &ct }
            )
        };
        tracing::debug!(target: "rassvet::openstack::response", service, %method, path, status, upstream_request_id = upstream, body, "OpenStack response");
        return Ok(r);
    }
    let mut builder = http::Response::builder()
        .status(r.status())
        .version(r.version())
        .url(r.url().clone());
    if let Some(h) = builder.headers_mut() {
        *h = r.headers().clone();
    }
    let bytes = r.bytes().await?;
    let body = describe(&ct, &bytes);
    tracing::debug!(target: "rassvet::openstack::response", service, %method, path, status, upstream_request_id = upstream, body, "OpenStack response");
    let rebuilt = builder
        .body(bytes)
        .expect("parts taken from a valid response");
    Ok(Response::from(rebuilt))
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

    #[test]
    fn secrets_are_hidden_at_any_depth() {
        let body = br#"{"auth":{"identity":{"methods":["password"],"password":{"user":{"name":"alice","password":"s3cret","domain":{"name":"Default"}}}}},
            "server":{"name":"vm","adminPass":"x","user_data":"IyEvYmluL3No","key_name":"mykey"},
            "secret":{"payload":"top","payload_content_type":"text/plain"},"credential":{"blob":"{\"secret\":\"y\"}"},"tokens":[{"access_token":"t"}]}"#;
        let out = describe("application/json", body);
        for leak in ["s3cret", "IyEvYmluL3No", "\"top\"", "\"t\""] {
            assert!(!out.contains(leak), "{leak} leaked: {out}");
        }
        // Names, ids and non-secret fields stay; objects named like secrets keep their shape.
        for kept in [
            "\"name\":\"alice\"",
            "\"key_name\":\"mykey\"",
            "\"methods\":[\"password\"]",
            "\"payload_content_type\":\"text/plain\"",
        ] {
            assert!(out.contains(kept), "{kept} missing: {out}");
        }
        assert!(out.contains("\"user\":{"), "{out}");

        // Re-scoping with a token sends the token as the "id" of a "token" object.
        let rescope = br#"{"auth":{"identity":{"methods":["token"],"token":{"id":"gAAAA-live-token"}},"scope":{"project":{"id":"p1"}}}}"#;
        let out = describe("application/json", rescope);
        assert!(!out.contains("gAAAA-live-token"), "{out}");
        assert!(out.contains(r#""project":{"id":"p1"}"#), "{out}");
    }

    #[test]
    fn bodies_that_are_not_json_or_too_long() {
        assert_eq!(
            describe("application/octet-stream", &[0u8; 10]),
            "<10 bytes, application/octet-stream>"
        );
        assert_eq!(describe("", b""), "-");
        assert_eq!(describe("text/plain", b"hello"), "<5 bytes, text/plain>");
        let big = format!("{{\"x\":\"{}\"}}", "é".repeat(BODY_LOG_MAX));
        let out = describe("application/json", big.as_bytes());
        assert!(out.len() < BODY_LOG_MAX + 40, "{}", out.len());
        assert!(
            out.ends_with(&format!("… ({} bytes)", big.len())),
            "{}",
            &out[out.len() - 30..]
        );
    }

    /// Log lines written while a test runs.
    #[derive(Clone, Default)]
    struct Captured(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for Captured {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    async fn call_with_filter(filter: &str) -> (String, serde_json::Value) {
        use wiremock::{Mock, MockServer, ResponseTemplate, matchers::method};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(201)
                    .insert_header("x-openstack-request-id", "req-up")
                    .set_body_json(
                        serde_json::json!({"server": {"id": "s1", "adminPass": "generated"}}),
                    ),
            )
            .mount(&server)
            .await;
        let out = Captured::default();
        let w = out.clone();
        let sub = tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
            .with_writer(move || w.clone())
            .with_ansi(false)
            .finish();
        let _guard = tracing::subscriber::set_default(sub);
        let rb = reqwest::Client::new()
            .post(format!("{}/v2.1/servers", server.uri()))
            .json(&serde_json::json!({"server": {"name": "vm", "adminPass": "chosen"}}));
        let res = send("compute", rb).await.unwrap();
        let body: serde_json::Value = res.json().await.unwrap();
        let log = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
        (log, body)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn debug_logs_both_bodies_and_the_response_stays_readable() {
        let (log, body) = call_with_filter("rassvet::openstack=debug").await;
        assert!(
            log.contains("OpenStack request") && log.contains(r#"\"name\":\"vm\""#),
            "{log}"
        );
        assert!(
            log.contains("OpenStack response") && log.contains(r#"\"id\":\"s1\""#),
            "{log}"
        );
        assert!(
            log.contains("upstream_request_id=\"req-up\"")
                || log.contains("upstream_request_id=req-up"),
            "{log}"
        );
        assert!(
            !log.contains("chosen") && !log.contains("generated"),
            "{log}"
        );
        // The caller still gets the whole body, secrets included.
        assert_eq!(body["server"]["adminPass"], "generated");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn each_direction_has_its_own_target() {
        let (log, _) =
            call_with_filter("rassvet::openstack=info,rassvet::openstack::request=debug").await;
        assert!(
            log.contains("OpenStack request") && !log.contains("OpenStack response"),
            "{log}"
        );
        assert!(log.contains("OpenStack call"), "{log}");
        let (log, body) = call_with_filter("rassvet::openstack=info").await;
        assert!(
            !log.contains("OpenStack request") && !log.contains("OpenStack response"),
            "{log}"
        );
        assert_eq!(body["server"]["id"], "s1");
    }

    #[tokio::test]
    async fn scope_sets_current() {
        assert_eq!(current(), None);
        let got = scope("req-x".into(), async { current() }).await;
        assert_eq!(got.as_deref(), Some("req-x"));
    }
}
