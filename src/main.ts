/// <reference types="vite/client" />
import Webamp from 'webamp';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { patchTitleBar } from './titlebar';

/**
 * Whole-UI scale factor (1 or 2). Webamp lays out at 1x (275x348) and #webamp
 * is scaled with a CSS transform (see style.css). The Tauri window size in
 * src-tauri/tauri.conf.json must be 275*UI_SCALE x 348*UI_SCALE.
 */
const UI_SCALE = 2;
document.documentElement.style.setProperty('--ui-scale', String(UI_SCALE));

type ResolvedAudio = {
  proxy_url: string;
  title: string;
  channel: string | null;
  codec: string;
  bitrate_kbps: number | null;
  sample_rate_hz: number | null;
  duration_s: number;
  expires_at: number;
};

const VIDEO_IDS = ['u1MqeDGBo94', 'Hf20ZzMRs-I', 'dkrpqUyiZgA'];

const statusEl = document.getElementById('status')!;
function setStatus(lines: { text: string; err?: boolean }[]) {
  statusEl.replaceChildren(
    ...lines.map((l) => {
      const d = document.createElement('div');
      d.textContent = l.text;
      if (l.err) d.className = 'err';
      return d;
    }),
  );
}

async function resolve(videoId: string): Promise<ResolvedAudio> {
  // async wrapper so a synchronous throw (no Tauri) becomes a rejection
  return await invoke<ResolvedAudio>('resolve_audio', { videoId });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function installDragHandler() {
  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const bar = target.closest('#main-window #title-bar');
      if (!bar) return;
      // leave the menu / minimize / shade / close buttons alone
      if (target.closest('#option, #minimize, #shade, #close')) return;
      e.preventDefault();
      e.stopPropagation();
      getCurrentWindow()
        .startDragging()
        .catch((err) => console.error('startDragging failed', err));
    },
    true,
  );
}

function logAudioErrors() {
  const handler = (e: Event) => {
    const t = e.target;
    if (t instanceof HTMLMediaElement) {
      console.error('[audio error]', t.currentSrc || t.src, t.error?.code, t.error?.message, e);
    }
  };
  // media error events don't bubble; capture on window catches them
  window.addEventListener('error', handler, true);
  window.addEventListener('unhandledrejection', (e) =>
    console.error('[unhandled rejection]', e.reason),
  );
}

async function main() {
  logAudioErrors();
  setStatus([{ text: 'resolving…' }]);

  const results = await Promise.allSettled(VIDEO_IDS.map(resolve));
  const tracks: {
    metaData: { artist: string; title: string };
    url: string;
    duration: number;
  }[] = [];
  const lines: { text: string; err?: boolean }[] = [];

  results.forEach((r, i) => {
    const id = VIDEO_IDS[i];
    if (r.status === 'fulfilled') {
      const a = r.value;
      console.log(
        `[track ${id}] codec=${a.codec} bitrate_kbps=${a.bitrate_kbps} sample_rate_hz=${a.sample_rate_hz} duration_s=${a.duration_s} title=${a.title}`,
      );
      tracks.push({
        metaData: { artist: a.channel ?? '', title: a.title },
        url: a.proxy_url,
        duration: a.duration_s,
      });
    } else {
      const m = errMsg(r.reason);
      console.error(`[resolve failed ${id}]`, r.reason);
      lines.push({ text: `${id}: ${m}`, err: true });
    }
  });
  setStatus(lines);

  const webamp = new Webamp({
    initialTracks: tracks,
    windowLayout: {
      main: { position: { left: 0, top: 0 } },
      equalizer: { position: { left: 0, top: 116 } },
      playlist: { position: { left: 0, top: 232 }, size: { extraHeight: 0, extraWidth: 0 } },
    },
    enableHotkeys: true,
  });

  const inTauri = '__TAURI_INTERNALS__' in window;
  if (inTauri) {
    webamp.onClose(() => {
      getCurrentWindow().close().catch((e) => console.error('close failed', e));
    });
    webamp.onMinimize(() => {
      getCurrentWindow().minimize().catch((e) => console.error('minimize failed', e));
    });
    installDragHandler();
  }

  // attach audio error listeners to Webamp's <audio> element(s) as they appear
  const hook = (el: HTMLMediaElement) => {
    if ((el as any).__wt) return;
    (el as any).__wt = true;
    el.addEventListener('error', () =>
      console.error('[audio element error]', el.currentSrc, el.error?.code, el.error?.message),
    );
    el.addEventListener('stalled', () => console.warn('[audio stalled]', el.currentSrc));
  };
  document.querySelectorAll('audio').forEach(hook);
  new MutationObserver(() => document.querySelectorAll('audio').forEach(hook)).observe(
    document.documentElement,
    { childList: true, subtree: true },
  );
  // Webamp's audio element is created detached; also hook via Audio constructor path
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    hook(this);
    lastAudio = this;
    const p = origPlay.call(this);
    p?.catch?.((e: unknown) => console.error('[audio play() rejected]', this.currentSrc, e));
    return p;
  };

  await webamp.renderWhenReady(document.getElementById('app')!);
  const patched = await patchTitleBar().catch((e) => {
    console.error('[titlebar] patch failed', e);
    return 0;
  });
  if (patched < 6) console.warn(`[titlebar] only ${patched}/6 title sprites patched`);

  if (import.meta.env.VITE_SELFTEST === 'timeline') void timelineProbe(webamp);
  else if (import.meta.env.VITE_SELFTEST) void selfTest(webamp, tracks.length);
}

let lastAudio: HTMLMediaElement | null = null;

/** Diagnostic (VITE_SELFTEST=timeline): seek track 1 to known times and log what the element reports. */
async function timelineProbe(webamp: Webamp) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const rep = (label: string) => {
    const a = lastAudio;
    const b = a ? Array.from({ length: a.buffered.length }, (_, i) => `${a.buffered.start(i).toFixed(0)}-${a.buffered.end(i).toFixed(0)}`).join(',') : '';
    const sk = a && a.seekable.length ? `${a.seekable.start(0).toFixed(0)}-${a.seekable.end(a.seekable.length - 1).toFixed(0)}` : '';
    console.warn(`[timeline] ${label}: t=${a?.currentTime.toFixed(1)} dur=${a?.duration.toFixed(1)} buffered=[${b}] seekable=[${sk}] ended=${a?.ended} paused=${a?.paused} ready=${a?.readyState}`);
  };
  webamp.setVolume(4);
  webamp.setCurrentTrack(1);
  webamp.play();
  await sleep(12000);
  rep('playing');
  for (const t of [663]) {
    console.warn(`[timeline] --- setting currentTime=${t}`);
    if (lastAudio) lastAudio.currentTime = t;
    lastAudio?.addEventListener('ended', () => console.warn(`[timeline] ENDED event at t=${lastAudio?.currentTime.toFixed(1)}`), { once: true });
    await sleep(3000);
    rep(`after ${t} +3s`);
    await sleep(6000);
    rep(`after ${t} +9s`);
  }
  webamp.stop();
  console.warn('[timeline] done');
}

/**
 * Opt-in playback check (run with VITE_SELFTEST=1): plays each track quietly,
 * seeks deep into it, pauses and resumes, and logs the audio element's state
 * so playback can be verified from the dev log without clicking.
 */
async function selfTest(webamp: Webamp, count: number) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const report = (label: string) => {
    const a = lastAudio;
    console.warn(
      `[selftest] ${label}: status=${webamp.getMediaStatus()} t=${a?.currentTime.toFixed(1)} ` +
        `dur=${a?.duration.toFixed(0)} readyState=${a?.readyState} paused=${a?.paused} err=${a?.error?.code ?? 'none'}`,
    );
    return a?.currentTime ?? 0;
  };
  webamp.setVolume(4);
  for (let i = 0; i < count; i++) {
    webamp.setCurrentTrack(i);
    webamp.play();
    await sleep(12000); // includes the wait for a fresh URL to become available
    const t1 = report(`track ${i} after play`);
    await sleep(3000);
    const t2 = report(`track ${i} +3s`);
    console.warn(`[selftest] track ${i} advancing=${t2 > t1 + 2}`);
    const target = Math.floor((lastAudio?.duration || 0) * 0.85);
    webamp.seekToTime(target);
    await sleep(6000);
    const t3 = report(`track ${i} after seek to ${target}s`);
    console.warn(`[selftest] track ${i} deep-seek-ok=${t3 >= target && t3 < target + 12}`);
    webamp.pause();
    await sleep(2000);
    const t4 = report(`track ${i} paused`);
    await sleep(2000);
    console.warn(`[selftest] track ${i} pause-holds=${Math.abs(report(`track ${i} still paused`) - t4) < 0.2}`);
    webamp.play();
    await sleep(3000);
    console.warn(`[selftest] track ${i} resume-ok=${report(`track ${i} resumed`) > t4 + 2}`);
  }
  webamp.stop();
  console.warn('[selftest] done');
}

main().catch((e) => {
  console.error('fatal', e);
  setStatus([{ text: `fatal: ${errMsg(e)}`, err: true }]);
});
