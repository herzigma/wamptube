//! Resolves a YouTube video id to a direct audio stream URL using yt-dlp.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio::process::Command;

const YTDLP_TIMEOUT: Duration = Duration::from_secs(20);
const FORMAT: &str = "bestaudio[ext=m4a]/bestaudio";
const FALLBACK_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
const DEFAULT_TTL_S: i64 = 6 * 60 * 60;

/// Everything we learned about one video's chosen audio format.
#[derive(Debug, Clone)]
pub struct ResolvedTrack {
    pub video_id: String,
    pub upstream_url: String,
    /// Headers yt-dlp says to send with requests for this format.
    pub headers: Vec<(String, String)>,
    pub title: String,
    pub channel: Option<String>,
    pub codec: String,
    pub bitrate_kbps: Option<u32>,
    pub sample_rate_hz: Option<u32>,
    pub duration_s: u32,
    pub expires_at: i64,
    /// Exact size of the audio stream, when yt-dlp reports it.
    pub size_bytes: Option<u64>,
    /// Unix time before which the stream URL answers 403 (newer yt-dlp).
    pub available_at: Option<i64>,
}

/// `^[A-Za-z0-9_-]{11}$`
pub fn is_valid_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// `WAMPTUBE_YTDLP` (a path) overrides the search, e.g. to try a newer build.
fn find_ytdlp() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("WAMPTUBE_YTDLP").map(PathBuf::from) {
        if is_executable(&p) {
            return Some(p);
        }
    }
    let path_dirs = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    path_dirs
        .into_iter()
        .chain(FALLBACK_DIRS.iter().map(PathBuf::from))
        .map(|d| d.join("yt-dlp"))
        .find(|p| is_executable(p))
}

/// PATH for the child: the inherited PATH plus the Homebrew dirs, so yt-dlp
/// can find a JS runtime (deno) even when launched from a GUI app.
fn child_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for d in FALLBACK_DIRS.iter().chain(["/usr/bin", "/bin"].iter()) {
        let d = PathBuf::from(d);
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

fn last_stderr_line(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines
        .iter()
        .rev()
        .find(|l| l.starts_with("ERROR"))
        .or_else(|| lines.last())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "(no output on stderr)".into())
}

pub fn now_s() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn parse_expire(url: &str) -> Option<i64> {
    let u = reqwest::Url::parse(url).ok()?;
    let v = u.query_pairs().find(|(k, _)| k == "expire")?.1;
    v.parse::<i64>().ok()
}

fn as_u32(v: Option<&Value>) -> Option<u32> {
    v.and_then(Value::as_f64)
        .filter(|f| f.is_finite() && *f >= 0.0)
        .map(|f| f.round() as u32)
}

fn as_string(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Parse yt-dlp's `-j` output into a track.
pub fn parse_ytdlp_json(video_id: &str, json: &str) -> Result<ResolvedTrack, String> {
    let root: Value = serde_json::from_str(json.trim())
        .map_err(|e| format!("Unparseable yt-dlp output: {e}"))?;

    // With a single-format selector the chosen format's fields are top-level.
    // If yt-dlp ever returns a merged selection, take its audio-only part.
    let fmt: &Value = match root.get("requested_formats").and_then(Value::as_array) {
        Some(list) if root.get("url").is_none() => list
            .iter()
            .find(|f| {
                f.get("vcodec").and_then(Value::as_str) == Some("none") && f.get("url").is_some()
            })
            .ok_or("Unparseable yt-dlp output: no audio-only format among requested_formats")?,
        _ => &root,
    };

    let upstream_url = as_string(fmt.get("url"))
        .ok_or("Unparseable yt-dlp output: chosen format has no url")?;
    let headers = fmt
        .get("http_headers")
        .or_else(|| root.get("http_headers"))
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default();

    let title = as_string(root.get("title")).unwrap_or_else(|| video_id.to_string());
    let channel = as_string(root.get("channel")).or_else(|| as_string(root.get("uploader")));
    let codec = as_string(fmt.get("acodec"))
        .filter(|c| c != "none")
        .unwrap_or_else(|| "unknown".into());
    let expires_at = parse_expire(&upstream_url).unwrap_or_else(|| now_s() + DEFAULT_TTL_S);

    Ok(ResolvedTrack {
        video_id: video_id.to_string(),
        upstream_url,
        headers,
        title,
        channel,
        codec,
        bitrate_kbps: as_u32(fmt.get("abr")),
        sample_rate_hz: as_u32(fmt.get("asr")),
        duration_s: as_u32(root.get("duration")).unwrap_or(0),
        expires_at,
        size_bytes: fmt.get("filesize").and_then(Value::as_u64),
        available_at: fmt
            .get("available_at")
            .or_else(|| root.get("available_at"))
            .and_then(Value::as_i64),
    })
}

/// Run yt-dlp for `video_id` (validated here) with a hard timeout.
pub async fn resolve(video_id: &str) -> Result<ResolvedTrack, String> {
    if !is_valid_video_id(video_id) {
        return Err(format!("Invalid video id: {video_id:?} (expected 11 chars of A-Z a-z 0-9 _ -)"));
    }
    let ytdlp = find_ytdlp().ok_or_else(|| {
        "yt-dlp not found (looked on PATH, /opt/homebrew/bin, /usr/local/bin). Install it with `brew install yt-dlp`.".to_string()
    })?;

    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let child = Command::new(&ytdlp)
        .args(["-j", "--no-playlist", "--no-update", "-f", FORMAT, &url])
        .env("PATH", child_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("yt-dlp not found or not runnable at {}: {e}", ytdlp.display()))?;

    // On timeout the future (and the Child it owns) is dropped; kill_on_drop
    // sends SIGKILL to the process.
    let out = match tokio::time::timeout(YTDLP_TIMEOUT, child.wait_with_output()).await {
        Err(_) => {
            return Err(format!(
                "yt-dlp timed out after {}s resolving {video_id}",
                YTDLP_TIMEOUT.as_secs()
            ))
        }
        Ok(Err(e)) => return Err(format!("yt-dlp failed to run: {e}")),
        Ok(Ok(o)) => o,
    };

    let stderr = String::from_utf8_lossy(&out.stderr);
    for line in stderr.lines().filter(|l| !l.trim().is_empty()) {
        eprintln!("[yt-dlp] {line}");
    }
    if !out.status.success() {
        return Err(format!(
            "Video unavailable or extraction failed: {}",
            last_stderr_line(&stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    parse_ytdlp_json(video_id, &stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ids() {
        assert!(is_valid_video_id("u1MqeDGBo94"));
        assert!(is_valid_video_id("a-b_c-d_e-f"));
        assert!(!is_valid_video_id("u1MqeDGBo9"));
        assert!(!is_valid_video_id("u1MqeDGBo94x"));
        assert!(!is_valid_video_id("u1MqeDG;o94"));
        assert!(!is_valid_video_id("u1MqeDG o94"));
        assert!(!is_valid_video_id("u1MqeDGBo9é"));
    }

    #[test]
    fn parses_minimal_json() {
        let j = r#"{"title":"T","uploader":"U","acodec":"mp4a.40.2","abr":129.478,"asr":44100,
            "duration":1197,"url":"https://x.googlevideo.com/videoplayback?expire=1794742059&a=b",
            "http_headers":{"User-Agent":"UA"}}"#;
        let t = parse_ytdlp_json("u1MqeDGBo94", j).unwrap();
        assert_eq!(t.channel.as_deref(), Some("U"));
        assert_eq!(t.bitrate_kbps, Some(129));
        assert_eq!(t.sample_rate_hz, Some(44100));
        assert_eq!(t.expires_at, 1794742059);
        assert_eq!(t.headers, vec![("User-Agent".into(), "UA".into())]);
        assert!(parse_ytdlp_json("x", "WARNING nope").unwrap_err().starts_with("Unparseable"));
    }
}
