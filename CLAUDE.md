# wamptube

A lightweight macOS desktop audio player for music on regular YouTube videos, with a classic
Winamp 2 interface (Webamp) inside a Tauri 2 shell. Personal-use tool, not distributed.

This repo is at the **prototype milestone**: Webamp in Tauri plays three hardcoded test videos
through a loopback proxy. There is no library, database, tagging, Discover window or enrichment yet.
`NOTES.md` is the record of what the prototype found, including open problems; read it before
changing playback code, and update it when a finding changes.

## Commands

```bash
deno install                      # npm packages from package.json into node_modules
deno task tauri dev               # run the app (Vite on :1420 + cargo run)
deno task build                   # type-check (tsc --noEmit) + front-end production build

cd src-tauri
cargo test                        # offline: unit tests + proxy against a fake upstream
cargo test --test live_proxy -- --ignored --nocapture   # live: real yt-dlp + googlevideo
cargo clippy --all-targets
```

Deno is the only JS runtime; there is no Node. Deno reads `package.json` (scripts run via
`deno task`) and locks with `deno.lock`. The Tauri CLI is the npm-local `@tauri-apps/cli`, run
by `deno task tauri`; there is no global `cargo tauri`. `tauri.conf.json`'s `beforeDevCommand` /
`beforeBuildCommand` call `deno task` too. Add packages with `deno add npm:<name>` (or
`-D` for dev), not npm.

Environment switches:

- `WAMPTUBE_YTDLP=/path/to/yt-dlp` – use a specific yt-dlp build instead of the one on PATH.
- `VITE_SELFTEST=1` – on launch, play each track quietly, deep-seek, pause and resume, logging `[selftest]` lines.
- `VITE_SELFTEST=timeline` – seek track 1 to fixed times and log the audio element's timeline.

In `tauri dev`, the webview's `console.warn` and `console.error` are forwarded to the terminal;
`console.log` is not. Rust logs `[proxy]`, `[resolve]` and `[yt-dlp]` lines to stderr. This is the
way to observe the app without looking at the window.

## Prerequisites

Rust (rustup), and Homebrew `yt-dlp` and `deno`. yt-dlp must be recent: a build a few
months old can resolve URLs that then refuse to play. Deno does double duty: it is the front-end
toolchain, and yt-dlp finds it on PATH at runtime to solve YouTube's JS challenges (in Deno's
sandbox, which is why we don't point yt-dlp at another runtime). ffmpeg is not used.

## Architecture

Two halves. The webview draws the UI and never contacts YouTube; the Rust core owns everything else.

- `src/main.ts` – resolves the hardcoded video ids via the `resolve_audio` command, builds Webamp
  tracks, positions the three Webamp windows with `windowLayout`, wires window dragging /
  close / minimize to Tauri, and holds the self-test code.
- `src/titlebar.ts` – redraws the default skin's title-bar sprites at runtime so they read
  WAMPTUBE instead of WINAMP. Default skin only; it skips with a warning if the sprite layout
  doesn't match.
- `src/style.css` – layout and the UI scale. `UI_SCALE` in `main.ts` drives a `--ui-scale` CSS
  variable applied as `transform: scale()` on `#webamp`.
- `src-tauri/src/resolve.rs` – runs yt-dlp as a child process (no shell, validated id, 20 s
  timeout) and parses its JSON.
- `src-tauri/src/proxy.rs` – axum server on `127.0.0.1:<random port>`. Serves
  `GET|HEAD /stream/{token}` with CORS and Range support so Webamp's Web Audio graph can use it.
- `src-tauri/src/lib.rs` – Tauri setup, starts the proxy, registers the command.

### Contract between the halves

`invoke('resolve_audio', { videoId })` returns, or rejects with a string:

```
{ proxy_url, title, channel, codec, bitrate_kbps, sample_rate_hz, duration_s, expires_at }
```

Keys are snake_case on purpose. Change both sides together.

## Things that are easy to get wrong

- **Window size and scale are coupled by hand.** The Tauri window (`src-tauri/tauri.conf.json`,
  550x696) must equal 275x348 times `UI_SCALE`. `#app` deliberately stays at 1x size because
  Webamp centres its windows in the mount node's unscaled box.
- **Scale with `transform`, not CSS `zoom`.** Webamp's sliders compare `getBoundingClientRect()`
  with the mouse position; `zoom` breaks that in WebKit.
- **The proxy must chunk upstream requests.** googlevideo throttles open-ended or whole-file
  ranges to about 32 KB/s but serves bounded ranges at full speed, so the proxy fills each
  response from sequential 2 MiB upstream requests. Don't simplify it to a pass-through.
- **Fresh stream URLs 403 for a few seconds.** yt-dlp reports `available_at`; the proxy waits for
  it and retries once near the boundary. A 403 outside that window means expired: re-resolve
  once, at most once per token per 30 s.
- **The webview is WKWebView, not Chromium.** A browser check at `localhost:1420` shows layout
  only (resolves fail without Tauri, by design). Verify behaviour in the real app.
- **CSP is explicit** in `tauri.conf.json`. Audio comes from `http://127.0.0.1:*`; skin images are
  `data:` URLs. Milkdrop would need `'unsafe-eval'`, which is not enabled.
- **Known open problem:** WKWebView reports double the real duration for YouTube's DASH m4a.
  See NOTES.md before touching seek or time display.

## Constraints from the spec

- Audio only; never decode or render video. No downloading or exporting audio for offline use.
- No Electron or bundled Chromium. Rust core plus the system webview.
- Do not use the YouTube Data API; extraction goes through yt-dlp only, and nothing writes back
  to YouTube.
- Optional enrichment (Gemini, MusicBrainz) must fail soft; the player works without it.
- Ship Webamp's default skin only. No bundled third-party skins or downloaded art.
- Keep request rates modest: resolve just before playback, don't bulk re-resolve.

## Roadmap

Prototype (here) → Library core (SQLite, tags, playlists) → Import → Enrichment → Discover →
Polish (engine B via mpv if needed, media keys, sidecar bundling, update-yt-dlp action) →
Recommendations. Engine A is Webamp's own audio through the proxy; engine B would be libmpv
behind Webamp's private `__customMediaClass` option, which exists in webamp 2.3.1.
