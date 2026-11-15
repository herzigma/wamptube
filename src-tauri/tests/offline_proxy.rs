//! Offline proxy test against a local fake upstream that implements Range
//! like googlevideo (206 + Content-Range; 403 for a "bad" path).

use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use wamptube_lib::{proxy, resolve::ResolvedTrack};

const TOTAL: usize = 5_000_000;

fn data() -> Vec<u8> {
    (0..TOTAL).map(|i| (i % 251) as u8).collect()
}

async fn upstream(headers: HeaderMap) -> axum::response::Response {
    assert_eq!(headers.get("x-yt").unwrap(), "1", "yt-dlp http_headers must be forwarded");
    let d = data();
    let Some(r) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) else {
        return (StatusCode::OK, d).into_response();
    };
    let spec = r.strip_prefix("bytes=").unwrap();
    let (a, b) = spec.split_once('-').unwrap();
    let a: usize = a.parse().unwrap();
    let b: usize = if b.is_empty() { TOTAL - 1 } else { b.parse::<usize>().unwrap().min(TOTAL - 1) };
    if a >= TOTAL {
        return (StatusCode::RANGE_NOT_SATISFIABLE, [(header::CONTENT_RANGE, format!("bytes */{TOTAL}"))]).into_response();
    }
    (
        StatusCode::PARTIAL_CONTENT,
        [
            (header::CONTENT_TYPE, "audio/mp4".to_string()),
            (header::CONTENT_RANGE, format!("bytes {a}-{b}/{TOTAL}")),
        ],
        d[a..=b].to_vec(),
    )
        .into_response()
}

#[tokio::test]
async fn ranges_cors_and_status_passthrough() {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up_port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        let app = Router::new()
            .route("/videoplayback", get(upstream))
            .route("/gone", get(|| async { StatusCode::NOT_FOUND }));
        axum::serve(l, app).await.unwrap();
    });

    let px = proxy::start().await.unwrap();
    let track = ResolvedTrack {
        video_id: "u1MqeDGBo94".into(),
        upstream_url: format!("http://127.0.0.1:{up_port}/videoplayback?expire=1"),
        headers: vec![("X-Yt".into(), "1".into())],
        title: "t".into(),
        channel: None,
        codec: "mp4a.40.2".into(),
        bitrate_kbps: None,
        sample_rate_hz: None,
        duration_s: 0,
        expires_at: 0,
        size_bytes: None,
        available_at: None,
    };
    let url = px.register(&track).await;
    let c = reqwest::Client::new();
    let d = data();

    let r = c.get(&url).header("Range", "bytes=0-1023").send().await.unwrap();
    assert_eq!(r.status(), 206);
    let h = r.headers().clone();
    assert_eq!(h["content-range"], format!("bytes 0-1023/{TOTAL}"));
    assert_eq!(h["content-length"], "1024");
    assert_eq!(h["content-type"], "audio/mp4");
    assert_eq!(h["accept-ranges"], "bytes");
    assert_eq!(h["access-control-allow-origin"], "*");
    assert_eq!(h["access-control-expose-headers"], "Content-Length, Content-Range, Accept-Ranges");
    assert_eq!(r.bytes().await.unwrap(), d[..1024]);

    let s = TOTAL * 9 / 10;
    let r = c.get(&url).header("Range", format!("bytes={s}-")).send().await.unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(r.headers()["content-range"], format!("bytes {s}-{}/{TOTAL}", TOTAL - 1));
    assert_eq!(r.bytes().await.unwrap(), d[s..]);

    // No client Range -> proxy sends bytes=0- upstream, client sees 200 + full length.
    let r = c.get(&url).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.headers().get("content-range").is_none());
    assert_eq!(r.headers()["content-length"], TOTAL.to_string());
    assert_eq!(r.bytes().await.unwrap().len(), TOTAL);

    let r = c.head(&url).header("Range", "bytes=100-199").send().await.unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(r.headers()["content-range"], format!("bytes 100-199/{TOTAL}"));

    let r = c.get(&url).header("Range", format!("bytes={}-", TOTAL + 10)).send().await.unwrap();
    assert_eq!(r.status(), 416);
    assert_eq!(r.headers()["access-control-allow-origin"], "*");

    let r = c.request(reqwest::Method::OPTIONS, &url).send().await.unwrap();
    assert_eq!(r.status(), 204);
    assert_eq!(r.headers()["access-control-allow-origin"], "*");

    assert_eq!(c.get(px.url_for("deadbeef")).send().await.unwrap().status(), 404);

    // /v/{video_id} serves an already-registered video without running yt-dlp.
    let vurl = px.video_url("u1MqeDGBo94");
    let r = c.get(&vurl).header("Range", "bytes=10-19").send().await.unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(r.headers()["access-control-allow-origin"], "*");
    assert_eq!(r.bytes().await.unwrap(), d[10..20]);
    let r = c.get(format!("http://127.0.0.1:{}/v/bad;id", px.port)).send().await.unwrap();
    assert_eq!(r.status(), 404, "invalid ids never reach yt-dlp");
    let r = c.request(reqwest::Method::OPTIONS, px.video_url("zzzzzzzzzzz")).send().await.unwrap();
    assert_eq!(r.status(), 204, "preflight needs no resolve");

    let token = url.rsplit('/').next().unwrap();
    px.set_upstream(token, format!("http://127.0.0.1:{up_port}/gone"), None).await;
    let r = c.get(&url).header("Range", "bytes=0-1").send().await.unwrap();
    assert_eq!(r.status(), 404, "non-403 upstream errors pass through");
    assert_eq!(r.headers()["access-control-allow-origin"], "*");
}
