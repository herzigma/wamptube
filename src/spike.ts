/// <reference types="vite/client" />
// THROWAWAY SPIKE: play a video's H.264 video-only and AAC audio-only DASH
// streams through ONE <video> element with Media Source Extensions, fed from
// the loopback proxy. Question: does WKWebView accept it, and are duration,
// seeks and A/V decoding sane?
import { invoke } from '@tauri-apps/api/core';

const VIDEO_ID = new URLSearchParams(location.search).get('id') ?? 'Hf20ZzMRs-I';
const AHEAD_S = 30;
const logEl = document.getElementById('log')!;
const v = document.getElementById('v') as HTMLVideoElement;

function log(...a: unknown[]) {
  const line = '[mse] ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.warn(line); // warn/error are forwarded to the tauri dev terminal
  logEl.textContent += line + '\n';
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- MP4 box parsing -------------------------------------------------------
interface Seg { start: number; end: number; t0: number; t1: number } // byte range [start,end), seconds
interface Track { name: string; url: string; mime: string; init: Uint8Array; segs: Seg[]; duration: number }

const u32 = (d: DataView, o: number) => d.getUint32(o);
const u64 = (d: DataView, o: number) => Number(d.getBigUint64(o));
const fourcc = (d: DataView, o: number) => String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));

async function fetchRange(url: string, a: number, b: number): Promise<Uint8Array> {
  const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` } });
  if (!r.ok && r.status !== 206) throw new Error(`${url} ${a}-${b}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function loadTrack(name: string, url: string, kind: 'audio' | 'video'): Promise<Track> {
  const head = await fetchRange(url, 0, 128 * 1024 - 1);
  const d = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let o = 0, sidxAt = -1;
  while (o + 8 <= head.length) {
    let size = u32(d, o); const type = fourcc(d, o + 4);
    if (size === 1) size = u64(d, o + 8);
    if (type === 'sidx') { sidxAt = o; break; }
    if (size < 8) break;
    o += size;
  }
  if (sidxAt < 0) throw new Error(`${name}: no sidx in first 128 KiB (boxes ended at ${o})`);
  const init = head.slice(0, sidxAt);

  const ver = d.getUint8(sidxAt + 8);
  let p = sidxAt + 12 + 4; // box header(8)+version/flags(4) -> reference_ID(4)
  const timescale = u32(d, p); p += 4;
  let ept: number, firstOffset: number;
  if (ver === 0) { ept = u32(d, p); firstOffset = u32(d, p + 4); p += 8; }
  else { ept = u64(d, p); firstOffset = u64(d, p + 8); p += 16; }
  p += 2; // reserved
  const count = d.getUint16(p); p += 2;
  const sidxSize = u32(d, sidxAt);
  let byte = sidxAt + sidxSize + firstOffset, t = ept;
  const segs: Seg[] = [];
  for (let i = 0; i < count; i++) {
    const size = u32(d, p) & 0x7fffffff, dur = u32(d, p + 4); p += 12;
    segs.push({ start: byte, end: byte + size, t0: t / timescale, t1: (t + dur) / timescale });
    byte += size; t += dur;
  }

  let codecs: string;
  if (kind === 'video') {
    let at = -1;
    for (let i = 0; i + 8 < init.length; i++) if (init[i] === 0x61 && init[i + 1] === 0x76 && init[i + 2] === 0x63 && init[i + 3] === 0x43) { at = i; break; } // 'avcC'
    if (at < 0) throw new Error('video init has no avcC (not H.264?)');
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    codecs = `avc1.${hex(init[at + 5])}${hex(init[at + 6])}${hex(init[at + 7])}`;
  } else {
    codecs = 'mp4a.40.2';
  }
  const mime = `${kind}/mp4; codecs="${codecs}"`;
  const duration = segs[segs.length - 1].t1;
  log(name, mime, `init=${init.length}B segs=${segs.length} firstSeg=${segs[0].t0.toFixed(2)}s dur=${duration.toFixed(2)}s timescale=${timescale}`);
  return { name, url, mime, init, segs, duration };
}

// ---- MSE feeder -------------------------------------------------------------
class Feeder {
  sb: SourceBuffer;
  done = new Set<number>();
  busy = false;
  constructor(public tr: Track, ms: MediaSource) {
    if (!MediaSource.isTypeSupported(tr.mime)) throw new Error(`MSE does not support ${tr.mime}`);
    this.sb = ms.addSourceBuffer(tr.mime);
  }
  append(buf: Uint8Array): Promise<void> {
    return new Promise((res, rej) => {
      const ok = () => { this.sb.removeEventListener('error', bad); res(); };
      const bad = () => { this.sb.removeEventListener('updateend', ok); rej(new Error(`${this.tr.name} append error`)); };
      this.sb.addEventListener('updateend', ok, { once: true });
      this.sb.addEventListener('error', bad, { once: true });
      this.sb.appendBuffer(buf as Uint8Array<ArrayBuffer>);
    });
  }
  async start() { await this.append(this.tr.init); }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = v.currentTime, segs = this.tr.segs;
      for (let i = Math.max(0, segs.findIndex((s) => s.t1 > now)); i < segs.length && segs[i].t0 < now + AHEAD_S; i++) {
        if (this.done.has(i)) continue;
        const s = segs[i];
        const t0 = performance.now();
        const bytes = await fetchRange(this.tr.url, s.start, s.end - 1);
        await this.append(bytes);
        this.done.add(i);
        if (i % 10 === 0 || i < 2) log(this.tr.name, `seg ${i} ${s.t0.toFixed(1)}s ${bytes.length}B ${(performance.now() - t0).toFixed(0)}ms`);
        if (v.currentTime !== now && Math.abs(v.currentTime - now) > 2) break; // user seeked: restart from new position
      }
    } finally { this.busy = false; }
  }
}

function ranges(el: HTMLMediaElement) {
  const r: string[] = [];
  for (let i = 0; i < el.buffered.length; i++) r.push(`${el.buffered.start(i).toFixed(1)}-${el.buffered.end(i).toFixed(1)}`);
  return r.join(' ');
}
function snap(label: string) {
  const q = v.getVideoPlaybackQuality?.();
  const w = v as unknown as Record<string, number>;
  log(label, {
    t: +v.currentTime.toFixed(2), dur: +v.duration.toFixed(2), paused: v.paused, rs: v.readyState,
    size: `${v.videoWidth}x${v.videoHeight}`, buf: ranges(v),
    frames: q?.totalVideoFrames, dropped: q?.droppedVideoFrames,
    aBytes: w.webkitAudioDecodedByteCount, vBytes: w.webkitVideoDecodedByteCount,
    err: v.error?.message,
  });
}
async function waitFor(pred: () => boolean, ms: number, what: string) {
  const t0 = performance.now();
  while (!pred()) { if (performance.now() - t0 > ms) { log('TIMEOUT waiting for', what); snap('state'); return false; } await sleep(100); }
  return true;
}

async function main() {
  const base = await invoke<string>('proxy_base');
  log('proxy', base, 'video', VIDEO_ID);
  const [audio, video] = await Promise.all([
    loadTrack('audio', `${base}/v/${VIDEO_ID}`, 'audio'),
    loadTrack('video', `${base}/vv/${VIDEO_ID}`, 'video'),
  ]);

  const ms = new MediaSource();
  v.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  const feeders = [new Feeder(audio, ms), new Feeder(video, ms)];
  await Promise.all(feeders.map((f) => f.start()));
  ms.duration = Math.max(audio.duration, video.duration);
  log('MediaSource duration set to', ms.duration.toFixed(2));

  const pumpAll = () => { for (const f of feeders) f.pump().catch((e) => log('PUMP ERROR', String(e))); };
  v.addEventListener('seeking', pumpAll);
  setInterval(pumpAll, 500);
  v.addEventListener('error', () => log('ELEMENT ERROR', v.error?.code, v.error?.message));
  pumpAll();

  // ---- scripted check ----
  await waitFor(() => v.readyState >= 3, 30000, 'readyState>=3');
  snap('ready');
  v.muted = true; // allow autoplay without a gesture; decoded byte counts still show audio is decoded
  await v.play().catch((e) => log('play() rejected', String(e)));
  await sleep(5000); snap('after 5s of play');

  const d = v.duration;
  for (const target of [60, d * 0.8, 5]) {
    log('seek ->', target.toFixed(1));
    v.currentTime = target;
    await waitFor(() => !v.seeking && v.readyState >= 3, 20000, 'seek landing');
    snap('seek landed');
    await sleep(4000); snap('4s after seek');
  }
  v.pause(); await sleep(1000); const tp = v.currentTime; await sleep(1500);
  log('pause holds position:', Math.abs(v.currentTime - tp) < 0.05);
  await v.play(); await sleep(3000); snap('resumed');
  log('DONE');
}
main().catch((e) => log('FATAL', String(e?.message ?? e)));
