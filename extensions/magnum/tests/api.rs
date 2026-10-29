//! The Magnum gateway and kubeconfig route against a mocked Magnum API.

use std::sync::Arc;

use rassvet_ext_api::{
    Extension, RequestContext,
    axum::{Extension as Ext, Router},
    os::{Catalog, Endpoint, Interface, ProjectRef, ServiceEntry, Token},
};
use rassvet_ext_magnum::Magnum;
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_partial_json, header, method, path, query_param, query_param_is_missing},
};

/// Serve the extension's router for a session whose catalog points `container-infra` at `magnum`.
async fn serve(cloud: &str, magnum: &MockServer) -> String {
    let token = Token {
        value: "tok".into(),
        expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
        user: ProjectRef {
            id: "u1".into(),
            name: "alice".into(),
            domain: None,
        },
        project: Some(ProjectRef {
            id: "p1".into(),
            name: "demo".into(),
            domain: None,
        }),
        domain: None,
        system: false,
        roles: vec![],
        methods: vec!["password".into()],
        catalog: Catalog(vec![ServiceEntry {
            service_type: "container-infra".into(),
            name: Some("magnum".into()),
            endpoints: vec![Endpoint {
                interface: "public".into(),
                region_id: Some("RegionOne".into()),
                region: Some("RegionOne".into()),
                url: format!("{}/v1", magnum.uri()),
            }],
        }]),
    };
    let ctx = RequestContext {
        cloud_id: cloud.into(),
        auth_url: "http://keystone/v3".into(),
        http: reqwest::Client::new(),
        token: Arc::new(token),
        region: Some("RegionOne".into()),
        interface: Interface::Public,
    };
    let app = Router::new().merge(Magnum.router()).layer(Ext(ctx));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { rassvet_ext_api::axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

/// Magnum's root version document (served at `/`, `/v1` is a resource index).
async fn versions(magnum: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"versions": [{
                "id": "v1", "status": "CURRENT", "min_version": "1.1", "max_version": "1.11",
            }]})),
        )
        .mount(magnum)
        .await;
}

const MV: &str = "container-infra 1.11";

#[tokio::test]
async fn lists_all_pages_with_the_negotiated_microversion() {
    let magnum = MockServer::start().await;
    versions(&magnum).await;
    Mock::given(method("GET"))
        .and(path("/v1/clusters"))
        .and(header("OpenStack-API-Version", MV))
        .and(header("X-Auth-Token", "tok"))
        .and(query_param_is_missing("marker"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "clusters": [{"uuid": "a"}],
            "next": format!("{}/v1/clusters?limit=1&marker=a", magnum.uri()),
        })))
        .mount(&magnum)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/clusters"))
        .and(query_param("marker", "a"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"clusters": [{"uuid": "b"}]})),
        )
        .mount(&magnum)
        .await;
    let base = serve("pages", &magnum).await;
    let got: Value = reqwest::get(format!("{base}/os/clusters?all_pages=1"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["clusters"], json!([{"uuid": "a"}, {"uuid": "b"}]));
    assert_eq!(got["truncated"], json!(false));
    assert!(got.get("next").is_none());
}

#[tokio::test]
async fn refuses_what_is_not_allowed() {
    let magnum = MockServer::start().await;
    let base = serve("refuse", &magnum).await;
    let http = reqwest::Client::new();
    // Not in the allowlist.
    let r = http
        .post(format!("{base}/os/certificates"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    // Admin only.
    let r = http
        .get(format!("{base}/os/mservices"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    // Not a JSON-Patch document.
    let r = http
        .patch(format!("{base}/os/clusters/c1"))
        .json(&json!({"node_count": 3}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    assert!(magnum.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn builds_a_kubeconfig_with_a_signed_certificate() {
    let magnum = MockServer::start().await;
    versions(&magnum).await;
    Mock::given(method("GET"))
        .and(path("/v1/clusters/c1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "uuid": "c1", "name": "prod", "api_address": "https://10.0.0.5:6443",
            "cluster_template_id": "t1", "status": "CREATE_COMPLETE",
        })))
        .mount(&magnum)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/clustertemplates/t1"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"uuid": "t1", "coe": "kubernetes", "tls_disabled": false})),
        )
        .mount(&magnum)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/certificates/c1"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"cluster_uuid": "c1", "pem": "CA-PEM"})),
        )
        .mount(&magnum)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/certificates"))
        .and(header("OpenStack-API-Version", MV))
        .and(body_partial_json(json!({"cluster_uuid": "c1"})))
        .respond_with(
            ResponseTemplate::new(201)
                .set_body_json(json!({"cluster_uuid": "c1", "pem": "CERT-PEM"})),
        )
        .expect(1)
        .mount(&magnum)
        .await;
    let base = serve("kubeconfig", &magnum).await;
    let r = reqwest::Client::new()
        .post(format!("{base}/clusters/c1/kubeconfig"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let got: Value = r.json().await.unwrap();
    assert_eq!(got["filename"], "prod.kubeconfig");
    let cfg = got["kubeconfig"].as_str().unwrap();
    use base64::Engine;
    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
    assert!(cfg.contains(&format!("certificate-authority-data: {}", b64("CA-PEM"))));
    assert!(cfg.contains(&format!("client-certificate-data: {}", b64("CERT-PEM"))));
    assert!(cfg.contains("client-key-data: "));
    assert!(cfg.contains("server: \"https://10.0.0.5:6443\""));
    // The CSR sent to Magnum is a real one for the session's user.
    let reqs = magnum.received_requests().await.unwrap();
    let sign = reqs.iter().find(|r| r.method.as_str() == "POST").unwrap();
    let body: Value = serde_json::from_slice(&sign.body).unwrap();
    assert!(
        body["csr"]
            .as_str()
            .unwrap()
            .starts_with("-----BEGIN CERTIFICATE REQUEST-----")
    );
}

#[tokio::test]
async fn keystone_kubeconfig_needs_no_certificate() {
    let magnum = MockServer::start().await;
    versions(&magnum).await;
    Mock::given(method("GET"))
        .and(path("/v1/clusters/c2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "uuid": "c2", "name": "dev", "api_address": "https://10.0.0.6:6443", "cluster_template_id": "t1",
        })))
        .mount(&magnum)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/clustertemplates/t1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"coe": "kubernetes"})))
        .mount(&magnum)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/certificates/c2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"pem": "CA"})))
        .mount(&magnum)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&magnum)
        .await;
    let base = serve("keystone", &magnum).await;
    let got: Value = reqwest::Client::new()
        .post(format!("{base}/clusters/c2/kubeconfig"))
        .json(&json!({"auth": "keystone"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let cfg = got["kubeconfig"].as_str().unwrap();
    assert!(cfg.contains("OS_TOKEN"));
    assert!(!cfg.contains("client-key-data"));
}

#[tokio::test]
async fn reports_the_negotiated_microversion() {
    let magnum = MockServer::start().await;
    versions(&magnum).await;
    let base = serve("info", &magnum).await;
    let got: Value = reqwest::get(format!("{base}/info"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // The extension targets 1.14; this Magnum stops at 1.11 (no credentials API).
    assert_eq!(got, json!({"microversion": "1.11"}));
}
