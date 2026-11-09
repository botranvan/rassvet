use reqwest::StatusCode;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("transport error: {0}")]
    Http(#[from] reqwest::Error),

    /// The user name or password was refused, or the session is no longer valid.
    #[error("{0}")]
    Unauthorized(String),

    /// Any other error answer of vCenter / ESXi.
    #[error("vSphere API error {status}: {message}")]
    Api { status: StatusCode, message: String },

    #[error("invalid response: {0}")]
    InvalidResponse(String),
}

impl Error {
    pub fn status(&self) -> Option<StatusCode> {
        match self {
            Error::Unauthorized(_) => Some(StatusCode::UNAUTHORIZED),
            Error::Api { status, .. } => Some(*status),
            Error::Http(e) => e.status(),
            Error::InvalidResponse(_) => None,
        }
    }
}

/// Turn a non-2xx answer of the vCenter REST API into an [`Error`]. Its error bodies look
/// like `{"error_type": "UNAUTHENTICATED", "messages": [{"default_message": "…"}]}`.
pub(crate) async fn check(resp: reqwest::Response) -> Result<reqwest::Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v["messages"][0]["default_message"]
                .as_str()
                .or_else(|| v["error_type"].as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| {
            let t = body.trim();
            if t.is_empty() {
                status.canonical_reason().unwrap_or("error").to_owned()
            } else {
                t.chars().take(300).collect()
            }
        });
    Err(match status {
        StatusCode::UNAUTHORIZED => Error::Unauthorized(message),
        _ => Error::Api { status, message },
    })
}
