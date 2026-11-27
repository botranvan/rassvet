//! Brute-force protection for `POST /api/auth/login`.
//!
//! Failed sign-ins (Keystone answered 401) are counted per account — cloud, user domain
//! and user name, or the application credential id — in a fixed window. Once an account
//! has [`MAX_FAILURES`] failures in [`WINDOW`], further attempts are refused with 429 and
//! `Retry-After` until the window ends, without asking Keystone at all; a successful
//! sign-in clears the count. Counting per account (not per client address) works the same
//! behind a reverse proxy. Each Rassvet instance counts on its own.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

pub const MAX_FAILURES: u32 = 10;
pub const WINDOW: Duration = Duration::from_secs(15 * 60);
/// Bound on tracked accounts; expired entries are dropped first.
const MAX_ENTRIES: usize = 50_000;

#[derive(Default)]
pub struct LoginThrottle {
    failures: Mutex<HashMap<String, (u32, Instant)>>,
}

impl LoginThrottle {
    /// Seconds to wait when the account is locked out for now.
    pub fn retry_after(&self, key: &str) -> Option<u64> {
        let map = self.failures.lock().unwrap();
        let (n, since) = map.get(key)?;
        let left = WINDOW.checked_sub(since.elapsed())?;
        (*n >= MAX_FAILURES).then(|| left.as_secs().max(1))
    }

    pub fn failure(&self, key: &str) {
        let mut map = self.failures.lock().unwrap();
        if map.len() >= MAX_ENTRIES {
            map.retain(|_, (_, since)| since.elapsed() < WINDOW);
            if map.len() >= MAX_ENTRIES {
                // Under a flood of distinct names: keep memory bounded rather than the counts.
                map.clear();
            }
        }
        let e = map.entry(key.to_owned()).or_insert((0, Instant::now()));
        if e.1.elapsed() >= WINDOW {
            *e = (0, Instant::now());
        }
        e.0 += 1;
        if e.0 == MAX_FAILURES {
            tracing::warn!(account = key, "too many failed sign-ins; refusing new attempts for a while");
        }
    }

    pub fn success(&self, key: &str) {
        self.failures.lock().unwrap().remove(key);
    }
}

/// Throttle key for a password login (names compared case-insensitively, like most backends).
pub fn password_key(cloud: &str, domain: &str, user: &str) -> String {
    format!(
        "{cloud}|pw|{}|{}",
        domain.trim().to_lowercase(),
        user.trim().to_lowercase()
    )
}

pub fn app_cred_key(cloud: &str, id: &str) -> String {
    format!("{cloud}|ac|{}", id.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locks_after_max_failures_and_clears_on_success() {
        let t = LoginThrottle::default();
        let k = password_key("lab", "Default", "Alice");
        assert_eq!(k, password_key("lab", "default", " alice "));
        for _ in 0..MAX_FAILURES - 1 {
            t.failure(&k);
        }
        assert!(t.retry_after(&k).is_none());
        t.failure(&k);
        let wait = t.retry_after(&k).unwrap();
        assert!(wait > 0 && wait <= WINDOW.as_secs());
        assert!(t.retry_after(&password_key("lab", "Default", "bob")).is_none());
        t.success(&k);
        assert!(t.retry_after(&k).is_none());
    }
}
