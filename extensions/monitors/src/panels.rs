//! The charts of each monitor view and their PromQL.
//!
//! Users never send PromQL: they pick a panel by id, and the server fills its template with
//! label matchers it builds itself (`$sel`, `$node`, `$project`) and the `rate()` window (`$w`).
//! Matcher values are restricted to id characters and escaped anyway.
//!
//! Metric names follow the Telegraf `outputs.prometheus_client` naming (`<measurement>_<field>`):
//! * instances: the libvirt exec script (`libvirt_*`, `libvirt_disk_*`, `libvirt_net_*`), labels
//!   `monitor=~"cloud.*"` (e.g. `cloud`, `cloud-infras`; see `cloud_monitor`), `project_id`, `project_name`, `guest_id`, `guest_name`;
//! * physical servers: Telegraf's `cpu`, `mem`, `system`, `disk`, `diskio`, `net` inputs, labels
//!   `monitor=~"physical.*"` (see `physical_monitor`), `compute_node_id`, `hostname`;
//! * Nova's view of a compute node and of a project: the OpenStack DB exec script
//!   (`openstack_compute_node_usage_*` by `compute_node_id`, `openstack_project_usage_total_*`
//!   by `project_id`).

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// One Nova instance (libvirt guest).
    Guest,
    /// One physical server (compute node).
    Host,
    /// Totals of one project.
    Project,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
    Percent,
    Bytes,
    BytesPerSec,
    BitsPerSec,
    OpsPerSec,
    PacketsPerSec,
    Seconds,
    Count,
}

#[derive(Debug, Serialize)]
pub struct Query {
    /// Series name in the legend, e.g. "read".
    pub name: &'static str,
    #[serde(skip)]
    pub expr: &'static str,
    /// Labels kept by the expression that tell its series apart (e.g. `device`).
    pub legend: &'static [&'static str],
}

#[derive(Debug, Serialize)]
pub struct Panel {
    pub id: &'static str,
    pub kind: Kind,
    pub title: &'static str,
    pub unit: Unit,
    pub queries: &'static [Query],
}

const fn q(name: &'static str, expr: &'static str) -> Query {
    Query {
        name,
        expr,
        legend: &[],
    }
}

/// A query whose series are told apart by `legend` labels (they must match its `by (…)`).
const fn by(name: &'static str, legend: &'static [&'static str], expr: &'static str) -> Query {
    Query { name, expr, legend }
}

/// Interfaces of instances and of the virtual network on a compute node, left out of
/// the physical server's network chart.
macro_rules! phys_if {
    () => {
        r#"interface!~"lo|tap.*|qvo.*|qvb.*|qbr.*|qr-.*|qg-.*|vnet.*|veth.*|br-.*|ovs-system|vxlan.*|genev.*|docker.*|virbr.*""#
    };
}

use Kind::{Guest, Host, Project};
use Unit::*;

pub static PANELS: &[Panel] = &[
    // ------------------------------------------------------------------ instance
    Panel {
        id: "cpu",
        kind: Guest,
        title: "CPU usage",
        unit: Percent,
        queries: &[q(
            "CPU",
            "100 * sum(rate(libvirt_cpu_time{$sel}[$w])) / 1e9 / max(libvirt_cpu_number{$sel})",
        )],
    },
    Panel {
        id: "memory",
        kind: Guest,
        title: "Memory",
        unit: Bytes,
        queries: &[
            q("used", "1024 * max(libvirt_memory_used{$sel})"),
            q("resident", "1024 * max(libvirt_memory_resident{$sel})"),
            q("total", "1024 * max(libvirt_memory_total{$sel})"),
        ],
    },
    Panel {
        id: "memory_percent",
        kind: Guest,
        title: "Memory usage",
        unit: Percent,
        queries: &[q("used", "max(libvirt_memory_used_percent{$sel})")],
    },
    Panel {
        id: "disk_bytes",
        kind: Guest,
        title: "Disk throughput",
        unit: BytesPerSec,
        queries: &[
            by(
                "read",
                &["device"],
                "sum by (device) (rate(libvirt_disk_read_bytes{$sel}[$w]))",
            ),
            by(
                "write",
                &["device"],
                "sum by (device) (rate(libvirt_disk_write_bytes{$sel}[$w]))",
            ),
        ],
    },
    Panel {
        id: "disk_iops",
        kind: Guest,
        title: "Disk IOPS",
        unit: OpsPerSec,
        queries: &[
            by(
                "read",
                &["device"],
                "sum by (device) (rate(libvirt_disk_read_requests{$sel}[$w]))",
            ),
            by(
                "write",
                &["device"],
                "sum by (device) (rate(libvirt_disk_write_requests{$sel}[$w]))",
            ),
        ],
    },
    Panel {
        id: "disk_latency",
        kind: Guest,
        title: "Disk latency",
        unit: Seconds,
        queries: &[
            by(
                "read",
                &["device"],
                "sum by (device) (rate(libvirt_disk_rd_total_times{$sel}[$w])) / 1e9 / sum by (device) (rate(libvirt_disk_read_requests{$sel}[$w]))",
            ),
            by(
                "write",
                &["device"],
                "sum by (device) (rate(libvirt_disk_wr_total_times{$sel}[$w])) / 1e9 / sum by (device) (rate(libvirt_disk_write_requests{$sel}[$w]))",
            ),
        ],
    },
    Panel {
        id: "disk_space",
        kind: Guest,
        title: "Disk allocation",
        unit: Bytes,
        queries: &[
            by(
                "allocated",
                &["device"],
                "max by (device) (libvirt_disk_allocation{$sel})",
            ),
            by(
                "capacity",
                &["device"],
                "max by (device) (libvirt_disk_capacity{$sel})",
            ),
        ],
    },
    Panel {
        id: "net_bits",
        kind: Guest,
        title: "Network traffic",
        unit: BitsPerSec,
        queries: &[
            by(
                "received",
                &["device"],
                "8 * sum by (device) (rate(libvirt_net_read_bytes{$sel}[$w]))",
            ),
            by(
                "sent",
                &["device"],
                "8 * sum by (device) (rate(libvirt_net_write_bytes{$sel}[$w]))",
            ),
        ],
    },
    Panel {
        id: "net_packets",
        kind: Guest,
        title: "Network packets",
        unit: PacketsPerSec,
        queries: &[
            by(
                "received",
                &["device"],
                "sum by (device) (rate(libvirt_net_read_packets{$sel}[$w]))",
            ),
            by(
                "sent",
                &["device"],
                "sum by (device) (rate(libvirt_net_write_packets{$sel}[$w]))",
            ),
        ],
    },
    Panel {
        id: "net_errors",
        kind: Guest,
        title: "Network errors and drops",
        unit: PacketsPerSec,
        queries: &[
            q(
                "receive errors",
                "sum(rate(libvirt_net_read_errors{$sel}[$w]))",
            ),
            q(
                "send errors",
                "sum(rate(libvirt_net_write_errors{$sel}[$w]))",
            ),
            q(
                "receive drops",
                "sum(rate(libvirt_net_read_drops{$sel}[$w]))",
            ),
            q("send drops", "sum(rate(libvirt_net_write_drops{$sel}[$w]))"),
        ],
    },
    // ------------------------------------------------------------------ physical server
    Panel {
        id: "cpu",
        kind: Host,
        title: "CPU usage",
        unit: Percent,
        queries: &[
            q("used", r#"100 - avg(cpu_usage_idle{$sel,cpu="cpu-total"})"#),
            q("user", r#"avg(cpu_usage_user{$sel,cpu="cpu-total"})"#),
            q("system", r#"avg(cpu_usage_system{$sel,cpu="cpu-total"})"#),
            q("iowait", r#"avg(cpu_usage_iowait{$sel,cpu="cpu-total"})"#),
        ],
    },
    Panel {
        id: "load",
        kind: Host,
        title: "Load average",
        unit: Count,
        queries: &[
            q("1 min", "max(system_load1{$sel})"),
            q("5 min", "max(system_load5{$sel})"),
            q("15 min", "max(system_load15{$sel})"),
        ],
    },
    Panel {
        id: "memory",
        kind: Host,
        title: "Memory",
        unit: Bytes,
        queries: &[
            q("used", "max(mem_used{$sel})"),
            q("available", "max(mem_available{$sel})"),
            q("total", "max(mem_total{$sel})"),
        ],
    },
    Panel {
        id: "memory_percent",
        kind: Host,
        title: "Memory usage",
        unit: Percent,
        queries: &[q("used", "max(mem_used_percent{$sel})")],
    },
    Panel {
        id: "disk_space",
        kind: Host,
        title: "Disk space used",
        unit: Percent,
        queries: &[by(
            "used",
            &["path"],
            "max by (path) (disk_used_percent{$sel})",
        )],
    },
    Panel {
        id: "disk_bytes",
        kind: Host,
        title: "Disk throughput",
        unit: BytesPerSec,
        queries: &[
            by(
                "read",
                &["name"],
                "sum by (name) (rate(diskio_read_bytes{$sel}[$w]))",
            ),
            by(
                "write",
                &["name"],
                "sum by (name) (rate(diskio_write_bytes{$sel}[$w]))",
            ),
        ],
    },
    Panel {
        id: "net_bits",
        kind: Host,
        title: "Network traffic",
        unit: BitsPerSec,
        queries: &[
            by(
                "received",
                &["interface"],
                concat!(
                    "8 * sum by (interface) (rate(net_bytes_recv{$sel,",
                    phys_if!(),
                    "}[$w]))"
                ),
            ),
            by(
                "sent",
                &["interface"],
                concat!(
                    "8 * sum by (interface) (rate(net_bytes_sent{$sel,",
                    phys_if!(),
                    "}[$w]))"
                ),
            ),
        ],
    },
    Panel {
        id: "nova_vcpus",
        kind: Host,
        title: "Nova vCPUs",
        unit: Count,
        queries: &[
            q(
                "used",
                "max(openstack_compute_node_usage_vcpus_used{$node})",
            ),
            q(
                "total",
                "max(openstack_compute_node_usage_vcpus_total{$node})",
            ),
        ],
    },
    Panel {
        id: "nova_memory",
        kind: Host,
        title: "Nova memory",
        unit: Bytes,
        queries: &[
            q(
                "used",
                "1048576 * max(openstack_compute_node_usage_memory_mb_used{$node})",
            ),
            q(
                "total",
                "1048576 * max(openstack_compute_node_usage_memory_mb_total{$node})",
            ),
        ],
    },
    Panel {
        id: "nova_instances",
        kind: Host,
        title: "Running instances",
        unit: Count,
        queries: &[q(
            "instances",
            "max(openstack_compute_node_usage_running_vms{$node})",
        )],
    },
    // ------------------------------------------------------------------ project totals
    Panel {
        id: "instances",
        kind: Project,
        title: "Instances and vCPUs",
        unit: Count,
        queries: &[
            q(
                "instances",
                "max(openstack_project_usage_total_instances{$project})",
            ),
            q(
                "vCPUs",
                "max(openstack_project_usage_total_vcpus{$project})",
            ),
        ],
    },
    Panel {
        id: "memory",
        kind: Project,
        title: "Instance memory",
        unit: Bytes,
        queries: &[q(
            "memory",
            "1048576 * max(openstack_project_usage_total_memory_mb{$project})",
        )],
    },
    Panel {
        id: "storage",
        kind: Project,
        title: "Block storage",
        unit: Bytes,
        queries: &[
            q(
                "volumes",
                "1073741824 * max(openstack_project_usage_total_volume_gb{$project})",
            ),
            q(
                "snapshots",
                "1073741824 * max(openstack_project_usage_total_snapshot_gb{$project})",
            ),
        ],
    },
    Panel {
        id: "network",
        kind: Project,
        title: "Network resources",
        unit: Count,
        queries: &[
            q(
                "networks",
                "max(openstack_project_usage_total_networks{$project})",
            ),
            q(
                "ports",
                "max(openstack_project_usage_total_ports{$project})",
            ),
            q(
                "routers",
                "max(openstack_project_usage_total_routers{$project})",
            ),
        ],
    },
];

pub fn find(kind: Kind, id: &str) -> Option<&'static Panel> {
    PANELS.iter().find(|p| p.kind == kind && p.id == id)
}

pub fn of(kind: Kind) -> impl Iterator<Item = &'static Panel> {
    PANELS.iter().filter(move |p| p.kind == kind)
}

/// Label matchers, rendered as `a="x",b="y"` (to go inside `{…}`).
#[derive(Debug, Default, Clone)]
pub struct Matchers(Vec<(&'static str, &'static str, String)>);

impl Matchers {
    /// `label="value"`
    pub fn with(mut self, label: &'static str, value: impl Into<String>) -> Self {
        self.0.push((label, "=", value.into()));
        self
    }

    /// `label=~"regex"` (anchored by PromQL: it must match the whole value).
    pub fn with_re(mut self, label: &'static str, regex: impl Into<String>) -> Self {
        self.0.push((label, "=~", regex.into()));
        self
    }

    pub fn render(&self) -> String {
        self.0
            .iter()
            .map(|(l, op, v)| format!("{l}{op}\"{}\"", escape(v)))
            .collect::<Vec<_>>()
            .join(",")
    }
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

/// Fill a template: `$sel`, `$node`, `$project` (each only if given) and `$w` (seconds).
pub fn render(
    expr: &str,
    sel: &Matchers,
    node: Option<&Matchers>,
    project: Option<&Matchers>,
    window: i64,
) -> String {
    let mut s = expr.replace("$w", &format!("{window}s"));
    if let Some(n) = node {
        s = s.replace("$node", &n.render());
    }
    if let Some(p) = project {
        s = s.replace("$project", &p.render());
    }
    s.replace("$sel", &sel.render())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_per_kind_and_templates_known() {
        for p in PANELS {
            assert_eq!(
                PANELS
                    .iter()
                    .filter(|o| o.kind == p.kind && o.id == p.id)
                    .count(),
                1
            );
            for q in p.queries {
                let placeholder = match p.kind {
                    Kind::Guest => q.expr.contains("$sel"),
                    Kind::Host => q.expr.contains("$sel") || q.expr.contains("$node"),
                    Kind::Project => q.expr.contains("$project"),
                };
                assert!(placeholder, "{} / {} has no selector", p.id, q.name);
                for l in q.legend {
                    assert!(
                        q.expr.contains(&format!("by ({l})")),
                        "{}: legend {l}",
                        p.id
                    );
                }
            }
        }
    }

    #[test]
    fn renders_escaped_matchers() {
        let sel = Matchers::default()
            .with_re("monitor", "cloud.*")
            .with("guest_id", r#"a"b\c"#);
        let got = render(
            "rate(x{$sel}[$w]) + y{$sel,cpu=\"t\"}",
            &sel,
            None,
            None,
            300,
        );
        assert_eq!(
            got,
            r#"rate(x{monitor=~"cloud.*",guest_id="a\"b\\c"}[300s]) + y{monitor=~"cloud.*",guest_id="a\"b\\c",cpu="t"}"#
        );
    }
}
