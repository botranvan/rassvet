//! Embedded single-page app (ui/dist) with SPA fallback to index.html.

use axum::{
    http::{StatusCode, Uri, header},
    response::{Html, IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../ui/dist"]
struct Ui;

pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Some(file) = Ui::get(path).filter(|_| !path.is_empty()) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        // Vite emits content-hashed files under assets/, safe to cache forever.
        let cache = if path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        return (
            [
                (header::CONTENT_TYPE, mime.as_ref().to_owned()),
                (header::CACHE_CONTROL, cache.to_owned()),
            ],
            file.data,
        )
            .into_response();
    }
    match Ui::get("index.html") {
        Some(index) => (
            [(header::CACHE_CONTROL, "no-cache")],
            Html(index.data.into_owned()),
        )
            .into_response(),
        None => Html(
            "<h1>rassvet</h1><p>The UI has not been built. Run <code>pnpm install &amp;&amp; \
             pnpm build</code> in <code>ui/</code>, then rebuild the server.</p>",
        )
        .into_response(),
    }
}
