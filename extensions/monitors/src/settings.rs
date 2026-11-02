//! `[cloud.extensions.monitors]` of rassvet.toml: the Prometheus of a cloud and the limits.

use std::time::Duration;

use anyhow::{Context, bail};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    /// Base URL of the Prometheus HTTP API (anything that answers `/api/v1/query_range`:
    /// Prometheus, VictoriaMetrics, Thanos, Mimir…), e.g. `http://prometheus:9090`.
    pub prometheus_url: String,
    /// `Authorization: Bearer …` sent to Prometheus.
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default)]
    pub bearer_token_file: Option<String>,
    /// HTTP basic auth sent to Prometheus.
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub password_file: Option<String>,
    #[serde(default)]
    pub ca_file: Option<String>,
    #[serde(default)]
    pub insecure_tls: bool,
    /// Longest time range a project user may look at, counted back from now.
    #[serde(default = "d60")]
    pub project_max_range_days: u32,
    /// Longest time range an admin may look at, counted back from now.
    #[serde(default = "d365")]
    pub admin_max_range_days: u32,
    #[serde(default = "d30")]
    pub timeout_seconds: u64,
    /// Smallest window of `rate()` for counters; at least 4× the scrape / Telegraf interval.
    #[serde(default = "d300")]
    pub rate_window_seconds: u64,
    /// Also match `region="<the session's region>"` in every query (one Prometheus for
    /// several regions). Off: only `project_id` scopes what a project user sees.
    #[serde(default)]
    pub region_filter: bool,
    /// Regular expression the `monitor` label of instance metrics must match (whole value),
    /// e.g. `cloud`, `cloud-infras`.
    #[serde(default = "d_cloud")]
    pub cloud_monitor: String,
    /// Regular expression the `monitor` label of physical server metrics must match.
    #[serde(default = "d_physical")]
    pub physical_monitor: String,
}

fn d_cloud() -> String {
    "cloud.*".into()
}
fn d_physical() -> String {
    "physical.*".into()
}

const fn d60() -> u32 {
    60
}
const fn d365() -> u32 {
    365
}
const fn d30() -> u64 {
    30
}
const fn d300() -> u64 {
    300
}

/// How rassvet authenticates to Prometheus.
#[derive(Clone)]
pub enum Auth {
    None,
    Bearer(String),
    Basic(String, Option<String>),
}

fn read_secret(path: &str, what: &str) -> anyhow::Result<String> {
    let raw = std::fs::read_to_string(path).with_context(|| format!("reading {what} {path}"))?;
    Ok(raw.lines().next().unwrap_or("").trim().to_owned())
}

impl Settings {
    pub fn parse(cloud: &str, v: toml::Value) -> anyhow::Result<Self> {
        let s: Settings = v
            .try_into()
            .with_context(|| format!("[cloud.extensions.monitors] of cloud '{cloud}'"))?;
        let url = reqwest::Url::parse(&s.prometheus_url)
            .with_context(|| format!("cloud '{cloud}': prometheus_url {:?}", s.prometheus_url))?;
        if !matches!(url.scheme(), "http" | "https") {
            bail!("cloud '{cloud}': prometheus_url must be http:// or https://");
        }
        for (name, days) in [
            ("project_max_range_days", s.project_max_range_days),
            ("admin_max_range_days", s.admin_max_range_days),
        ] {
            if !(1..=3650).contains(&days) {
                bail!("cloud '{cloud}': {name} must be 1-3650");
            }
        }
        for (name, re) in [
            ("cloud_monitor", &s.cloud_monitor),
            ("physical_monitor", &s.physical_monitor),
        ] {
            if re.is_empty() || re.len() > 256 || re.contains('\n') {
                bail!("cloud '{cloud}': {name} must be a one-line regular expression");
            }
        }
        if s.timeout_seconds == 0 || s.rate_window_seconds == 0 {
            bail!("cloud '{cloud}': timeout_seconds and rate_window_seconds must be > 0");
        }
        if (s.bearer_token.is_some() || s.bearer_token_file.is_some()) && s.username.is_some() {
            bail!("cloud '{cloud}': use either a bearer token or username/password for Prometheus");
        }
        Ok(s)
    }

    pub fn auth(&self) -> anyhow::Result<Auth> {
        if let Some(p) = &self.bearer_token_file {
            return Ok(Auth::Bearer(read_secret(p, "bearer_token_file")?));
        }
        if let Some(t) = &self.bearer_token {
            return Ok(Auth::Bearer(t.clone()));
        }
        if let Some(u) = &self.username {
            let pw = match &self.password_file {
                Some(p) => Some(read_secret(p, "password_file")?),
                None => self.password.clone(),
            };
            return Ok(Auth::Basic(u.clone(), pw));
        }
        Ok(Auth::None)
    }

    pub fn timeout(&self) -> Duration {
        Duration::from_secs(self.timeout_seconds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> anyhow::Result<Settings> {
        Settings::parse("lab", toml::from_str(s).unwrap())
    }

    #[test]
    fn defaults() {
        let s = parse(r#"prometheus_url = "http://prom:9090""#).unwrap();
        assert_eq!(s.project_max_range_days, 60);
        assert_eq!(s.admin_max_range_days, 365);
        assert!(!s.region_filter);
        assert_eq!(s.cloud_monitor, "cloud.*");
        assert_eq!(s.physical_monitor, "physical.*");
        assert!(matches!(s.auth().unwrap(), Auth::None));
    }

    #[test]
    fn rejects_bad_values() {
        assert!(parse(r#"prometheus_url = "ftp://prom""#).is_err());
        assert!(
            parse(
                r#"prometheus_url = "http://p"
project_max_range_days = 0"#
            )
            .is_err()
        );
        assert!(
            parse(
                r#"prometheus_url = "http://p"
unknown = 1"#
            )
            .is_err()
        );
        assert!(
            parse(
                r#"prometheus_url = "http://p"
bearer_token = "t"
username = "u""#
            )
            .is_err()
        );
    }
}
