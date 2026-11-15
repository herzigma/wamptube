pub mod proxy;
pub mod resolve;

use std::sync::Arc;

use serde::Serialize;
use tauri::Manager;

/// Returned to the front end. Keys are snake_case and fixed by contract.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedAudio {
    pub proxy_url: String,
    pub title: String,
    pub channel: Option<String>,
    pub codec: String,
    pub bitrate_kbps: Option<u32>,
    pub sample_rate_hz: Option<u32>,
    pub duration_s: u32,
    pub expires_at: i64,
}

/// Resolve a video and register it with the proxy (usable without Tauri).
pub async fn resolve_and_register(
    proxy: &proxy::ProxyState,
    video_id: &str,
) -> Result<ResolvedAudio, String> {
    let t = resolve::resolve(video_id).await?;
    let proxy_url = proxy.register(&t).await;
    eprintln!(
        "[resolve] {video_id} -> {} | {} {:?}kbps {:?}Hz {}s | {proxy_url}",
        t.title, t.codec, t.bitrate_kbps, t.sample_rate_hz, t.duration_s
    );
    Ok(ResolvedAudio {
        proxy_url,
        title: t.title,
        channel: t.channel,
        codec: t.codec,
        bitrate_kbps: t.bitrate_kbps,
        sample_rate_hz: t.sample_rate_hz,
        duration_s: t.duration_s,
        expires_at: t.expires_at,
    })
}

#[tauri::command]
async fn resolve_audio(
    video_id: String,
    proxy: tauri::State<'_, Arc<proxy::ProxyState>>,
) -> Result<ResolvedAudio, String> {
    resolve_and_register(&proxy, &video_id).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let proxy = tauri::async_runtime::block_on(proxy::start())?;
            app.manage(proxy);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![resolve_audio])
        .run(tauri::generate_context!())
        .expect("error while running wamptube");
}
