//! The monitors routes against a mocked Prometheus: project scoping, admin-only views, limits.

use std::sync::Arc;

use rassvet_ext_api::{
    Extension, RequestContext,
    axum::{Extension as Ext, Router},
    os::{Catalog, IdName, Interface, ProjectRef, Token},
};
use rassvet_ext_monitors::Monitors;
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path, query_param, query_param_contains},
};

fn monitors(prom: &MockServer, extra: &str) -> Monitors {
    let settings: toml::Value = toml::from_str(&format!(
        "prometheus_url = \"{}\"\nbearer_token = \"secret\"\n{extra}",
        prom.uri()
    ))
    .unwrap();
    Monitors::from_settings(vec![("c".into(), settings)]).unwrap()
}

async fn serve(prom: &MockServer, is_admin: bool) -> String {
    serve_with(prom, is_admin, "").await
}

async fn serve_with(prom: &MockServer, is_admin: bool, extra: &str) -> String {
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
        catalog: Catalog(vec![]),
    };
    let ctx = RequestContext {
        cloud_id: "c".into(),
        auth_url: "http://keystone/v3".into(),
        http: reqwest::Client::new(),
        token: Arc::new(token),
        region: Some("RegionOne".into()),
        interface: Interface::Public,
    };
    let app = Router::new()
        .merge(monitors(prom, extra).router())
        .layer(Ext(ctx));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { rassvet_ext_api::axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

async fn get(url: String) -> (u16, Value) {
    let res = reqwest::get(url).await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn project_user_only_sees_own_project() {
    let prom = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/series"))
        .and(query_param(
            "match[]",
            r#"libvirt_cpu_time{monitor=~"cloud.*",project_id="p1"}"#,
        ))
        .and(query_param(
            "match[]",
            r#"libvirt_memory_total{monitor=~"cloud.*",project_id="p1"}"#,
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "success",
            "data": [
                {"__name__": "libvirt_cpu_time", "guest_id": "g1", "guest_name": "web", "project_id": "p1", "project_name": "demo", "monitor": "cloud-infras"},
                {"__name__": "libvirt_cpu_time", "guest_id": "g1", "guest_name": "web", "project_id": "p1", "project_name": "demo", "monitor": "cloud-infras", "host": "other"},
            ],
        })))
        .expect(1)
        .mount(&prom)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/query_range"))
        .and(query_param_contains(
            "query",
            r#"guest_id="g1",project_id="p1""#,
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "success",
            "data": {"resultType": "matrix", "result": [
                {"metric": {}, "values": [[1.0, "12.5"], [16.0, "NaN"]]},
            ]},
        })))
        .expect(1)
        .mount(&prom)
        .await;
    let base = serve(&prom, false).await;

    // Asking for another project changes nothing: the token's project is matched.
    let (status, got) = get(format!("{base}/guests?project_id=p2")).await;
    assert_eq!(status, 200, "{got}");
    assert_eq!(
        got,
        json!([{"guest_name": "web", "guest_id": "g1", "project_id": "p1", "project_name": "demo"}])
    );

    let (status, got) = get(format!(
        "{base}/series?kind=guest&panel=cpu&guest_id=g1&project_id=p2"
    ))
    .await;
    assert_eq!(status, 200, "{got}");
    assert_eq!(got["series"][0]["values"], json!([[1.0, 12.5]]));
    assert_eq!(got["hidden"], 0);

    let (status, info) = get(format!("{base}/info")).await;
    assert_eq!(status, 200);
    assert_eq!(info["admin"], false);
    assert_eq!(info["max_range_days"], 60);
}

#[tokio::test]
async fn project_user_gets_no_physical_servers_or_long_ranges() {
    let prom = MockServer::start().await;
    let base = serve(&prom, false).await;
    assert_eq!(get(format!("{base}/hosts")).await.0, 403);
    assert_eq!(get(format!("{base}/projects")).await.0, 403);
    assert_eq!(get(format!("{base}/panels?kind=host")).await.0, 403);
    assert_eq!(
        get(format!(
            "{base}/series?kind=host&panel=cpu&compute_node_id=n1"
        ))
        .await
        .0,
        403
    );
    let now = chrono::Utc::now().timestamp();
    let (status, body) = get(format!(
        "{base}/series?kind=guest&panel=cpu&guest_id=g1&start={}",
        now - 61 * 86400
    ))
    .await;
    assert_eq!(status, 400);
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("60 days")
    );
    assert_eq!(
        get(format!("{base}/series?kind=guest&panel=cpu&guest_id=a%22b"))
            .await
            .0,
        400
    );
    assert!(prom.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn admin_sees_physical_servers_and_a_year() {
    let prom = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/series"))
        .and(query_param(
            "match[]",
            r#"cpu_usage_idle{monitor=~"physical.*",cpu="cpu-total"}"#,
        ))
        .and(wiremock::matchers::header("authorization", "Bearer secret"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "success",
            "data": [{"compute_node_id": "n1", "hostname": "compute-1", "region": "RegionOne", "cpu": "cpu-total"}],
        })))
        .mount(&prom)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/query_range"))
        .and(query_param_contains(
            "query",
            r#"openstack_compute_node_usage_vcpus_used{compute_node_id="n1"}"#,
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "success",
            "data": {"resultType": "matrix", "result": [{"metric": {}, "values": [[1.0, "8"]]}]},
        })))
        .mount(&prom)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/query_range"))
        .and(query_param_contains("query", "vcpus_total"))
        .respond_with(ResponseTemplate::new(422).set_body_json(json!({
            "status": "error", "errorType": "execution", "error": "boom",
        })))
        .mount(&prom)
        .await;
    let base = serve(&prom, true).await;

    let (status, got) = get(format!("{base}/hosts")).await;
    assert_eq!(status, 200, "{got}");
    assert_eq!(
        got,
        json!([{"hostname": "compute-1", "compute_node_id": "n1", "region": "RegionOne"}])
    );

    let now = chrono::Utc::now().timestamp();
    let (status, body) = get(format!(
        "{base}/series?kind=host&panel=nova_vcpus&compute_node_id=n1&start={}",
        now - 364 * 86400
    ))
    .await;
    // The second query of the chart failed: the error of Prometheus is passed on.
    assert_eq!(status, 502);
    assert_eq!(body["error"]["message"], "Prometheus: boom");
}

#[test]
fn only_available_in_configured_clouds() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let prom = rt.block_on(MockServer::start());
    let m = monitors(&prom, "");
    assert!(m.is_available_in("c", &Catalog(vec![]), None));
    assert!(!m.is_available_in("other", &Catalog(vec![]), None));
}

#[tokio::test]
async fn monitor_label_pattern_is_configurable() {
    let prom = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/series"))
        .and(query_param(
            "match[]",
            r#"libvirt_memory_total{monitor=~"cloud-infras|cloud",project_id="p1"}"#,
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "success",
            "data": [{"__name__": "libvirt_memory_total", "guest_id": "006af7b5-4490-4157-b1ba-36d14409e120", "guest_name": "edge-fw-001", "project_id": "p1", "project_name": "ministryinc", "monitor": "cloud-infras", "region": "HaNoi", "db": "public-infras", "host": "han01osp01com05"}],
        })))
        .expect(1)
        .mount(&prom)
        .await;
    let base = serve_with(&prom, false, r#"cloud_monitor = "cloud-infras|cloud""#).await;
    let (status, got) = get(format!("{base}/guests")).await;
    assert_eq!(status, 200, "{got}");
    assert_eq!(got[0]["guest_name"], "edge-fw-001");
}
