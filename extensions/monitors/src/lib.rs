//! Monitors extension: charts of Nova instances (libvirt guests) and of physical servers,
//! read from the Prometheus configured for each cloud in `[cloud.extensions.monitors]`.
//!
//! Metrics are written by Telegraf (exec scripts for libvirt and the OpenStack database, and
//! Telegraf's own inputs on the physical servers) and keep their labels: `project_id`,
//! `project_name`, `region`, `guest_id`, `guest_name`, `monitor` (`cloud` | `physical`) and,
//! for physical servers, `compute_node_id` and `hostname`.
//!
//! Who sees what is decided here, never by the browser:
//! * a project user only gets series with `project_id` = the project of their token, may not
//!   look at physical servers, and may look back at most `project_max_range_days` (60);
//! * an admin (admin role) may pick any project, instance or physical server, and may look
//!   back `admin_max_range_days` (365).
//!
//! Routes under `/api/ext/monitors`: `info`, `panels?kind=`, `projects`, `guests`, `hosts`,
//! `series?kind=&panel=…`. Users choose a chart by id ([`panels`]); the PromQL is built here.

mod panels;
mod prom;
mod settings;

use std::{
    collections::{BTreeMap, HashMap},
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

use panels::{Kind, Matchers, Panel};
use prom::{Labels, Prometheus};
use settings::Settings;

pub const ID: &str = "monitors";

/// Most series drawn in one chart; the quietest ones beyond it are left out.
const MAX_SERIES: usize = 8;
/// Points per series a chart asks for (the step follows from the time range).
const MAX_POINTS: i64 = 300;
/// The default time range: the last hour.
const DEFAULT_RANGE: i64 = 3600;

struct Cloud {
    settings: Settings,
    prom: Prometheus,
}

type Clouds = Arc<HashMap<String, Arc<Cloud>>>;

pub struct Monitors {
    clouds: Clouds,
}

impl Monitors {
    /// Build from the `[cloud.extensions.monitors]` table of each cloud that has one.
    pub fn from_settings(clouds: Vec<(String, toml::Value)>) -> anyhow::Result<Self> {
        let mut map = HashMap::new();
        for (id, v) in clouds {
            let settings = Settings::parse(&id, v)?;
            let prom = Prometheus::new(&settings)?;
            tracing::info!(
                cloud = id,
                url = settings.prometheus_url,
                "monitors: Prometheus configured"
            );
            map.insert(id, Arc::new(Cloud { settings, prom }));
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
            description: "Charts of instances (libvirt) and physical servers from Prometheus, collected by Telegraf",
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
            .route("/panels", get(list_panels))
            .route("/projects", get(projects))
            .route("/guests", get(guests))
            .route("/hosts", get(hosts))
            .route("/series", get(series))
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
    /// The project of the token: the only `project_id` a project user gets series of.
    own_project: Option<String>,
    region: Option<String>,
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
            region: ctx.region.clone().filter(|_| cloud.settings.region_filter),
            cloud,
            admin,
            own_project,
        })
    }

    fn require_admin(&self) -> Result<(), ApiError> {
        if self.admin {
            Ok(())
        } else {
            Err(err(StatusCode::FORBIDDEN, "only admins can see this"))
        }
    }

    fn max_range_days(&self) -> u32 {
        if self.admin {
            self.cloud.settings.admin_max_range_days
        } else {
            self.cloud.settings.project_max_range_days
        }
    }

    /// The `project_id` to match: forced to the token's project for project users; for
    /// admins the requested one, if any.
    fn project(&self, requested: Option<&str>) -> Result<Option<String>, ApiError> {
        if !self.admin {
            return Ok(self.own_project.clone());
        }
        requested
            .filter(|p| !p.is_empty())
            .map(id_param)
            .transpose()
    }

    fn base(&self, monitor: Option<Monitor>) -> Matchers {
        let mut m = Matchers::default();
        let s = &self.cloud.settings;
        match monitor {
            Some(Monitor::Cloud) => m = m.with_re("monitor", s.cloud_monitor.clone()),
            Some(Monitor::Physical) => m = m.with_re("monitor", s.physical_monitor.clone()),
            None => {}
        }
        if let Some(r) = &self.region {
            m = m.with("region", r.clone());
        }
        m
    }
}

/// Which `monitor` label values a selector matches (regexes from the settings).
#[derive(Clone, Copy)]
enum Monitor {
    Cloud,
    Physical,
}

/// Series that every monitored instance has: the instance pickers are built from these.
fn guest_matchers(sel: &str) -> Vec<String> {
    ["libvirt_cpu_time", "libvirt_memory_total"]
        .iter()
        .map(|m| format!("{m}{{{sel}}}"))
        .collect()
}

fn id_param(v: &str) -> Result<String, ApiError> {
    if valid_id(v) && v.len() <= 64 {
        Ok(v.to_owned())
    } else {
        Err(err(StatusCode::BAD_REQUEST, format!("invalid id {v:?}")))
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

#[derive(Deserialize)]
struct RangeQuery {
    start: Option<i64>,
    end: Option<i64>,
}

// ---------------------------------------------------------------------------- routes

async fn info(Ext(clouds): Ext<Clouds>, ctx: RequestContext) -> Result<Json<Value>, ApiError> {
    let a = Access::new(&clouds, &ctx)?;
    Ok(Json(json!({
        "admin": a.admin,
        "max_range_days": a.max_range_days(),
        "project": ctx.token.project.as_ref().map(|p| json!({"id": p.id, "name": p.name})),
        "region": ctx.region,
        "region_filter": a.cloud.settings.region_filter,
    })))
}

#[derive(Deserialize)]
struct KindQuery {
    kind: Kind,
}

async fn list_panels(
    Ext(clouds): Ext<Clouds>,
    ctx: RequestContext,
    Query(q): Query<KindQuery>,
) -> Result<Json<Vec<&'static Panel>>, ApiError> {
    let a = Access::new(&clouds, &ctx)?;
    if q.kind == Kind::Host {
        a.require_admin()?;
    }
    Ok(Json(panels::of(q.kind).collect()))
}

#[derive(Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct ProjectItem {
    project_name: String,
    project_id: String,
}

/// Admin: the projects with instance metrics in the range.
async fn projects(
    Ext(clouds): Ext<Clouds>,
    ctx: RequestContext,
    Query(q): Query<RangeQuery>,
) -> Result<Json<Vec<ProjectItem>>, ApiError> {
    let a = Access::new(&clouds, &ctx)?;
    a.require_admin()?;
    let w = window(now(), q.start, q.end, a.max_range_days())?;
    let sel = a.base(Some(Monitor::Cloud)).render();
    let found = a
        .cloud
        .prom
        .series(&guest_matchers(&sel), w.start, w.end)
        .await?;
    let mut by_id: BTreeMap<String, String> = BTreeMap::new();
    for l in found {
        if let Some(id) = l.get("project_id") {
            let name = l.get("project_name").cloned().unwrap_or_default();
            by_id.insert(id.clone(), name);
        }
    }
    let mut out: Vec<ProjectItem> = by_id
        .into_iter()
        .map(|(project_id, project_name)| ProjectItem {
            project_name,
            project_id,
        })
        .collect();
    out.sort();
    Ok(Json(out))
}

#[derive(Deserialize)]
struct GuestsQuery {
    project_id: Option<String>,
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

fn label(l: &Labels, k: &str) -> String {
    l.get(k).cloned().unwrap_or_default()
}

/// The instances with metrics in the range: of the token's project for project users, of
/// the chosen project (or every project) for admins.
async fn guests(
    Ext(clouds): Ext<Clouds>,
    ctx: RequestContext,
    Query(q): Query<GuestsQuery>,
) -> Result<Json<Vec<GuestItem>>, ApiError> {
    let a = Access::new(&clouds, &ctx)?;
    let w = window(now(), q.start, q.end, a.max_range_days())?;
    let mut sel = a.base(Some(Monitor::Cloud));
    if let Some(p) = a.project(q.project_id.as_deref())? {
        sel = sel.with("project_id", p);
    }
    let found = a
        .cloud
        .prom
        .series(&guest_matchers(&sel.render()), w.start, w.end)
        .await?;
    let mut by_id: BTreeMap<String, GuestItem> = BTreeMap::new();
    for l in found {
        let Some(id) = l.get("guest_id") else {
            continue;
        };
        by_id.insert(
            id.clone(),
            GuestItem {
                guest_name: label(&l, "guest_name"),
                guest_id: id.clone(),
                project_id: label(&l, "project_id"),
                project_name: label(&l, "project_name"),
            },
        );
    }
    let mut out: Vec<GuestItem> = by_id.into_values().collect();
    out.sort();
    Ok(Json(out))
}

#[derive(Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct HostItem {
    hostname: String,
    compute_node_id: String,
    region: String,
}

/// Admin: the physical servers with metrics in the range.
async fn hosts(
    Ext(clouds): Ext<Clouds>,
    ctx: RequestContext,
    Query(q): Query<RangeQuery>,
) -> Result<Json<Vec<HostItem>>, ApiError> {
    let a = Access::new(&clouds, &ctx)?;
    a.require_admin()?;
    let w = window(now(), q.start, q.end, a.max_range_days())?;
    let sel = a.base(Some(Monitor::Physical)).render();
    // `up`-like metrics differ between setups; any CPU series of the server will do.
    let found = a
        .cloud
        .prom
        .series(
            &[format!("cpu_usage_idle{{{sel},cpu=\"cpu-total\"}}")],
            w.start,
            w.end,
        )
        .await?;
    let mut by_id: BTreeMap<String, HostItem> = BTreeMap::new();
    for l in found {
        let Some(id) = l.get("compute_node_id") else {
            continue;
        };
        by_id.insert(
            id.clone(),
            HostItem {
                hostname: label(&l, "hostname"),
                compute_node_id: id.clone(),
                region: label(&l, "region"),
            },
        );
    }
    let mut out: Vec<HostItem> = by_id.into_values().collect();
    out.sort();
    Ok(Json(out))
}

#[derive(Deserialize)]
struct SeriesQuery {
    kind: Kind,
    panel: String,
    guest_id: Option<String>,
    compute_node_id: Option<String>,
    project_id: Option<String>,
    start: Option<i64>,
    end: Option<i64>,
}

#[derive(Serialize)]
struct OutSeries {
    /// Query name plus the legend labels, e.g. "read vda".
    name: String,
    query: &'static str,
    labels: Labels,
    values: Vec<(f64, f64)>,
}

/// The series of one chart.
async fn series(
    Ext(clouds): Ext<Clouds>,
    ctx: RequestContext,
    Query(q): Query<SeriesQuery>,
) -> Result<Json<Value>, ApiError> {
    let a = Access::new(&clouds, &ctx)?;
    let panel = panels::find(q.kind, &q.panel).ok_or_else(|| {
        err(
            StatusCode::NOT_FOUND,
            format!("unknown chart {:?}", q.panel),
        )
    })?;
    let w = window(now(), q.start, q.end, a.max_range_days())?;
    let required = |v: &Option<String>, name: &str| {
        v.as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, format!("{name} is required")))
            .and_then(id_param)
    };

    let (sel, node, project) = match q.kind {
        Kind::Guest => {
            let mut sel = a
                .base(Some(Monitor::Cloud))
                .with("guest_id", required(&q.guest_id, "guest_id")?);
            if let Some(p) = a.project(q.project_id.as_deref())? {
                sel = sel.with("project_id", p);
            }
            (sel, None, None)
        }
        Kind::Host => {
            a.require_admin()?;
            let id = required(&q.compute_node_id, "compute_node_id")?;
            (
                a.base(Some(Monitor::Physical))
                    .with("compute_node_id", id.clone()),
                Some(a.base(None).with("compute_node_id", id)),
                None,
            )
        }
        Kind::Project => {
            let p = match a.project(q.project_id.as_deref())? {
                Some(p) => p,
                None => return Err(err(StatusCode::BAD_REQUEST, "project_id is required")),
            };
            (
                Matchers::default(),
                None,
                Some(a.base(None).with("project_id", p)),
            )
        }
    };

    let rate_window = w.step.max(a.cloud.settings.rate_window_seconds as i64);
    let mut out: Vec<OutSeries> = Vec::new();
    for query in panel.queries {
        let expr = panels::render(
            query.expr,
            &sel,
            node.as_ref(),
            project.as_ref(),
            rate_window,
        );
        let mut got = a
            .cloud
            .prom
            .query_range(&expr, w.start, w.end, w.step)
            .await?;
        got.sort_by(|x, y| x.labels.cmp(&y.labels));
        for s in got {
            let labels: Labels = query
                .legend
                .iter()
                .filter_map(|l| s.labels.get(*l).map(|v| (l.to_string(), v.clone())))
                .collect();
            let name = std::iter::once(query.name.to_owned())
                .chain(labels.values().cloned())
                .collect::<Vec<_>>()
                .join(" ");
            out.push(OutSeries {
                name,
                query: query.name,
                labels,
                values: s.values,
            });
        }
    }
    let hidden = keep_loudest(&mut out, MAX_SERIES);
    Ok(Json(json!({
        "panel": panel,
        "start": w.start,
        "end": w.end,
        "step": w.step,
        "series": out,
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
    fn keeps_loudest_in_order() {
        let s = |name: &str, v: f64| OutSeries {
            name: name.into(),
            query: "q",
            labels: Labels::new(),
            values: vec![(0.0, v)],
        };
        let mut v = vec![s("a", 1.0), s("b", 5.0), s("c", 3.0)];
        assert_eq!(keep_loudest(&mut v, 2), 1);
        let names: Vec<_> = v.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["b", "c"]);
    }
}
