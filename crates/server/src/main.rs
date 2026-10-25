mod api;
mod assets;
mod barbican;
mod compute;
mod config;
mod extensions;
mod gateway;
mod identity;
mod image;
mod keypair;
mod logging;
mod memcache;
mod metadefs;
mod nav;
mod session;
mod state;
mod swift;
mod throttle;

use std::path::PathBuf;

use axum::{
    Router,
    http::{HeaderValue, header},
    middleware,
    routing::get,
};
use clap::Parser;

#[derive(Parser)]
#[command(name = "rassvet", version = api::VERSION, about = "Next-gen OpenStack dashboard")]
struct Cli {
    /// Path to the TOML configuration file.
    #[arg(short, long, env = "RASSVET_CONFIG", default_value = "rassvet.toml")]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let cfg = config::Config::load(&cli.config)?;
    if let Some(file) = logging::init(&cfg.log)? {
        logging::reopen_on_sighup(file);
    }
    let listen = cfg.server.listen;
    let secure_cookies = cfg.server.secure_cookies;
    let exts = extensions::registered();
    for e in &exts {
        let m = e.manifest();
        tracing::info!(id = m.id, version = m.version, "extension compiled in");
    }
    let st = state::build(cfg, exts)?;
    st.sessions.announce().await;

    let mut api = api::router();
    for ext in &st.extensions {
        let id = ext.manifest().id;
        api = api.nest(&format!("/ext/{id}"), ext.router().with_state(()));
    }
    let api = api.layer(middleware::from_fn_with_state(
        st.clone(),
        api::session_layer,
    ));

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest("/api", api)
        .fallback(assets::serve)
        .layer(axum::middleware::map_response_with_state(
            secure_cookies,
            security_headers,
        ))
        .layer(middleware::from_fn(logging::request_layer))
        .with_state(st);

    if !secure_cookies && !listen.ip().is_loopback() {
        tracing::warn!(
            %listen,
            "secure_cookies is off: the session cookie is also sent over plain HTTP. Serve Rassvet over HTTPS (directly or behind a TLS proxy) and set [server] secure_cookies = true"
        );
    }
    let listener = tokio::net::TcpListener::bind(listen).await?;
    tracing::info!(%listen, version = api::VERSION, "rassvet listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

async fn security_headers(
    axum::extract::State(https): axum::extract::State<bool>,
    mut res: axum::response::Response,
) -> axum::response::Response {
    let h = res.headers_mut();
    if https {
        // Only when served over HTTPS (secure_cookies): browsers then refuse plain HTTP.
        h.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000"),
        );
    }
    h.insert(
        "cross-origin-opener-policy",
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        "permissions-policy",
        HeaderValue::from_static(
            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
        ),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    // A handler may set a stricter policy (object downloads use `sandbox`).
    if !h.contains_key(header::CONTENT_SECURITY_POLICY) {
        h.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; \
                 font-src 'self'; connect-src 'self'; frame-src 'self' https: http:; \
                 object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
            ),
        );
    }
    res
}
