//! `POST /api/ext/magnum/clusters/{id}/kubeconfig`: a kubeconfig for a Kubernetes cluster,
//! built like `openstack coe cluster config`.
//!
//! * `auth: "cert"` (default): a new ECDSA P-256 key and a CSR (`CN=<user>`,
//!   `O=system:masters`, i.e. cluster-admin) are made here and signed by the cluster CA
//!   through Magnum (`POST /certificates`). The key is only in the response.
//! * `auth: "keystone"`: for clusters with `keystone_auth_enabled`; the user section runs an
//!   exec plugin that hands `$OS_TOKEN` to the API server, so no certificate is issued.
//!
//! Clusters whose template has `tls_disabled` get a plain `http` server entry without a CA.

use base64::{Engine, engine::general_purpose::STANDARD as B64};
use rassvet_ext_api::{
    ApiError, RequestContext,
    axum::{
        Json,
        extract::Path,
        http::{Method, StatusCode},
    },
    gateway::{self, valid_id},
};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::SERVICE;

#[derive(Debug, Default, Deserialize)]
pub struct Request {
    #[serde(default)]
    auth: Auth,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Auth {
    #[default]
    Cert,
    Keystone,
}

/// The client certificate's subject: the Rassvet user and the cluster-admin group.
fn csr(user: &str) -> Result<(String, String), rcgen::Error> {
    let key = KeyPair::generate()?;
    let mut params = CertificateParams::new(Vec::<String>::new())?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, user);
    dn.push(DnType::OrganizationName, "system:masters");
    params.distinguished_name = dn;
    let csr = params.serialize_request(&key)?.pem()?;
    Ok((csr, key.serialize_pem()))
}

/// YAML scalar: JSON strings are valid YAML and need no further escaping.
fn q(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Shell snippet of the `keystone` exec plugin (same as python-magnumclient).
const KEYSTONE_EXEC: &str = r#"if [ -z ${OS_TOKEN} ]; then echo 'Error: Missing OpenStack credential from environment variable $OS_TOKEN' > /dev/stderr; exit 1; else echo '{ "apiVersion": "client.authentication.k8s.io/v1beta1", "kind": "ExecCredential", "status": { "token": "'"${OS_TOKEN}"'"}}'; fi"#;

struct Parts<'a> {
    name: &'a str,
    server: &'a str,
    ca_pem: Option<&'a str>,
    user: &'a str,
    /// (certificate PEM, key PEM) for `cert`, `None` for `keystone`.
    client: Option<(&'a str, &'a str)>,
}

fn render(p: &Parts) -> String {
    let ca = match p.ca_pem {
        Some(pem) => format!("    certificate-authority-data: {}\n", B64.encode(pem)),
        None => String::new(),
    };
    let user = match p.client {
        Some((cert, key)) => format!(
            "    client-certificate-data: {}\n    client-key-data: {}\n",
            B64.encode(cert),
            B64.encode(key)
        ),
        None => format!(
            "    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: /bin/bash\n      args:\n      - -c\n      - {}\n",
            q(KEYSTONE_EXEC)
        ),
    };
    let (name, user_name) = (q(p.name), q(p.user));
    format!(
        "apiVersion: v1\nkind: Config\nclusters:\n- name: {name}\n  cluster:\n{ca}    server: {server}\ncontexts:\n- name: {name}\n  context:\n    cluster: {name}\n    user: {user_name}\ncurrent-context: {name}\npreferences: {{}}\nusers:\n- name: {user_name}\n  user:\n{user}",
        server = q(p.server),
    )
}

fn bad(status: StatusCode, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, msg)
}

async fn get(ctx: &RequestContext, path: &str) -> Result<Value, ApiError> {
    Ok(gateway::call(ctx, &SERVICE, Method::GET, path, &[], None)
        .await?
        .1)
}

/// `/api/ext/magnum/clusters/{id}/kubeconfig` → `{"filename", "kubeconfig"}`
pub async fn handle(
    ctx: RequestContext,
    Path(id): Path<String>,
    body: Option<Json<Request>>,
) -> Result<Json<Value>, ApiError> {
    if !valid_id(&id) {
        return Err(bad(StatusCode::NOT_FOUND, "no such cluster"));
    }
    let auth = body.map(|b| b.0.auth).unwrap_or_default();
    let cluster = get(&ctx, &format!("clusters/{id}")).await?;
    let uuid = cluster["uuid"].as_str().unwrap_or(&id).to_owned();
    let name = cluster["name"].as_str().unwrap_or(&uuid).to_owned();
    let Some(server) = cluster["api_address"].as_str().filter(|s| !s.is_empty()) else {
        return Err(bad(
            StatusCode::CONFLICT,
            "the cluster has no API address yet; wait until it is created",
        ));
    };
    let template_id = cluster["cluster_template_id"].as_str().unwrap_or_default();
    if !valid_id(template_id) {
        return Err(bad(StatusCode::BAD_GATEWAY, "the cluster has no template"));
    }
    let template = get(&ctx, &format!("clustertemplates/{template_id}")).await?;
    if template["coe"].as_str() != Some("kubernetes") {
        return Err(bad(
            StatusCode::BAD_REQUEST,
            "a kubeconfig can only be made for Kubernetes clusters",
        ));
    }
    let tls = !template["tls_disabled"].as_bool().unwrap_or(false);
    if !tls && auth == Auth::Cert {
        return Err(bad(
            StatusCode::BAD_REQUEST,
            "TLS is disabled on this cluster, so it has no CA to sign a client certificate",
        ));
    }
    let ca = if tls {
        let c = get(&ctx, &format!("certificates/{uuid}")).await?;
        Some(c["pem"].as_str().unwrap_or_default().to_owned())
    } else {
        None
    };
    let user = ctx.token.user.name.clone();
    let signed = match auth {
        Auth::Keystone => None,
        Auth::Cert => {
            let (csr, key) = csr(&user).map_err(|e| {
                bad(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("could not make a key: {e}"),
                )
            })?;
            tracing::info!(user = %user, service = "container-infra", cluster = %uuid, "sign client certificate");
            let (_, cert) = gateway::call(
                &ctx,
                &SERVICE,
                Method::POST,
                "certificates",
                &[],
                Some(&json!({"cluster_uuid": uuid, "csr": csr})),
            )
            .await?;
            let pem = cert["pem"].as_str().unwrap_or_default().to_owned();
            if pem.is_empty() {
                return Err(bad(
                    StatusCode::BAD_GATEWAY,
                    "Magnum returned no certificate",
                ));
            }
            Some((pem, key))
        }
    };
    let kubeconfig = render(&Parts {
        name: &name,
        server,
        ca_pem: ca.as_deref(),
        user: &user,
        client: signed.as_ref().map(|(c, k)| (c.as_str(), k.as_str())),
    });
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-_.".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok(Json(json!({
        "filename": format!("{safe}.kubeconfig"),
        "kubeconfig": kubeconfig,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_a_csr() {
        let (csr, key) = csr("alice").unwrap();
        assert!(csr.starts_with("-----BEGIN CERTIFICATE REQUEST-----"));
        assert!(key.starts_with("-----BEGIN PRIVATE KEY-----"));
    }

    #[test]
    fn renders_cert_config() {
        let y = render(&Parts {
            name: "k8s: prod",
            server: "https://10.0.0.5:6443",
            ca_pem: Some("CA"),
            user: "alice",
            client: Some(("CERT", "KEY")),
        });
        assert!(y.contains("- name: \"k8s: prod\"\n"));
        assert!(y.contains(&format!(
            "certificate-authority-data: {}\n",
            B64.encode("CA")
        )));
        assert!(y.contains("server: \"https://10.0.0.5:6443\"\n"));
        assert!(y.contains(&format!("client-key-data: {}\n", B64.encode("KEY"))));
        assert!(y.contains("current-context: \"k8s: prod\"\n"));
        assert!(!y.contains("exec:"));
    }

    #[test]
    fn renders_keystone_config() {
        let y = render(&Parts {
            name: "k",
            server: "http://10.0.0.5:8080",
            ca_pem: None,
            user: "alice",
            client: None,
        });
        assert!(!y.contains("certificate-authority-data"));
        assert!(y.contains("command: /bin/bash"));
        assert!(y.contains("OS_TOKEN"));
    }

    #[test]
    fn request_defaults_to_cert() {
        let r: Request = serde_json::from_str("{}").unwrap();
        assert_eq!(r.auth, Auth::Cert);
        let r: Request = serde_json::from_str(r#"{"auth":"keystone"}"#).unwrap();
        assert_eq!(r.auth, Auth::Keystone);
    }
}
