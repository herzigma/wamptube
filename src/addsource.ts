/**
 * Adding playlists and videos from the UI: Webamp's playlist ADD > URL button
 * and dropping a YouTube link on the playlist. Both list the source through
 * the Rust core (no stream is resolved until a track plays), and save it to
 * the config file so it loads again on the next launch.
 */
import { invoke } from '@tauri-apps/api/core';

export type TrackInfo = {
  video_id: string;
  title: string;
  channel: string | null;
  duration_s: number;
  stream_url: string;
};

export type ListedSource = { source: string; tracks: TrackInfo[] };

export type WebampTrack = {
  metaData: { artist: string; title: string };
  url: string;
  /** Always set: without it Webamp fetches the URL to measure it, which would resolve every track. */
  duration: number;
};

export function toWebampTrack(t: TrackInfo): WebampTrack {
  return {
    metaData: { artist: t.channel ?? '', title: t.title },
    url: t.stream_url,
    duration: t.duration_s,
  };
}

export async function listSource(source: string): Promise<ListedSource> {
  // async wrapper so a synchronous throw (no Tauri) becomes a rejection
  return await invoke<ListedSource>('list_source', { source });
}

type Notify = (text: string, err?: boolean) => void;

/** List `source`, save it to the config, and return Webamp tracks (null on failure). */
async function addSource(source: string, notify: Notify): Promise<WebampTrack[] | null> {
  notify(`listing ${source}…`);
  try {
    const listed = await listSource(source);
    const added = await invoke<boolean>('save_source', { source: listed.source }).catch((e) => {
      notify(`could not save to config: ${e}`, true);
      return null;
    });
    if (added !== null) {
      notify(`${listed.tracks.length} tracks${added ? ', saved to config' : ' (already in config)'}`);
    }
    return listed.tracks.map(toWebampTrack);
  } catch (e) {
    console.error('[add source]', source, e);
    notify(String(e), true);
    return null;
  }
}

/** A small text box over the player; resolves to the entered text, or null on Escape / Cancel. */
function askForUrl(): Promise<string | null> {
  return new Promise((done) => {
    const form = document.createElement('form');
    form.id = 'add-url';
    const label = document.createElement('label');
    label.textContent = 'YouTube playlist or video URL';
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = 'https://www.youtube.com/playlist?list=…';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.textContent = 'Add';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const row = document.createElement('div');
    row.append(input, ok, cancel);
    label.htmlFor = input.id = 'add-url-input';
    form.append(label, row);

    const finish = (v: string | null) => {
      form.remove();
      done(v && v.trim() ? v.trim() : null);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(input.value);
    });
    cancel.addEventListener('click', () => finish(null));
    // keep Webamp's hotkeys (enableHotkeys) from seeing keystrokes typed here
    form.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish(null);
    });
    document.body.append(form);
    input.focus();
  });
}

export function handleAddUrlEvent(notify: Notify) {
  return async (): Promise<WebampTrack[] | null> => {
    const url = await askForUrl();
    return url ? addSource(url, notify) : null;
  };
}

/** Dropped links: text/uri-list or plain text. Anything else falls through to Webamp (files). */
export function handleTrackDropEvent(notify: Notify) {
  return async (e: { dataTransfer: DataTransfer }): Promise<WebampTrack[] | null> => {
    const dt = e.dataTransfer;
    const text = (dt.getData('text/uri-list') || dt.getData('text/plain') || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (!text || !/youtu\.?be/i.test(text)) return null;
    return addSource(text, notify);
  };
}
