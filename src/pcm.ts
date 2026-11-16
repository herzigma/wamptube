// Decoded audio for the visualizers (the big FX pane and Webamp's small one).
//
// WKWebView cannot tap an MSE <video> element's sound: a Web Audio
// MediaElementSource on it reads pure silence (measured; see NOTES.md). So the
// visualizers don't listen to the player at all. The same AAC segments that
// mse.ts feeds to the element are decoded a second time here
// (decodeAudioData on init + one segment works in WKWebView), and readers ask
// for "the sound at the element's current time". Nothing here makes sound.

import type { FxSource } from './fx';

export interface PcmTrack {
  init: Uint8Array<ArrayBuffer>;
  segs: { t0: number; t1: number }[];
  /** Get segment `i`'s bytes again (a proxy request); used when they are no longer kept here. */
  fetch(i: number): Promise<Uint8Array<ArrayBuffer>>;
}

const RATE = 44100;
/** Compressed segments kept (about 160 KB each) and decoded ones (about 1.7 MB each). */
const KEEP_RAW = 6, KEEP_PCM = 3;

let track: PcmTrack | null = null;
let gen = 0;
let active = false;
const raw = new Map<number, Uint8Array<ArrayBuffer>>();
const pcm = new Map<number, Float32Array>();
const decoding = new Set<number>();
let ctx: OfflineAudioContext | undefined;
/** One log line per track, so the terminal shows the visualizers have real audio. */
let logged = false;

/** Drop the entries furthest from segment `near` until at most `keep` are left. */
function trim<T>(m: Map<number, T>, keep: number, near: number) {
  while (m.size > keep) {
    let far = near;
    for (const k of m.keys()) if (Math.abs(k - near) >= Math.abs(far - near)) far = k;
    m.delete(far);
  }
}

/** A new track is loading (or none): forget the old one's audio. */
export function pcmSetTrack(t: PcmTrack | null) {
  track = t;
  gen++;
  raw.clear();
  pcm.clear();
  decoding.clear();
  logged = false;
}

/** mse.ts hands over each audio segment as it appends it, so decoding needs no second download. */
export function pcmOffer(i: number, bytes: Uint8Array<ArrayBuffer>) {
  raw.set(i, bytes);
  trim(raw, KEEP_RAW, i);
}

/** Decoding only happens while something is showing (the FX pane). */
export function pcmSetActive(on: boolean) {
  active = on;
  if (!on) pcm.clear();
}

async function decode(i: number) {
  const t = track;
  if (!t || pcm.has(i) || decoding.has(i) || i < 0 || i >= t.segs.length) return;
  const mine = gen;
  decoding.add(i);
  try {
    const seg = raw.get(i) ?? (await t.fetch(i));
    const file = new Uint8Array(t.init.length + seg.length);
    file.set(t.init);
    file.set(seg, t.init.length);
    ctx ??= new OfflineAudioContext(1, 1, RATE);
    const buf = await ctx.decodeAudioData(file.buffer);
    if (mine !== gen) return;
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let k = 0; k < d.length; k++) mono[k] += d[k] / buf.numberOfChannels;
    }
    if (!logged) {
      logged = true;
      let peak = 0;
      for (let k = 0; k < mono.length; k += 16) peak = Math.max(peak, Math.abs(mono[k]));
      console.warn(`[pcm] segment ${i} decoded: ${(mono.length / RATE).toFixed(2)} s, peak ${peak.toFixed(2)}`);
    }
    pcm.set(i, mono);
    trim(pcm, KEEP_PCM, i);
  } catch (e) {
    if (mine === gen) console.error(`[pcm] decode segment ${i} failed`, String((e as Error)?.message ?? e));
  } finally {
    if (mine === gen) decoding.delete(i);
  }
}

let lastSeg = 0;

/**
 * Fill `out` with the waveform (bytes, 128 = silence, as AnalyserNode gives it)
 * of the samples leading up to time `t`. Silence if that part isn't decoded yet;
 * asking is what starts the decode.
 */
export function pcmWave(t: number, out: Uint8Array) {
  out.fill(128);
  const tr = track;
  if (!tr || !active || t < 0) return;
  const segs = tr.segs;
  let i = lastSeg < segs.length && segs[lastSeg].t0 <= t && t < segs[lastSeg].t1 ? lastSeg : segs.findIndex((s) => t < s.t1);
  if (i < 0) return;
  lastSeg = i;
  if (segs[i].t1 - t < 3) void decode(i + 1); // have the next one ready before the playhead gets there
  const cur = pcm.get(i);
  if (!cur) { void decode(i); return; }
  // The decoder trims a little from the front of each segment, so count back from its end.
  const end = cur.length - Math.round((segs[i].t1 - t) * RATE);
  const prev = pcm.get(i - 1);
  for (let k = 0; k < out.length; k++) {
    const n = end - out.length + k;
    const s = n >= 0 ? (n < cur.length ? cur[n] : 0) : prev ? prev[prev.length + n] ?? 0 : 0;
    out[k] = Math.max(0, Math.min(255, 128 + s * 127));
  }
}

// Spectrum for FX: a plain 1024-point FFT of the waveform, scaled to bytes the
// way AnalyserNode does (-100..-30 dB, smoothed over time).
const N = 1024;
const re = new Float32Array(N), im = new Float32Array(N), smooth = new Float32Array(N / 2);
const win = Float32Array.from({ length: N }, (_, k) => 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / N) + 0.08 * Math.cos((4 * Math.PI * k) / N));
const rev = Uint16Array.from({ length: N }, (_, k) => {
  let r = 0;
  for (let b = 0; b < 10; b++) r |= ((k >> b) & 1) << (9 - b);
  return r;
});

function spectrum(wave: Uint8Array, out: Uint8Array) {
  for (let k = 0; k < N; k++) {
    re[rev[k]] = ((wave[k] - 128) / 128) * win[k];
    im[k] = 0;
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len, half = len >> 1;
    for (let s = 0; s < N; s += len) {
      for (let k = 0; k < half; k++) {
        const c = Math.cos(ang * k), sn = Math.sin(ang * k);
        const a = s + k, b = a + half;
        const xr = re[b] * c - im[b] * sn, xi = re[b] * sn + im[b] * c;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  for (let k = 0; k < out.length && k < N / 2; k++) {
    smooth[k] = smooth[k] * 0.6 + (Math.hypot(re[k], im[k]) / N) * 0.4;
    const db = 20 * Math.log10(smooth[k] + 1e-9);
    out[k] = Math.max(0, Math.min(255, ((db + 100) / 70) * 255));
  }
}

/** The FX pane's audio: what is playing on `el`, or silence while it is paused. */
export function pcmSource(el: HTMLMediaElement): FxSource {
  const time = () => (el.paused ? -1 : el.currentTime);
  return {
    read(wave, freq) {
      pcmWave(time(), wave);
      spectrum(wave, freq);
    },
    setActive: pcmSetActive,
  };
}

/**
 * Stands in for the AnalyserNode Webamp's small visualizer reads. Webamp only
 * ever sets `fftSize` / `smoothingTimeConstant` and calls getByteTimeDomainData
 * (webamp 2.3.1), so that is all this has.
 */
export function pcmAnalyser(el: HTMLMediaElement): AnalyserNode {
  const node = {
    fftSize: 2048,
    smoothingTimeConstant: 0,
    get frequencyBinCount(): number { return node.fftSize / 2; },
    getByteTimeDomainData(out: Uint8Array) { pcmWave(el.paused ? -1 : el.currentTime, out); },
  };
  return node as unknown as AnalyserNode;
}
