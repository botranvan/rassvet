//! Monitors extension: dashboards of Nova instances (libvirt guests) and of physical servers,
//! read from the Prometheus-compatible API configured for each cloud in
//! `[cloud.extensions.monitors]` (Prometheus, VictoriaMetrics, Thanos, Mimir…).
//!
//! What is charted is not built in: dashboards and panels are PromQL templates in YAML files
//! (`monitor_panels_paths`, see [`dashboards`]); without that setting the built-in
//! `panels/default.yaml` is used. Templates use Grafana-style variables (`$project_id`,
//! `$guest_id`, `$compute_node_id`, `$hostname`, `$region`, `$__rate_interval`, `$__interval`,
//! `$__range`) that the server fills, plus each dashboard's own `variables` (e.g. `$monitor`).
//!
//! Who sees what is decided here, never by the browser:
//! * a project user's `$project_id` is always the project of their token (every instance query
//!   must use it), they may not open physical dashboards, and may look back at most
//!   `project_max_range_days` (60);
//! * an admin (admin role) may pick any project, instance or physical server, and may look
//!   back `admin_max_range_days` (365).
//!
//! Routes under `/api/ext/monitors`: `info`, `dashboards?kind=`, `targets?dashboard=`,
//! `variables?dashboard=&var-<name>=…`, `query?dashboard=&panel=&var-<name>=…&…`.

pub mod dashboards;
mod prom;
mod settings;

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use rassvet_ext_api::{
    ApiError, Extension, Manifest, NavItem, NavSection, RequestContext,
    axum::{Extension as Ext, Json, Router, extract::Query, http::StatusCode, routing::get},
    gateway::valid_id,
    os::Catalog,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use dashboards::{ChartType, Dashboard, Kind, Panel, Panels};
use prom::{Labels, Prometheus};
use settings::Settings;

pub const ID: &str = "monitors";

/// Points per series a chart asks for (the step follows from the time range).
const MAX_POINTS: i64 = 300;
/// The default time range: the last hour.
const DEFAULT_RANGE: i64 = 3600;

struct Cloud {
    settings: Settings,
    prom: Prometheus,
    panels: Panels,
}

type Clouds = Arc<HashMap<String, Arc<Cloud>>>;

pub struct Monitors {
    clouds: Clouds,
}

impl Monitors {
    /// Build from the `[cloud.extensions.monitors]` table of each cloud that has one, loading
    /// its panel files.
    pub fn from_settings(clouds: Vec<(String, toml::Value)>) -> anyhow::Result<Self> {
        let mut map = HashMap::new();
        for (id, v) in clouds {
            let settings = Settings::parse(&id, v)?;
            let prom = Prometheus::new(&settings)?;
            let paths = settings.monitor_panels_paths.as_ref().map(|p| p.list());
            let panels = Panels::load(paths.clone())
                .map_err(|e| anyhow::anyhow!("cloud '{id}': monitor panels: {e:#}"))?;
            let cat = panels.get();
            tracing::info!(
                cloud = id,
                url = settings.prometheus_url,
                panels = paths
                    .map(|p| p.join(", "))
                    .unwrap_or_else(|| "built-in".into()),
                dashboards = cat.dashboards.len(),
                "monitors: Prometheus configured"
            );
            map.insert(
                id,
                Arc::new(Cloud {
                    settings,
                    prom,
                    panels,
                }),
            );
        }
        Ok(Self {
            clouds: Arc::new(map),
        })
    }
}

impl Extension for Monitors {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: ID,
            name: "Monitors",
            version: env!("CARGO_PKG_VERSION"),
            description: "Dashboards of instances and physical servers from Prometheus, defined in YAML panel files",
            service_types: &[],
        }
    }

    fn nav(&self) -> Vec<NavItem> {
        let item = |id: &str, label: &str, path: &str, icon: &str, section: NavSection| NavItem {
            id: format!("{ID}.{id}"),
            group: "Monitoring".into(),
            label: label.into(),
            path: path.into(),
            icon: icon.into(),
            section,
            role: (section == NavSection::Admin).then(|| "admin".into()),
        };
        vec![
            item(
                "instances",
                "Instance monitors",
                &format!("/ext/{ID}/instances"),
                "activity",
                NavSection::Project,
            ),
            item(
                "admin-instances",
                "Instance monitors",
                &format!("/admin/ext/{ID}/instances"),
                "activity",
                NavSection::Admin,
            ),
            item(
                "hosts",
                "Physical server monitors",
                &format!("/admin/ext/{ID}/hosts"),
                "server",
                NavSection::Admin,
            ),
        ]
    }

    fn router(&self) -> Router {
        Router::new()
            .route("/info", get(info))
            .route("/dashboards", get(list_dashboards))
            .route("/targets", get(targets))
            .route("/variables", get(variables))
            .route("/query", get(query))
            .layer(Ext(self.clouds.clone()))
    }

    /// Shown only in the clouds with a `[cloud.extensions.monitors]` table.
    fn is_available_in(&self, cloud_id: &str, _: &Catalog, _: Option<&str>) -> bool {
        self.clouds.contains_key(cloud_id)
    }
}

// ---------------------------------------------------------------------------- access

fn err(status: StatusCode, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, msg)
}

/// What the session may see in this cloud.
struct Access {
    cloud: Arc<Cloud>,
    admin: bool,
    /// The project of the token: the only `$project_id` a project user gets.
    own_project: Option<String>,
    region: String,
}

impl Access {
    fn new(clouds: &Clouds, ctx: &RequestContext) -> Result<Self, ApiError> {
        let cloud = clouds.get(&ctx.cloud_id).cloned().ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                "monitors are not configured for this cloud",
            )
        })?;
        let admin = ctx.is_admin();
        let own_project = ctx.project_id().map(str::to_owned);
        if !admin && own_project.is_none() {
            return Err(err(
                StatusCode::FORBIDDEN,
                "choose a project to see its monitors",
            ));
        }
        Ok(Self {
            region: ctx
                .region
                .clone()
                .filter(|r| valid_id(r))
                .unwrap_or_default(),
            cloud,
            admin,
            own_project,
        })
    }

    fn max_range_days(&self) -> u32 {
        if self.admin {
            self.cloud.settings.admin_max_range_days
        } else {
            self.cloud.settings.project_max_range_days
        }
    }

    /// `$project_id`: always the token's project for project users; for admins the
    /// requested one, if any.
    fn project(&self, requested: Option<&str>) -> Result<Option<String>, ApiError> {
        if !self.admin {
            return Ok(self.own_project.clone());
        }
        requested
            .filter(|p| !p.is_empty())
            .map(id_param)
            .transpose()
    }

    /// A dashboard this session may open.
    fn dashboard<'a>(
        &self,
        cat: &'a dashboards::Catalog,
        id: &str,
    ) -> Result<&'a Dashboard, ApiError> {
        let d = cat
            .find(id)
            .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("unknown dashboard {id:?}")))?;
        if d.kind == Kind::Physical && !self.admin {
            return Err(err(
                StatusCode::FORBIDDEN,
                "only admins can see physical servers",
            ));
        }
        Ok(d)
    }
}

fn id_param(v: &str) -> Result<String, ApiError> {
    if valid_id(v) && v.len() <= 255 {
        Ok(v.to_owned())
    } else {
        Err(err(StatusCode::BAD_REQUEST, format!("invalid value {v:?}")))
    }
}

// ---------------------------------------------------------------------------- time range

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Window {
    pub start: i64,
    pub end: i64,
    pub step: i64,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Steps a chart snaps to, so the same range gives the same points (and cache hits).
const STEPS: &[i64] = &[
    15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400,
];

/// Validate a requested range against the session's limit (`max_days`, counted back from
/// `now`) and choose its step. Unix seconds; defaults to the last hour.
pub fn window(
    now: i64,
    start: Option<i64>,
    end: Option<i64>,
    max_days: u32,
) -> Result<Window, ApiError> {
    let end = end.unwrap_or(now).min(now);
    let start = start.unwrap_or(end - DEFAULT_RANGE);
    if start >= end {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "the time range must end after it starts",
        ));
    }
    // A minute of slack for clocks and for the time a request takes.
    let oldest = now - i64::from(max_days) * 86400 - 60;
    if start < oldest {
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!("you can look back at most {max_days} days"),
        ));
    }
    let raw = (end - start + MAX_POINTS - 1) / MAX_POINTS;
    let step = STEPS
        .iter()
        .copied()
        .find(|s| *s >= raw)
        .unwrap_or_else(|| (raw + 86399) / 86400 * 86400);
    Ok(Window {
        start: start.div_euclid(step) * step,
        end: end.div_euclid(step) * step + if end % step == 0 { 0 } else { step },
        step,
    })
}

// ---------------------------------------------------------------------------- routes

async fn info(Ext(clouds): Ext<Clouds>, ctx: RequestContext) -> Result<Json<Value>, ApiError> {
    let a = Access::new(&clouds, &ctx)?;
    Ok(Json(json!({
        "admin": a.admin,
        "max_range_days": a.max_range_days(),
        "project": ctx.token.project.as_ref().map(|p| json!({"id": p.id, "name": p.name})),
        "region": ctx.region,
    })))
}

#[derive(Deserialize)]
struct KindQuery {
    kind: Kind,
}

/// The dashboards of one kind, with their panels (without the PromQL).
async fn list_dashboards(
    Ext(clouds): Ext<Clouds>,
    ctx: RequestContext,
    Query(q): Query<KindQuery>,
) -> Result<Json<Value>, ApiError> {
    let a = Access::new(&clouds, &ctx)?;
    if q.kind == Kind::Physical && !a.admin {
        return Err(err(
            StatusCode::FORBIDDEN,
            "only admins can see physical servers",
        ));
    }
    let cat = a.cloud.panels.get();
    let list: Vec<&Dashboard> = cat.dashboards.iter().filter(|d| d.kind == q.kind).collect();
    Ok(Json(serde_json::to_value(list).unwrap_or_default()))
}

#[derive(Deserialize)]
struct TargetsQuery {
    dashboard: String,
    start: Option<i64>,
    end: Option<i64>,
}

#[derive(Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct GuestItem {
    guest_name: String,
    guest_id: String,
    project_id: String,
    project_name: String,
}

#[derive(Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct HostItem {
    hostname: String,
    compute_node_id: String,
    region: String,
}

fn label(l: &Labels, k: &str) -> String {
    l.get(k).cloned().unwrap_or_default()
}

/// What can be picked on a dashboard, from its `discover` selector: instances (of the token's
/// project for project users, of every project for admins) or physical servers.
async fn targets(
    Ext(clouds): Ext<Clouds>,
    ctx: RequestContext,
    Query(q): Query<TargetsQuery>,
) -> Result<Json<Value>, ApiError> {
    let a = Access::new(&clouds, &ctx)?;
    let cat = a.cloud.panels.get();
    let d = a.dashboard(&cat, &q.dashboard)?;
    let w = window(now(), q.start, q.end, a.max_range_days())?;
    // In `discover`, $project_id is a regex: the project, or any for admins.
    let project = a.project(None)?.unwrap_or_else(|| ".+".into());
    let mut vars: HashMap<&str, String> = own_vars(d);
    vars.insert("region", a.region.clone());
    vars.insert("project_id", project);
    let selector = dashboards::render(&d.discover, &vars);
    let found = a.cloud.prom.series(&[selector], w.start, w.end).await?;

    let out = match d.kind {
        Kind::Instance => {
            let mut by_id: BTreeMap<String, GuestItem> = BTreeMap::new();
            for l in found {
                let Some(id) = l.get("guest_id").filter(|v| !v.is_empty()) else {
                    continue;
                };
                let project_id = label(&l, "project_id");
                // Whatever `discover` says, a project user only gets their own instances.
                if !a.admin && Some(&project_id) != a.own_project.as_ref() {
                    continue;
                }
                by_id.entry(id.clone()).or_insert(GuestItem {
                    guest_name: label(&l, "guest_name"),
                    guest_id: id.clone(),
                    project_id,
                    project_name: label(&l, "project_name"),
                });
            }
            let mut v: Vec<GuestItem> = by_id.into_values().collect();
            v.sort();
            json!({"kind": "instance", "guests": v})
        }
        Kind::Physical => {
            let mut by_id: BTreeMap<String, HostItem> = BTreeMap::new();
            for l in found {
                let id = l
                    .get("compute_node_id")
                    .filter(|v| !v.is_empty())
                    .or_else(|| l.get("hostname"))
                    .cloned();
                let Some(id) = id else { continue };
                by_id.entry(id.clone()).or_insert(HostItem {
                    hostname: label(&l, "hostname"),
                    compute_node_id: label(&l, "compute_node_id"),
                    region: label(&l, "region"),
                });
            }
            let mut v: Vec<HostItem> = by_id.into_values().collect();
            v.sort();
            json!({"kind": "physical", "hosts": v})
        }
    };
    Ok(Json(out))
}

#[derive(Deserialize)]
struct PanelQuery {
    dashboard: String,
    panel: String,
    project_id: Option<String>,
    guest_id: Option<String>,
    compute_node_id: Option<String>,
    hostname: Option<String>,
    start: Option<i64>,
    end: Option<i64>,
}

#[derive(Serialize)]
struct OutSeries {
    name: String,
    labels: Labels,
    values: Vec<(f64, f64)>,
}

#[derive(Serialize)]
struct OutQuery {
    #[serde(rename = "type")]
    chart: ChartType,
    unit: dashboards::Unit,
    series: Vec<OutSeries>,
}

/// The dashboard's constant `variables` (their names never clash with the built-in ones).
fn own_vars(d: &Dashboard) -> HashMap<&str, String> {
    d.constants().map(|(k, v)| (k, v.to_owned())).collect()
}

/// Longest value accepted for a query variable.
const MAX_VAR_VALUE: usize = 256;
/// Most values listed for a query variable.
const MAX_VAR_VALUES: usize = 5000;

/// The value picked for a query variable (`var-<name>`), if usable.
fn picked<'q>(params: &'q HashMap<String, String>, name: &str) -> Option<&'q str> {
    params
        .get(&format!("var-{name}"))
        .map(String::as_str)
        .filter(|v| !v.is_empty() && v.len() <= MAX_VAR_VALUE && !v.chars().any(char::is_control))
}

#[derive(Serialize)]
struct ResolvedVar {
    name: String,
    values: Vec<String>,
    /// The picked value when it is one of `values`, otherwise the first value (or empty).
    value: String,
}

/// Resolve the query variables of `d` in order: each one's selector is filled with the
/// constants, the built-ins and the values of the variables before it, and its value is the
/// picked one if listed, else the first. E.g. with `$compute` = node1, `compute_node_id` =
/// `label_values(x{hostname="$compute"}, compute_node_id)` lists x{hostname="node1"}'s ids.
async fn resolve_vars(
    a: &Access,
    d: &Dashboard,
    params: &HashMap<String, String>,
    w: &Window,
) -> Result<Vec<ResolvedVar>, ApiError> {
    let mut vars: HashMap<&str, String> = own_vars(d);
    vars.insert("region", a.region.clone());
    match d.kind {
        // In variable selectors $project_id is a regex: the project, or any for admins.
        Kind::Instance => {
            let p = a.project(params.get("project_id").map(String::as_str))?;
            vars.insert("project_id", p.unwrap_or_else(|| ".+".into()));
            // The picked instance; empty when none is (its selectors then match nothing).
            let guest = params.get("guest_id").filter(|v| !v.is_empty());
            vars.insert(
                "guest_id",
                guest.map(|g| id_param(g)).transpose()?.unwrap_or_default(),
            );
        }
        Kind::Physical => {
            for name in ["compute_node_id", "hostname"] {
                if d.var(name).is_none()
                    && let Some(v) = params.get(name).filter(|v| !v.is_empty())
                {
                    vars.insert(name, id_param(v)?);
                }
            }
        }
    }
    let mut out = Vec::new();
    for v in d.variables.iter().filter(|v| v.query) {
        let dashboards::VarValue::LabelValues { selector, label } = &v.value else {
            continue;
        };
        let mut values: Vec<String> = match selector {
            Some(sel) => {
                let sel = dashboards::render(sel, &vars);
                let found = a.cloud.prom.series(&[sel], w.start, w.end).await?;
                let set: BTreeSet<String> = found
                    .into_iter()
                    .filter_map(|mut l| l.remove(label))
                    .filter(|x| !x.is_empty())
                    .collect();
                set.into_iter().collect()
            }
            None => a.cloud.prom.label_values(label, w.start, w.end).await?,
        };
        values.truncate(MAX_VAR_VALUES);
        let value = picked(params, &v.name)
            .filter(|p| values.iter().any(|x| x == p))
            .map(str::to_owned)
            .or_else(|| values.first().cloned())
            .unwrap_or_default();
        vars.insert(v.name.as_str(), value.clone());
        out.push(ResolvedVar {
            name: v.name.clone(),
            values,
            value,
        });
    }
    Ok(out)
}

#[derive(Deserialize)]
struct VariablesQuery {
    dashboard: String,
    start: Option<i64>,
    end: Option<i64>,
}

/// The values of a dashboard's query variables, resolved in order from the picked ones
/// (`var-<name>=…`), and `project_id` / `guest_id` / `compute_node_id` / `hostname` when picked.
async fn variables(
    Ext(clouds): Ext<Clouds>,
    ctx: RequestContext,
    Query(q): Query<VariablesQuery>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Vec<ResolvedVar>>, ApiError> {
    let a = Access::new(&clouds, &ctx)?;
    let cat = a.cloud.panels.get();
    let d = a.dashboard(&cat, &q.dashboard)?;
    let w = window(now(), q.start, q.end, a.max_range_days())?;
    Ok(Json(resolve_vars(&a, d, &params, &w).await?))
}

/// The variables of one panel request.
fn panel_vars<'a>(
    a: &Access,
    d: &'a Dashboard,
    p: &Panel,
    q: &PanelQuery,
    params: &HashMap<String, String>,
    w: &Window,
) -> Result<HashMap<&'a str, String>, ApiError> {
    let needs = |v: &str| p.vars.contains(v);
    let required = |v: &Option<String>, name: &str| {
        v.as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, format!("{name} is required")))
            .and_then(id_param)
    };
    let mut vars = own_vars(d);
    // Query variables: the values picked in the UI (resolved by the `variables` route).
    for v in d.variables.iter().filter(|v| v.query) {
        vars.insert(
            v.name.as_str(),
            picked(params, &v.name).unwrap_or_default().to_owned(),
        );
    }
    vars.extend([
        ("region", a.region.clone()),
        ("__interval", format!("{}s", w.step)),
        (
            "__rate_interval",
            format!(
                "{}s",
                w.step.max(a.cloud.settings.rate_window_seconds as i64)
            ),
        ),
        ("__range", format!("{}s", w.end - w.start)),
    ]);
    match d.kind {
        Kind::Instance => {
            // Every instance query uses $project_id (checked when the files are loaded).
            let project = a
                .project(q.project_id.as_deref())?
                .ok_or_else(|| err(StatusCode::BAD_REQUEST, "project_id is required"))?;
            vars.insert("project_id", project);
            if needs("guest_id") {
                vars.insert("guest_id", required(&q.guest_id, "guest_id")?);
            }
        }
        // Unless the dashboard defines them as variables (no server picker then).
        Kind::Physical => {
            if needs("compute_node_id") && d.var("compute_node_id").is_none() {
                vars.insert(
                    "compute_node_id",
                    required(&q.compute_node_id, "compute_node_id")?,
                );
            }
            if needs("hostname") && d.var("hostname").is_none() {
                vars.insert("hostname", required(&q.hostname, "hostname")?);
            }
        }
    }
    Ok(vars)
}

/// Series names: the legend template, or the labels that tell the series apart.
fn name_series(legend: Option<&str>, fallback: &str, series: &[prom::Series]) -> Vec<String> {
    if let Some(t) = legend {
        return series
            .iter()
            .map(|s| {
                let mut out = String::new();
                let mut rest = t;
                while let Some(i) = rest.find("{{") {
                    out.push_str(&rest[..i]);
                    match rest[i + 2..].find("}}") {
                        Some(j) => {
                            let key = rest[i + 2..i + 2 + j].trim();
                            out.push_str(s.labels.get(key).map_or("", String::as_str));
                            rest = &rest[i + 4 + j..];
                        }
                        None => {
                            out.push_str(&rest[i..]);
                            rest = "";
                        }
                    }
                }
                out.push_str(rest);
                out
            })
            .collect();
    }
    let keys: BTreeSet<&String> = series.iter().flat_map(|s| s.labels.keys()).collect();
    let varying: Vec<&String> = keys
        .into_iter()
        .filter(|k| {
            let first = series[0].labels.get(*k);
            series.iter().any(|s| s.labels.get(*k) != first)
        })
        .collect();
    series
        .iter()
        .map(|s| {
            let parts: Vec<&str> = varying
                .iter()
                .filter_map(|k| s.labels.get(*k).map(String::as_str))
                .collect();
            if parts.is_empty() {
                fallback.to_owned()
            } else {
                parts.join(" ")
            }
        })
        .collect()
}

/// The data of one panel: a range query per time series, an instant query (at the end of the
/// range) per stat, gauge or pie chart.
async fn query(
    Ext(clouds): Ext<Clouds>,
    ctx: RequestContext,
    Query(q): Query<PanelQuery>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let a = Access::new(&clouds, &ctx)?;
    let cat = a.cloud.panels.get();
    let d = a.dashboard(&cat, &q.dashboard)?;
    let p = d.panels.iter().find(|p| p.name == q.panel).ok_or_else(|| {
        err(
            StatusCode::NOT_FOUND,
            format!("unknown panel {:?}", q.panel),
        )
    })?;
    let w = window(now(), q.start, q.end, a.max_range_days())?;
    let vars = panel_vars(&a, d, p, &q, &params, &w)?;
    let at = w.end.min(now());

    let mut results = Vec::new();
    let mut hidden = 0;
    let mut shown = 0;
    for (i, query) in p.queries.iter().enumerate() {
        let expr = dashboards::render(&query.expr, &vars);
        let mut got = match query.chart {
            ChartType::TimeSeries => {
                a.cloud
                    .prom
                    .query_range(&expr, w.start, w.end, w.step)
                    .await?
            }
            _ => a.cloud.prom.query(&expr, at).await?,
        };
        got.retain(|s| !s.values.is_empty());
        got.sort_by(|x, y| x.labels.cmp(&y.labels));
        let fallback = if p.queries.len() == 1 {
            p.title.clone()
        } else {
            format!("Query {}", (b'A' + (i % 26) as u8) as char)
        };
        let names = name_series(query.legend.as_deref(), &fallback, &got);
        let mut series: Vec<OutSeries> = got
            .into_iter()
            .zip(names)
            .map(|(s, name)| OutSeries {
                name,
                labels: s.labels,
                values: s.values,
            })
            .collect();
        if query.chart == ChartType::TimeSeries {
            // The panel's max_series counts every time series query of the panel.
            let room = p.max_series.saturating_sub(shown);
            hidden += keep_loudest(&mut series, room);
            shown += series.len();
        }
        results.push(OutQuery {
            chart: query.chart,
            unit: query.unit,
            series,
        });
    }
    Ok(Json(json!({
        "start": w.start,
        "end": w.end,
        "step": w.step,
        "results": results,
        "hidden": hidden,
    })))
}

/// Keep the `max` series with the largest mean, in their original order (so colours stay
/// with their series); returns how many were dropped.
fn keep_loudest(series: &mut Vec<OutSeries>, max: usize) -> usize {
    if series.len() <= max {
        return 0;
    }
    let mean = |s: &OutSeries| {
        if s.values.is_empty() {
            f64::MIN
        } else {
            s.values.iter().map(|(_, v)| v).sum::<f64>() / s.values.len() as f64
        }
    };
    let mut order: Vec<(usize, f64)> = series.iter().map(mean).enumerate().collect();
    order.sort_by(|a, b| b.1.total_cmp(&a.1));
    let keep: std::collections::HashSet<usize> = order.iter().take(max).map(|(i, _)| *i).collect();
    let dropped = series.len() - max;
    let mut i = 0;
    series.retain(|_| {
        let k = keep.contains(&i);
        i += 1;
        k
    });
    dropped
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn default_window_is_last_hour() {
        let w = window(NOW, None, None, 60).unwrap();
        assert_eq!(w.step, 15);
        assert!(w.end >= NOW && w.end - w.start >= 3600);
    }

    #[test]
    fn limits_how_far_back() {
        let day = 86400;
        assert!(window(NOW, Some(NOW - 60 * day), None, 60).is_ok());
        let e = window(NOW, Some(NOW - 61 * day), None, 60).unwrap_err();
        assert_eq!(e.status, StatusCode::BAD_REQUEST);
        assert!(window(NOW, Some(NOW - 365 * day), None, 365).is_ok());
        assert!(window(NOW, Some(NOW - 366 * day), None, 365).is_err());
        // Shifting the window into the past doesn't get around the limit.
        assert!(window(NOW, Some(NOW - 90 * day), Some(NOW - 80 * day), 60).is_err());
    }

    #[test]
    fn step_keeps_points_bounded() {
        let w = window(NOW, Some(NOW - 365 * 86400), None, 365).unwrap();
        assert!((w.end - w.start) / w.step <= MAX_POINTS + 2, "{w:?}");
        assert!(window(NOW, Some(NOW), Some(NOW), 60).is_err());
    }

    #[test]
    fn legends() {
        let s = |pairs: &[(&str, &str)]| prom::Series {
            labels: pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            values: vec![(0.0, 1.0)],
        };
        let two = [
            s(&[("device", "vda"), ("guest_name", "web")]),
            s(&[("device", "vdb"), ("guest_name", "web")]),
        ];
        assert_eq!(name_series(None, "x", &two), ["vda", "vdb"]);
        assert_eq!(
            name_series(Some("write-{{device}} {{nope}}"), "x", &two),
            ["write-vda ", "write-vdb "]
        );
        assert_eq!(name_series(None, "CPU", &[s(&[])]), ["CPU"]);
    }

    #[test]
    fn keeps_loudest_in_order() {
        let s = |name: &str, v: f64| OutSeries {
            name: name.into(),
            labels: Labels::new(),
            values: vec![(0.0, v)],
        };
        let mut v = vec![s("a", 1.0), s("b", 5.0), s("c", 3.0)];
        assert_eq!(keep_loudest(&mut v, 2), 1);
        let names: Vec<_> = v.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["b", "c"]);
    }
}
