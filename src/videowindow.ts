// The video pane's window chrome. It is drawn inside Webamp's own #webamp root
// (so it scales with everything else) from the skin's "gen window" classes, the
// frame Winamp skins define for extra windows (GEN.BMP): corners, bottom edge,
// close button and title lettering all come from the active skin.

/** 1x pixel sizes: gen borders are 11 and 8 wide, the title bar 20 tall, the bottom edge 14. */
const CHROME_W = 11 + 8, CHROME_H = 20 + 14;
const MIN_FRAME_H = 116;
/** Frame widths the grip can set (1x px). The default gives a full 16:9 picture at the minimum stack height. */
const MIN_FRAME_W = 220, MAX_FRAME_W = 900, DEFAULT_FRAME_W = CHROME_W + 448;
/** Shortest Webamp stack (1x px) that gives the video a full 448x252 picture; the playlist grows to reach it. */
export const VIDEO_STACK_FLOOR = CHROME_H + 252;

let frameWidth = DEFAULT_FRAME_W;
export const getFrameWidth = () => frameWidth;
export function setFrameWidth(w: number) {
  frameWidth = Math.round(Math.min(MAX_FRAME_W, Math.max(MIN_FRAME_W, w)));
}

/**
 * Frame size for a Webamp stack `stackHeight` tall: as tall as the stack (so the
 * Tauri window has no empty slab under it), at the width the user dragged to;
 * the picture is letterboxed inside whatever shape results.
 */
export function frameSize(stackHeight: number) {
  return { w: frameWidth, h: Math.max(stackHeight, MIN_FRAME_H) };
}

const div = (cls: string, ...kids: HTMLElement[]) => {
  const d = document.createElement('div');
  d.className = cls;
  d.append(...kids);
  return d;
};

let frame: HTMLElement | undefined;
let host: HTMLElement | undefined;
let resizeCb: (dxPx: number, dyPx: number, phase: 'start' | 'move' | 'end') => void = () => {};

/** The bottom-right grip: `dxPx`/`dyPx` are the screen-pixel drag so far. */
export function onVideoResize(cb: typeof resizeCb) {
  resizeCb = cb;
}
let open = true;
let onChange: () => void = () => {};

export const isVideoOpen = () => open;

export function setVideoOpen(v: boolean) {
  open = v;
  if (frame) frame.style.display = v ? 'flex' : 'none';
  host?.classList.toggle('video-active', v);
  onChange();
}
export const toggleVideo = () => setVideoOpen(!open);

/** Build the window around `video` and add it to `host` (Webamp's #webamp). */
export function mountVideoWindow(hostEl: HTMLElement, video: HTMLVideoElement, changed: () => void) {
  host = hostEl;
  onChange = changed;
  const grip = div('video-resize');
  grip.title = 'Resize';
  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY;
    resizeCb(0, 0, 'start');
    const move = (m: MouseEvent) => resizeCb(m.clientX - x0, m.clientY - y0, 'move');
    const up = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      resizeCb(0, 0, 'end');
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  });
  const close = div('');
  close.id = 'video-close';
  close.title = 'Close video (Alt+V)';
  close.addEventListener('click', () => setVideoOpen(false));
  const title = div('gen-top-title');
  for (const ch of 'VIDEO') title.append(div(`gen-text-letter gen-text-${ch.toLowerCase()}`));
  frame = div(
    'gen-window selected video-window',
    div(
      'gen-top video-top',
      div('gen-top-left'),
      div('gen-top-left-fill'),
      div('gen-top-left-end'),
      title,
      div('gen-top-right-end'),
      div('gen-top-right-fill'),
      div('gen-top-right', div('gen-close', close)),
    ),
    div(
      'gen-middle',
      div('gen-middle-left', div('gen-middle-left-bottom')),
      div('gen-middle-center', video),
      div('gen-middle-right', div('gen-middle-right-bottom')),
    ),
    div('gen-bottom', div('gen-bottom-left'), div('gen-bottom-right', grip)),
  );
  frame.style.left = '275px'; // beside the default stack until the first layout
  host.appendChild(frame);
  host.classList.toggle('video-active', open);
  refreshGriplessSprite();
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyV') { e.preventDefault(); toggleVideo(); }
  });
}

/** Put the window `left` 1x pixels from the origin, sized for a stack `stackHeight` tall. */
export function placeVideoWindow(left: number, stackHeight: number) {
  if (!frame) return;
  const { w, h } = frameSize(stackHeight);
  frame.style.left = `${left}px`;
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
}

let gripless: { src: string; url: string } | undefined;

/**
 * While the video window is open its grip is the resize handle, so the playlist's
 * own grip art has to go. The grip is part of the playlist's bottom-right sprite
 * (150x38), so this redraws that sprite with the grip's pixels (x 131..143,
 * y 19..31 in the default skin's layout) blended from the plain rows above and
 * below, column by column, which keeps the sprite's own diagonal shading. The result is handed to
 * the stylesheet as --playlist-bottom-right (see style.css). Cheap to call often.
 */
export function refreshGriplessSprite() {
  const el = host?.querySelector('.playlist-bottom-right') as HTMLElement | null;
  if (!el || !host) return;
  const src = /url\("?([^")]+)"?\)/.exec(getComputedStyle(el).backgroundImage)?.[1];
  if (!src || src === gripless?.src || src === gripless?.url) return;
  const img = new Image();
  img.onload = () => {
    if (img.width !== 150 || img.height !== 38) return; // not the default-skin layout: leave it alone
    const c = document.createElement('canvas');
    c.width = 150;
    c.height = 38;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    // Plain rows bracket the grip (18 above, 32 below); blend between them per column.
    for (let x = 131; x <= 143; x++) {
      const top = g.getImageData(x, 18, 1, 1).data;
      const bottom = g.getImageData(x, 32, 1, 1).data;
      for (let y = 19; y <= 31; y++) {
        const t = (y - 18) / 14;
        g.fillStyle = `rgb(${[0, 1, 2].map((k) => Math.round(top[k] + (bottom[k] - top[k]) * t)).join(',')})`;
        g.fillRect(x, y, 1, 1);
      }
    }
    const url = c.toDataURL('image/png');
    gripless = { src, url };
    host!.style.setProperty('--playlist-bottom-right', `url(${url})`);
    host!.classList.add('grip-patched'); // only now may the stylesheet swap the sprite in
  };
  img.src = src;
}
