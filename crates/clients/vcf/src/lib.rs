//! Minimal VMware Cloud Foundation client: SDDC Manager public API (`/v1`).
//!
//! Sign-in: `POST /v1/tokens` with a vCenter SSO user (e.g. `administrator@vsphere.local`)
//! gives a short-lived access token (JWT, sent as `Authorization: Bearer`) and a refresh token
//! (`PATCH /v1/tokens/access-token/refresh`) that lasts much longer.

use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use reqwest::{StatusCode, header};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("transport error: {0}")]
    Http(#[from] reqwest::Error),

    /// The user name or password was refused, or the token is no longer valid.
    #[error("{0}")]
    Unauthorized(String),

    #[error("SDDC Manager API error {status}: {message}")]
    Api { status: StatusCode, message: String },

    #[error("invalid response: {0}")]
    InvalidResponse(String),
}

impl Error {
    pub fn status(&self) -> Option<StatusCode> {
        match self {
            Error::Unauthorized(_) => Some(StatusCode::UNAUTHORIZED),
            Error::Api { status, .. } => Some(*status),
            Error::Http(e) => e.status(),
            Error::InvalidResponse(_) => None,
        }
    }
}

/// SDDC Manager error bodies: `{"errorCode": "…", "message": "…", "remediationMessage": "…"}`.
async fn check(resp: reqwest::Response) -> Result<reqwest::Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v["message"]
                .as_str()
                .or_else(|| v["errorCode"].as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| {
            let t = body.trim();
            if t.is_empty() {
                status.canonical_reason().unwrap_or("error").to_owned()
            } else {
                t.chars().take(300).collect()
            }
        });
    Err(match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN if message.is_empty() => {
            Error::Unauthorized("access denied".into())
        }
        StatusCode::UNAUTHORIZED => Error::Unauthorized(message),
        _ => Error::Api { status, message },
    })
}

/// Tokens of a signed-in SDDC Manager user. Holds secrets: keep it on the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    /// When the access token expires (from its JWT `exp`, else one hour after issue).
    pub access_expires_at: DateTime<Utc>,
}

impl Tokens {
    /// Expired, or about to (a minute of margin for clock skew and slow calls).
    pub fn access_expired(&self) -> bool {
        self.access_expires_at - Duration::seconds(60) <= Utc::now()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenPair {
    access_token: String,
    refresh_token: RefreshToken,
}

#[derive(Serialize, Deserialize)]
struct RefreshToken {
    id: String,
}

/// A page of SDDC Manager results.
#[derive(Debug, Deserialize)]
pub struct Page<T> {
    #[serde(default = "Vec::new")]
    pub elements: Vec<T>,
}

#[derive(Clone)]
pub struct Vcf {
    http: reqwest::Client,
    base: String,
}

impl Vcf {
    /// `url` is the SDDC Manager, e.g. `https://sddc-manager.example.com` (a trailing `/v1`
    /// is ignored).
    pub fn new(http: reqwest::Client, url: &str) -> Self {
        let mut base = url.trim().trim_end_matches('/').to_owned();
        if let Some(b) = base.strip_suffix("/v1") {
            base = b.to_owned();
        }
        Self { http, base }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub async fn login(&self, username: &str, password: &str) -> Result<Tokens> {
        let resp = self
            .http
            .post(format!("{}/v1/tokens", self.base))
            .json(&serde_json::json!({ "username": username, "password": password }))
            .send()
            .await?;
        let pair: TokenPair = check(resp)
            .await?
            .json()
            .await
            .map_err(|e| Error::InvalidResponse(format!("tokens: {e}")))?;
        Ok(Tokens {
            access_expires_at: jwt_expiry(&pair.access_token)
                .unwrap_or_else(|| Utc::now() + Duration::hours(1)),
            access_token: pair.access_token,
            refresh_token: pair.refresh_token.id,
        })
    }

    /// A new access token from the refresh token.
    pub async fn refresh(&self, t: &Tokens) -> Result<Tokens> {
        let resp = self
            .http
            .patch(format!("{}/v1/tokens/access-token/refresh", self.base))
            .json(&t.refresh_token)
            .send()
            .await?;
        let access: String = check(resp)
            .await?
            .json()
            .await
            .map_err(|e| Error::InvalidResponse(format!("refreshed token: {e}")))?;
        Ok(Tokens {
            access_expires_at: jwt_expiry(&access)
                .unwrap_or_else(|| Utc::now() + Duration::hours(1)),
            access_token: access,
            refresh_token: t.refresh_token.clone(),
        })
    }

    /// Invalidate the refresh token (best effort: the access token expires by itself).
    pub async fn logout(&self, t: &Tokens) -> Result<()> {
        let resp = self
            .http
            .delete(format!("{}/v1/tokens/refresh-token", self.base))
            .bearer_auth(&t.access_token)
            .json(&RefreshToken {
                id: t.refresh_token.clone(),
            })
            .send()
            .await?;
        check(resp).await.map(|_| ())
    }

    pub async fn get<T: DeserializeOwned>(&self, t: &Tokens, path: &str) -> Result<T> {
        let resp = self
            .http
            .get(format!("{}{path}", self.base))
            .bearer_auth(&t.access_token)
            .header(header::ACCEPT, "application/json")
            .send()
            .await?;
        check(resp)
            .await?
            .json()
            .await
            .map_err(|e| Error::InvalidResponse(format!("{path}: {e}")))
    }

    pub async fn sddc_managers(&self, t: &Tokens) -> Result<Vec<SddcManager>> {
        Ok(self.get::<Page<_>>(t, "/v1/sddc-managers").await?.elements)
    }

    pub async fn domains(&self, t: &Tokens) -> Result<Vec<Domain>> {
        Ok(self.get::<Page<_>>(t, "/v1/domains").await?.elements)
    }

    pub async fn clusters(&self, t: &Tokens) -> Result<Vec<Named>> {
        Ok(self.get::<Page<_>>(t, "/v1/clusters").await?.elements)
    }

    pub async fn hosts(&self, t: &Tokens) -> Result<Vec<Host>> {
        Ok(self.get::<Page<_>>(t, "/v1/hosts").await?.elements)
    }

    pub async fn vcenters(&self, t: &Tokens) -> Result<Vec<Named>> {
        Ok(self.get::<Page<_>>(t, "/v1/vcenters").await?.elements)
    }

    pub async fn nsxt_clusters(&self, t: &Tokens) -> Result<Vec<Named>> {
        Ok(self.get::<Page<_>>(t, "/v1/nsxt-clusters").await?.elements)
    }
}

/// The `exp` claim of a JWT (not verified: only used to know when to refresh).
fn jwt_expiry(token: &str) -> Option<DateTime<Utc>> {
    let payload = token.split('.').nth(1)?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let exp = serde_json::from_slice::<serde_json::Value>(&raw).ok()?["exp"].as_i64()?;
    DateTime::from_timestamp(exp, 0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SddcManager {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub fqdn: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Domain {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// `MANAGEMENT` or `VI`.
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Host {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub fqdn: Option<String>,
    /// `ASSIGNED`, `UNASSIGNED_USEABLE`, `UNASSIGNED_UNUSEABLE`.
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Named {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub fqdn: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_json, header as h, method, path},
    };

    fn jwt(exp: i64) -> String {
        let e = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!(
            "{}.{}.sig",
            e.encode(br#"{"alg":"HS256"}"#),
            e.encode(format!(r#"{{"sub":"admin","exp":{exp}}}"#))
        )
    }

    #[tokio::test]
    async fn login_refresh_and_inventory() {
        let s = MockServer::start().await;
        let exp = Utc::now().timestamp() + 3600;
        Mock::given(method("POST"))
            .and(path("/v1/tokens"))
            .and(body_json(
                serde_json::json!({"username": "administrator@vsphere.local", "password": "pw"}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": jwt(exp), "refreshToken": {"id": "r-1"}
            })))
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/tokens"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "errorCode": "AUTHENTICATION_FAILED", "message": "Invalid credentials"
            })))
            .mount(&s)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/v1/tokens/access-token/refresh"))
            .and(body_json(serde_json::json!("r-1")))
            .respond_with(ResponseTemplate::new(200).set_body_json(jwt(exp + 60)))
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/domains"))
            .and(h("authorization", format!("Bearer {}", jwt(exp)).as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "elements": [{"id": "d1", "name": "mgmt", "type": "MANAGEMENT"}, {"id": "d2", "name": "wld01", "type": "VI"}]
            })))
            .mount(&s)
            .await;

        let v = Vcf::new(reqwest::Client::new(), &format!("{}/v1/", s.uri()));
        let t = v.login("administrator@vsphere.local", "pw").await.unwrap();
        assert_eq!(t.refresh_token, "r-1");
        assert_eq!(t.access_expires_at.timestamp(), exp);
        assert!(!t.access_expired());
        let domains = v.domains(&t).await.unwrap();
        assert_eq!(domains.len(), 2);
        assert_eq!(domains[1].kind.as_deref(), Some("VI"));

        let t2 = v.refresh(&t).await.unwrap();
        assert_eq!(t2.access_expires_at.timestamp(), exp + 60);

        let err = v
            .login("administrator@vsphere.local", "bad")
            .await
            .unwrap_err();
        assert!(
            matches!(err, Error::Unauthorized(ref m) if m == "Invalid credentials"),
            "{err:?}"
        );
    }

    #[test]
    fn expiry_without_jwt_falls_back() {
        assert!(jwt_expiry("opaque-token").is_none());
        assert_eq!(
            jwt_expiry(&jwt(1_900_000_000)).unwrap().timestamp(),
            1_900_000_000
        );
    }
}
