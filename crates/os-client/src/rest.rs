//! Generic authenticated JSON client for one OpenStack service endpoint.
//! Service modules (image, later compute/network/...) build on this.

use std::time::Duration;

use reqwest::{Method, RequestBuilder, Response};
use serde_json::Value;

use crate::{Error, Result};

/// Timeout for long transfers (image upload/download). Normal calls use the
/// client's default timeout.
pub const TRANSFER_TIMEOUT: Duration = Duration::from_secs(6 * 3600);

#[derive(Debug, Clone)]
pub struct Rest {
    http: reqwest::Client,
    base: String,
    token: String,
    service: &'static str,
}

impl Rest {
    /// `base` is the versioned API root, e.g. `https://glance:9292/v2`.
    pub fn new(
        http: reqwest::Client,
        base: impl Into<String>,
        token: &str,
        service: &'static str,
    ) -> Self {
        Self {
            http,
            base: base.into().trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            service,
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// Request builder for `base + path` (or an absolute URL) with the token attached.
    pub fn request(&self, method: Method, path: &str) -> RequestBuilder {
        let url = if path.starts_with("http://") || path.starts_with("https://") {
            path.to_owned()
        } else {
            format!("{}{}", self.base, path)
        };
        self.http
            .request(method, url)
            .header("X-Auth-Token", &self.token)
    }

    /// Send and turn non-2xx into [`Error::Api`]; returns the raw response.
    pub async fn send(&self, rb: RequestBuilder) -> Result<Response> {
        crate::trace::send(self.service, rb).await
    }

    /// Send and parse a JSON body; empty / 204 responses become `Value::Null`.
    pub async fn json(&self, rb: RequestBuilder) -> Result<Value> {
        let resp = self.send(rb).await?;
        if resp.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        let bytes = resp.bytes().await?;
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|e| Error::InvalidResponse(e.to_string()))
    }

    pub async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        self.json(self.request(Method::GET, path).query(query))
            .await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        self.json(self.request(Method::POST, path).json(body)).await
    }

    pub async fn put(&self, path: &str, body: &Value) -> Result<Value> {
        self.json(self.request(Method::PUT, path).json(body)).await
    }

    pub async fn delete(&self, path: &str) -> Result<()> {
        self.json(self.request(Method::DELETE, path))
            .await
            .map(|_| ())
    }
}
