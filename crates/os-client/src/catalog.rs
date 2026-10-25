use serde::{Deserialize, Serialize};

/// Keystone v3 service catalog as returned inside a token.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Catalog(pub Vec<ServiceEntry>);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceEntry {
    #[serde(rename = "type")]
    pub service_type: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub endpoints: Vec<Endpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub interface: String,
    #[serde(default)]
    pub region_id: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Interface {
    #[default]
    Public,
    Internal,
    Admin,
}

impl Interface {
    pub fn as_str(self) -> &'static str {
        match self {
            Interface::Public => "public",
            Interface::Internal => "internal",
            Interface::Admin => "admin",
        }
    }
}

/// Official service types (service-types-authority) and their historical aliases.
const ALIASES: &[(&str, &[&str])] = &[
    (
        "block-storage",
        &["volumev3", "volumev2", "volume", "block-store"],
    ),
    ("compute", &[]),
    ("identity", &[]),
    ("image", &[]),
    ("network", &[]),
    ("placement", &[]),
    ("key-manager", &[]),
    ("object-store", &[]),
    ("load-balancer", &[]),
];

fn candidates(service_type: &str) -> Vec<&str> {
    let mut out = vec![service_type];
    for (official, aliases) in ALIASES {
        if *official == service_type {
            out.extend_from_slice(aliases);
        } else if aliases.contains(&service_type) {
            out.push(official);
        }
    }
    out
}

impl Endpoint {
    fn in_region(&self, region: Option<&str>) -> bool {
        region.is_none_or(|r| {
            self.region_id.as_deref() == Some(r) || self.region.as_deref() == Some(r)
        })
    }

    fn region_name(&self) -> Option<&str> {
        self.region_id.as_deref().or(self.region.as_deref())
    }
}

impl Catalog {
    /// Whether `service_type` (or an alias) has an endpoint in `region` (`None` = any region).
    pub fn has_service(&self, service_type: &str, region: Option<&str>) -> bool {
        let c = candidates(service_type);
        self.0.iter().any(|s| {
            c.contains(&s.service_type.as_str()) && s.endpoints.iter().any(|e| e.in_region(region))
        })
    }

    /// Find the endpoint URL for a service, interface and optional region.
    pub fn endpoint(
        &self,
        service_type: &str,
        interface: Interface,
        region: Option<&str>,
    ) -> Option<&str> {
        for ty in candidates(service_type) {
            for svc in self.0.iter().filter(|s| s.service_type == ty) {
                let found = svc
                    .endpoints
                    .iter()
                    .find(|e| e.interface == interface.as_str() && e.in_region(region));
                if let Some(e) = found {
                    return Some(e.url.trim_end_matches('/'));
                }
            }
        }
        None
    }

    /// All regions that appear in the catalog, sorted and de-duplicated.
    pub fn regions(&self) -> Vec<String> {
        let mut r: Vec<String> = self
            .0
            .iter()
            .flat_map(|s| s.endpoints.iter())
            .filter_map(|e| e.region_name().map(str::to_owned))
            .collect();
        r.sort();
        r.dedup();
        r
    }

    /// The region offering the most services — a sensible default when none is configured.
    pub fn primary_region(&self) -> Option<String> {
        self.regions().into_iter().max_by_key(|r| {
            (
                self.service_types(Some(r)).len(),
                std::cmp::Reverse(r.clone()),
            )
        })
    }

    /// Service types (raw catalog values) with an endpoint in `region` (`None` = any).
    pub fn service_types(&self, region: Option<&str>) -> Vec<String> {
        let mut t: Vec<String> = self
            .0
            .iter()
            .filter(|s| s.endpoints.iter().any(|e| e.in_region(region)))
            .map(|s| s.service_type.clone())
            .collect();
        t.sort();
        t.dedup();
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Catalog {
        serde_json::from_str(
            r#"[
              {"type":"volumev3","name":"cinderv3","endpoints":[
                {"interface":"public","region_id":"RegionOne","url":"https://c1/v3/abc/"},
                {"interface":"public","region_id":"RegionTwo","url":"https://c2/v3/abc"}]},
              {"type":"compute","endpoints":[
                {"interface":"internal","region_id":"RegionOne","url":"http://nova-int/v2.1"},
                {"interface":"public","region_id":"RegionOne","url":"https://nova/v2.1"}]}
            ]"#,
        )
        .unwrap()
    }

    #[test]
    fn resolves_aliases_and_regions() {
        let c = sample();
        assert!(c.has_service("block-storage", None));
        assert!(c.has_service("block-storage", Some("RegionTwo")));
        assert!(!c.has_service("compute", Some("RegionTwo")));
        assert!(!c.has_service("load-balancer", None));
        assert_eq!(c.primary_region().as_deref(), Some("RegionOne"));
        assert_eq!(c.service_types(Some("RegionTwo")), vec!["volumev3"]);
        assert_eq!(
            c.endpoint("block-storage", Interface::Public, Some("RegionOne")),
            Some("https://c1/v3/abc")
        );
        assert_eq!(
            c.endpoint("block-storage", Interface::Public, Some("RegionTwo")),
            Some("https://c2/v3/abc")
        );
        assert_eq!(
            c.endpoint("compute", Interface::Public, None),
            Some("https://nova/v2.1")
        );
        assert_eq!(c.regions(), vec!["RegionOne", "RegionTwo"]);
    }
}
