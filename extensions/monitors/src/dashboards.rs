//! Dashboards and panels, defined in YAML files (`monitor_panels_paths`) or, without that
//! setting, in the built-in `panels/default.yaml`.
//!
//! ```yaml
//! - dashboard: cloud.*          # entries with the same key make one page
//!   title: Instances            # optional, defaults to the key
//!   kind: instance              # instance | physical (default: physical when the key starts
//!                               #   with "physical", else instance)
//!   variables:                  # optional, the dashboard's own variables
//!     - monitor: cloud-infras
//!     - db: public-infras
//!   discover: '{monitor="$monitor",project_id=~"$project_id",guest_id!=""}'  # optional
//!   panels:
//!     - name: cpu
//!       description: CPU usage
//!       unit: percent
//!       legend_rows: 4          # legend rows before it scrolls (default: dashboard's, else 4)
//!       max_series: 8           # most series in the time series chart (default 8, up to 50)
//!       queries:
//!         - query: 'sum(rate(libvirt_cpu_user{db="$db",project_id="$project_id",guest_id="$guest_id"}[$__rate_interval]))'
//!           type: time_series   # time_series | pie_chart | stat | gauge
//!           legend: auto        # or a template such as "write {{device}}"
//!           unit: bytes         # optional, for stat / gauge / pie (default: the panel's)
//! ```
//!
//! Queries are written by the operator, not by users. Users only pick a dashboard, a panel and
//! a target; the server fills the variables. Every query of an instance dashboard must use
//! `$project_id`, which is always the token's project for project users: a file that breaks
//! this rule is refused, so a forgotten filter can't show other projects' data.

use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::{Duration, Instant, SystemTime},
};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

/// The built-in dashboards, used when `monitor_panels_paths` isn't set.
pub const DEFAULT_YAML: &str = include_str!("../panels/default.yaml");

/// How often the panel files are checked for changes.
const RECHECK: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Nova instances (libvirt guests), visible to project users for their own project.
    Instance,
    /// Physical servers, visible to admins only.
    Physical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChartType {
    TimeSeries,
    #[serde(alias = "pie")]
    PieChart,
    Stat,
    Gauge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
    #[default]
    #[serde(alias = "none", alias = "short")]
    Count,
    Percent,
    /// 0-1, shown as a percentage.
    #[serde(alias = "percentunit")]
    PercentUnit,
    Bytes,
    #[serde(alias = "Bps")]
    BytesPerSec,
    #[serde(alias = "bps")]
    BitsPerSec,
    #[serde(alias = "iops")]
    OpsPerSec,
    #[serde(alias = "pps")]
    PacketsPerSec,
    #[serde(alias = "s")]
    Seconds,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Width {
    #[default]
    Half,
    Full,
}

/// Whether a panel needs a picked instance / server, or shows the project / fleet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Target,
    Overview,
}

// ---------------------------------------------------------------------------- file format

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EntryDef {
    dashboard: String,
    title: Option<String>,
    kind: Option<Kind>,
    discover: Option<String>,
    variables: Option<VarsDef>,
    /// Default `legend_rows` of the dashboard's panels.
    legend_rows: Option<u32>,
    #[serde(default)]
    panels: Vec<PanelDef>,
}

/// `variables:` as a list of one-key maps (`- monitor: cloud-infras`) or as one map, in order.
#[derive(Deserialize)]
#[serde(untagged)]
enum VarsDef {
    List(Vec<serde_yaml::Mapping>),
    Map(serde_yaml::Mapping),
}

impl VarsDef {
    fn pairs(self) -> Vec<(serde_yaml::Value, serde_yaml::Value)> {
        match self {
            VarsDef::List(l) => l.into_iter().flatten().collect(),
            VarsDef::Map(m) => m.into_iter().collect(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PanelDef {
    name: String,
    title: Option<String>,
    description: Option<String>,
    #[serde(default)]
    unit: Unit,
    /// Default chart type of the panel's queries.
    #[serde(rename = "type")]
    chart: Option<ChartType>,
    #[serde(default)]
    width: Width,
    min: Option<f64>,
    max: Option<f64>,
    /// Legend rows shown before the legend scrolls (default: the dashboard's, else 4).
    legend_rows: Option<u32>,
    /// Most series in the panel's time series chart (default 8).
    max_series: Option<u32>,
    queries: Vec<QueryDef>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryDef {
    query: String,
    #[serde(rename = "type")]
    chart: Option<ChartType>,
    legend: Option<String>,
    /// Unit of this query's stat, gauge or pie chart (a time series chart uses the panel's).
    unit: Option<Unit>,
}

// ---------------------------------------------------------------------------- loaded model

#[derive(Debug, Serialize)]
pub struct Dashboard {
    pub id: String,
    pub title: String,
    pub kind: Kind,
    /// The dashboard's own variables (`variables:`), in order: constants such as `monitor` →
    /// `cloud-infras`, and query variables (`label_values(...)`) picked in the UI.
    pub variables: Vec<Variable>,
    /// Whether the page shows Rassvet's instance / server picker (from `discover`). A physical
    /// dashboard that defines `compute_node_id` or `hostname` as variables uses those instead.
    pub server_picker: bool,
    /// Series selector listing the instances / servers to pick from.
    #[serde(skip)]
    pub discover: String,
    pub panels: Vec<Panel>,
    /// Default `legend_rows` of the panels (`legend_rows:` of the dashboard).
    #[serde(skip)]
    legend_rows: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VarValue {
    Constant(String),
    /// `label_values(<selector>, <label>)`, or `label_values(<label>)` without a selector.
    LabelValues {
        selector: Option<String>,
        label: String,
    },
}

#[derive(Debug, Serialize)]
pub struct Variable {
    pub name: String,
    /// A query variable, picked in the UI; constants aren't shown.
    pub query: bool,
    #[serde(skip)]
    pub value: VarValue,
    /// As written, to compare definitions of the same variable in several entries.
    #[serde(skip)]
    raw: String,
}

impl Dashboard {
    pub fn var(&self, name: &str) -> Option<&Variable> {
        self.variables.iter().find(|v| v.name == name)
    }

    /// `(name, value)` of the constant variables.
    pub fn constants(&self) -> impl Iterator<Item = (&str, &str)> {
        self.variables.iter().filter_map(|v| match &v.value {
            VarValue::Constant(c) => Some((v.name.as_str(), c.as_str())),
            VarValue::LabelValues { .. } => None,
        })
    }
}

/// `label_values(<selector>, <label>)` or `label_values(<label>)` (Grafana's syntax);
/// `None` when `s` isn't a `label_values` call.
fn parse_label_values(s: &str) -> Option<Result<VarValue, String>> {
    let inner = s.trim().strip_prefix("label_values")?.trim_start();
    let inner = inner.strip_prefix('(')?.strip_suffix(')')?;
    // The last comma outside braces, parentheses and quotes splits selector and label.
    let (mut depth, mut quote, mut split) = (0i32, None::<char>, None);
    let mut prev = ' ';
    for (i, c) in inner.char_indices() {
        match quote {
            Some(q) if c == q && prev != '\\' => quote = None,
            Some(_) => {}
            None => match c {
                '"' | '\'' | '`' => quote = Some(c),
                '{' | '(' | '[' => depth += 1,
                '}' | ')' | ']' => depth -= 1,
                ',' if depth == 0 => split = Some(i),
                _ => {}
            },
        }
        prev = c;
    }
    let (selector, label) = match split {
        Some(i) => (Some(inner[..i].trim().to_owned()), inner[i + 1..].trim()),
        None => (None, inner.trim()),
    };
    if !valid_var_name(label) {
        return Some(Err(format!("{label:?} is not a label name")));
    }
    if selector.as_deref() == Some("") {
        return Some(Err("the series selector is empty".into()));
    }
    Some(Ok(VarValue::LabelValues {
        selector,
        label: label.to_owned(),
    }))
}

#[derive(Debug, Serialize)]
pub struct Panel {
    pub name: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub unit: Unit,
    pub width: Width,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    pub scope: Scope,
    pub queries: Vec<Query>,
    /// Legend rows shown before the legend scrolls.
    pub legend_rows: u32,
    /// `legend_rows` as set on the panel, if it was.
    #[serde(skip)]
    own_legend_rows: Option<u32>,
    /// Most series in the panel's time series chart (the busiest ones are kept).
    #[serde(skip)]
    pub max_series: usize,
    /// Variables used by the panel's queries.
    #[serde(skip)]
    pub vars: BTreeSet<String>,
}

#[derive(Debug, Serialize)]
pub struct Query {
    #[serde(rename = "type")]
    pub chart: ChartType,
    pub unit: Unit,
    #[serde(skip)]
    pub expr: String,
    #[serde(skip)]
    pub legend: Option<String>,
}

#[derive(Debug, Default)]
pub struct Catalog {
    pub dashboards: Vec<Dashboard>,
}

impl Catalog {
    pub fn find(&self, id: &str) -> Option<&Dashboard> {
        self.dashboards.iter().find(|d| d.id == id)
    }
}

/// Legend rows shown before a legend scrolls, unless set.
pub const DEFAULT_LEGEND_ROWS: u32 = 4;
/// Series in a time series chart, unless set (`max_series`), and the most that can be set.
pub const DEFAULT_MAX_SERIES: u32 = 8;
const LIMIT_MAX_SERIES: u32 = 50;

/// Variables filled by Rassvet; a dashboard's own `variables` may not use these names.
pub const VARS: &[&str] = &[
    "project_id",
    "guest_id",
    "compute_node_id",
    "hostname",
    "region",
    "__rate_interval",
    "__interval",
    "__range",
];

/// Built-in names a dashboard's own variables may not use: `project_id`, `guest_id` and
/// `region` always, `compute_node_id` and `hostname` in instance dashboards (a physical
/// dashboard may define them, e.g. with `label_values`, instead of using the server picker).
fn reserved(kind: Kind, name: &str) -> bool {
    name.starts_with("__")
        || match kind {
            Kind::Instance => VARS.contains(&name),
            Kind::Physical => ["project_id", "guest_id", "region"].contains(&name),
        }
}

/// Built-in variables `discover` may use (besides the dashboard's own).
const DISCOVER_VARS: &[&str] = &["project_id", "region"];

/// Names of the `$name` / `${name}` variables in `expr`, in order.
pub fn vars_in(expr: &str) -> Vec<String> {
    let mut out = Vec::new();
    scan(expr, |name| {
        out.push(name.to_owned());
        None
    });
    out
}

/// Replace known variables; values are escaped for a double-quoted PromQL string.
pub fn render(expr: &str, vars: &HashMap<&str, String>) -> String {
    scan(expr, |name| vars.get(name).map(|v| escape(v)))
}

/// Walk `expr`, calling `f` for each variable; `Some(text)` replaces it, `None` keeps it.
fn scan(expr: &str, mut f: impl FnMut(&str) -> Option<String>) -> String {
    let b = expr.as_bytes();
    let mut out = String::with_capacity(expr.len());
    let mut i = 0;
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    while i < b.len() {
        if b[i] == b'$' {
            let (name, end) = if b.get(i + 1) == Some(&b'{') {
                match expr[i + 2..].find('}') {
                    Some(n) => (&expr[i + 2..i + 2 + n], i + 3 + n),
                    None => ("", i + 1),
                }
            } else {
                let mut j = i + 1;
                while j < b.len() && ident(b[j]) {
                    j += 1;
                }
                (&expr[i + 1..j], j)
            };
            if !name.is_empty() && name.bytes().all(ident) {
                match f(name) {
                    Some(v) => out.push_str(&v),
                    None => out.push_str(&expr[i..end]),
                }
                i = end;
                continue;
            }
        }
        // Copy one UTF-8 character.
        let len = expr[i..].chars().next().map_or(1, char::len_utf8);
        out.push_str(&expr[i..i + len]);
        i += len;
    }
    out
}

/// Escape a value for a double-quoted PromQL string.
pub fn escape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out
}

fn default_discover(kind: Kind) -> &'static str {
    match kind {
        Kind::Instance => r#"{project_id=~"$project_id",guest_id!=""}"#,
        Kind::Physical => r#"{compute_node_id!=""}"#,
    }
}

fn valid_panel_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

/// Parse and check the YAML documents `(source name, text)`, merging entries with the same
/// dashboard key in the order given.
pub fn parse(sources: &[(String, String)]) -> anyhow::Result<Catalog> {
    let mut cat = Catalog::default();
    for (src, text) in sources {
        if text.trim().is_empty() {
            continue;
        }
        let entries: Vec<EntryDef> = serde_yaml::from_str(text)
            .with_context(|| format!("{src}: not a list of dashboards"))?;
        for e in entries {
            add(&mut cat, src, e)?;
        }
    }
    for d in &mut cat.dashboards {
        check_vars(d)?;
        // A dashboard's legend_rows may be set in a later entry than its panels.
        let default = d.legend_rows.unwrap_or(DEFAULT_LEGEND_ROWS);
        for p in &mut d.panels {
            p.legend_rows = p.own_legend_rows.unwrap_or(default);
        }
    }
    cat.dashboards.retain(|d| !d.panels.is_empty());
    Ok(cat)
}

/// Check the variables of a merged dashboard (variables and panels of a dashboard may come
/// from different files): names, the order of query variables, and that every variable used
/// is built in or defined.
fn check_vars(d: &mut Dashboard) -> anyhow::Result<()> {
    let id = d.id.clone();
    for v in &d.variables {
        if reserved(d.kind, &v.name) {
            bail!(
                "dashboard {id:?}: variable {:?} is built in and can't be defined here",
                v.name
            );
        }
    }
    d.server_picker = d.kind == Kind::Instance
        || (d.var("compute_node_id").is_none() && d.var("hostname").is_none());
    let names = |filter: &dyn Fn(&Variable) -> bool| -> Vec<&str> {
        d.variables
            .iter()
            .filter(|v| filter(v))
            .map(|v| v.name.as_str())
            .collect()
    };
    let list = |known: &[&str]| format!("${}", known.join(", $"));

    // Query variables may use built-ins, constants and the query variables before them.
    for (i, v) in d.variables.iter().enumerate() {
        let VarValue::LabelValues { selector, .. } = &v.value else {
            continue;
        };
        let at = format!("dashboard {id:?}, variable {:?}", v.name);
        let Some(sel) = selector else {
            if d.kind == Kind::Instance {
                bail!(
                    "{at}: in an instance dashboard, use label_values(<selector with project_id=\"$project_id\">, <label>)"
                );
            }
            continue;
        };
        let mut known: Vec<&str> = vec!["region"];
        match d.kind {
            // The picked instance, from Rassvet's instance picker.
            Kind::Instance => known.extend(["project_id", "guest_id"]),
            Kind::Physical if d.server_picker => known.extend(["compute_node_id", "hostname"]),
            Kind::Physical => {}
        }
        known.extend(names(&|o: &Variable| !o.query));
        known.extend(
            d.variables[..i]
                .iter()
                .filter(|o| o.query)
                .map(|o| o.name.as_str()),
        );
        let used = vars_in(sel);
        for u in &used {
            if !known.contains(&u.as_str()) {
                bail!(
                    "{at}: uses ${u}, which is not defined before it (it may use {})",
                    list(&known)
                );
            }
        }
        if d.kind == Kind::Instance && !used.iter().any(|u| u == "project_id") {
            bail!(
                "{at}: in an instance dashboard, the selector must match project_id=~\"$project_id\", \
                 so project users only get their own project's values"
            );
        }
    }

    let mut discover_known: Vec<&str> = DISCOVER_VARS.to_vec();
    discover_known.extend(names(&|o: &Variable| !o.query));
    for v in vars_in(&d.discover) {
        if !discover_known.contains(&v.as_str()) {
            bail!(
                "dashboard {id:?}: `discover` uses ${v}, which it can't (it may use {})",
                list(&discover_known)
            );
        }
    }

    let mut known: Vec<&str> = VARS.to_vec();
    known.extend(names(&|_| true));
    for p in &d.panels {
        for (i, q) in p.queries.iter().enumerate() {
            for v in vars_in(&q.expr) {
                if !known.contains(&v.as_str()) {
                    bail!(
                        "dashboard {id:?}, panel {:?}, query {}: unknown variable ${v} (known: {}); \
                         define it under the dashboard's `variables`",
                        p.name,
                        i + 1,
                        list(&known)
                    );
                }
            }
        }
    }
    Ok(())
}

fn valid_var_name(s: &str) -> bool {
    let mut b = s.bytes();
    b.next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && b.all(|c| c.is_ascii_alphanumeric() || c == b'_')
        && s.len() <= 64
}

fn add(cat: &mut Catalog, src: &str, e: EntryDef) -> anyhow::Result<()> {
    let key = e.dashboard.trim().to_owned();
    if key.is_empty() || key.len() > 256 || key.contains('\n') {
        bail!("{src}: `dashboard` must be a one-line value");
    }
    let kind = e.kind.unwrap_or(if key.starts_with("physical") {
        Kind::Physical
    } else {
        Kind::Instance
    });
    let at = format!("{src}: dashboard {key:?}");
    let idx = match cat.dashboards.iter().position(|d| d.id == key) {
        Some(i) => {
            let d = &mut cat.dashboards[i];
            if e.kind.is_some() && d.kind != kind {
                bail!("{at}: kind {kind:?} differs from {:?} set earlier", d.kind);
            }
            if let Some(t) = e.title {
                d.title = t;
            }
            if let Some(q) = e.discover {
                d.discover = q;
            }
            if e.legend_rows.is_some() {
                d.legend_rows = e.legend_rows;
            }
            i
        }
        None => {
            cat.dashboards.push(Dashboard {
                id: key.clone(),
                title: e.title.unwrap_or_else(|| key.clone()),
                kind,
                variables: Vec::new(),
                server_picker: true,
                legend_rows: e.legend_rows,
                discover: e
                    .discover
                    .unwrap_or_else(|| default_discover(kind).to_owned()),
                panels: Vec::new(),
            });
            cat.dashboards.len() - 1
        }
    };
    let d = &mut cat.dashboards[idx];
    if d.legend_rows.is_some_and(|n| !(1..=50).contains(&n)) {
        bail!("{at}: legend_rows must be 1-50");
    }
    for (name, value) in e.variables.map(VarsDef::pairs).unwrap_or_default() {
        let Some(name) = name.as_str().map(str::to_owned) else {
            bail!("{at}: variable names must be text");
        };
        if !valid_var_name(&name) || name.starts_with("__") {
            bail!("{at}: variable {name:?} must be a name (letters, digits, '_')");
        }
        let raw = match value {
            serde_yaml::Value::String(s) => s,
            serde_yaml::Value::Number(n) => n.to_string(),
            serde_yaml::Value::Bool(b) => b.to_string(),
            _ => bail!("{at}: variable {name:?} must be a string, a number or true / false"),
        };
        if raw.contains('\n') {
            bail!("{at}: variable {name:?} must be one line");
        }
        let value = match parse_label_values(&raw) {
            Some(Ok(v)) => v,
            Some(Err(e)) => bail!("{at}: variable {name:?}: {e}"),
            None => VarValue::Constant(raw.clone()),
        };
        match d.variables.iter().find(|v| v.name == name) {
            Some(old) if old.raw != raw => bail!(
                "{at}: variable {name:?} is {raw:?} here but {:?} in an earlier entry",
                old.raw
            ),
            Some(_) => {}
            None => d.variables.push(Variable {
                query: matches!(value, VarValue::LabelValues { .. }),
                name,
                value,
                raw,
            }),
        }
    }
    for p in e.panels {
        let pat = format!("{at}, panel {:?}", p.name);
        if !valid_panel_name(&p.name) {
            bail!("{pat}: `name` must be 1-64 letters, digits, '-', '_' or '.'");
        }
        if d.panels.iter().any(|o| o.name == p.name) {
            bail!("{pat}: another panel of this dashboard has the same name");
        }
        if p.queries.is_empty() {
            bail!("{pat}: needs at least one query");
        }
        if p.legend_rows.is_some_and(|n| !(1..=50).contains(&n)) {
            bail!("{pat}: legend_rows must be 1-50");
        }
        if p.max_series
            .is_some_and(|n| !(1..=LIMIT_MAX_SERIES).contains(&n))
        {
            bail!("{pat}: max_series must be 1-{LIMIT_MAX_SERIES}");
        }
        let mut vars = BTreeSet::new();
        let mut queries = Vec::new();
        for (i, q) in p.queries.into_iter().enumerate() {
            let qat = format!("{pat}, query {}", i + 1);
            if q.query.trim().is_empty() {
                bail!("{qat}: `query` is empty");
            }
            let used = vars_in(&q.query);
            for v in &used {
                let wrong = match kind {
                    Kind::Instance => v == "compute_node_id" || v == "hostname",
                    Kind::Physical => v == "guest_id",
                };
                if wrong {
                    bail!("{qat}: ${v} has no value in a {kind:?} dashboard");
                }
            }
            if kind == Kind::Instance && !used.iter().any(|v| v == "project_id") {
                bail!(
                    "{qat}: queries of instance dashboards must match project_id=\"$project_id\", \
                     so project users only see their own project"
                );
            }
            vars.extend(used);
            queries.push(Query {
                chart: q.chart.or(p.chart).unwrap_or(ChartType::TimeSeries),
                unit: q.unit.unwrap_or(p.unit),
                expr: q.query,
                legend: q
                    .legend
                    .filter(|l| !l.trim().is_empty() && l.trim() != "auto"),
            });
        }
        let target = match kind {
            Kind::Instance => vars.contains("guest_id"),
            Kind::Physical => vars.contains("compute_node_id") || vars.contains("hostname"),
        };
        d.panels.push(Panel {
            title: p
                .title
                .clone()
                .or_else(|| p.description.clone())
                .unwrap_or_else(|| p.name.clone()),
            description: p.description.filter(|_| p.title.is_some()),
            name: p.name,
            unit: p.unit,
            width: p.width,
            min: p.min,
            max: p.max,
            scope: if target {
                Scope::Target
            } else {
                Scope::Overview
            },
            queries,
            legend_rows: DEFAULT_LEGEND_ROWS,
            own_legend_rows: p.legend_rows,
            max_series: p.max_series.unwrap_or(DEFAULT_MAX_SERIES) as usize,
            vars,
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------- files

/// The YAML files of `paths`: each a file, or a directory whose `*.yaml` / `*.yml` files are
/// read in name order (not recursively).
fn files(paths: &[String]) -> anyhow::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for p in paths {
        let path = Path::new(p);
        if path.is_dir() {
            let mut found: Vec<PathBuf> = std::fs::read_dir(path)
                .with_context(|| format!("reading {p}"))?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|f| f.is_file() && f.extension().is_some_and(|x| x == "yaml" || x == "yml"))
                .collect();
            found.sort();
            out.extend(found);
        } else if path.is_file() {
            out.push(path.to_owned());
        } else {
            bail!("monitor_panels_paths: {p} is neither a file nor a directory");
        }
    }
    Ok(out)
}

type Fingerprint = Vec<(PathBuf, Option<SystemTime>, u64)>;

fn fingerprint(paths: &[String]) -> anyhow::Result<Fingerprint> {
    Ok(files(paths)?
        .into_iter()
        .map(|f| {
            let m = std::fs::metadata(&f).ok();
            let modified = m.as_ref().and_then(|m| m.modified().ok());
            let len = m.map_or(0, |m| m.len());
            (f, modified, len)
        })
        .collect())
}

fn load_files(paths: &[String]) -> anyhow::Result<Catalog> {
    let mut sources = Vec::new();
    for f in files(paths)? {
        let text =
            std::fs::read_to_string(&f).with_context(|| format!("reading {}", f.display()))?;
        sources.push((f.display().to_string(), text));
    }
    let cat = parse(&sources)?;
    if cat.dashboards.is_empty() {
        bail!(
            "no dashboard with panels in monitor_panels_paths ({}); copy panels/default.yaml there",
            paths.join(", ")
        );
    }
    Ok(cat)
}

struct State {
    catalog: Arc<Catalog>,
    fingerprint: Fingerprint,
    checked: Instant,
}

/// The dashboards of one cloud; reloaded when the files change.
pub struct Panels {
    paths: Option<Vec<String>>,
    state: RwLock<State>,
}

impl Panels {
    pub fn load(paths: Option<Vec<String>>) -> anyhow::Result<Self> {
        let (catalog, fp) = match &paths {
            Some(p) => (load_files(p)?, fingerprint(p)?),
            None => (
                parse(&[("panels/default.yaml".into(), DEFAULT_YAML.into())])?,
                Vec::new(),
            ),
        };
        Ok(Self {
            paths,
            state: RwLock::new(State {
                catalog: Arc::new(catalog),
                fingerprint: fp,
                checked: Instant::now(),
            }),
        })
    }

    /// The current dashboards. Every few seconds, checks whether the files changed and loads
    /// them again; a broken file is logged and the previous dashboards are kept.
    pub fn get(&self) -> Arc<Catalog> {
        let Some(paths) = &self.paths else {
            return self.state.read().unwrap().catalog.clone();
        };
        {
            let s = self.state.read().unwrap();
            if s.checked.elapsed() < RECHECK {
                return s.catalog.clone();
            }
        }
        let mut s = self.state.write().unwrap();
        if s.checked.elapsed() < RECHECK {
            return s.catalog.clone();
        }
        s.checked = Instant::now();
        match fingerprint(paths) {
            Ok(fp) if fp != s.fingerprint => {
                s.fingerprint = fp;
                match load_files(paths) {
                    Ok(c) => {
                        tracing::info!(
                            dashboards = c.dashboards.len(),
                            "monitors: panel files reloaded"
                        );
                        s.catalog = Arc::new(c);
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = format!("{e:#}"),
                            "monitors: panel files not reloaded, keeping the previous ones"
                        )
                    }
                }
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(
                error = format!("{e:#}"),
                "monitors: can't read the panel files"
            ),
        }
        s.catalog.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(yaml: &str) -> anyhow::Result<Catalog> {
        parse(&[("t.yaml".into(), yaml.into())])
    }

    #[test]
    fn default_panels_load() {
        let c = one(DEFAULT_YAML).unwrap();
        let kinds: Vec<_> = c.dashboards.iter().map(|d| d.kind).collect();
        assert!(kinds.contains(&Kind::Instance) && kinds.contains(&Kind::Physical));
        for d in &c.dashboards {
            assert!(
                d.panels.iter().any(|p| p.scope == Scope::Target),
                "{}",
                d.id
            );
        }
    }

    #[test]
    fn merges_entries_and_infers_kind_and_scope() {
        let c = parse(&[
            (
                "a.yaml".into(),
                r#"
- dashboard: cloud.*
  panels:
    - name: cpu
      description: CPU Monitors
      queries:
        - query: 'sum(x{project_id="$project_id",guest_id="$guest_id"})'
          legend: write-{{device}}
"#
                .into(),
            ),
            (
                "b.yaml".into(),
                r#"
- dashboard: cloud.*
  title: Instances
  panels:
    - name: totals
      queries:
        - query: 'sum(y{project_id="$project_id"})'
          type: stat
- dashboard: physical-infras
  panels:
    - name: load
      queries: [{query: 'system_load1{hostname="$hostname"}', type: gauge}]
"#
                .into(),
            ),
        ])
        .unwrap();
        let d = c.find("cloud.*").unwrap();
        assert_eq!(d.title, "Instances");
        assert_eq!(d.kind, Kind::Instance);
        assert_eq!(d.panels[0].title, "CPU Monitors");
        assert_eq!(d.panels[0].scope, Scope::Target);
        assert_eq!(
            d.panels[0].queries[0].legend.as_deref(),
            Some("write-{{device}}")
        );
        assert_eq!(d.panels[1].scope, Scope::Overview);
        assert_eq!(d.panels[1].queries[0].chart, ChartType::Stat);
        let p = c.find("physical-infras").unwrap();
        assert_eq!(p.kind, Kind::Physical);
        assert_eq!(p.panels[0].scope, Scope::Target);
    }

    #[test]
    fn refuses_unsafe_or_wrong_panels() {
        let no_project = r#"
- dashboard: cloud.*
  panels:
    - name: cpu
      queries: [{query: 'sum(x{guest_id="$guest_id"})'}]
"#;
        let e = one(no_project).unwrap_err().to_string();
        assert!(e.contains("project_id"), "{e}");
        let unknown = r#"
- dashboard: physical.*
  panels:
    - name: cpu
      queries: [{query: 'x{host="$host"}'}]
"#;
        assert!(
            one(unknown)
                .unwrap_err()
                .to_string()
                .contains("unknown variable $host")
        );
        let wrong_kind = r#"
- dashboard: physical.*
  panels:
    - name: cpu
      queries: [{query: 'x{guest_id="$guest_id"}'}]
"#;
        assert!(one(wrong_kind).is_err());
        let dup = r#"
- dashboard: physical.*
  panels:
    - {name: a, queries: [{query: 'x'}]}
    - {name: a, queries: [{query: 'y'}]}
"#;
        assert!(one(dup).is_err());
        assert!(
            one("- dashboard: x\n  panels:\n    - {name: a, queries: [{query: 'x', type: bar}]}")
                .is_err()
        );
    }

    #[test]
    fn dashboard_variables() {
        // Variables may be defined in another file than the panels using them.
        let c = parse(&[
            (
                "a.yaml".into(),
                r#"
- dashboard: cloud.*
  variables:
    - monitor: cloud-infras
  discover: '{monitor="$monitor",db="$db",project_id=~"$project_id"}'
  panels:
    - name: cpu
      queries: [{query: 'x{monitor="$monitor",db="$db",project_id="$project_id"}'}]
"#
                .into(),
            ),
            (
                "b.yaml".into(),
                "- dashboard: cloud.*\n  variables: {db: public-infras, monitor: cloud-infras}\n"
                    .into(),
            ),
        ])
        .unwrap();
        let d = c.find("cloud.*").unwrap();
        let consts: Vec<_> = d.constants().collect();
        assert_eq!(
            consts,
            [("monitor", "cloud-infras"), ("db", "public-infras")]
        );

        let undefined = r#"
- dashboard: cloud.*
  panels:
    - name: cpu
      queries: [{query: 'x{monitor="$monitor",project_id="$project_id"}'}]
"#;
        let e = one(undefined).unwrap_err().to_string();
        assert!(e.contains("unknown variable $monitor"), "{e}");
        // Built-in names can't be redefined: $project_id stays the user's project.
        let reserved = "- dashboard: cloud.*\n  variables: [{project_id: p2}]\n";
        assert!(one(reserved).is_err());
        let clash =
            "- dashboard: x\n  variables: [{a: '1'}]\n- dashboard: x\n  variables: [{a: '2'}]\n";
        assert!(
            one(clash)
                .unwrap_err()
                .to_string()
                .contains("earlier entry")
        );
        assert!(one("- dashboard: x\n  variables: [{a: [1]}]\n").is_err());
    }

    #[test]
    fn query_variables() {
        let c = one(
            r#"
- dashboard: physical.*
  variables:
    - zone: nova
    - availability_zone: label_values(openstack_compute_node_usage_cpu_allocation_ratio, availability_zone)
    - compute: label_values(openstack_compute_node_usage_cpu_allocation_ratio{availability_zone="$availability_zone"},hostname)
    - compute_node_id: label_values(openstack_compute_node_usage_cpu_allocation_ratio{availability_zone="$availability_zone", hostname="$compute"},compute_node_id)
    - all_zones: label_values(availability_zone)
  panels:
    - name: cpu
      queries: [{query: 'x{compute_node_id="$compute_node_id",az="$zone"}'}]
"#,
        )
        .unwrap();
        let d = &c.dashboards[0];
        assert!(
            !d.server_picker,
            "compute_node_id is a variable: no server picker"
        );
        let q: Vec<_> = d
            .variables
            .iter()
            .filter(|v| v.query)
            .map(|v| v.name.as_str())
            .collect();
        assert_eq!(
            q,
            [
                "availability_zone",
                "compute",
                "compute_node_id",
                "all_zones"
            ]
        );
        assert_eq!(
            d.var("compute_node_id").unwrap().value,
            VarValue::LabelValues {
                selector: Some(r#"openstack_compute_node_usage_cpu_allocation_ratio{availability_zone="$availability_zone", hostname="$compute"}"#.into()),
                label: "compute_node_id".into(),
            }
        );
        assert_eq!(
            d.var("all_zones").unwrap().value,
            VarValue::LabelValues {
                selector: None,
                label: "availability_zone".into()
            }
        );

        // A query variable may only use the ones before it.
        let later = r#"
- dashboard: physical.*
  variables:
    - compute_node_id: label_values(x{hostname="$compute"}, compute_node_id)
    - compute: label_values(x, hostname)
  panels: [{name: a, queries: [{query: 'y{compute_node_id="$compute_node_id"}'}]}]
"#;
        assert!(
            one(later)
                .unwrap_err()
                .to_string()
                .contains("not defined before it")
        );
        // Instance dashboards: project_id stays built in, query variables must filter on it.
        let unscoped = r#"
- dashboard: cloud.*
  variables: [{flavor: 'label_values(libvirt_cpu_number, flavor)'}]
  panels: [{name: a, queries: [{query: 'y{project_id="$project_id",f="$flavor"}'}]}]
"#;
        assert!(
            one(unscoped)
                .unwrap_err()
                .to_string()
                .contains("project_id")
        );
        let scoped = r#"
- dashboard: cloud.*
  variables: [{flavor: 'label_values(libvirt_cpu_number{project_id=~"$project_id"}, flavor)'}]
  panels: [{name: a, queries: [{query: 'y{project_id="$project_id",f="$flavor"}'}]}]
"#;
        assert!(one(scoped).unwrap().dashboards[0].server_picker);
        let by_guest = r#"
- dashboard: cloud.user
  variables:
    - guest_name: label_values({project_id="$project_id", guest_id="$guest_id"},guest_name)
  panels: [{name: a, queries: [{query: 'y{project_id="$project_id",n="$guest_name"}'}]}]
"#;
        assert!(one(by_guest).is_ok());
        let own_host = "- dashboard: cloud.*\n  variables: [{hostname: a}]\n  panels: [{name: a, queries: [{query: 'y{project_id=\"$project_id\"}'}]}]\n";
        assert!(one(own_host).is_err());
        assert!(one("- dashboard: x\n  variables: [{a: 'label_values(x, \"bad\")'}]\n").is_err());
    }

    #[test]
    fn legend_rows_and_max_series() {
        let c = parse(&[
            (
                "a.yaml".into(),
                r#"
- dashboard: physical.*
  panels:
    - {name: a, queries: [{query: 'x'}]}
    - {name: b, legend_rows: 2, max_series: 20, queries: [{query: 'x'}]}
"#
                .into(),
            ),
            (
                "b.yaml".into(),
                "- dashboard: physical.*\n  legend_rows: 6\n".into(),
            ),
        ])
        .unwrap();
        let p = &c.dashboards[0].panels;
        assert_eq!((p[0].legend_rows, p[0].max_series), (6, 8));
        assert_eq!((p[1].legend_rows, p[1].max_series), (2, 20));
        assert_eq!(
            one("- dashboard: physical-x\n  panels: [{name: a, queries: [{query: x}]}]")
                .unwrap()
                .dashboards[0]
                .panels[0]
                .legend_rows,
            4
        );
        assert!(one("- dashboard: physical-x\n  panels: [{name: a, max_series: 51, queries: [{query: x}]}]").unwrap_err().to_string().contains("max_series"));
        assert!(one("- dashboard: physical-x\n  legend_rows: 0\n  panels: [{name: a, queries: [{query: x}]}]").unwrap_err().to_string().contains("legend_rows"));
    }

    #[test]
    fn renders_variables() {
        let vars: HashMap<&str, String> = [
            ("project_id", "p\"1".to_string()),
            ("__rate_interval", "300s".into()),
        ]
        .into();
        assert_eq!(
            render(
                r#"rate(x{p="$project_id",q="${project_id}"}[$__rate_interval]) $unknown "a$""#,
                &vars
            ),
            r#"rate(x{p="p\"1",q="p\"1"}[300s]) $unknown "a$""#
        );
        assert_eq!(vars_in(r#"x{a=~"^b$|c"} $guest_id"#), ["guest_id"]);
    }

    #[test]
    fn reloads_changed_files() {
        let dir = std::env::temp_dir().join(format!("rassvet-panels-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, panel: &str| {
            std::fs::write(
                dir.join(name),
                format!("- dashboard: physical.*\n  panels:\n    - {{name: {panel}, queries: [{{query: 'x'}}]}}\n"),
            )
            .unwrap()
        };
        write("10-a.yaml", "a");
        std::fs::write(dir.join("notes.txt"), "ignored").unwrap();
        let p = Panels::load(Some(vec![dir.display().to_string()])).unwrap();
        assert_eq!(p.get().dashboards[0].panels.len(), 1);
        write("20-b.yml", "b");
        p.state.write().unwrap().checked = Instant::now() - RECHECK * 2;
        assert_eq!(p.get().dashboards[0].panels.len(), 2);
        // A broken file keeps the previous dashboards.
        std::fs::write(dir.join("30-bad.yaml"), "- dashboard: [").unwrap();
        p.state.write().unwrap().checked = Instant::now() - RECHECK * 2;
        assert_eq!(p.get().dashboards[0].panels.len(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
