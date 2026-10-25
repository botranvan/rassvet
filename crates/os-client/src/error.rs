use reqwest::StatusCode;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("transport error: {0}")]
    Http(#[from] reqwest::Error),

    /// Error returned by an OpenStack API, with the request id for troubleshooting.
    #[error("{service} API error {status}: {message}")]
    Api {
        service: String,
        status: StatusCode,
        message: String,
        request_id: Option<String>,
    },

    #[error("service '{0}' not found in the catalog")]
    NoEndpoint(String),

    #[error("invalid response: {0}")]
    InvalidResponse(String),

    /// Caller supplied an unusable value (e.g. a malformed resource id).
    #[error("{0}")]
    InvalidInput(String),
}

impl Error {
    pub fn status(&self) -> Option<StatusCode> {
        match self {
            Error::Api { status, .. } => Some(*status),
            Error::Http(e) => e.status(),
            Error::InvalidInput(_) => Some(StatusCode::BAD_REQUEST),
            _ => None,
        }
    }

    pub fn request_id(&self) -> Option<&str> {
        match self {
            Error::Api { request_id, .. } => request_id.as_deref(),
            _ => None,
        }
    }
}

/// Turn a non-2xx response into [`Error::Api`], extracting the most useful message
/// from the many error body shapes OpenStack services use.
pub async fn check(service: &str, resp: reqwest::Response) -> Result<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let request_id = resp
        .headers()
        .get("x-openstack-request-id")
        .or_else(|| resp.headers().get("x-compute-request-id"))
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let body = resp.text().await.unwrap_or_default();
    Err(Error::Api {
        service: service.to_owned(),
        status,
        message: extract_message(&body).unwrap_or_else(|| {
            status
                .canonical_reason()
                .unwrap_or("request failed")
                .to_owned()
        }),
        request_id,
    })
}

fn extract_message(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    // Keystone: {"error": {"message": ..}}; Nova/Cinder: {"badRequest": {"message": ..}};
    // Neutron: {"NeutronError": {"message": ..}}; Barbican/Placement: {"errors": [{"detail"|"title"}]}
    if let Some(obj) = v.as_object() {
        for (_, inner) in obj {
            if let Some(m) = inner.get("message").and_then(|m| m.as_str()) {
                return Some(m.to_owned());
            }
            if let Some(first) = inner.as_array().and_then(|a| a.first())
                && let Some(m) = first
                    .get("detail")
                    .or_else(|| first.get("title"))
                    .and_then(|m| m.as_str())
            {
                return Some(m.to_owned());
            }
        }
        if let Some(m) = obj
            .get("description")
            .or_else(|| obj.get("title"))
            .and_then(|m| m.as_str())
        {
            return Some(m.to_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::extract_message;

    #[test]
    fn extracts_common_shapes() {
        assert_eq!(
            extract_message(r#"{"error":{"message":"bad creds","code":401}}"#).as_deref(),
            Some("bad creds")
        );
        assert_eq!(
            extract_message(r#"{"itemNotFound":{"message":"no server","code":404}}"#).as_deref(),
            Some("no server")
        );
        assert_eq!(
            extract_message(r#"{"errors":[{"status":409,"title":"Conflict","detail":"busy"}]}"#)
                .as_deref(),
            Some("busy")
        );
        assert_eq!(extract_message("not json"), None);
    }
}
