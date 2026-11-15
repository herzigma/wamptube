//! Loopback HTTP proxy that re-serves googlevideo audio with CORS headers so
//! Webamp's Web Audio graph can consume it.
//!
//! googlevideo throttles open-ended and very large ranges to roughly 2x
//! realtime (~32 KB/s for 129 kbps audio) but serves bounded ranges of a few
//! MB at full speed. So whatever range the webview asks for, the proxy answers
//! it as one response and fills the body from sequential bounded upstream
//! requests of `CHUNK` bytes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use tokio::sync::{mpsc, RwLock};
use tokio_stream::wrappers::ReceiverStream;

use crate::resolve::{self, now_s, ResolvedTrack};

/// Upstream request size. Bounded ranges up to ~10 MB were measured at full
/// speed; 2 MiB keeps waste low when the webview abandons a response.
const CHUNK: u64 = 2 * 1024 * 1024;
/// Don't re-run yt-dlp for a token more often than this (avoids a storm when
/// every request 403s, e.g. with an outdated yt-dlp).
const RERESOLVE_MIN_GAP_S: i64 = 30;
/// Longest we will wait for a freshly resolved URL to become valid.
const MAX_AVAILABILITY_WAIT_S: i64 = 15;
/// Window after `available_at` in which a 403 is treated as "not ready yet".
const AVAILABILITY_GRACE_S: i64 = 10;

#[derive(Debug, Clone)]
pub struct StreamEntry {
    pub video_id: String,
    pub upstream_url: String,
    pub headers: Vec<(String, String)>,
    /// Total size in bytes, from yt-dlp or learned from the first Content-Range.
    pub size: Option<u64>,
    /// yt-dlp's `available_at`: requests before this unix time get 403.
    pub available_at: Option<i64>,
    last_reresolve: Option<i64>,
}

pub struct ProxyState {
    pub port: u16,
    tokens: RwLock<HashMap<String, StreamEntry>>,
    /// video id -> token, for `/v/{video_id}` URLs that resolve on first use.
    by_video: RwLock<HashMap<String, String>>,
    /// Recent lazy-resolve failures (unix time, message), so a webview that
    /// retries a dead video doesn't run yt-dlp on every request.
    failed: RwLock<HashMap<String, (i64, String)>>,
    /// Serialises lazy resolves: the webview often sends several requests for
    /// the same new track at once, and they must share one yt-dlp run.
    resolve_lock: tokio::sync::Mutex<()>,
    client: reqwest::Client,
}

impl ProxyState {
    /// Register a resolved track and return its loopback URL.
    pub async fn register(&self, track: &ResolvedTrack) -> String {
        let token = self.insert(track).await;
        self.url_for(&token)
    }

    async fn insert(&self, track: &ResolvedTrack) -> String {
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        self.by_video
            .write()
            .await
            .insert(track.video_id.clone(), token.clone());
        self.tokens.write().await.insert(
            token.clone(),
            StreamEntry {
                video_id: track.video_id.clone(),
                upstream_url: track.upstream_url.clone(),
                headers: track.headers.clone(),
                size: track.size_bytes,
                available_at: track.available_at,
                last_reresolve: None,
            },
        );
        token
    }

    pub fn url_for(&self, token: &str) -> String {
        format!("http://127.0.0.1:{}/stream/{token}", self.port)
    }

    /// Loopback URL for a video that is resolved only when first requested.
    /// Assumes `video_id` is valid (the handler checks again).
    pub fn video_url(&self, video_id: &str) -> String {
        format!("http://127.0.0.1:{}/v/{video_id}", self.port)
    }

    /// The token serving `video_id`, running yt-dlp if there is none yet.
    /// The resolve runs in its own task: WebKit often cancels the first request
    /// for a new track and retries, and the yt-dlp run must survive that rather
    /// than be killed and started over.
    async fn token_for_video(self: &Arc<Self>, video_id: &str) -> Result<String, String> {
        if let Some(t) = self.by_video.read().await.get(video_id) {
            return Ok(t.clone());
        }
        let (st, id) = (self.clone(), video_id.to_string());
        tokio::spawn(async move { st.resolve_video(&id).await })
            .await
            .map_err(|e| format!("resolve task failed: {e}"))?
    }

    async fn resolve_video(&self, video_id: &str) -> Result<String, String> {
        if let Some(t) = self.by_video.read().await.get(video_id) {
            return Ok(t.clone());
        }
        let _guard = self.resolve_lock.lock().await;
        if let Some(t) = self.by_video.read().await.get(video_id) {
            return Ok(t.clone()); // resolved while we waited
        }
        if let Some((at, msg)) = self.failed.read().await.get(video_id) {
            if now_s() - at < RERESOLVE_MIN_GAP_S {
                return Err(msg.clone());
            }
        }
        eprintln!("[proxy] resolving {video_id} on first request");
        match resolve::resolve(video_id).await {
            Ok(track) => {
                self.failed.write().await.remove(video_id);
                let token = self.insert(&track).await;
                eprintln!(
                    "[resolve] {video_id} -> {} | {} {:?}kbps {:?}Hz {}s | token {}",
                    track.title, track.codec, track.bitrate_kbps, track.sample_rate_hz, track.duration_s,
                    short(&token)
                );
                Ok(token)
            }
            Err(e) => {
                self.failed.write().await.insert(video_id.to_string(), (now_s(), e.clone()));
                Err(e)
            }
        }
    }

    /// Replace a token's upstream URL (used after re-resolving; also handy in tests).
    pub async fn set_upstream(&self, token: &str, url: String, headers: Option<Vec<(String, String)>>) -> bool {
        match self.tokens.write().await.get_mut(token) {
            Some(e) => {
                e.upstream_url = url;
                if let Some(h) = headers {
                    e.headers = h;
                }
                true
            }
            None => false,
        }
    }

    async fn entry(&self, token: &str) -> Option<StreamEntry> {
        self.tokens.read().await.get(token).cloned()
    }
}

/// Bind 127.0.0.1:0, spawn the server on the current tokio runtime.
pub async fn start() -> std::io::Result<Arc<ProxyState>> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(std::io::Error::other)?;
    let state = Arc::new(ProxyState {
        port,
        tokens: RwLock::new(HashMap::new()),
        by_video: RwLock::new(HashMap::new()),
        failed: RwLock::new(HashMap::new()),
        resolve_lock: tokio::sync::Mutex::new(()),
        client,
    });
    let app = Router::new()
        .route("/stream/{token}", any(stream_handler))
        .route("/v/{video_id}", any(video_handler))
        .with_state(state.clone());
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[proxy] server stopped: {e}");
        }
    });
    eprintln!("[proxy] listening on http://127.0.0.1:{port}");
    Ok(state)
}

fn short(token: &str) -> &str {
    &token[..token.len().min(8)]
}

fn cors(h: &mut HeaderMap) {
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Length, Content-Range, Accept-Ranges"),
    );
}

fn simple(status: StatusCode, msg: &'static str) -> Response {
    let mut r = Response::new(Body::from(msg));
    *r.status_mut() = status;
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    cors(r.headers_mut());
    r
}

/// What the client asked for, resolved against the total size.
/// `None` = no (usable) Range header: serve the whole file as a 200.
fn parse_range(h: Option<&str>, total: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = h.and_then(|v| v.trim().strip_prefix("bytes=")) else {
        return Ok(None);
    };
    if spec.contains(',') {
        return Ok(None); // multi-range: ignoring Range is allowed
    }
    let Some((a, b)) = spec.split_once('-') else { return Ok(None) };
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        // suffix: last N bytes
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 || total == 0 {
            return Err(());
        }
        return Ok(Some((total.saturating_sub(n), total - 1)));
    }
    let start: u64 = a.parse().map_err(|_| ())?;
    if start >= total {
        return Err(());
    }
    let end = if b.is_empty() {
        total - 1
    } else {
        b.parse::<u64>().map_err(|_| ())?.min(total - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some((start, end)))
}

fn total_from_content_range(h: &reqwest::header::HeaderMap) -> Option<u64> {
    h.get(reqwest::header::CONTENT_RANGE)?
        .to_str()
        .ok()?
        .rsplit('/')
        .next()?
        .parse()
        .ok()
}

/// One bounded upstream GET for `start..=end`. Waits for the URL to become
/// available, and on 403 re-resolves the video once (rate-limited per token)
/// and retries.
async fn upstream_get(
    st: &ProxyState,
    token: &str,
    start: u64,
    end: u64,
) -> Result<reqwest::Response, String> {
    let range = format!("bytes={start}-{end}");
    let mut entry = st.entry(token).await.ok_or("token vanished")?;
    let resp = fetch_when_available(&st.client, &entry, &range).await.map_err(|e| e.to_string())?;
    if resp.status() != reqwest::StatusCode::FORBIDDEN {
        return Ok(resp);
    }
    if entry
        .last_reresolve
        .is_some_and(|t| now_s() - t < RERESOLVE_MIN_GAP_S)
    {
        eprintln!(
            "[proxy] {} {range} upstream 403 again within {RERESOLVE_MIN_GAP_S}s of a re-resolve; not retrying",
            short(token)
        );
        return Ok(resp);
    }
    eprintln!("[proxy] {} {range} upstream 403, re-resolving {}", short(token), entry.video_id);
    let track = resolve::resolve(&entry.video_id)
        .await
        .map_err(|e| format!("upstream expired and re-resolve failed: {e}"))?;
    if let Some(e) = st.tokens.write().await.get_mut(token) {
        e.upstream_url = track.upstream_url;
        e.headers = track.headers;
        e.available_at = track.available_at;
        e.size = track.size_bytes.or(e.size);
        e.last_reresolve = Some(now_s());
        entry = e.clone();
    }
    fetch_when_available(&st.client, &entry, &range).await.map_err(|e| e.to_string())
}

/// Fetch once the URL should be valid. `available_at` is not exact: a request
/// just after it can still 403, so near that boundary retry once after a pause
/// instead of treating the URL as expired.
async fn fetch_when_available(
    client: &reqwest::Client,
    entry: &StreamEntry,
    range: &str,
) -> reqwest::Result<reqwest::Response> {
    wait_available(entry).await;
    let resp = fetch(client, entry, range).await?;
    let near_boundary = entry
        .available_at
        .is_some_and(|at| now_s() < at + AVAILABILITY_GRACE_S);
    if resp.status() == reqwest::StatusCode::FORBIDDEN && near_boundary {
        eprintln!("[proxy] {} 403 just after available_at; retrying in 3s", entry.video_id);
        tokio::time::sleep(Duration::from_secs(3)).await;
        return fetch(client, entry, range).await;
    }
    Ok(resp)
}

async fn wait_available(entry: &StreamEntry) {
    if let Some(at) = entry.available_at {
        // +1 s margin: requests right at the boundary still 403.
        let wait = (at + 1 - now_s()).min(MAX_AVAILABILITY_WAIT_S);
        if wait > 0 {
            eprintln!("[proxy] waiting {wait}s for {} to become available", entry.video_id);
            tokio::time::sleep(Duration::from_secs(wait as u64)).await;
        }
    }
}

async fn stream_handler(
    State(st): State<Arc<ProxyState>>,
    Path(token): Path<String>,
    method: Method,
    req_headers: HeaderMap,
) -> Response {
    serve(st, token, method, req_headers).await
}

/// `/v/{video_id}`: like `/stream/{token}`, but resolves the video with yt-dlp
/// on its first request, so a playlist can hold many tracks without resolving
/// any of them up front.
async fn video_handler(
    State(st): State<Arc<ProxyState>>,
    Path(video_id): Path<String>,
    method: Method,
    req_headers: HeaderMap,
) -> Response {
    if method == Method::OPTIONS {
        return serve(st, video_id, method, req_headers).await;
    }
    if !resolve::is_valid_video_id(&video_id) {
        return simple(StatusCode::NOT_FOUND, "invalid video id");
    }
    match st.token_for_video(&video_id).await {
        Ok(token) => serve(st, token, method, req_headers).await,
        Err(e) => {
            eprintln!("[proxy] {method} /v/{video_id} -> 502 resolve failed: {e}");
            simple(StatusCode::BAD_GATEWAY, "could not resolve video")
        }
    }
}

async fn serve(st: Arc<ProxyState>, token: String, method: Method, req_headers: HeaderMap) -> Response {
    if method == Method::OPTIONS {
        let mut r = simple(StatusCode::NO_CONTENT, "");
        let h = r.headers_mut();
        h.remove(header::CONTENT_TYPE);
        h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, HEAD, OPTIONS"));
        let allow = req_headers
            .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
            .cloned()
            .unwrap_or_else(|| HeaderValue::from_static("Range"));
        h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, allow);
        h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
        eprintln!("[proxy] OPTIONS {} -> 204 (preflight)", short(&token));
        return r;
    }
    if method != Method::GET && method != Method::HEAD {
        return simple(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }

    let Some(entry) = st.entry(&token).await else {
        eprintln!("[proxy] {method} {} -> 404 unknown token", short(&token));
        return simple(StatusCode::NOT_FOUND, "unknown stream token");
    };

    let client_range = req_headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let range_label = client_range.as_deref().unwrap_or("none").to_string();
    let tok = short(&token).to_string();

    let passthrough = |status: reqwest::StatusCode| {
        let s = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let mut r = Response::new(Body::empty());
        *r.status_mut() = s;
        r.headers_mut().insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        cors(r.headers_mut());
        r
    };

    // Total size: from yt-dlp, else learned with a 1-byte probe.
    let total = match entry.size {
        Some(t) => t,
        None => match upstream_get(&st, &token, 0, 0).await {
            Ok(r) if r.status().is_success() => match total_from_content_range(r.headers()) {
                Some(t) => {
                    if let Some(e) = st.tokens.write().await.get_mut(&token) {
                        e.size = Some(t);
                    }
                    t
                }
                None => {
                    eprintln!("[proxy] {method} {tok} range={range_label} -> size probe had no Content-Range");
                    return simple(StatusCode::BAD_GATEWAY, "upstream did not report a size");
                }
            },
            Ok(r) => {
                eprintln!("[proxy] {method} {tok} range={range_label} -> size probe upstream {}", r.status().as_u16());
                return passthrough(r.status());
            }
            Err(e) => {
                eprintln!("[proxy] {method} {tok} range={range_label} -> upstream error: {e}");
                return simple(StatusCode::BAD_GATEWAY, "upstream request failed");
            }
        },
    };

    let (start, end, partial) = match parse_range(client_range.as_deref(), total) {
        Ok(Some((s, e))) => (s, e, true),
        Ok(None) if total > 0 => (0, total - 1, false),
        _ => {
            eprintln!("[proxy] {method} {tok} range={range_label} -> client 416 (total {total})");
            let mut r = simple(StatusCode::RANGE_NOT_SATISFIABLE, "range not satisfiable");
            if let Ok(v) = HeaderValue::from_str(&format!("bytes */{total}")) {
                r.headers_mut().insert(header::CONTENT_RANGE, v);
            }
            return r;
        }
    };

    // First upstream chunk before we commit to a status line.
    let is_head = method == Method::HEAD;
    let first_end = if is_head { start } else { end.min(start + CHUNK - 1) };
    let first = match upstream_get(&st, &token, start, first_end).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[proxy] {method} {tok} range={range_label} -> upstream error: {e}");
            return simple(StatusCode::BAD_GATEWAY, "upstream request failed");
        }
    };
    if !first.status().is_success() {
        eprintln!(
            "[proxy] {method} {tok} range={range_label} -> upstream {} -> client {}",
            first.status().as_u16(),
            first.status().as_u16()
        );
        return passthrough(first.status());
    }
    let content_type = first
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok())
        .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"));

    let status = if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
    eprintln!(
        "[proxy] {method} {tok} range={range_label} -> upstream {} -> client {} (bytes {start}-{end}/{total})",
        first.status().as_u16(),
        status.as_u16()
    );

    let body = if is_head {
        Body::empty()
    } else {
        let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(8);
        let st2 = st.clone();
        let token2 = token.clone();
        tokio::spawn(async move {
            let mut resp = first;
            let mut pos = start;
            loop {
                let chunk_end = end.min(pos + CHUNK - 1);
                let mut got = 0u64;
                loop {
                    match resp.chunk().await {
                        Ok(Some(b)) => {
                            got += b.len() as u64;
                            if tx.send(Ok(b)).await.is_err() {
                                return; // client went away (seek/stop)
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            eprintln!("[proxy] {} body error at {}: {e}", short(&token2), pos + got);
                            let _ = tx.send(Err(std::io::Error::other(e))).await;
                            return;
                        }
                    }
                }
                if got != chunk_end - pos + 1 {
                    eprintln!(
                        "[proxy] {} short upstream chunk {pos}-{chunk_end}: got {got} bytes",
                        short(&token2)
                    );
                    let _ = tx.send(Err(std::io::Error::other("short upstream chunk"))).await;
                    return;
                }
                pos = chunk_end + 1;
                if pos > end {
                    return;
                }
                let next_end = end.min(pos + CHUNK - 1);
                resp = match upstream_get(&st2, &token2, pos, next_end).await {
                    Ok(r) if r.status().is_success() => r,
                    Ok(r) => {
                        eprintln!(
                            "[proxy] {} chunk {pos}-{next_end} upstream {}",
                            short(&token2),
                            r.status().as_u16()
                        );
                        let _ = tx.send(Err(std::io::Error::other("upstream chunk failed"))).await;
                        return;
                    }
                    Err(e) => {
                        eprintln!("[proxy] {} chunk {pos}-{next_end} error: {e}", short(&token2));
                        let _ = tx.send(Err(std::io::Error::other(e))).await;
                        return;
                    }
                };
            }
        });
        Body::from_stream(ReceiverStream::new(rx))
    };

    let mut r = Response::new(body);
    *r.status_mut() = status;
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, content_type);
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(end - start + 1));
    if partial {
        if let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")) {
            h.insert(header::CONTENT_RANGE, v);
        }
    }
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    cors(h);
    r
}

async fn fetch(
    client: &reqwest::Client,
    entry: &StreamEntry,
    range: &str,
) -> reqwest::Result<reqwest::Response> {
    let mut req = client.get(&entry.upstream_url);
    for (k, v) in &entry.headers {
        if let (Ok(k), Ok(v)) = (HeaderName::try_from(k.as_str()), HeaderValue::from_str(v)) {
            req = req.header(k, v);
        }
    }
    req.header(header::RANGE, range).send().await
}
