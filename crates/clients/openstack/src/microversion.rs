use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};

/// An API microversion such as `2.96` (compute) or `3.71` (block-storage).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Microversion {
    pub major: u16,
    pub minor: u16,
}

impl Microversion {
    pub const fn new(major: u16, minor: u16) -> Self {
        Self { major, minor }
    }

    /// Header (name, value) to request this microversion from `service_type`.
    /// Uses the generic `OpenStack-API-Version` header understood by
    /// Nova, Cinder, Placement, Manila, Ironic and friends.
    pub fn header(self, service_type: &str) -> (&'static str, String) {
        let svc = match service_type {
            "block-storage" | "volumev3" => "volume",
            other => other,
        };
        ("OpenStack-API-Version", format!("{svc} {self}"))
    }

    /// Pick the highest version both sides support, if any overlap.
    pub fn negotiate(client_max: Self, server: VersionRange) -> Option<Self> {
        if client_max < server.min {
            return None;
        }
        Some(client_max.min(server.max))
    }
}

impl fmt::Display for Microversion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

impl FromStr for Microversion {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let s = s.trim();
        let (a, b) = s
            .split_once('.')
            .ok_or_else(|| format!("bad microversion '{s}'"))?;
        Ok(Self {
            major: a.parse().map_err(|_| format!("bad microversion '{s}'"))?,
            minor: b.parse().map_err(|_| format!("bad microversion '{s}'"))?,
        })
    }
}

impl Serialize for Microversion {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Microversion {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

/// Supported microversion range advertised by a service's version document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionRange {
    pub min: Microversion,
    pub max: Microversion,
}

impl VersionRange {
    /// Parse a version discovery document (`GET <endpoint>/`), either the single
    /// `{"version": {...}}` form or the `{"versions": [...]}` list, picking the CURRENT one.
    pub fn from_discovery(doc: &serde_json::Value) -> Option<Self> {
        let pick = |v: &serde_json::Value| -> Option<Self> {
            let min = v.get("min_version")?.as_str().filter(|s| !s.is_empty())?;
            // Nova/Cinder use `version`, Placement uses `max_version`.
            let max = v
                .get("version")
                .and_then(|m| m.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| v.get("max_version")?.as_str())
                .filter(|s| !s.is_empty())?;
            Some(Self {
                min: min.parse().ok()?,
                max: max.parse().ok()?,
            })
        };
        if let Some(v) = doc.get("version") {
            return pick(v);
        }
        let list = doc.get("versions")?;
        let list = list.get("values").unwrap_or(list).as_array()?;
        list.iter()
            .find(|v| v.get("status").and_then(|s| s.as_str()) == Some("CURRENT"))
            .and_then(pick)
    }
}

/// Candidate URLs for a service's version document, most specific first:
/// the endpoint itself, the endpoint cut after its `/vN[.M]` segment, and the root.
pub fn discovery_urls(endpoint: &str) -> Vec<String> {
    let e = endpoint.trim_end_matches('/');
    let mut out = vec![e.to_owned()];
    if let Some(pos) = e.match_indices("/v").find_map(|(i, _)| {
        let rest = &e[i + 2..];
        let end = rest.find('/').unwrap_or(rest.len());
        let ver = &rest[..end];
        (!ver.is_empty() && ver.chars().all(|c| c.is_ascii_digit() || c == '.'))
            .then_some(i + 2 + end)
    }) {
        let cut = &e[..pos];
        if cut != e {
            out.push(cut.to_owned());
        }
        if let Some(root) = cut.rfind("/v").map(|i| &cut[..i]) {
            out.push(format!("{root}/"));
        }
    } else if let Ok(u) = reqwest::Url::parse(e) {
        let root = format!("{}://{}/", u.scheme(), u.host_str().unwrap_or_default());
        let root = match u.port() {
            Some(p) => root.trim_end_matches('/').to_owned() + &format!(":{p}/"),
            None => root,
        };
        if root.trim_end_matches('/') != e {
            out.push(root);
        }
    }
    out.dedup();
    out
}

/// Ask the service which microversions it supports (first version document that parses).
pub async fn discover(http: &reqwest::Client, endpoint: &str, token: &str) -> Option<VersionRange> {
    for url in discovery_urls(endpoint) {
        let rb = http
            .get(&url)
            .header("X-Auth-Token", token)
            .header("Accept", "application/json")
            .timeout(std::time::Duration::from_secs(10));
        let Ok(resp) = crate::trace::exec("version-discovery", rb).await else {
            continue;
        };
        // Version documents are often served with 300 Multiple Choices.
        if !(resp.status().is_success() || resp.status().as_u16() == 300) {
            continue;
        }
        if let Ok(doc) = resp.json::<serde_json::Value>().await
            && let Some(r) = VersionRange::from_discovery(&doc)
        {
            return Some(r);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_order_and_negotiate() {
        let a: Microversion = "2.9".parse().unwrap();
        let b: Microversion = "2.10".parse().unwrap();
        assert!(a < b);
        let range = VersionRange {
            min: "2.1".parse().unwrap(),
            max: "2.95".parse().unwrap(),
        };
        assert_eq!(
            Microversion::negotiate(Microversion::new(2, 100), range),
            Some(Microversion::new(2, 95))
        );
        assert_eq!(
            Microversion::negotiate(Microversion::new(2, 0), range),
            None
        );
        assert_eq!(
            Microversion::new(3, 70).header("block-storage").1,
            "volume 3.70"
        );
    }

    #[test]
    fn discovery_candidates() {
        assert_eq!(
            discovery_urls("https://cinder:8776/v3/abc123"),
            vec![
                "https://cinder:8776/v3/abc123",
                "https://cinder:8776/v3",
                "https://cinder:8776/"
            ]
        );
        assert_eq!(
            discovery_urls("https://nova:8774/v2.1/"),
            vec!["https://nova:8774/v2.1", "https://nova:8774/"]
        );
        assert_eq!(
            discovery_urls("https://x/placement"),
            vec!["https://x/placement", "https://x/"]
        );
        let placement: serde_json::Value = serde_json::from_str(
            r#"{"versions":[{"id":"v1.0","max_version":"1.39","min_version":"1.0","status":"CURRENT"}]}"#,
        )
        .unwrap();
        assert_eq!(
            VersionRange::from_discovery(&placement).unwrap().max,
            Microversion::new(1, 39)
        );
    }

    #[test]
    fn discovery_doc() {
        let doc: serde_json::Value = serde_json::from_str(
            r#"{"versions":[
                {"id":"v2.0","status":"SUPPORTED","version":"","min_version":""},
                {"id":"v2.1","status":"CURRENT","version":"2.96","min_version":"2.1"}]}"#,
        )
        .unwrap();
        let r = VersionRange::from_discovery(&doc).unwrap();
        assert_eq!(r.max, Microversion::new(2, 96));
        let single: serde_json::Value = serde_json::from_str(
            r#"{"version":{"id":"v3.0","status":"CURRENT","version":"3.71","min_version":"3.0"}}"#,
        )
        .unwrap();
        assert_eq!(
            VersionRange::from_discovery(&single).unwrap().max,
            Microversion::new(3, 71)
        );
    }
}
