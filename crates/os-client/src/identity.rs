//! Thin Keystone v3 resource client (users, projects, roles, assignments,
//! application credentials, catalog management).
//!
//! Responses are returned as raw JSON so the dashboard passes Keystone's own
//! documents through unchanged; request bodies are built by typed callers.

use reqwest::Method;
use serde_json::Value;

use crate::{Error, Result};

#[derive(Debug, Clone)]
pub struct Identity {
    http: reqwest::Client,
    base: String,
    token: String,
}

/// Turn any identity endpoint form (`https://ks:5000`, `.../v3`, `.../v3/`) into `.../v3`.
pub fn v3_url(endpoint: &str) -> String {
    let e = endpoint.trim_end_matches('/');
    let e = e.strip_suffix("/v3").unwrap_or(e);
    format!("{e}/v3")
}

/// Validate a resource id before putting it in a URL path, so a crafted id can never
/// address a different Keystone resource (e.g. `../`, `?`, `#`, `%2F`).
pub fn seg(id: &str) -> Result<&str> {
    let ok = !id.is_empty()
        && id.len() <= 255
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'@'));
    if ok {
        Ok(id)
    } else {
        Err(Error::InvalidInput(format!("invalid id '{id}'")))
    }
}

impl Identity {
    pub fn new(http: reqwest::Client, endpoint: &str, token: &str) -> Self {
        Self {
            http,
            base: v3_url(endpoint),
            token: token.to_owned(),
        }
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<Value> {
        let mut req = self
            .http
            .request(method, format!("{}{}", self.base, path))
            .header("X-Auth-Token", &self.token)
            .query(query);
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = crate::trace::send("identity", req).await?;
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
        self.call(Method::GET, path, query, None).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        self.call(Method::POST, path, &[], Some(body)).await
    }

    pub async fn patch(&self, path: &str, body: &Value) -> Result<Value> {
        self.call(Method::PATCH, path, &[], Some(body)).await
    }

    pub async fn put(&self, path: &str) -> Result<()> {
        self.call(Method::PUT, path, &[], None).await.map(|_| ())
    }

    pub async fn delete(&self, path: &str) -> Result<()> {
        self.call(Method::DELETE, path, &[], None).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn url_and_segments() {
        assert_eq!(v3_url("https://ks:5000/"), "https://ks:5000/v3");
        assert_eq!(v3_url("https://ks/identity/v3/"), "https://ks/identity/v3");
        assert!(seg("4b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e").is_ok());
        assert!(seg("default").is_ok());
        for bad in ["", "..", "a/b", "a?b", "a%2Fb", "a#b", "a b"] {
            assert!(seg(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn get_and_no_content() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v3/users"))
            .and(query_param("domain_id", "default"))
            .and(header("X-Auth-Token", "tok"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"users": []})))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v3/projects/p/users/u/roles/r"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let id = Identity::new(reqwest::Client::new(), &server.uri(), "tok");
        let v = id.get("/users", &[("domain_id", "default")]).await.unwrap();
        assert_eq!(v["users"], json!([]));
        id.put("/projects/p/users/u/roles/r").await.unwrap();
    }
}
