# rassvet — next-gen OpenStack dashboard

Single-binary dashboard for OpenStack, written in Rust with an embedded React UI.
*Rassvet* (рассвет) means "dawn".

- **Backend**: Rust (axum + tokio + reqwest). Keystone tokens stay on the server; the browser gets an opaque HttpOnly session cookie.
- **Frontend**: React + TypeScript + Tailwind, built into `ui/dist` and embedded into the binary.
- **OpenStack**: targets 2026.2 (Hibiscus) APIs, oldest supported release 2026.1 (Gazpacho). Microversions are negotiated per cloud.
- **Core services**: Keystone, Glance, Nova, Placement, Neutron, Cinder, Barbican.
- **Extensions**: other services (e.g. Octavia) are compile-time extension crates under `extensions/`.

## Documentation

The user guide is in [`docs/`](docs/README.md): a feature overview, step-by-step guides for
project users ([`docs/project`](docs/project)) and for cloud administrators ([`docs/admin`](docs/admin)).

## Layout

```
crates/os-client   OpenStack client: Keystone, Glance, generic REST, catalog, microversions, API errors
crates/ext-api     Extension contract (Extension trait, NavItem, RequestContext, ApiError)
crates/server      rassvet binary: config, sessions, core API, embedded UI
extensions/octavia Reference extension: Rust crate + ui/ (React pages)
ui/                Host UI (Vite + React); `@rassvet/sdk` is the API exposed to extension UIs
```

## Build

Requirements: Rust 1.88+ (edition 2024), Node 22+, pnpm 10+.

```sh
cd ui && pnpm install && pnpm build && cd ..
cargo build --release
./target/release/rassvet --config rassvet.toml
```

Copy `rassvet.example.toml` to `rassvet.toml` and set your Keystone `auth_url`.

Build without an extension: `cargo build --release --no-default-features`.

### Sessions and memcached

By default login sessions live in the server's memory (a restart signs everyone out). Add a
`[memcached]` section to keep them in memcached instead, so they survive restarts and can be
shared by several Rassvet instances behind a load balancer:

```toml
[memcached]
servers = ["10.0.0.11:11211", "10.0.0.12:11211"]
key_prefix = "rassvet"
timeout_ms = 500
secret_key_file = "/etc/rassvet/session.key"   # or secret_key = "…" (≥ 16 chars, same on every instance)
```

- Sessions are encrypted with ChaCha20-Poly1305 when a secret key is set (they contain Keystone
  tokens); keys are a hash of the cookie, so neither appears in memcached. Without a key Rassvet
  warns at startup and stores them in plain JSON.
- Memory stays the fallback: if memcached isn't configured, can't be reached at startup, or fails
  later (per-request timeout, then the server is skipped for 15 s), logins and requests keep
  working from memory. Sessions created meanwhile, or lost by a memcached restart, are written back
  once it answers again. Logging out leaves a short tombstone so other instances drop their copy.
- Sessions are deleted, from memory and from memcached, at the first of: no request for
  `session_idle_minutes` (default 60), `session_max_minutes` after login however active (default 720;
  0 = no limit), or the expiry of the Keystone token. The memcached TTL is set to exactly that
  deadline (the idle part is refreshed at most once a minute), and memory is swept every
  `session_cleanup_seconds` (default 60). An expired session found on a request is deleted at once.

### Menus follow the cloud's policy

Some menu entries are only shown when the cloud's policy lets the user use them: Rassvet asks the
service once (e.g. `GET groups/detail?limit=1` for Volume groups / Group snapshots) and hides the
entry on 401, 403 or 404. Results are kept for 10 minutes per user, project and region.

### Logs and request ids

`[log]` sets the level (`info`, `debug`… or a full filter; `RUST_LOG` overrides it), the format
(`text` or `json`), standard output and an optional `file` that rotates `hourly`, `daily` or by
size (`rotation = "size"`, `max_size_mb`), keeping `max_files` rotated files
(`rassvet.log.2026-10-22T05-00-00`). With `rotation = "never"` an external logrotate can move
the file and send SIGHUP; Rassvet reopens it.

Every browser request gets an id like `req-6df3735c-…`: it is in every log line written while
the request runs, returned as the `X-Request-Id` header, and sent to OpenStack as
`X-OpenStack-Request-ID`, which oslo.middleware records as the **global_request_id** in Nova,
Neutron, Cinder… logs. Each OpenStack call is logged (`rassvet::openstack`) with the service,
method, path, status, time and the service's own request id (`upstream_request_id`, the
`x-openstack-request-id` / `x-compute-request-id` header), which is also returned in API errors:

```
INFO request{request_id=req-6df3…}: rassvet::openstack: OpenStack call service="compute" method=GET path="/compute/v2.1/servers/…" status=404 ms=3 upstream_request_id="req-6b79…"
INFO request{request_id=req-6df3…}: rassvet::http: request method=GET path="/api/os/compute/servers/…" status=404 ms=12
```

## Develop

```sh
cargo run -p rassvet -- -c rassvet.toml   # API on :8080
cd ui && pnpm dev                       # UI on :5173, proxies /api to :8080
cargo test && cargo clippy --all-targets
```

## Writing an extension

1. `extensions/<id>/Cargo.toml` + `src/lib.rs` implementing `rassvet_ext_api::Extension`
   (manifest with required `service_types`, nav items, axum routes mounted at `/api/ext/<id>`).
   Handlers take `RequestContext` to get the endpoint and an authenticated request builder.
2. `extensions/<id>/ui/index.tsx` default-exporting an `ExtensionUi` (routes mounted at `/ext/<id>/...`).
   Import shared components and the API client only from `@rassvet/sdk`.
3. Add the crate to the workspace, add an `ext-<id>` feature in `crates/server/Cargo.toml`,
   and register it in `crates/server/src/extensions.rs`.

An extension is shown only when all its service types have endpoints in the user's current region.
