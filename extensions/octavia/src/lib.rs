//! Octavia (load-balancer) extension — reference implementation of the extension model.
//!
//! Backend: an allowlisted gateway to the Octavia v2 API at `/api/ext/octavia/os/{*path}`
//! (paths are relative to `<endpoint>/v2/`, e.g. `lbaas/loadbalancers/<id>`). Every request
//! must match a rule in [`RULES`]; ids in the path are validated and admin-only rules
//! (amphorae, flavor / availability zone profiles, quotas of other projects, failover)
//! require the admin role in Rassvet as well as in Octavia's own policy. `?all_pages=1`
//! follows `<key>_links` "next" pages. The UI uses it through the SDK's `os` helpers with
//! the service name `ext:octavia`.

use rassvet_ext_api::{
    ApiError, Extension, Manifest, NavItem, NavSection, RequestContext,
    axum::{
        Router,
        body::Bytes,
        extract::{Path, Query},
        http::Method,
        response::Response,
        routing::any,
    },
    gateway::{self, Rule, Service, admin, rule as r},
};

pub struct Octavia;

const ID: &str = "octavia";

const SERVICE: Service = Service {
    service_type: "load-balancer",
    version: "v2",
    microversion: None,
};

impl Extension for Octavia {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: ID,
            name: "Load Balancers",
            version: env!("CARGO_PKG_VERSION"),
            description: "Manage Octavia load balancers, listeners, pools, members, health monitors, L7 policies, amphorae, flavors, availability zones and quotas",
            service_types: &["load-balancer"],
        }
    }

    fn nav(&self) -> Vec<NavItem> {
        let item = |id: &str, label: &str, path: &str, icon: &str, section: NavSection| NavItem {
            id: format!("{ID}.{id}"),
            group: "Network".into(),
            label: label.into(),
            path: path.into(),
            icon: icon.into(),
            section,
            role: (section == NavSection::Admin).then(|| "admin".into()),
        };
        vec![
            item(
                "load-balancers",
                "Load balancers",
                &format!("/ext/{ID}/load-balancers"),
                "split",
                NavSection::Project,
            ),
            item(
                "admin-load-balancers",
                "All load balancers",
                &format!("/admin/ext/{ID}/load-balancers"),
                "split",
                NavSection::Admin,
            ),
            item(
                "amphorae",
                "Amphorae",
                &format!("/admin/ext/{ID}/amphorae"),
                "container",
                NavSection::Admin,
            ),
            item(
                "settings",
                "Load balancing",
                &format!("/admin/ext/{ID}/settings"),
                "sliders-horizontal",
                NavSection::Admin,
            ),
        ]
    }

    fn router(&self) -> Router {
        Router::new().route("/os/{*path}", any(handle))
    }
}

// ---------------------------------------------------------------------------- rules

use Method as M;

static RULES: &[Rule] = &[
    // Load balancers
    r(M::GET, "lbaas/loadbalancers"),
    r(M::POST, "lbaas/loadbalancers"),
    r(M::GET, "lbaas/loadbalancers/{id}"),
    r(M::PUT, "lbaas/loadbalancers/{id}"),
    r(M::DELETE, "lbaas/loadbalancers/{id}"),
    r(M::GET, "lbaas/loadbalancers/{id}/stats"),
    r(M::GET, "lbaas/loadbalancers/{id}/status"),
    admin(M::PUT, "lbaas/loadbalancers/{id}/failover"),
    // Listeners
    r(M::GET, "lbaas/listeners"),
    r(M::POST, "lbaas/listeners"),
    r(M::GET, "lbaas/listeners/{id}"),
    r(M::PUT, "lbaas/listeners/{id}"),
    r(M::DELETE, "lbaas/listeners/{id}"),
    r(M::GET, "lbaas/listeners/{id}/stats"),
    // Pools and members
    r(M::GET, "lbaas/pools"),
    r(M::POST, "lbaas/pools"),
    r(M::GET, "lbaas/pools/{id}"),
    r(M::PUT, "lbaas/pools/{id}"),
    r(M::DELETE, "lbaas/pools/{id}"),
    r(M::GET, "lbaas/pools/{id}/members"),
    r(M::POST, "lbaas/pools/{id}/members"),
    r(M::PUT, "lbaas/pools/{id}/members"),
    r(M::GET, "lbaas/pools/{id}/members/{id}"),
    r(M::PUT, "lbaas/pools/{id}/members/{id}"),
    r(M::DELETE, "lbaas/pools/{id}/members/{id}"),
    // Health monitors
    r(M::GET, "lbaas/healthmonitors"),
    r(M::POST, "lbaas/healthmonitors"),
    r(M::GET, "lbaas/healthmonitors/{id}"),
    r(M::PUT, "lbaas/healthmonitors/{id}"),
    r(M::DELETE, "lbaas/healthmonitors/{id}"),
    // L7 policies and rules
    r(M::GET, "lbaas/l7policies"),
    r(M::POST, "lbaas/l7policies"),
    r(M::GET, "lbaas/l7policies/{id}"),
    r(M::PUT, "lbaas/l7policies/{id}"),
    r(M::DELETE, "lbaas/l7policies/{id}"),
    r(M::GET, "lbaas/l7policies/{id}/rules"),
    r(M::POST, "lbaas/l7policies/{id}/rules"),
    r(M::GET, "lbaas/l7policies/{id}/rules/{id}"),
    r(M::PUT, "lbaas/l7policies/{id}/rules/{id}"),
    r(M::DELETE, "lbaas/l7policies/{id}/rules/{id}"),
    // Quotas: a project reads its own; admins list and change any.
    r(M::GET, "lbaas/quotas/{id}"),
    admin(M::GET, "lbaas/quotas"),
    admin(M::PUT, "lbaas/quotas/{id}"),
    admin(M::DELETE, "lbaas/quotas/{id}"),
    // Providers, flavors, availability zones (read for everyone, managed by admins)
    r(M::GET, "lbaas/providers"),
    admin(M::GET, "lbaas/providers/{name}/flavor_capabilities"),
    admin(
        M::GET,
        "lbaas/providers/{name}/availability_zone_capabilities",
    ),
    r(M::GET, "lbaas/flavors"),
    r(M::GET, "lbaas/flavors/{id}"),
    admin(M::POST, "lbaas/flavors"),
    admin(M::PUT, "lbaas/flavors/{id}"),
    admin(M::DELETE, "lbaas/flavors/{id}"),
    admin(M::GET, "lbaas/flavorprofiles"),
    admin(M::POST, "lbaas/flavorprofiles"),
    admin(M::GET, "lbaas/flavorprofiles/{id}"),
    admin(M::PUT, "lbaas/flavorprofiles/{id}"),
    admin(M::DELETE, "lbaas/flavorprofiles/{id}"),
    r(M::GET, "lbaas/availabilityzones"),
    r(M::GET, "lbaas/availabilityzones/{name}"),
    admin(M::POST, "lbaas/availabilityzones"),
    admin(M::PUT, "lbaas/availabilityzones/{name}"),
    admin(M::DELETE, "lbaas/availabilityzones/{name}"),
    admin(M::GET, "lbaas/availabilityzoneprofiles"),
    admin(M::POST, "lbaas/availabilityzoneprofiles"),
    admin(M::GET, "lbaas/availabilityzoneprofiles/{id}"),
    admin(M::PUT, "lbaas/availabilityzoneprofiles/{id}"),
    admin(M::DELETE, "lbaas/availabilityzoneprofiles/{id}"),
    // Amphorae (admin)
    admin(M::GET, "octavia/amphorae"),
    admin(M::GET, "octavia/amphorae/{id}"),
    admin(M::GET, "octavia/amphorae/{id}/stats"),
    admin(M::PUT, "octavia/amphorae/{id}/failover"),
    admin(M::PUT, "octavia/amphorae/{id}/config"),
    admin(M::DELETE, "octavia/amphorae/{id}"),
];

// ---------------------------------------------------------------------------- calls

/// `/api/ext/octavia/os/{*path}`
async fn handle(
    ctx: RequestContext,
    method: Method,
    Path(path): Path<String>,
    Query(raw): Query<Vec<(String, String)>>,
    body: Bytes,
) -> Result<Response, ApiError> {
    gateway::proxy(&ctx, &SERVICE, RULES, None, method, &path, raw, body).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rassvet_ext_api::gateway::encode;

    fn find_rule(method: &Method, path: &str) -> Option<&'static Rule> {
        gateway::find_rule(RULES, method, path)
    }

    fn base_url(endpoint: &str) -> String {
        SERVICE.base_url(endpoint)
    }

    #[test]
    fn allowlist() {
        assert!(find_rule(&M::GET, "lbaas/loadbalancers").is_some());
        assert!(find_rule(&M::PUT, "lbaas/pools/abc-1/members/def-2").is_some());
        assert!(find_rule(&M::PUT, "lbaas/pools/abc-1/members").is_some());
        assert!(
            find_rule(&M::GET, "lbaas/providers/amphora/flavor_capabilities")
                .unwrap()
                .admin
        );
        assert!(
            find_rule(&M::PUT, "lbaas/loadbalancers/x/failover")
                .unwrap()
                .admin
        );
        assert!(find_rule(&M::GET, "octavia/amphorae").unwrap().admin);
        assert!(find_rule(&M::GET, "lbaas/quotas").unwrap().admin);
        assert!(!find_rule(&M::GET, "lbaas/quotas/p1").unwrap().admin);
        assert!(find_rule(&M::GET, "lbaas/loadbalancers/../x").is_none());
        assert!(find_rule(&M::PATCH, "lbaas/loadbalancers/x").is_none());
        assert!(find_rule(&M::GET, "lbaas/secrets").is_none());
    }

    #[test]
    fn urls() {
        assert_eq!(base_url("http://h:9876"), "http://h:9876/v2");
        assert_eq!(
            base_url("http://h/load-balancer/"),
            "http://h/load-balancer/v2"
        );
        assert_eq!(base_url("http://h:9876/v2"), "http://h:9876/v2");
        assert_eq!(base_url("http://h:9876/v2/"), "http://h:9876/v2");
        assert_eq!(base_url("http://h:9876/v2.0"), "http://h:9876/v2.0");
        assert_eq!(
            base_url("https://h/load-balancer/v2"),
            "https://h/load-balancer/v2"
        );
        assert_eq!(
            encode("lbaas/availabilityzones/az 1"),
            "lbaas/availabilityzones/az%201"
        );
    }
}
