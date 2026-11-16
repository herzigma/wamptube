// Buffering indicator: the Winamp lightning-bolt logo (bottom right of the main
// window, where Webamp's #about link sits) pulses while a track loads or stalls,
// like the animated logo in the corner of an early browser: the size stays fixed
// and the animation runs inside it. The frames are cut from the active skin's own
// logo pixels, so a different skin gives a different bolt (see CLAUDE.md).

// The logo's box in the skin (1x px): the bolt itself is about x 250-265, y 89-106; the rest is margin.
const X = 249, Y = 88, W = 19, H = 19;
/** How far each frame pushes the bolt's pixels toward white, 0..1. Muted on purpose. */
const LIFT = [0, 0.12, 0.25, 0.4, 0.4, 0.25, 0.12, 0];
const FRAME_MS = 112;

let el: HTMLCanvasElement | undefined;
let frames: ImageData[] | undefined;
let framesFor = ''; // skin image the frames were cut from
let timer: number | undefined;
/** Reasons the player is waiting; the throbber runs while any is set. */
const reasons = new Set<string>();

export function installThrobber() {
  const main = document.getElementById('main-window');
  if (!main || el) return;
  el = document.createElement('canvas');
  el.className = 'throbber';
  el.width = W;
  el.height = H;
  main.appendChild(el);
  render();
}

/** Mark `reason` as waiting (or done). Safe to call before the throbber is installed. */
export function setBuffering(reason: string, on: boolean) {
  if (on) reasons.add(reason);
  else reasons.delete(reason);
  render();
}

function render() {
  if (!el) return;
  const on = reasons.size > 0;
  el.classList.toggle('on', on);
  if (on && timer === undefined) {
    void start();
  } else if (!on && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

async function start() {
  timer = -1; // claim the slot while the frames load
  try {
    await buildFrames();
  } catch (e) {
    console.error('[throbber]', e);
    timer = undefined;
    return;
  }
  if (timer !== -1 || reasons.size === 0) { timer = undefined; return; } // stopped meanwhile
  let i = 0;
  const draw = () => el?.getContext('2d')?.putImageData(frames![i++ % frames!.length], 0, 0);
  draw();
  timer = window.setInterval(draw, FRAME_MS);
}

/** Cut the logo out of the active skin's main background and make the pulse frames. */
async function buildFrames() {
  const main = document.getElementById('main-window')!;
  const url = /url\("?(.*?)"?\)/.exec(getComputedStyle(main).backgroundImage)?.[1];
  if (!url) throw new Error('no main window background');
  if (url === framesFor && frames) return;
  const img = new Image();
  img.src = url;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, X, Y, W, H, 0, 0, W, H);
  const src = ctx.getImageData(0, 0, W, H);

  // "Bolt" = far from the area's corner colour, which is the panel. Only those pixels
  // are drawn, so the overlay never paints a square of panel over the window.
  const bolt = new ImageData(new Uint8ClampedArray(src.data), W, H);
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    const dist = Math.abs(src.data[k] - src.data[0]) + Math.abs(src.data[k + 1] - src.data[1]) + Math.abs(src.data[k + 2] - src.data[2]);
    if (dist <= 40) bolt.data[k + 3] = 0;
  }
  frames = LIFT.map((lift) => {
    const d = new ImageData(new Uint8ClampedArray(bolt.data), W, H);
    for (let i = 0; i < d.data.length; i += 4) {
      if (!d.data[i + 3]) continue;
      for (let c = 0; c < 3; c++) d.data[i + c] += (255 - d.data[i + c]) * lift;
    }
    return d;
  });
  framesFor = url;
}
