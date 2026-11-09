//! Minimal VMware vSphere client used by the dashboard server.
//!
//! * **vCenter Server** (7.0 U2 and later): the vSphere Automation REST API under `/api`
//!   (`POST /api/session` → `vmware-api-session-id`, then `/api/vcenter/...`).
//! * **ESXi** (standalone host): no REST API, so sign-in uses the vim25 SOAP endpoint `/sdk`
//!   (`SessionManager.Login` → `vmware_soap_session` cookie).
//!
//! Both answer `RetrieveServiceContent` without a session, which tells what the endpoint is.

pub mod error;
mod soap;

use reqwest::{StatusCode, header};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub use error::{Error, Result};

/// Which vSphere product an endpoint is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Product {
    Vcenter,
    Esxi,
}

/// `ServiceContent.about` of a vCenter or ESXi endpoint.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct About {
    pub name: String,
    pub full_name: String,
    pub version: String,
    pub build: String,
    /// `VirtualCenter` (vCenter) or `HostAgent` (ESXi).
    pub api_type: String,
    pub api_version: String,
    #[serde(default)]
    pub instance_uuid: Option<String>,
}

/// A signed-in vSphere session. Holds a secret (`id`): keep it on the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub product: Product,
    /// vCenter: the `vmware-api-session-id`; ESXi: the `vmware_soap_session` cookie value.
    pub id: String,
    /// User name as the endpoint knows it, e.g. `VSPHERE.LOCAL\Administrator` or `root`.
    pub user: String,
    pub about: About,
    /// ESXi: managed object id of the SessionManager (for logout).
    #[serde(default)]
    pub session_manager: Option<String>,
}

/// Header carrying the vCenter REST session.
pub const SESSION_HEADER: &str = "vmware-api-session-id";

#[derive(Clone)]
pub struct Vsphere {
    http: reqwest::Client,
    base: String,
}

impl Vsphere {
    /// `url` is the endpoint's base, e.g. `https://vcenter.example.com` (a trailing `/sdk`
    /// or `/api` is ignored).
    pub fn new(http: reqwest::Client, url: &str) -> Self {
        let mut base = url.trim().trim_end_matches('/').to_owned();
        for suffix in ["/sdk", "/api", "/ui"] {
            if let Some(b) = base.strip_suffix(suffix) {
                base = b.to_owned();
            }
        }
        Self { http, base }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// What the endpoint is (no session needed).
    pub async fn about(&self) -> Result<About> {
        Ok(soap::service_content(&self.http, &self.base).await?.about)
    }

    /// Sign in with a user name and password.
    pub async fn login(&self, product: Product, username: &str, password: &str) -> Result<Session> {
        match product {
            Product::Vcenter => self.login_vcenter(username, password).await,
            Product::Esxi => self.login_esxi(username, password).await,
        }
    }

    async fn login_vcenter(&self, username: &str, password: &str) -> Result<Session> {
        let resp = self
            .http
            .post(format!("{}/api/session", self.base))
            .basic_auth(username, Some(password))
            .send()
            .await?;
        let resp = error::check(resp).await?;
        let id: String = resp
            .json()
            .await
            .map_err(|e| Error::InvalidResponse(format!("session id: {e}")))?;
        let mut session = Session {
            product: Product::Vcenter,
            id,
            user: username.to_owned(),
            about: About::default(),
            session_manager: None,
        };
        // Best effort: the user name as vCenter spells it, and the product details.
        if let Ok(info) = self.get::<SessionInfo>(&session, "/api/session").await {
            session.user = info.user;
        }
        match self.about().await {
            Ok(about) => session.about = about,
            Err(e) => {
                tracing::debug!(error = %e, "vCenter about not available");
                session.about.name = "VMware vCenter Server".into();
                session.about.api_type = "VirtualCenter".into();
            }
        }
        Ok(session)
    }

    async fn login_esxi(&self, username: &str, password: &str) -> Result<Session> {
        let sc = soap::service_content(&self.http, &self.base).await?;
        let (cookie, user) = soap::login(
            &self.http,
            &self.base,
            &sc.session_manager,
            username,
            password,
        )
        .await?;
        Ok(Session {
            product: Product::Esxi,
            id: cookie,
            user,
            about: sc.about,
            session_manager: Some(sc.session_manager),
        })
    }

    /// End the session on the endpoint.
    pub async fn logout(&self, s: &Session) -> Result<()> {
        match s.product {
            Product::Vcenter => {
                let resp = self
                    .http
                    .delete(format!("{}/api/session", self.base))
                    .header(SESSION_HEADER, &s.id)
                    .send()
                    .await?;
                error::check(resp).await.map(|_| ())
            }
            Product::Esxi => {
                let sm = s.session_manager.as_deref().unwrap_or("ha-sessionmgr");
                soap::logout(&self.http, &self.base, sm, &s.id).await
            }
        }
    }

    /// GET a vCenter REST resource with the session.
    pub async fn get<T: DeserializeOwned>(&self, s: &Session, path: &str) -> Result<T> {
        if s.product != Product::Vcenter {
            return Err(Error::Api {
                status: StatusCode::NOT_IMPLEMENTED,
                message: "standalone ESXi hosts have no REST API".into(),
            });
        }
        let resp = self
            .http
            .get(format!("{}{path}", self.base))
            .header(SESSION_HEADER, &s.id)
            .header(header::ACCEPT, "application/json")
            .send()
            .await?;
        error::check(resp)
            .await?
            .json()
            .await
            .map_err(|e| Error::InvalidResponse(format!("{path}: {e}")))
    }

    pub async fn vms(&self, s: &Session) -> Result<Vec<VmSummary>> {
        self.get(s, "/api/vcenter/vm").await
    }

    pub async fn hosts(&self, s: &Session) -> Result<Vec<HostSummary>> {
        self.get(s, "/api/vcenter/host").await
    }

    pub async fn clusters(&self, s: &Session) -> Result<Vec<ClusterSummary>> {
        self.get(s, "/api/vcenter/cluster").await
    }

    pub async fn datacenters(&self, s: &Session) -> Result<Vec<DatacenterSummary>> {
        self.get(s, "/api/vcenter/datacenter").await
    }

    pub async fn datastores(&self, s: &Session) -> Result<Vec<DatastoreSummary>> {
        self.get(s, "/api/vcenter/datastore").await
    }

    pub async fn networks(&self, s: &Session) -> Result<Vec<NetworkSummary>> {
        self.get(s, "/api/vcenter/network").await
    }
}

#[derive(Debug, Deserialize)]
struct SessionInfo {
    user: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VmSummary {
    pub vm: String,
    pub name: String,
    /// `POWERED_ON`, `POWERED_OFF` or `SUSPENDED`.
    pub power_state: String,
    #[serde(default)]
    pub cpu_count: Option<u32>,
    #[serde(default, rename = "memory_size_MiB")]
    pub memory_size_mib: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostSummary {
    pub host: String,
    pub name: String,
    /// `CONNECTED`, `DISCONNECTED` or `NOT_RESPONDING`.
    pub connection_state: String,
    #[serde(default)]
    pub power_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterSummary {
    pub cluster: String,
    pub name: String,
    #[serde(default)]
    pub ha_enabled: bool,
    #[serde(default)]
    pub drs_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatacenterSummary {
    pub datacenter: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatastoreSummary {
    pub datastore: String,
    pub name: String,
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub free_space: Option<u64>,
    #[serde(default)]
    pub capacity: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkSummary {
    pub network: String,
    pub name: String,
    /// `STANDARD_PORTGROUP`, `DISTRIBUTED_PORTGROUP` or `OPAQUE_NETWORK`.
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_string_contains, header as h, method, path},
    };

    const SERVICE_CONTENT: &str = r#"<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><RetrieveServiceContentResponse xmlns="urn:vim25"><returnval><rootFolder type="Folder">ha-folder-root</rootFolder><about><name>VMware ESXi</name><fullName>VMware ESXi 8.0.3 build-24022510</fullName><vendor>VMware, Inc.</vendor><version>8.0.3</version><build>24022510</build><apiType>HostAgent</apiType><apiVersion>8.0.3.0</apiVersion></about><sessionManager type="SessionManager">ha-sessionmgr</sessionManager></returnval></RetrieveServiceContentResponse></soapenv:Body></soapenv:Envelope>"#;

    async fn soap_server() -> MockServer {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/sdk"))
            .and(body_string_contains("RetrieveServiceContent"))
            .respond_with(ResponseTemplate::new(200).set_body_string(SERVICE_CONTENT))
            .mount(&s)
            .await;
        s
    }

    #[tokio::test]
    async fn esxi_login_and_logout() {
        let s = soap_server().await;
        Mock::given(method("POST"))
            .and(path("/sdk"))
            .and(body_string_contains("<urn:password>s3cret&amp;</urn:password>"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("Set-Cookie", r#"vmware_soap_session="abc123"; Path=/; HttpOnly"#)
                    .set_body_string("<LoginResponse><returnval><userName>root</userName></returnval></LoginResponse>"),
            )
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/sdk"))
            .and(body_string_contains("<urn:Login>"))
            .respond_with(ResponseTemplate::new(500).set_body_string(
                "<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>Cannot complete login due to an incorrect user name or password.</faultstring><detail><InvalidLoginFault/></detail></soapenv:Fault>",
            ))
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/sdk"))
            .and(body_string_contains("<urn:Logout>"))
            .and(h("cookie", r#"vmware_soap_session="abc123""#))
            .respond_with(ResponseTemplate::new(200).set_body_string("<LogoutResponse/>"))
            .expect(1)
            .mount(&s)
            .await;

        let v = Vsphere::new(reqwest::Client::new(), &format!("{}/sdk/", s.uri()));
        let session = v.login(Product::Esxi, "root", "s3cret&").await.unwrap();
        assert_eq!(session.id, r#""abc123""#);
        assert_eq!(session.user, "root");
        assert_eq!(session.about.api_type, "HostAgent");
        assert_eq!(session.about.version, "8.0.3");
        assert_eq!(session.session_manager.as_deref(), Some("ha-sessionmgr"));
        v.logout(&session).await.unwrap();

        let err = v.login(Product::Esxi, "root", "wrong").await.unwrap_err();
        assert!(matches!(err, Error::Unauthorized(_)), "{err:?}");
        assert!(err.to_string().contains("incorrect user name"));
    }

    #[tokio::test]
    async fn vcenter_login_and_inventory() {
        let s = soap_server().await;
        Mock::given(method("POST"))
            .and(path("/api/session"))
            .and(h(
                "authorization",
                "Basic YWRtaW5pc3RyYXRvckB2c3BoZXJlLmxvY2FsOnB3",
            ))
            .respond_with(ResponseTemplate::new(201).set_body_json("sess-1"))
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/session"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error_type": "UNAUTHENTICATED",
                "messages": [{"id": "x", "default_message": "Authentication required."}]
            })))
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/session"))
            .and(h(SESSION_HEADER, "sess-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"user": "VSPHERE.LOCAL\\Administrator", "created_time": "2026-01-01T00:00:00Z"}),
            ))
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/vcenter/vm"))
            .and(h(SESSION_HEADER, "sess-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"vm": "vm-1", "name": "web", "power_state": "POWERED_ON", "cpu_count": 2, "memory_size_MiB": 4096},
                {"vm": "vm-2", "name": "db", "power_state": "POWERED_OFF"}
            ])))
            .mount(&s)
            .await;

        let v = Vsphere::new(reqwest::Client::new(), &s.uri());
        let session = v
            .login(Product::Vcenter, "administrator@vsphere.local", "pw")
            .await
            .unwrap();
        assert_eq!(session.id, "sess-1");
        assert_eq!(session.user, "VSPHERE.LOCAL\\Administrator");
        let vms = v.vms(&session).await.unwrap();
        assert_eq!(vms.len(), 2);
        assert_eq!(vms[0].memory_size_mib, Some(4096));

        let err = v
            .login(Product::Vcenter, "administrator@vsphere.local", "bad")
            .await
            .unwrap_err();
        assert!(
            matches!(err, Error::Unauthorized(ref m) if m == "Authentication required."),
            "{err:?}"
        );
    }
}
