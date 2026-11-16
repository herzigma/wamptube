// The video pane's window chrome. It is drawn inside Webamp's own #webamp root
// (so it scales with everything else) from the skin's "gen window" classes, the
// frame Winamp skins define for extra windows (GEN.BMP): corners, bottom edge,
// close button and title lettering all come from the active skin.

/** 1x pixel sizes: gen borders are 11 and 8 wide, the title bar 20 tall, the bottom edge 14. */
const VIDEO_W = 448, VIDEO_H = 252; // 16:9 picture area at the least height
export const FRAME_W = 11 + VIDEO_W + 8;
export const FRAME_H = 20 + VIDEO_H + 14;

const div = (cls: string, ...kids: HTMLElement[]) => {
  const d = document.createElement('div');
  d.className = cls;
  d.append(...kids);
  return d;
};

let frame: HTMLElement | undefined;
let open = true;
let onChange: () => void = () => {};

export const isVideoOpen = () => open;

export function setVideoOpen(v: boolean) {
  open = v;
  if (frame) frame.style.display = v ? 'flex' : 'none';
  onChange();
}
export const toggleVideo = () => setVideoOpen(!open);

/** Build the window around `video` and add it to `host` (Webamp's #webamp). */
export function mountVideoWindow(host: HTMLElement, video: HTMLVideoElement, changed: () => void) {
  onChange = changed;
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
    div('gen-bottom', div('gen-bottom-left'), div('gen-bottom-right')),
  );
  frame.style.left = '275px'; // beside the default stack until the first layout
  host.appendChild(frame);
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyV') { e.preventDefault(); toggleVideo(); }
  });
}

/** Put the window `left` 1x pixels from the origin, `height` tall. */
export function placeVideoWindow(left: number, height: number) {
  if (!frame) return;
  frame.style.left = `${left}px`;
  frame.style.height = `${height}px`;
}
