//! Minimal async memcached client (text protocol: get / set / delete / version) with a
//! small connection pool per server, timeouts, and a short back-off after failures so a
//! dead memcached never slows requests down. Keys are spread over servers by hash.

use std::{
    hash::{DefaultHasher, Hash, Hasher},
    sync::Mutex,
    time::{Duration, Instant},
};

use anyhow::{Context, anyhow, bail};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufStream},
    net::TcpStream,
    time::timeout,
};

/// Pause before retrying a server after an error.
const BACKOFF: Duration = Duration::from_secs(15);
/// Idle connections kept per server.
const POOL: usize = 8;
/// Largest value accepted back from a server (sessions are a few KB; catalogs can be ~100 KB).
const MAX_VALUE: usize = 4 * 1024 * 1024;

struct Server {
    addr: String,
    pool: Mutex<Vec<BufStream<TcpStream>>>,
    down_until: Mutex<Option<Instant>>,
}

pub struct Memcache {
    servers: Vec<Server>,
    timeout: Duration,
}

impl Memcache {
    pub fn new(addrs: &[String], timeout_ms: u64) -> Self {
        Self {
            servers: addrs
                .iter()
                .map(|a| Server {
                    addr: a.clone(),
                    pool: Mutex::new(Vec::new()),
                    down_until: Mutex::new(None),
                })
                .collect(),
            timeout: Duration::from_millis(timeout_ms.max(50)),
        }
    }

    fn server(&self, key: &str) -> &Server {
        let mut h = DefaultHasher::new();
        key.hash(&mut h);
        &self.servers[(h.finish() % self.servers.len() as u64) as usize]
    }

    /// Ask every server for its version (startup check). Returns (addr, Ok(version) | Err).
    pub async fn probe(&self) -> Vec<(String, anyhow::Result<String>)> {
        let mut out = Vec::new();
        for s in &self.servers {
            let r = self
                .run(s, |c| {
                    Box::pin(async move {
                        c.write_all(b"version\r\n").await?;
                        c.flush().await?;
                        let line = read_line(c).await?;
                        line.strip_prefix("VERSION ")
                            .map(str::to_owned)
                            .ok_or_else(|| anyhow!("unexpected reply: {line}"))
                    })
                })
                .await;
            out.push((s.addr.clone(), r));
        }
        out
    }

    pub async fn get(&self, key: &str) -> anyhow::Result<Option<Vec<u8>>> {
        let s = self.server(key);
        let cmd = format!("get {key}\r\n");
        let key = key.to_owned();
        self.run(s, move |c| {
            Box::pin(async move {
                c.write_all(cmd.as_bytes()).await?;
                c.flush().await?;
                let line = read_line(c).await?;
                if line == "END" {
                    return Ok(None);
                }
                // VALUE <key> <flags> <bytes>
                let mut parts = line.split(' ');
                if parts.next() != Some("VALUE") || parts.next() != Some(key.as_str()) {
                    bail!("unexpected reply: {line}");
                }
                let len: usize = parts.nth(1).context("missing length")?.parse()?;
                if len > MAX_VALUE {
                    bail!("value too large ({len} bytes)");
                }
                let mut buf = vec![0; len + 2];
                c.read_exact(&mut buf).await?;
                buf.truncate(len);
                let end = read_line(c).await?;
                if end != "END" {
                    bail!("unexpected reply: {end}");
                }
                Ok(Some(buf))
            })
        })
        .await
    }

    /// Store with an expiry in seconds (memcached treats > 30 days as a timestamp, so it's capped).
    pub async fn set(&self, key: &str, value: &[u8], ttl_secs: u64) -> anyhow::Result<()> {
        let s = self.server(key);
        let ttl = ttl_secs.clamp(1, 30 * 24 * 3600);
        let mut cmd = format!("set {key} 0 {ttl} {}\r\n", value.len()).into_bytes();
        cmd.extend_from_slice(value);
        cmd.extend_from_slice(b"\r\n");
        self.run(s, move |c| {
            Box::pin(async move {
                c.write_all(&cmd).await?;
                c.flush().await?;
                let line = read_line(c).await?;
                if line != "STORED" {
                    bail!("set failed: {line}");
                }
                Ok(())
            })
        })
        .await
    }

    pub async fn delete(&self, key: &str) -> anyhow::Result<()> {
        let s = self.server(key);
        let cmd = format!("delete {key}\r\n");
        self.run(s, move |c| {
            Box::pin(async move {
                c.write_all(cmd.as_bytes()).await?;
                c.flush().await?;
                let line = read_line(c).await?;
                if line != "DELETED" && line != "NOT_FOUND" {
                    bail!("delete failed: {line}");
                }
                Ok(())
            })
        })
        .await
    }

    /// Run one request on a pooled connection with the configured timeout. A failed
    /// connection is dropped and the server is skipped for [`BACKOFF`].
    async fn run<T>(
        &self,
        s: &Server,
        op: impl for<'a> FnOnce(
            &'a mut BufStream<TcpStream>,
        ) -> std::pin::Pin<
            Box<dyn Future<Output = anyhow::Result<T>> + Send + 'a>,
        >,
    ) -> anyhow::Result<T> {
        if let Some(t) = *s.down_until.lock().unwrap()
            && Instant::now() < t
        {
            bail!("memcached {} is marked down", s.addr);
        }
        let pooled = s.pool.lock().unwrap().pop();
        let result = timeout(self.timeout, async {
            let mut conn = match pooled {
                Some(c) => c,
                None => {
                    let tcp = TcpStream::connect(&s.addr)
                        .await
                        .with_context(|| format!("connecting to memcached {}", s.addr))?;
                    // Small request/response pairs: Nagle + delayed ACK would add ~40 ms.
                    let _ = tcp.set_nodelay(true);
                    BufStream::new(tcp)
                }
            };
            let r = op(&mut conn).await;
            Ok::<_, anyhow::Error>((conn, r))
        })
        .await;
        match result {
            Ok(Ok((conn, Ok(v)))) => {
                let mut pool = s.pool.lock().unwrap();
                if pool.len() < POOL {
                    pool.push(conn);
                }
                let mut down = s.down_until.lock().unwrap();
                if down.take().is_some() {
                    tracing::info!(server = %s.addr, "memcached is reachable again");
                }
                Ok(v)
            }
            Ok(Ok((_, Err(e)))) | Ok(Err(e)) => Err(self.mark_down(s, e)),
            Err(_) => Err(self.mark_down(s, anyhow!("memcached {} timed out", s.addr))),
        }
    }

    fn mark_down(&self, s: &Server, e: anyhow::Error) -> anyhow::Error {
        let mut down = s.down_until.lock().unwrap();
        if down.is_none() {
            tracing::warn!(server = %s.addr, error = %e, "memcached unavailable; sessions fall back to this server's memory");
        }
        *down = Some(Instant::now() + BACKOFF);
        s.pool.lock().unwrap().clear();
        e
    }
}

async fn read_line(c: &mut BufStream<TcpStream>) -> anyhow::Result<String> {
    let mut line = String::new();
    let n = c.read_line(&mut line).await?;
    if n == 0 {
        bail!("connection closed");
    }
    let line = line.trim_end_matches(['\r', '\n']).to_owned();
    if line == "ERROR" || line.starts_with("CLIENT_ERROR") || line.starts_with("SERVER_ERROR") {
        bail!("memcached error: {line}");
    }
    Ok(line)
}
