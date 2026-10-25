//! Keystone v3 authentication (password, application credential, token re-scope).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{Catalog, Result};

/// How the user proves their identity.
#[derive(Debug, Clone)]
pub enum AuthMethod {
    Password {
        username: String,
        password: String,
        user_domain: String,
    },
    ApplicationCredential {
        id: String,
        secret: String,
    },
    /// Re-scope an existing token (used for project switching).
    Token(String),
}

/// What the token should be scoped to.
#[derive(Debug, Clone, Default)]
pub enum Scope {
    #[default]
    Unscoped,
    ProjectId(String),
    DomainId(String),
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdName {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub domain: Option<IdName>,
}

/// A validated Keystone token plus the information the dashboard needs from it.
#[derive(Debug, Clone, Serialize)]
pub struct Token {
    #[serde(skip_serializing)]
    pub value: String,
    pub expires_at: DateTime<Utc>,
    pub user: ProjectRef,
    pub project: Option<ProjectRef>,
    pub domain: Option<IdName>,
    pub system: bool,
    pub roles: Vec<IdName>,
    pub methods: Vec<String>,
    #[serde(skip_serializing)]
    pub catalog: Catalog,
}

impl Token {
    pub fn is_expired(&self) -> bool {
        self.expires_at <= Utc::now() + chrono::Duration::seconds(30)
    }

    pub fn has_role(&self, role: &str) -> bool {
        self.roles.iter().any(|r| r.name.eq_ignore_ascii_case(role))
    }
}

#[derive(Deserialize)]
struct TokenBody {
    token: RawToken,
}

#[derive(Deserialize)]
struct RawToken {
    expires_at: DateTime<Utc>,
    user: ProjectRef,
    #[serde(default)]
    project: Option<ProjectRef>,
    #[serde(default)]
    domain: Option<IdName>,
    #[serde(default)]
    system: Option<serde_json::Value>,
    #[serde(default)]
    roles: Vec<IdName>,
    #[serde(default)]
    methods: Vec<String>,
    #[serde(default)]
    catalog: Catalog,
}

/// Keystone client bound to one cloud's auth URL.
#[derive(Debug, Clone)]
pub struct Keystone {
    http: reqwest::Client,
    base: String,
}

impl Keystone {
    /// `auth_url` may be given with or without the trailing `/v3`.
    pub fn new(http: reqwest::Client, auth_url: &str) -> Self {
        let base = auth_url.trim_end_matches('/');
        let base = base.strip_suffix("/v3").unwrap_or(base).to_owned();
        Self { http, base }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// `POST /v3/auth/tokens`
    pub async fn authenticate(&self, method: &AuthMethod, scope: &Scope) -> Result<Token> {
        let identity = match method {
            AuthMethod::Password {
                username,
                password,
                user_domain,
            } => json!({
                "methods": ["password"],
                "password": {"user": {
                    "name": username,
                    "domain": {"name": user_domain},
                    "password": password,
                }}
            }),
            AuthMethod::ApplicationCredential { id, secret } => json!({
                "methods": ["application_credential"],
                "application_credential": {"id": id, "secret": secret}
            }),
            AuthMethod::Token(t) => json!({"methods": ["token"], "token": {"id": t}}),
        };
        let mut auth = json!({ "identity": identity });
        // Application credentials are already scoped; Keystone rejects an explicit scope.
        if !matches!(method, AuthMethod::ApplicationCredential { .. }) {
            match scope {
                Scope::Unscoped => {}
                Scope::ProjectId(id) => auth["scope"] = json!({"project": {"id": id}}),
                Scope::DomainId(id) => auth["scope"] = json!({"domain": {"id": id}}),
                Scope::System => auth["scope"] = json!({"system": {"all": true}}),
            }
        }

        let req = self
            .http
            .post(format!("{}/v3/auth/tokens", self.base))
            .json(&json!({ "auth": auth }));
        let resp = crate::trace::send("identity", req).await?;
        let value = resp
            .headers()
            .get("x-subject-token")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| crate::Error::InvalidResponse("missing X-Subject-Token".into()))?;
        let body: TokenBody = resp.json().await?;
        let t = body.token;
        Ok(Token {
            value,
            expires_at: t.expires_at,
            user: t.user,
            project: t.project,
            domain: t.domain,
            system: t.system.is_some(),
            roles: t.roles,
            methods: t.methods,
            catalog: t.catalog,
        })
    }

    /// `GET /v3/auth/projects` — projects the token's user can scope to.
    pub async fn list_auth_projects(&self, token: &str) -> Result<Vec<ProjectRef>> {
        #[derive(Deserialize)]
        struct Body {
            projects: Vec<AuthProject>,
        }
        #[derive(Deserialize)]
        struct AuthProject {
            id: String,
            name: String,
            #[serde(default)]
            domain_id: Option<String>,
            #[serde(default = "yes")]
            enabled: bool,
        }
        fn yes() -> bool {
            true
        }
        let req = self
            .http
            .get(format!("{}/v3/auth/projects", self.base))
            .header("X-Auth-Token", token);
        let body: Body = crate::trace::send("identity", req).await?.json().await?;
        let mut out: Vec<ProjectRef> = body
            .projects
            .into_iter()
            .filter(|p| p.enabled)
            .map(|p| ProjectRef {
                id: p.id,
                name: p.name,
                domain: p.domain_id.map(|id| IdName {
                    name: id.clone(),
                    id,
                }),
            })
            .collect();
        out.sort_by_key(|p| p.name.to_lowercase());
        Ok(out)
    }

    /// `DELETE /v3/auth/tokens` — revoke a token on logout (best effort).
    pub async fn revoke(&self, token: &str) -> Result<()> {
        let req = self
            .http
            .delete(format!("{}/v3/auth/tokens", self.base))
            .header("X-Auth-Token", token)
            .header("X-Subject-Token", token);
        crate::trace::send("identity", req).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn token_json() -> serde_json::Value {
        json!({"token": {
            "expires_at": "2099-01-01T00:00:00.000000Z",
            "methods": ["password"],
            "user": {"id": "u1", "name": "alice", "domain": {"id": "default", "name": "Default"}},
            "project": {"id": "p1", "name": "demo", "domain": {"id": "default", "name": "Default"}},
            "roles": [{"id": "r1", "name": "member"}],
            "catalog": [{"type": "compute", "endpoints": [
                {"interface": "public", "region_id": "RegionOne", "url": "https://nova/v2.1"}]}]
        }})
    }

    #[tokio::test]
    async fn password_auth_scoped() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v3/auth/tokens"))
            .and(body_partial_json(json!({"auth": {
                "identity": {"methods": ["password"]},
                "scope": {"project": {"id": "p1"}}}})))
            .respond_with(
                ResponseTemplate::new(201)
                    .insert_header("X-Subject-Token", "tok123")
                    .set_body_json(token_json()),
            )
            .mount(&server)
            .await;

        let ks = Keystone::new(reqwest::Client::new(), &format!("{}/v3/", server.uri()));
        let t = ks
            .authenticate(
                &AuthMethod::Password {
                    username: "alice".into(),
                    password: "secret".into(),
                    user_domain: "Default".into(),
                },
                &Scope::ProjectId("p1".into()),
            )
            .await
            .unwrap();
        assert_eq!(t.value, "tok123");
        assert_eq!(t.project.as_ref().unwrap().name, "demo");
        assert!(t.has_role("Member"));
        assert!(!t.is_expired());
        assert!(t.catalog.has_service("compute", Some("RegionOne")));
    }

    #[tokio::test]
    async fn auth_failure_maps_to_api_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v3/auth/tokens"))
            .respond_with(
                ResponseTemplate::new(401)
                    .insert_header("x-openstack-request-id", "req-abc")
                    .set_body_json(json!({"error": {"code": 401, "message": "The request you have made requires authentication."}})),
            )
            .mount(&server)
            .await;
        let ks = Keystone::new(reqwest::Client::new(), &server.uri());
        let err = ks
            .authenticate(
                &AuthMethod::ApplicationCredential {
                    id: "x".into(),
                    secret: "y".into(),
                },
                &Scope::Unscoped,
            )
            .await
            .unwrap_err();
        assert_eq!(err.status().map(|s| s.as_u16()), Some(401));
        assert_eq!(err.request_id(), Some("req-abc"));
    }

    #[tokio::test]
    async fn lists_projects() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v3/auth/projects"))
            .and(header("X-Auth-Token", "t"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"projects": [
                    {"id": "b", "name": "zeta", "domain_id": "default", "enabled": true},
                    {"id": "a", "name": "Alpha", "domain_id": "default", "enabled": true},
                    {"id": "c", "name": "off", "domain_id": "default", "enabled": false}
                ]})),
            )
            .mount(&server)
            .await;
        let ks = Keystone::new(reqwest::Client::new(), &server.uri());
        let p = ks.list_auth_projects("t").await.unwrap();
        assert_eq!(
            p.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["Alpha", "zeta"]
        );
    }
}
