//! The Designate gateway and zone file routes against a mocked Designate API.

use std::sync::Arc;

use rassvet_ext_api::{
    Extension, RequestContext,
    axum::{Extension as Ext, Router},
    os::{Catalog, Endpoint, IdName, Interface, ProjectRef, ServiceEntry, Token},
};
use rassvet_ext_designate::Designate;
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_string, header, method, path, query_param, query_param_is_missing},
};

/// Serve the extension's router for a session whose catalog points `dns` at `designate`.
async fn serve(designate: &MockServer, is_admin: bool) -> String {
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
        roles: if is_admin {
            vec![IdName {
                id: "r1".into(),
                name: "admin".into(),
            }]
        } else {
            vec![]
        },
        methods: vec!["password".into()],
        catalog: Catalog(vec![ServiceEntry {
            service_type: "dns".into(),
            name: Some("designate".into()),
            endpoints: vec![Endpoint {
                interface: "public".into(),
                region_id: Some("RegionOne".into()),
                region: Some("RegionOne".into()),
                url: format!("{}/", designate.uri()),
            }],
        }]),
    };
    let ctx = RequestContext {
        cloud_id: "c".into(),
        auth_url: "http://keystone/v3".into(),
        http: reqwest::Client::new(),
        token: Arc::new(token),
        region: Some("RegionOne".into()),
        interface: Interface::Public,
    };
    let app = Router::new().merge(Designate.router()).layer(Ext(ctx));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { rassvet_ext_api::axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

#[tokio::test]
async fn lists_every_project_across_pages() {
    let designate = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/zones"))
        .and(header("X-Auth-Token", "tok"))
        .and(header("X-Auth-All-Projects", "true"))
        .and(query_param_is_missing("marker"))
        .and(query_param_is_missing("all_projects"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "zones": [{"id": "a"}],
            "links": {"self": "s", "next": format!("{}/v2/zones?marker=a", designate.uri())},
            "metadata": {"total_count": 2},
        })))
        .mount(&designate)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/zones"))
        .and(header("X-Auth-All-Projects", "true"))
        .and(query_param("marker", "a"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "zones": [{"id": "b"}],
            "links": {"self": "s"},
        })))
        .mount(&designate)
        .await;
    let base = serve(&designate, true).await;
    let got: Value = reqwest::get(format!("{base}/os/zones?all_pages=1&all_projects=1"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["zones"], json!([{"id": "a"}, {"id": "b"}]));
    assert_eq!(got["truncated"], json!(false));
    assert!(got["links"].get("next").is_none());
}

#[tokio::test]
async fn refuses_admin_headers_and_unknown_paths() {
    let designate = MockServer::start().await;
    let base = serve(&designate, false).await;
    let http = reqwest::Client::new();
    let r = http
        .get(format!("{base}/os/zones?all_projects=1"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    let r = http
        .get(format!("{base}/os/tsigkeys"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    let r = http
        .post(format!("{base}/os/zones/tasks/imports"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    assert!(designate.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn imports_and_exports_zone_files() {
    let designate = MockServer::start().await;
    let zone = "$ORIGIN example.org.\nexample.org. 3600 IN SOA ns1.example.org. admin.example.org. 1 3600 600 86400 3600\n";
    Mock::given(method("POST"))
        .and(path("/v2/zones/tasks/imports"))
        .and(header("Content-Type", "text/dns"))
        .and(body_string(zone))
        .respond_with(
            ResponseTemplate::new(202).set_body_json(json!({"id": "i1", "status": "PENDING"})),
        )
        .mount(&designate)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/zones/tasks/exports/e1/export"))
        .and(header("Accept", "text/dns"))
        .respond_with(ResponseTemplate::new(200).set_body_string(zone))
        .mount(&designate)
        .await;
    let base = serve(&designate, false).await;
    let http = reqwest::Client::new();
    let r = http
        .post(format!("{base}/zones/import"))
        .json(&json!({"zonefile": zone}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 202);
    assert_eq!(r.json::<Value>().await.unwrap()["id"], "i1");
    let r = http
        .post(format!("{base}/zones/import"))
        .json(&json!({"zonefile": "  "}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    let got: Value = reqwest::get(format!("{base}/exports/e1/zonefile"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["zonefile"], zone);
}
