//! Live network test: resolve a real video with yt-dlp, then fetch through the
//! loopback proxy. Run with:
//!   cargo test --test live_proxy -- --ignored --nocapture

use wamptube_lib::{proxy, resolve_and_register};

const VIDEO: &str = "u1MqeDGBo94";

fn hdr(r: &reqwest::Response, name: &str) -> String {
    r.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

fn token_of(url: &str) -> &str {
    url.rsplit('/').next().unwrap()
}

#[tokio::test]
#[ignore = "hits YouTube; run explicitly"]
async fn resolve_and_proxy_ranges() {
    let px = proxy::start().await.expect("proxy start");
    let t0 = std::time::Instant::now();
    let audio = resolve_and_register(&px, VIDEO).await.expect("resolve");
    println!("resolved in {:?}: {}", t0.elapsed(), serde_json::to_string_pretty(&audio).unwrap());
    assert!(audio.proxy_url.starts_with(&format!("http://127.0.0.1:{}/stream/", px.port)));

    let c = reqwest::Client::new();

    // First KiB.
    let r = c.get(&audio.proxy_url).header("Range", "bytes=0-1023").send().await.unwrap();
    let cr = hdr(&r, "content-range");
    println!("bytes=0-1023 -> {} {cr} len={}", r.status(), hdr(&r, "content-length"));
    assert_eq!(r.status(), 206);
    assert_eq!(hdr(&r, "access-control-allow-origin"), "*");
    assert_eq!(hdr(&r, "accept-ranges"), "bytes");
    assert!(hdr(&r, "access-control-expose-headers").contains("Content-Range"));
    assert!(cr.starts_with("bytes 0-1023/"), "{cr}");
    let total: u64 = cr.rsplit('/').next().unwrap().parse().unwrap();
    let body = r.bytes().await.unwrap();
    assert_eq!(body.len(), 1024);
    assert_eq!(&body[4..8], b"ftyp", "m4a should start with an ftyp box");

    // Bounded range deep into the file (90%).
    let start = total * 9 / 10;
    let end = start + 65_535;
    let r = c.get(&audio.proxy_url).header("Range", format!("bytes={start}-{end}")).send().await.unwrap();
    let cr = hdr(&r, "content-range");
    println!("bytes={start}-{end} -> {} {cr}", r.status());
    assert_eq!(r.status(), 206);
    assert_eq!(cr, format!("bytes {start}-{end}/{total}"));
    assert_eq!(r.bytes().await.unwrap().len(), 65_536);

    // Open-ended range near the end, as a browser seek would send; read it all.
    let start = total - 300_000;
    let t = std::time::Instant::now();
    let r = c.get(&audio.proxy_url).header("Range", format!("bytes={start}-")).send().await.unwrap();
    let cr = hdr(&r, "content-range");
    assert_eq!(r.status(), 206);
    assert_eq!(cr, format!("bytes {start}-{}/{total}", total - 1));
    let n = r.bytes().await.unwrap().len();
    println!("bytes={start}- -> 206 {cr}, read {n} bytes in {:?}", t.elapsed());
    assert_eq!(n as u64, total - start);

    // No Range header: must look like a plain 200 with the full length.
    let r = c.get(&audio.proxy_url).send().await.unwrap();
    println!("no Range -> {} len={} content-range={:?}", r.status(), hdr(&r, "content-length"), hdr(&r, "content-range"));
    assert_eq!(r.status(), 200);
    assert_eq!(hdr(&r, "content-length"), total.to_string());
    drop(r);

    // HEAD.
    let r = c.head(&audio.proxy_url).header("Range", "bytes=0-").send().await.unwrap();
    println!("HEAD bytes=0- -> {} {}", r.status(), hdr(&r, "content-range"));
    assert_eq!(r.status(), 206);
    assert_eq!(hdr(&r, "access-control-allow-origin"), "*");

    // Preflight.
    let r = c
        .request(reqwest::Method::OPTIONS, &audio.proxy_url)
        .header("Origin", "http://localhost:1420")
        .header("Access-Control-Request-Method", "GET")
        .header("Access-Control-Request-Headers", "range")
        .send()
        .await
        .unwrap();
    println!("OPTIONS -> {} allow-headers={}", r.status(), hdr(&r, "access-control-allow-headers"));
    assert_eq!(r.status(), 204);
    assert_eq!(hdr(&r, "access-control-allow-origin"), "*");

    // Unknown token.
    let r = c.get(px.url_for("nope")).send().await.unwrap();
    assert_eq!(r.status(), 404);
    assert_eq!(hdr(&r, "access-control-allow-origin"), "*");

    // Simulated expiry: break the signature so googlevideo returns 403, and
    // check the proxy re-resolves and still serves the range.
    let token = token_of(&audio.proxy_url).to_string();
    let bad = audio_upstream_broken(&px, &token).await;
    println!("corrupted upstream ({bad})");
    let r = c.get(&audio.proxy_url).header("Range", "bytes=1024-2047").send().await.unwrap();
    println!("after corrupt, bytes=1024-2047 -> {} {}", r.status(), hdr(&r, "content-range"));
    assert_eq!(r.status(), 206);
    assert!(hdr(&r, "content-range").starts_with("bytes 1024-2047/"));
}

/// Swap the token's upstream for a URL with a mangled `sig`, which googlevideo rejects with 403.
async fn audio_upstream_broken(px: &proxy::ProxyState, token: &str) -> &'static str {
    let t = wamptube_lib::resolve::resolve(VIDEO).await.unwrap();
    let mut u = reqwest::Url::parse(&t.upstream_url).unwrap();
    let pairs: Vec<(String, String)> = u
        .query_pairs()
        .map(|(k, v)| {
            let v = if k == "sig" || k == "lsig" { format!("X{}", &v[1..]) } else { v.into_owned() };
            (k.into_owned(), v)
        })
        .collect();
    u.query_pairs_mut().clear().extend_pairs(pairs);
    assert!(px.set_upstream(token, u.to_string(), None).await);
    "sig/lsig mangled"
}
