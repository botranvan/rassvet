# Monitoring (instances and physical servers)

## Use case

You want project users to see how their instances are doing, and you want dashboards of your physical
servers in the same place. The **Monitors** extension reads metrics from Prometheus or any compatible API
(VictoriaMetrics, Thanos, Mimir), typically written by Telegraf. What it shows is up to you: dashboards and
panels are PromQL queries in YAML files, much like a simplified Grafana dashboard.

Project users get **Monitoring → Instance monitors** for their own project. Admins also get **Instance
monitors** for every project and **Physical server monitors** in the admin view.

![Physical server monitors](../images/admin/physical-server-monitors.png)

## Who sees what

| | Project user | Admin (`admin` role) |
|---|---|---|
| Instance dashboards | Only their token's project | Any project, or every project at once |
| Physical server dashboards | No | Yes |
| How far back | 60 days (`project_max_range_days`) | 1 year (`admin_max_range_days`) |

Rassvet enforces these rules on the server. The browser never sends PromQL. It picks a dashboard, a panel
and an instance or server, and Rassvet fills the panel's query. `$project_id` is always the project of the
user's token, whatever the browser asks for. Every query of an instance dashboard must use `$project_id`,
and Rassvet refuses a panel file that breaks this rule, so a forgotten filter can't show other projects'
data. Requests for physical dashboards or for older data are refused.

## Dashboards and panels

Point `monitor_panels_paths` at a directory (or files) and put YAML files there. Rassvet reads every
`*.yaml` / `*.yml` file of a directory in name order (not subdirectories) and picks up changes within about
ten seconds: no restart is needed. If a changed file is broken, Rassvet logs the error and keeps showing the
previous dashboards. At startup a broken file stops Rassvet with the file, dashboard and panel at fault.

Without `monitor_panels_paths`, Rassvet uses its built-in panels,
[`extensions/monitors/panels/default.yaml`](../../extensions/monitors/panels/default.yaml). Copy that file
into your directory to start from it. Once the setting is there, only your files are used.

```sh
mkdir -p /etc/rassvet/monitor-panels
cp extensions/monitors/panels/default.yaml /etc/rassvet/monitor-panels/00-default.yaml
```

Each file is a list of dashboards. Entries with the same `dashboard` key, in one file or several, are
merged into one page, so you can keep the defaults in one file and add panels in another:

```yaml
- dashboard: cloud-infras            # the page's key
  title: Infrastructure VMs          # optional, defaults to the key
  kind: instance                     # optional: instance | physical
  variables:                         # optional: the dashboard's own variables
    - monitor: cloud-infras
    - db: public-infras
  discover: 'libvirt_memory_total{monitor="$monitor",db="$db",project_id=~"$project_id"}'
  panels:
    - name: cpu                      # unique within the dashboard
      description: CPU Monitors      # shown as the title when there's no `title`
      unit: percent
      queries:
        - query: >-
            100 * sum(rate(libvirt_cpu_time{monitor="$monitor",db="$db",project_id="$project_id",guest_id="$guest_id"}[$__rate_interval])) / 1e9
            / max(libvirt_cpu_number{monitor="$monitor",db="$db",project_id="$project_id",guest_id="$guest_id"})
          type: time_series
          legend: CPU

    - name: disk
      description: Disk Monitors
      unit: bytes_per_sec
      queries:
        - query: sum by (device) (rate(libvirt_disk_read_bytes{project_id="$project_id",guest_id="$guest_id"}[$__rate_interval]))
          legend: "read-{{device}}"
        - query: sum by (device) (rate(libvirt_disk_write_bytes{project_id="$project_id",guest_id="$guest_id"}[$__rate_interval]))
          legend: "write-{{device}}"

    - name: project_memory           # no $guest_id: shown for the whole project
      description: Memory by instance
      unit: bytes
      queries:
        - query: 1024 * sum by (guest_name) (libvirt_memory_total{project_id="$project_id"})
          type: pie_chart
          legend: "{{guest_name}}"

- dashboard: physical-infras
  panels:
    - name: load
      description: Load now
      queries:
        - query: max(system_load1{hostname="$hostname"})
          type: gauge
          legend: 1 min
```

### Dashboard keys

| Key | Meaning |
|-----|---------|
| `dashboard` | Required. Entries with the same value make one page |
| `title` | Name shown in the dashboard picker. Defaults to the key |
| `kind` | `instance` (Instance monitors, every user) or `physical` (Physical server monitors, admins only). Defaults to `physical` when the key starts with `physical`, otherwise `instance` |
| `variables` | The dashboard's own variables, used as `$name` in its queries and `discover` (see below) |
| `discover` | Series selector that lists what can be picked (see below) |
| `panels` | The panels, in display order |

When a page has several dashboards of the same kind, a **Dashboard** picker appears above the charts.

### Panel keys

| Key | Meaning |
|-----|---------|
| `name` | Required, unique within the dashboard: letters, digits, `-`, `_`, `.` |
| `title` / `description` | Card title. With both, the description is shown under the title |
| `unit` | `count` (default, also `none`, `short`), `percent`, `percent_unit` (0-1), `bytes`, `bytes_per_sec` (`Bps`), `bits_per_sec` (`bps`), `ops_per_sec` (`iops`), `packets_per_sec` (`pps`), `seconds` (`s`) |
| `type` | Default chart type of the panel's queries |
| `width` | `half` (default) or `full` |
| `min` / `max` | Range of gauges (default 0 to 100 for percentages, otherwise 0 to the largest value) |
| `queries` | One or more queries |

### Query keys

| Key | Meaning |
|-----|---------|
| `query` | Required. PromQL, with the variables below |
| `type` | `time_series` (default): a line chart over the time range, all time series queries of a panel in one chart. `stat`: the value at the end of the range, as a number. `gauge`: the same as a half-circle gauge. `pie_chart`: one slice per series (the 7 largest and *Other*) |
| `legend` | `auto` (default): the labels that differ between the series, or the panel title when there's one series. Or a template such as `write-{{device}}`: `{{label}}` is replaced by the series' label |
| `unit` | Unit of a `stat`, `gauge` or `pie_chart` query, when it differs from the panel's. A time series chart always uses the panel's unit |

A time series chart shows at most eight series, the busiest ones, and says how many were left out. Use
`topk()` in the query to choose which ones yourself.

### Variables

Write variables as `$name` or `${name}`. Rassvet escapes their values for a double-quoted PromQL string.

| Variable | Value |
|----------|-------|
| `$project_id` | Instance dashboards: the project of the user's token for project users; for admins the project they picked or the picked instance's project. **Required in every instance query** |
| `$guest_id` | The picked instance (instance dashboards) |
| `$compute_node_id`, `$hostname` | The picked server (physical dashboards) |
| `$region` | The region selected in Rassvet's top bar |
| `$__rate_interval` | Window for `rate()` / `increase()`: the step or `rate_window_seconds`, whichever is larger |
| `$__interval` | The step between two points |
| `$__range` | The length of the time range, e.g. for `avg_over_time(x[$__range])` |

**Your own variables.** Define values you'd otherwise repeat in every query, such as the `monitor` or
`db` label of one Telegraf setup, under the dashboard's `variables`, as a list or a map:

```yaml
- dashboard: cloud.*
  title: Instances
  kind: instance
  variables:
    - monitor: cloud-infras
    - db: public-infras
  panels:
    - name: memory
      queries:
        - query: 'max(libvirt_memory_used_percent{monitor="$monitor",db="$db",project_id="$project_id",guest_id="$guest_id"})'
```

A variable applies to its dashboard only: entries with the same `dashboard` key share them, so they can
be set in one file and used in another. Defining the same variable twice with different values is an
error. The built-in names above can't be redefined, so `$project_id` always stays the user's project. A
query using a variable that isn't defined is refused when the files are loaded.

**Where a panel appears.** Panels that use `$guest_id` (instance) or `$compute_node_id` / `$hostname`
(physical) are shown when an instance or server is picked. The other panels form the overview: the
project's (instance dashboards) or the whole fleet's (physical dashboards).

### What can be picked: `discover`

The instance and server pickers list the label sets of a series selector over the time range
(`/api/v1/series`). Defaults:

```yaml
# instance dashboards
discover: '{project_id=~"$project_id",guest_id!=""}'
# physical dashboards
discover: '{compute_node_id!=""}'
```

Rassvet reads `guest_id`, `guest_name`, `project_id` and `project_name` from instance series, and
`compute_node_id` (or `hostname` when there is none), `hostname` and `region` from server series. In
`discover`, `$project_id` is a regular expression: the user's project, or `.+` for admins, so use
`project_id=~"$project_id"`. Project users only ever get their own project's instances, whatever the
selector returns.

`discover` may use `$project_id`, `$region` and the dashboard's own variables. The default selectors match
every series of every instance. On a large cloud, a single metric is much cheaper, for example:

```yaml
- dashboard: cloud-infras
  variables:
    - db: public-infras
  discover: 'libvirt_memory_total{db="$db",project_id=~"$project_id"}'
```

## Telegraf

The built-in panels expect the labels and metric names below. With your own panel files, only the labels
read from `discover` matter: `guest_id`, `guest_name`, `project_id`, `project_name` for instances, and
`compute_node_id` / `hostname` for servers.

- Instances: the libvirt exec script (`libvirt_*`, `libvirt_disk_*`, `libvirt_net_*`), labelled
  `monitor`, `project_id`, `project_name`, `guest_id`, `guest_name`.
- Physical servers: Telegraf's `cpu`, `mem`, `system`, `disk`, `diskio` and `net` inputs, labelled
  `monitor`, `compute_node_id`, `hostname`.
- Nova's view: the OpenStack database exec script (`openstack_compute_node_usage_*`,
  `openstack_project_usage_total_*`).

On each compute node, run the libvirt script for instance metrics and Telegraf's own inputs for the
server. Tag them with `monitor`, and give the physical inputs the node's `compute_node_id` and `hostname`
(`openstack hypervisor show <host> -c id -c hypervisor_hostname`):

```toml
[global_tags]
  region = "RegionOne"

[[inputs.exec]]
  commands = ["/usr/bin/python3 /opt/telegraf/libvirt_telegraf.py"]
  timeout = "30s"
  data_format = "influx"
  [inputs.exec.tags]
    monitor = "cloud"

[[inputs.cpu]]
  percpu = false
  totalcpu = true
  [inputs.cpu.tags]
    monitor = "physical"
    compute_node_id = "6f2c4d0e-7f1b-4a8e-9b0c-2d3e4f5a6b7c"
    hostname = "compute-1"
# Same tags on [[inputs.mem]], [[inputs.system]], [[inputs.disk]], [[inputs.diskio]] and [[inputs.net]].

[[outputs.prometheus_client]]
  listen = ":9273"
```

Run the OpenStack database script on one controller (`inputs.exec` with `data_format = "influx"`), and have
Prometheus scrape every Telegraf, or send to Prometheus with remote write.

## Connect Rassvet

Add a `[cloud.extensions.monitors]` table under the cloud's `[[cloud]]` block in `rassvet.toml` and restart
Rassvet. Clouds without the table don't show the Monitoring menu.

```toml
[[cloud]]
id = "lab"
# ...

[cloud.extensions.monitors]
prometheus_url = "http://prometheus.example.com:9090"  # any Prometheus-compatible query API
# bearer_token_file = "/etc/rassvet/prometheus.token"   # or bearer_token, or username + password(_file)
# ca_file = "/etc/ssl/certs/prometheus-ca.pem"
project_max_range_days = 60
admin_max_range_days = 365
# timeout_seconds = 30
# rate_window_seconds = 300   # smallest rate() window: at least 4 × the Telegraf interval
monitor_panels_paths = "/etc/rassvet/monitor-panels"   # or a list of files / directories
```

For VictoriaMetrics, use the address of its Prometheus query API: `http://victoriametrics:8428` for a
single node, or `http://vmselect:8481/select/<tenant>/prometheus` for a cluster.

Prometheus is only called by the Rassvet server, so it doesn't have to be reachable from users' browsers.

## Use it

- **Instance monitors** (admin view): pick a **Project** (or *All projects*), then an **Instance**. Without
  an instance you see the dashboard's overview panels for the project.
- **Physical server monitors**: pick a server by host name, or leave it empty for the fleet overview.

Both pages offer presets from the last 5 minutes to the last year (admins also get 90 days, 180 days and a
year) and a custom from / to.
