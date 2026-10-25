//! `POST /api/compute/keypairs`: create a new SSH key pair.
//!
//! Nova stopped generating key pairs in microversion 2.92, so Rassvet generates the key
//! itself, imports the public half into Nova and returns the private key exactly once.
//! The private key is never stored or logged; the response is marked `no-store`.

use axum::{
    Json,
    extract::State,
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use rassvet_ext_api::{ApiError, RequestContext};
use serde::Deserialize;
use serde_json::json;
use ssh_key::{
    Algorithm, HashAlg, LineEnding, PrivateKey,
    private::{KeypairData, RsaKeypair},
    rand_core::OsRng,
};

use crate::{
    gateway::{self, Svc, valid_name},
    state::AppState,
};

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
pub enum KeyAlgorithm {
    #[serde(rename = "ed25519")]
    Ed25519,
    #[serde(rename = "rsa-3072")]
    Rsa3072,
    #[serde(rename = "rsa-4096")]
    Rsa4096,
}

#[derive(Debug, Deserialize)]
pub struct NewKeypair {
    pub name: String,
    #[serde(default = "ed25519")]
    pub algorithm: KeyAlgorithm,
}

fn ed25519() -> KeyAlgorithm {
    KeyAlgorithm::Ed25519
}

pub struct Generated {
    pub private_openssh: String,
    pub public_openssh: String,
    pub fingerprint: String,
}

/// Generate a key; RSA takes a moment, so callers run this on a blocking thread.
pub fn generate(alg: KeyAlgorithm, comment: &str) -> Result<Generated, ssh_key::Error> {
    let mut key = match alg {
        KeyAlgorithm::Ed25519 => PrivateKey::random(&mut OsRng, Algorithm::Ed25519)?,
        KeyAlgorithm::Rsa3072 | KeyAlgorithm::Rsa4096 => {
            let bits = if alg == KeyAlgorithm::Rsa3072 {
                3072
            } else {
                4096
            };
            let pair = RsaKeypair::random(&mut OsRng, bits)?;
            PrivateKey::new(KeypairData::from(pair), comment)?
        }
    };
    key.set_comment(comment);
    Ok(Generated {
        private_openssh: key.to_openssh(LineEnding::LF)?.to_string(),
        public_openssh: key.public_key().to_openssh()?,
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
    })
}

pub async fn create(
    State(st): State<AppState>,
    ctx: RequestContext,
    Json(req): Json<NewKeypair>,
) -> Result<Response, ApiError> {
    let name = req.name.trim().to_owned();
    if !valid_name(&name) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "key pair names use letters, digits, spaces and . _ - @ (up to 255)",
        ));
    }
    let comment = format!("{name}@rassvet");
    let alg = req.algorithm;
    let key = tokio::task::spawn_blocking(move || generate(alg, &comment))
        .await
        .map_err(|e| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("key generation failed: {e}"),
            )
        })?
        .map_err(|e| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("key generation failed: {e}"),
            )
        })?;

    let (_, created) = gateway::call(
        &st,
        &ctx,
        Svc::Compute,
        Method::POST,
        "os-keypairs",
        &[],
        Some(&json!({ "keypair": { "name": name, "public_key": key.public_openssh, "type": "ssh" } })),
    )
    .await?;
    tracing::info!(user = %ctx.token.user.name, name = %name, algorithm = ?alg, fingerprint = %key.fingerprint, "key pair created");

    let mut res = (
        StatusCode::CREATED,
        Json(json!({
            "keypair": created["keypair"],
            "private_key": key.private_openssh,
            "fingerprint": key.fingerprint,
        })),
    )
        .into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_openssh_keys() {
        let k = generate(KeyAlgorithm::Ed25519, "demo@rassvet").unwrap();
        assert!(
            k.private_openssh
                .starts_with("-----BEGIN OPENSSH PRIVATE KEY-----")
        );
        assert!(k.public_openssh.starts_with("ssh-ed25519 "));
        assert!(k.public_openssh.ends_with(" demo@rassvet"));
        assert!(k.fingerprint.starts_with("SHA256:"));
        // The private key parses back and matches the public key.
        let back = PrivateKey::from_openssh(&k.private_openssh).unwrap();
        assert_eq!(back.public_key().to_openssh().unwrap(), k.public_openssh);
        let a: NewKeypair = serde_json::from_str(r#"{"name":"x","algorithm":"rsa-4096"}"#).unwrap();
        assert_eq!(a.algorithm, KeyAlgorithm::Rsa4096);
    }
}
