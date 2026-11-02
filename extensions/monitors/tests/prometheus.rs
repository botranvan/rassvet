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

const CLOUD: &str = "cloud.%2A";
const PHYSICAL: &str = "physical.%2A";

#[tokio::test]
async fn project_user_only_sees_own_project() {
    let prom = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/series"))
        .and(query_param(
            "match[]",
            r#"{project_id=~"p1",guest_id!=""}"#,
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "success",
            "data": [
                {"__name__": "libvirt_memory_total", "guest_id": "g1", "guest_name": "web", "project_id": "p1", "project_name": "demo", "monitor": "cloud-infras", "db": "public-infras"},
                {"__name__": "libvirt_cpu_time", "guest_id": "g1", "guest_name": "web", "project_id": "p1", "project_name": "demo", "monitor": "cloud-infras"},
                // Never shown to a project user, even if Prometheus returned it.
                {"__name__": "libvirt_cpu_time", "guest_id": "g2", "guest_name": "other", "project_id": "p2", "project_name": "x", "monitor": "cloud-infras"},
            ],
        })))
        .expect(1)
        .mount(&prom)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/query_range"))
        .and(query_param_contains(
            "query",
            r#"project_id="p1",guest_id="g1""#,
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

    let (status, got) = get(format!("{base}/targets?dashboard={CLOUD}")).await;
    assert_eq!(status, 200, "{got}");
    assert_eq!(
        got["guests"],
        json!([{"guest_name": "web", "guest_id": "g1", "project_id": "p1", "project_name": "demo"}])
    );

    // Asking for another project changes nothing: $project_id is the token's project.
    let (status, got) = get(format!(
        "{base}/query?dashboard={CLOUD}&panel=cpu&guest_id=g1&project_id=p2"
    ))
    .await;
    assert_eq!(status, 200, "{got}");
    assert_eq!(got["results"][0]["type"], "time_series");
    assert_eq!(
        got["results"][0]["series"][0]["values"],
        json!([[1.0, 12.5]])
    );
    assert_eq!(got["results"][0]["series"][0]["name"], "CPU");

    let (status, info) = get(format!("{base}/info")).await;
    assert_eq!(status, 200);
    assert_eq!(info["admin"], false);
    assert_eq!(info["max_range_days"], 60);

    let (_, list) = get(format!("{base}/dashboards?kind=instance")).await;
    assert_eq!(list[0]["id"], "cloud.*");
    assert!(list[0]["panels"][0].get("queries").is_some());
    assert!(
        !list.to_string().contains("libvirt_"),
        "PromQL must not be sent"
    );
}

#[tokio::test]
async fn project_user_gets_no_physical_servers_or_long_ranges() {
    let prom = MockServer::start().await;
    let base = serve(&prom, false).await;
    assert_eq!(get(format!("{base}/dashboards?kind=physical")).await.0, 403);
    assert_eq!(
        get(format!("{base}/targets?dashboard={PHYSICAL}")).await.0,
        403
    );
    assert_eq!(
        get(format!(
            "{base}/query?dashboard={PHYSICAL}&panel=cpu&compute_node_id=n1"
        ))
        .await
        .0,
        403
    );
    let now = chrono::Utc::now().timestamp();
    let (status, body) = get(format!(
        "{base}/query?dashboard={CLOUD}&panel=cpu&guest_id=g1&start={}",
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
        get(format!(
            "{base}/query?dashboard={CLOUD}&panel=cpu&guest_id=a%22b"
        ))
        .await
        .0,
        400
    );
    assert_eq!(
        get(format!("{base}/query?dashboard={CLOUD}&panel=cpu"))
            .await
            .0,
        400
    );
    assert_eq!(
        get(format!("{base}/query?dashboard=nope&panel=cpu"))
            .await
            .0,
        404
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
            r#"{compute_node_id!=""}"#,
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

    let (status, got) = get(format!("{base}/targets?dashboard={PHYSICAL}")).await;
    assert_eq!(status, 200, "{got}");
    assert_eq!(
        got["hosts"],
        json!([{"hostname": "compute-1", "compute_node_id": "n1", "region": "RegionOne"}])
    );

    let now = chrono::Utc::now().timestamp();
    let (status, body) = get(format!(
        "{base}/query?dashboard={PHYSICAL}&panel=nova_vcpus&compute_node_id=n1&start={}",
        now - 364 * 86400
    ))
    .await;
    // The second query of the panel failed: the error of Prometheus is passed on.
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
async fn custom_panel_files() {
    let dir = std::env::temp_dir().join(format!("rassvet-monitors-it-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("infras.yaml"),
        r#"
- dashboard: cloud-infras
  title: Infrastructure VMs
  variables:
    - monitor: cloud-infras
    - db: public-infras
  discover: 'libvirt_memory_total{db="$db",monitor="$monitor",project_id=~"$project_id"}'
  panels:
    - name: mem
      description: Memory Monitors
      unit: bytes
      queries:
        - query: 'sum(libvirt_memory_total{db="$db",project_id="$project_id",guest_id="$guest_id"})'
          type: stat
          legend: total
        - query: 'libvirt_memory_used{db="$db",project_id="$project_id",guest_id="$guest_id"}'
          type: pie_chart
"#,
    )
    .unwrap();
    let prom = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/series"))
        .and(query_param(
            "match[]",
            r#"libvirt_memory_total{db="public-infras",monitor="cloud-infras",project_id=~".+"}"#,
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "success",
            "data": [{"__name__": "libvirt_memory_total", "guest_id": "006af7b5-4490-4157-b1ba-36d14409e120", "guest_name": "edge-fw-001", "project_id": "25003f065dc8408c834b6ba52dbd812d", "project_name": "ministryinc", "monitor": "cloud-infras", "region": "HaNoi", "db": "public-infras", "host": "han01osp01com05"}],
        })))
        .expect(1)
        .mount(&prom)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/query"))
        .and(query_param_contains(
            "query",
            r#"project_id="25003f065dc8408c834b6ba52dbd812d""#,
        ))
        // The dashboard's own variables are filled in the queries.
        .and(query_param_contains("query", r#"db="public-infras""#))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "success",
            "data": {"resultType": "vector", "result": [{"metric": {}, "value": [5.0, "4096"]}]},
        })))
        .expect(2)
        .mount(&prom)
        .await;
    let paths = format!("monitor_panels_paths = \"{}\"", dir.display());
    let base = serve_with(&prom, true, &paths).await;

    let (_, list) = get(format!("{base}/dashboards?kind=instance")).await;
    assert_eq!(list[0]["title"], "Infrastructure VMs");
    assert_eq!(list[0]["panels"][0]["title"], "Memory Monitors");
    let (status, got) = get(format!("{base}/targets?dashboard=cloud-infras")).await;
    assert_eq!(status, 200, "{got}");
    assert_eq!(got["guests"][0]["guest_name"], "edge-fw-001");
    let (status, got) = get(format!(
        "{base}/query?dashboard=cloud-infras&panel=mem&project_id=25003f065dc8408c834b6ba52dbd812d&guest_id=006af7b5-4490-4157-b1ba-36d14409e120"
    ))
    .await;
    assert_eq!(status, 200, "{got}");
    assert_eq!(got["results"][0]["type"], "stat");
    assert_eq!(got["results"][0]["series"][0]["name"], "total");
    assert_eq!(got["results"][1]["type"], "pie_chart");
    assert_eq!(
        got["results"][1]["series"][0]["values"],
        json!([[5.0, 4096.0]])
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
