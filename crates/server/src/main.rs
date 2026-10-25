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
        .layer(axum::middleware::map_response(security_headers))
        .layer(middleware::from_fn(logging::request_layer))
        .with_state(st);

    let listener = tokio::net::TcpListener::bind(listen).await?;
    tracing::info!(%listen, version = api::VERSION, "rassvet listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

async fn security_headers(mut res: axum::response::Response) -> axum::response::Response {
    let h = res.headers_mut();
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
                 frame-ancestors 'none'",
            ),
        );
    }
    res
}
