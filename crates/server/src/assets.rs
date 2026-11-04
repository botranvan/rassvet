//! Embedded single-page app (ui/dist) with SPA fallback to index.html.
//!
//! With a single `[[cloud]]`, index.html is served with that cloud's name as its `<title>`,
//! so the page is named before the app runs (and in bookmarks, history and link previews).
//! The app then keeps the title on the tab's cloud.

use axum::{
    extract::State,
    http::{StatusCode, Uri, header},
    response::{Html, IntoResponse, Response},
};
use rust_embed::RustEmbed;

use crate::state::AppState;

#[derive(RustEmbed)]
#[folder = "../../ui/dist"]
struct Ui;

pub async fn serve(State(st): State<AppState>, uri: Uri) -> Response {
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
        Some(index) => {
            let only_cloud = match st.clouds.as_slice() {
                [c] => Some(c.cfg.name.as_str()),
                _ => None,
            };
            (
                [(header::CACHE_CONTROL, "no-cache")],
                Html(with_title(&index.data, only_cloud)),
            )
                .into_response()
        }
        None => Html(
            "<h1>rassvet</h1><p>The UI has not been built. Run <code>pnpm install &amp;&amp; \
             pnpm build</code> in <code>ui/</code>, then rebuild the server.</p>",
        )
        .into_response(),
    }
}

/// index.html with `title` (HTML-escaped) in place of its `<title>`, when given.
fn with_title(html: &[u8], title: Option<&str>) -> String {
    let html = String::from_utf8_lossy(html);
    let Some(title) = title.map(str::trim).filter(|t| !t.is_empty()) else {
        return html.into_owned();
    };
    let (Some(start), Some(end)) = (html.find("<title>"), html.find("</title>")) else {
        return html.into_owned();
    };
    if end < start {
        return html.into_owned();
    }
    let mut escaped = String::with_capacity(title.len());
    for c in title.chars() {
        match c {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            c => escaped.push(c),
        }
    }
    format!("{}<title>{escaped}{}", &html[..start], &html[end..])
}

#[cfg(test)]
mod tests {
    use super::with_title;

    const PAGE: &str = "<head><title>rassvet</title></head><body></body>";

    #[test]
    fn single_cloud_names_the_page() {
        assert_eq!(
            with_title(PAGE.as_bytes(), Some("Ministry Cloud")),
            "<head><title>Ministry Cloud</title></head><body></body>"
        );
        assert_eq!(
            with_title(PAGE.as_bytes(), Some("R&D <lab>")),
            "<head><title>R&amp;D &lt;lab&gt;</title></head><body></body>"
        );
        assert_eq!(with_title(PAGE.as_bytes(), None), PAGE);
        assert_eq!(with_title(PAGE.as_bytes(), Some("  ")), PAGE);
    }
}
