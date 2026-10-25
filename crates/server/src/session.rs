//! Server-side sessions. The browser only holds an opaque random id in an HttpOnly
//! cookie; Keystone tokens never leave the server.
//!
//! Sessions always live in this process's memory. When `[memcached]` is configured they
//! are also stored there (optionally encrypted), so they survive restarts and are shared
//! by several Rassvet instances behind a load balancer. If memcached is missing or
//! unreachable, everything keeps working from memory; sessions created during an outage
//! (or lost by a memcached restart) are copied back once it is reachable. Logging out
//! leaves a short-lived tombstone so other instances drop their memory copy too.

use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::Duration,
};

use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use chrono::{DateTime, Utc};
use rassvet_os_client::{Catalog, IdName, ProjectRef, Token};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::{
    config::{MemcachedConfig, ServerConfig},
    memcache::Memcache,
};

pub const COOKIE: &str = "rassvet_sid";

/// Don't rewrite a session in memcached on every request: only when `last_seen` is older than
/// this, or a quarter of the idle timeout when that is shorter (so short timeouts still work).
const TOUCH_EVERY_SECS: i64 = 60;

#[derive(Clone)]
pub struct Session {
    pub cloud_id: String,
    /// Unscoped token kept for project switching (password logins only).
    pub unscoped: Option<String>,
    pub token: Arc<Token>,
    pub projects: Vec<ProjectRef>,
    pub region: Option<String>,
    pub last_seen: DateTime<Utc>,
    /// Login time, for `session_max_minutes`.
    pub created_at: DateTime<Utc>,
    /// Small UI preferences for this login (e.g. each table's last filter), see `api::put_pref`.
    pub prefs: BTreeMap<String, serde_json::Value>,
}

/// When sessions are deleted, from `[server]` in rassvet.toml.
#[derive(Clone, Copy, Debug)]
pub struct SessionLimits {
    /// Without a request for this long.
    pub idle: chrono::Duration,
    /// This long after login, however active (None = no absolute limit).
    pub max: Option<chrono::Duration>,
    /// Sweep of expired sessions from memory.
    pub cleanup: Duration,
}

impl From<&ServerConfig> for SessionLimits {
    fn from(c: &ServerConfig) -> Self {
        Self {
            idle: chrono::Duration::minutes(c.session_idle_minutes.max(1)),
            max: (c.session_max_minutes > 0)
                .then(|| chrono::Duration::minutes(c.session_max_minutes)),
            cleanup: Duration::from_secs(c.session_cleanup_seconds.clamp(5, 3600)),
        }
    }
}

#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<RwLock<HashMap<String, Session>>>,
    remote: Option<Arc<Remote>>,
    limits: SessionLimits,
}

impl SessionStore {
    pub fn new(limits: SessionLimits, memcached: Option<&MemcachedConfig>) -> anyhow::Result<Self> {
        let remote = match memcached {
            Some(m) if !m.servers.is_empty() => Some(Arc::new(Remote::new(m)?)),
            _ => None,
        };
        Ok(Self {
            inner: Default::default(),
            remote,
            limits,
        })
    }

    /// Seconds until the session must be gone: the idle timeout, the absolute lifetime or
    /// the Keystone token's expiry, whichever comes first. Used as the memcached TTL.
    fn seconds_left(&self, s: &Session) -> i64 {
        let now = Utc::now();
        let mut left = (s.last_seen + self.limits.idle - now).num_seconds();
        left = left.min((s.token.expires_at - now).num_seconds());
        if let Some(max) = self.limits.max {
            left = left.min((s.created_at + max - now).num_seconds());
        }
        left
    }

    /// Log which session backend is used; check memcached servers once at startup.
    pub async fn announce(&self) {
        let l = &self.limits;
        tracing::info!(
            idle_minutes = l.idle.num_minutes(),
            max_minutes = l.max.map_or(0, |m| m.num_minutes()),
            cleanup_seconds = l.cleanup.as_secs(),
            "sessions are deleted after the idle timeout, the maximum lifetime (0 = none) or the token's expiry"
        );
        let Some(r) = &self.remote else {
            tracing::info!("sessions are kept in memory (no [memcached] configured)");
            return;
        };
        for (addr, res) in r.mc.probe().await {
            match res {
                Ok(v) => {
                    tracing::info!(server = %addr, version = %v, encrypted = r.cipher.is_some(), "sessions are stored in memcached")
                }
                Err(e) => {
                    tracing::warn!(server = %addr, error = %e, "memcached not reachable; sessions stay in memory until it is")
                }
            }
        }
        if r.cipher.is_none() {
            tracing::warn!(
                "[memcached] has no secret_key: Keystone tokens are stored unencrypted in memcached"
            );
        }
    }

    pub async fn create(&self, s: Session) -> String {
        let id: String = rand::random::<[u8; 32]>()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        self.push(&id, &s).await;
        self.inner.write().await.insert(id.clone(), s);
        id
    }

    /// Fetch a live session and bump its idle timer. Expired sessions are dropped.
    pub async fn get(&self, id: &str) -> Option<Session> {
        if let Some(r) = &self.remote {
            match r.get(id).await {
                Ok(Some(mut s)) => {
                    if self.is_dead(&s) {
                        self.drop_everywhere(id).await;
                        return None;
                    }
                    let now = Utc::now();
                    if (now - s.last_seen).num_seconds() >= self.touch_every() {
                        s.last_seen = now;
                        self.push(id, &s).await;
                    }
                    self.inner.write().await.insert(id.into(), s.clone());
                    return Some(s);
                }
                Ok(None) => {
                    // Not in memcached. Logged out on another instance → forget it; otherwise it was
                    // created during an outage or lost by a memcached restart → upload our copy.
                    let local = self.inner.read().await.get(id).cloned();
                    let mut s = local?;
                    if self.is_dead(&s) || r.logged_out(id).await {
                        self.inner.write().await.remove(id);
                        return None;
                    }
                    s.last_seen = Utc::now();
                    self.push(id, &s).await;
                    self.inner.write().await.insert(id.into(), s.clone());
                    return Some(s);
                }
                Err(_) => {} // memcached down: serve from memory below
            }
        }
        let mut map = self.inner.write().await;
        let s = map.get_mut(id)?;
        if self.is_dead(s) {
            map.remove(id);
            return None;
        }
        s.last_seen = Utc::now();
        Some(s.clone())
    }

    pub async fn update(&self, id: &str, f: impl FnOnce(&mut Session)) -> Option<Session> {
        let mut s = self.get(id).await?;
        f(&mut s);
        self.push(id, &s).await;
        self.inner.write().await.insert(id.into(), s.clone());
        Some(s)
    }

    pub async fn remove(&self, id: &str) -> Option<Session> {
        let s = self.get(id).await;
        if let Some(r) = &self.remote
            && let Err(e) = r.tombstone(id, self.tombstone_ttl()).await
        {
            tracing::debug!(error = %e, "memcached logout tombstone failed");
        }
        self.drop_everywhere(id).await;
        s
    }

    async fn drop_everywhere(&self, id: &str) {
        self.inner.write().await.remove(id);
        if let Some(r) = &self.remote
            && let Err(e) = r.delete(id).await
        {
            tracing::debug!(error = %e, "memcached delete failed");
        }
    }

    /// Write to memcached; true when stored.
    async fn push(&self, id: &str, s: &Session) -> bool {
        let Some(r) = &self.remote else { return false };
        let ttl = self.seconds_left(s).max(1) as u64;
        match r.set(id, s, ttl).await {
            Ok(()) => true,
            Err(e) => {
                tracing::debug!(error = %e, "memcached set failed; session kept in memory");
                false
            }
        }
    }

    fn is_dead(&self, s: &Session) -> bool {
        s.token.is_expired() || self.seconds_left(s) <= 0
    }

    fn touch_every(&self) -> i64 {
        (self.limits.idle.num_seconds() / 4).clamp(1, TOUCH_EVERY_SECS)
    }

    /// A logout tombstone must outlive any other instance's memory copy of the session.
    fn tombstone_ttl(&self) -> u64 {
        let l = &self.limits;
        l.max.unwrap_or(l.idle).max(l.idle).num_seconds().max(60) as u64
    }

    /// Background task removing idle/expired sessions from memory every minute
    /// (memcached expires its copies by itself).
    pub fn spawn_reaper(&self) {
        let store = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(store.limits.cleanup);
            loop {
                tick.tick().await;
                let mut map = store.inner.write().await;
                let before = map.len();
                map.retain(|_, s| !store.is_dead(s));
                let removed = before - map.len();
                if removed > 0 {
                    tracing::debug!(removed, "expired sessions removed");
                }
            }
        });
    }
}

// ---------------------------------------------------------------------------- memcached

struct Remote {
    mc: Memcache,
    prefix: String,
    cipher: Option<ChaCha20Poly1305>,
}

/// What is stored in memcached (the Token type hides its secret from JSON on purpose).
#[derive(Serialize, Deserialize)]
struct Stored {
    cloud_id: String,
    unscoped: Option<String>,
    token: StoredToken,
    projects: Vec<ProjectRef>,
    region: Option<String>,
    last_seen: DateTime<Utc>,
    /// Sessions stored before 0024 have none: count from when they're read.
    #[serde(default = "Utc::now")]
    created_at: DateTime<Utc>,
    #[serde(default)]
    prefs: BTreeMap<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
struct StoredToken {
    value: String,
    expires_at: DateTime<Utc>,
    user: ProjectRef,
    project: Option<ProjectRef>,
    domain: Option<IdName>,
    system: bool,
    roles: Vec<IdName>,
    methods: Vec<String>,
    catalog: Catalog,
}

const PLAIN: u8 = b'J';
const SEALED: u8 = b'E';

impl Remote {
    fn new(m: &MemcachedConfig) -> anyhow::Result<Self> {
        let secret = m.secret()?;
        Ok(Self {
            mc: Memcache::new(&m.servers, m.timeout_ms),
            prefix: m.key_prefix.clone(),
            cipher: secret.map(|s| ChaCha20Poly1305::new(&Sha256::digest(s.as_bytes()))),
        })
    }

    /// The cookie value never appears in memcached: keys are a hash of it.
    fn key(&self, id: &str) -> String {
        format!("{}:sess:{}", self.prefix, hash(id))
    }

    fn dead_key(&self, id: &str) -> String {
        format!("{}:gone:{}", self.prefix, hash(id))
    }

    async fn tombstone(&self, id: &str, ttl: u64) -> anyhow::Result<()> {
        self.mc.set(&self.dead_key(id), b"1", ttl).await
    }

    /// Was this session logged out on some instance? (Unknown when memcached fails: assume not.)
    async fn logged_out(&self, id: &str) -> bool {
        matches!(self.mc.get(&self.dead_key(id)).await, Ok(Some(_)))
    }

    async fn get(&self, id: &str) -> anyhow::Result<Option<Session>> {
        let key = self.key(id);
        let Some(raw) = self.mc.get(&key).await? else {
            return Ok(None);
        };
        match self.decode(&key, &raw) {
            Ok(s) => Ok(Some(s)),
            Err(e) => {
                // Wrong key, other format version, tampering: treat as no session.
                tracing::warn!(error = %e, "unreadable session in memcached; ignoring it");
                Ok(None)
            }
        }
    }

    async fn set(&self, id: &str, s: &Session, ttl: u64) -> anyhow::Result<()> {
        let key = self.key(id);
        let raw = self.encode(&key, s)?;
        self.mc.set(&key, &raw, ttl).await
    }

    async fn delete(&self, id: &str) -> anyhow::Result<()> {
        self.mc.delete(&self.key(id)).await
    }

    fn encode(&self, key: &str, s: &Session) -> anyhow::Result<Vec<u8>> {
        let t = &s.token;
        let json = serde_json::to_vec(&Stored {
            cloud_id: s.cloud_id.clone(),
            unscoped: s.unscoped.clone(),
            token: StoredToken {
                value: t.value.clone(),
                expires_at: t.expires_at,
                user: t.user.clone(),
                project: t.project.clone(),
                domain: t.domain.clone(),
                system: t.system,
                roles: t.roles.clone(),
                methods: t.methods.clone(),
                catalog: t.catalog.clone(),
            },
            projects: s.projects.clone(),
            region: s.region.clone(),
            last_seen: s.last_seen,
            created_at: s.created_at,
            prefs: s.prefs.clone(),
        })?;
        Ok(match &self.cipher {
            None => [&[PLAIN][..], &json].concat(),
            Some(c) => {
                let nonce: [u8; 12] = rand::random();
                let sealed = c
                    .encrypt(
                        Nonce::from_slice(&nonce),
                        Payload {
                            msg: &json,
                            aad: key.as_bytes(),
                        },
                    )
                    .map_err(|_| anyhow::anyhow!("encrypting session"))?;
                [&[SEALED][..], &nonce, &sealed].concat()
            }
        })
    }

    fn decode(&self, key: &str, raw: &[u8]) -> anyhow::Result<Session> {
        let json = match (raw.first(), &self.cipher) {
            (Some(&PLAIN), None) => raw[1..].to_vec(),
            (Some(&SEALED), Some(c)) if raw.len() > 13 => c
                .decrypt(
                    Nonce::from_slice(&raw[1..13]),
                    Payload {
                        msg: &raw[13..],
                        aad: key.as_bytes(),
                    },
                )
                .map_err(|_| anyhow::anyhow!("session doesn't decrypt with this secret_key"))?,
            (Some(&PLAIN), Some(_)) => {
                anyhow::bail!("session stored unencrypted but secret_key is set")
            }
            (Some(&SEALED), None) => anyhow::bail!("session is encrypted but no secret_key is set"),
            _ => anyhow::bail!("unknown session format"),
        };
        let st: Stored = serde_json::from_slice(&json)?;
        let t = st.token;
        Ok(Session {
            cloud_id: st.cloud_id,
            unscoped: st.unscoped,
            token: Arc::new(Token {
                value: t.value,
                expires_at: t.expires_at,
                user: t.user,
                project: t.project,
                domain: t.domain,
                system: t.system,
                roles: t.roles,
                methods: t.methods,
                catalog: t.catalog,
            }),
            projects: st.projects,
            region: st.region,
            last_seen: st.last_seen,
            created_at: st.created_at,
            prefs: st.prefs,
        })
    }
}

fn hash(id: &str) -> String {
    Sha256::digest(id.as_bytes())
        .iter()
        .take(20)
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session {
            cloud_id: "lab".into(),
            unscoped: Some("unscoped-token".into()),
            token: Arc::new(Token {
                value: "gAAAA-secret".into(),
                expires_at: Utc::now() + chrono::Duration::hours(1),
                user: ProjectRef {
                    id: "u1".into(),
                    name: "admin".into(),
                    domain: None,
                },
                project: None,
                domain: None,
                system: false,
                roles: vec![IdName {
                    id: "r1".into(),
                    name: "admin".into(),
                }],
                methods: vec!["password".into()],
                catalog: Catalog::default(),
            }),
            projects: vec![],
            region: Some("RegionOne".into()),
            last_seen: Utc::now(),
            created_at: Utc::now(),
            prefs: BTreeMap::from([("table.x".into(), serde_json::json!({"q": "web"}))]),
        }
    }

    fn remote(secret: Option<&str>) -> Remote {
        Remote::new(&MemcachedConfig {
            servers: vec!["127.0.0.1:1".into()],
            key_prefix: "t".into(),
            timeout_ms: 100,
            secret_key: secret.map(Into::into),
            secret_key_file: None,
        })
        .unwrap()
    }

    fn store(idle: i64, max: i64) -> SessionStore {
        let cfg = ServerConfig {
            session_idle_minutes: idle,
            session_max_minutes: max,
            ..Default::default()
        };
        SessionStore::new(SessionLimits::from(&cfg), None).unwrap()
    }

    #[tokio::test]
    async fn deleted_after_idle_timeout() {
        let st = store(30, 0);
        let id = st.create(session()).await;
        assert!(st.get(&id).await.is_some());
        st.inner.write().await.get_mut(&id).unwrap().last_seen =
            Utc::now() - chrono::Duration::minutes(31);
        assert!(st.get(&id).await.is_none());
        assert!(st.inner.read().await.is_empty());
    }

    #[tokio::test]
    async fn deleted_after_max_lifetime_even_when_active() {
        let st = store(30, 120);
        let id = st.create(session()).await;
        st.inner.write().await.get_mut(&id).unwrap().created_at =
            Utc::now() - chrono::Duration::minutes(121);
        assert!(st.get(&id).await.is_none());
        // 0 = no absolute limit
        let st = store(30, 0);
        let id = st.create(session()).await;
        st.inner.write().await.get_mut(&id).unwrap().created_at =
            Utc::now() - chrono::Duration::days(3);
        assert!(st.get(&id).await.is_some());
    }

    #[test]
    fn memcached_ttl_is_the_earliest_deadline() {
        let st = store(60, 90);
        let mut s = session();
        assert!((3590..=3600).contains(&st.seconds_left(&s))); // idle 60 min, token 1 h
        s.created_at = Utc::now() - chrono::Duration::minutes(80);
        assert!((590..=600).contains(&st.seconds_left(&s))); // 10 min of the 90 left
    }

    #[test]
    fn round_trips_encrypted_and_plain() {
        for secret in [Some("0123456789abcdef0123"), None] {
            let r = remote(secret);
            let key = r.key("abc");
            let raw = r.encode(&key, &session()).unwrap();
            if secret.is_some() {
                // The token must not be readable in memcached.
                assert!(!raw.windows(12).any(|w| w == b"gAAAA-secret"));
            }
            let s = r.decode(&key, &raw).unwrap();
            assert_eq!(s.token.value, "gAAAA-secret");
            assert_eq!(s.unscoped.as_deref(), Some("unscoped-token"));
            assert_eq!(s.region.as_deref(), Some("RegionOne"));
            assert_eq!(s.prefs["table.x"]["q"], "web");
        }
    }

    #[test]
    fn rejects_other_key_or_moved_value() {
        let a = remote(Some("0123456789abcdef0123"));
        let b = remote(Some("another-secret-0123456"));
        let raw = a.encode(&a.key("abc"), &session()).unwrap();
        assert!(b.decode(&b.key("abc"), &raw).is_err());
        // Same secret, but the value was copied under another session's key.
        assert!(a.decode(&a.key("xyz"), &raw).is_err());
        assert!(!a.key("abc").contains("abc"));
    }
}
