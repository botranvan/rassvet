//! A small client of the Prometheus HTTP API: `query_range` and `series`.

use std::collections::BTreeMap;

use rassvet_ext_api::{ApiError, axum::http::StatusCode};
use serde::Deserialize;
use serde_json::Value;

use crate::settings::{Auth, Settings};

pub type Labels = BTreeMap<String, String>;

pub struct Prometheus {
    base: reqwest::Url,
    http: reqwest::Client,
    auth: Auth,
    timeout: std::time::Duration,
}

/// One series of a range query; values that aren't finite numbers are left out.
pub struct Series {
    pub labels: Labels,
    pub values: Vec<(f64, f64)>,
}

#[derive(Deserialize)]
struct Envelope<T> {
    status: String,
    #[serde(default = "none")]
    data: Option<T>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct Matrix {
    #[serde(rename = "resultType")]
    result_type: String,
    result: Vec<MatrixItem>,
}

#[derive(Deserialize)]
struct MatrixItem {
    metric: Labels,
    #[serde(default)]
    values: Vec<(f64, String)>,
}

/// Largest answer read from Prometheus; a larger one (e.g. a `series` call matching far too
/// much) is refused rather than held in memory.
const MAX_BODY: usize = 64 * 1024 * 1024;

async fn read_limited(mut res: reqwest::Response, max: usize) -> Result<Vec<u8>, ApiError> {
    let too_big = || {
        tracing::warn!(max, "Prometheus answer too large");
        upstream("Prometheus answered with too much data; narrow the query or the time range")
    };
    if res.content_length().is_some_and(|n| n > max as u64) {
        return Err(too_big());
    }
    let mut out = Vec::new();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|_| upstream("Prometheus closed the connection"))?
    {
        if out.len() + chunk.len() > max {
            return Err(too_big());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

fn none<T>() -> Option<T> {
    None
}

fn upstream(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_GATEWAY, msg)
}

impl Prometheus {
    pub fn new(s: &Settings) -> anyhow::Result<Self> {
        let ca = match &s.ca_file {
            Some(p) => {
                Some(std::fs::read(p).map_err(|e| anyhow::anyhow!("reading CA file {p}: {e}"))?)
            }
            None => None,
        };
        let mut base = reqwest::Url::parse(&s.prometheus_url)?;
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        Ok(Self {
            base,
            http: rassvet_ext_api::os::http_client(s.insecure_tls, ca.as_deref())?,
            auth: s.auth()?,
            timeout: s.timeout(),
        })
    }

    async fn get<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        params: &[(&str, String)],
    ) -> Result<T, ApiError> {
        let url = self.base.join(path).map_err(|e| upstream(e.to_string()))?;
        let mut req = self.http.get(url).query(params).timeout(self.timeout);
        req = match &self.auth {
            Auth::None => req,
            Auth::Bearer(t) => req.bearer_auth(t),
            Auth::Basic(u, p) => req.basic_auth(u, p.as_ref()),
        };
        let res = req.send().await.map_err(|e| {
            tracing::warn!(error = %e, "Prometheus request failed");
            upstream(if e.is_timeout() {
                "Prometheus did not answer in time".to_owned()
            } else {
                "Prometheus is unreachable".to_owned()
            })
        })?;
        let status = res.status();
        let raw = read_limited(res, MAX_BODY).await?;
        let body: Value = serde_json::from_slice(&raw).map_err(|_| {
            upstream(format!(
                "Prometheus answered HTTP {status} without a JSON body"
            ))
        })?;
        let env: Envelope<T> = serde_json::from_value(body)
            .map_err(|e| upstream(format!("unexpected answer from Prometheus: {e}")))?;
        if env.status != "success" {
            let msg = env.error.unwrap_or_else(|| format!("HTTP {status}"));
            tracing::warn!(%status, error = msg, query = ?params.first().map(|p| &p.1), "Prometheus refused a query");
            return Err(upstream(format!("Prometheus: {msg}")));
        }
        env.data
            .ok_or_else(|| upstream("Prometheus answered without data"))
    }

    pub async fn query_range(
        &self,
        query: &str,
        start: i64,
        end: i64,
        step: i64,
    ) -> Result<Vec<Series>, ApiError> {
        let m: Matrix = self
            .get(
                "api/v1/query_range",
                &[
                    ("query", query.to_owned()),
                    ("start", start.to_string()),
                    ("end", end.to_string()),
                    ("step", step.to_string()),
                ],
            )
            .await?;
        if m.result_type != "matrix" {
            return Err(upstream(format!("Prometheus returned a {}", m.result_type)));
        }
        Ok(m.result
            .into_iter()
            .map(|i| Series {
                labels: i.metric,
                values: i
                    .values
                    .into_iter()
                    .filter_map(|(t, v)| {
                        v.parse::<f64>()
                            .ok()
                            .filter(|v| v.is_finite())
                            .map(|v| (t, v))
                    })
                    .collect(),
            })
            .collect())
    }

    /// Evaluate `query` at `time`: one value per series (a scalar result is one series
    /// without labels).
    pub async fn query(&self, query: &str, time: i64) -> Result<Vec<Series>, ApiError> {
        let v: Value = self
            .get(
                "api/v1/query",
                &[("query", query.to_owned()), ("time", time.to_string())],
            )
            .await?;
        let num = |p: &Value| -> Option<(f64, f64)> {
            let t = p.get(0)?.as_f64()?;
            let v = p
                .get(1)?
                .as_str()?
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())?;
            Some((t, v))
        };
        match v.get("resultType").and_then(Value::as_str) {
            Some("vector") => Ok(v["result"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|i| Series {
                    labels: serde_json::from_value(i["metric"].clone()).unwrap_or_default(),
                    values: num(&i["value"]).into_iter().collect(),
                })
                .collect()),
            Some("scalar") => Ok(vec![Series {
                labels: Labels::new(),
                values: num(&v["result"]).into_iter().collect(),
            }]),
            other => Err(upstream(format!(
                "Prometheus returned a {} for an instant query",
                other.unwrap_or("result")
            ))),
        }
    }

    /// The values of `label` between `start` and `end` (`/api/v1/label/<label>/values`).
    pub async fn label_values(
        &self,
        label: &str,
        start: i64,
        end: i64,
    ) -> Result<Vec<String>, ApiError> {
        self.get(
            &format!("api/v1/label/{label}/values"),
            &[("start", start.to_string()), ("end", end.to_string())],
        )
        .await
    }

    /// Label sets of the series matching any of `matchers` between `start` and `end`.
    pub async fn series(
        &self,
        matchers: &[String],
        start: i64,
        end: i64,
    ) -> Result<Vec<Labels>, ApiError> {
        let mut params: Vec<(&str, String)> =
            matchers.iter().map(|m| ("match[]", m.clone())).collect();
        params.push(("start", start.to_string()));
        params.push(("end", end.to_string()));
        self.get("api/v1/series", &params).await
    }
}
