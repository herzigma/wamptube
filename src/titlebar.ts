/**
 * Replace the "WINAMP" lettering in the default skin with "WAMPTUBE":
 *  - main window title bar (normal/focused + windowshade pair), and
 *  - playlist title piece ("WINAMP PLAYLIST" -> "WAMPTUBE PLAYLIST",
 *    normal/focused; the playlist windowshade bar has no lettering).
 *
 * Webamp turns each skin sprite into a data: URL inside a generated
 * stylesheet (`#webamp #title-bar {background-image: url(...)}` etc.). We read
 * those sprites, redraw them on a canvas at 1x in skin pixels, and add
 * override rules. Nothing is laid over the windows, so mouse handling (window
 * drag, title-bar buttons) is untouched, and the sprites scale with the rest
 * of the UI under the nearest-neighbour transform.
 *
 * Both title fonts in the base skin are the same 6px-cap anti-aliased face.
 * W/A/M/P (and PLAYLIST) are re-used from the sprites as coverage masks,
 * re-composited over a clean background; T is the skin's own T (from
 * "PLAYLIST"), U/B/E are hand-drawn masks in the same style. Geometry is
 * specific to the bundled base skin (Winamp 2.91 classic); a sprite that
 * doesn't look like it is left alone and a warning is logged.
 */

type RGB = [number, number, number];

/** Coverage masks for glyph rows 5..10, one hex digit per pixel (0..f => 0..1). */
const MASKS: Record<string, string[]> = {
  // T as drawn in the skin's "PLAYLIST" (PLEDIT.BMP title, x=88..93)
  T: ['4ffffb', '007f40', '007f40', '007f40', '007f40', '007f40'],
  U: ['bf00bf', 'bf00bf', 'bf00bf', 'bf00bf', '9f31cf', '3dffe7'],
  B: ['7fffd3', '7f41fa', '7fccd2', '7f41db', '7f41ed', '7fffe4'],
  E: ['7ffff', '7f400', '7fcc8', '7f400', '7f400', '7ffff'],
};

/** A run of the new word: columns [from,to) copied from the source sprite, or a mask; then `gap` blank columns. */
type Piece = { cols: [number, number]; gap: number } | { mask: string; gap: number };

/** WAMPTUBE from the main title bar's WINAMP (x=118..157). Width 56. */
const MAIN_WORD: Piece[] = [
  { cols: [118, 126], gap: 0 }, // W
  { cols: [136, 144], gap: 0 }, // A + its 1px gap
  { cols: [144, 152], gap: 0 }, // M + its 1px gap
  { cols: [152, 158], gap: 0 }, // P
  { mask: 'T', gap: 1 },
  { mask: 'U', gap: 1 },
  { mask: 'B', gap: 1 },
  { mask: 'E', gap: 0 },
];
/** WAMPTUBE PLAYLIST from the playlist title's "WINAMP PLAYLIST" (x=7..93). Width 104. */
const PLAYLIST_WORD: Piece[] = [
  { cols: [7, 15], gap: 0 }, // W
  { cols: [25, 32], gap: 1 }, // A (M follows it with no gap in this sprite)
  { cols: [32, 40], gap: 0 }, // M + its 1px gap
  { cols: [40, 46], gap: 0 }, // P
  { mask: 'T', gap: 1 },
  { mask: 'U', gap: 1 },
  { mask: 'B', gap: 1 },
  { mask: 'E', gap: 4 }, // word space, as before PLAYLIST
  { cols: [50, 94], gap: 0 }, // PLAYLIST
];

const pieceWidth = (p: Piece) => ('cols' in p ? p.cols[1] - p.cols[0] : MASKS[p.mask][0].length) + p.gap;
const wordWidth = (w: Piece[]) => w.reduce((n, p) => n + pieceWidth(p), 0);

/** New playlist title piece width: was 100; text grows 87 -> 104, keep the 7px margins both sides. */
export const PLAYLIST_TITLE_W = 7 + wordWidth(PLAYLIST_WORD) + 7; // 118 (even: stays centred)

class Px {
  constructor(public readonly img: ImageData) {}
  get w() {
    return this.img.width;
  }
  get h() {
    return this.img.height;
  }
  get(x: number, y: number): RGB {
    const d = this.img.data;
    const i = (y * this.w + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  }
  put(x: number, y: number, p: RGB) {
    const d = this.img.data;
    const i = (y * this.w + x) * 4;
    d[i] = p[0];
    d[i + 1] = p[1];
    d[i + 2] = p[2];
    d[i + 3] = 255;
  }
  toDataURL(): string {
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    c.getContext('2d')!.putImageData(this.img, 0, 0);
    return c.toDataURL('image/png');
  }
}

const lum = (p: RGB) => (p[0] + p[1] + p[2]) / 3;
const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
/**
 * Clean background of a glyph row: the gradient behind the lettering is
 * (near enough) constant down each column, and rows 3 and 11 are free of
 * artwork in both sprites, so interpolate between them.
 */
const cleanBg = (src: Px, x: number, y: number) => mix(src.get(x, 3), src.get(x, 11), (y - 3) / 8);

/** True if the column is bright text (not background) on all glyph rows. */
const isStem = (src: Px, x: number) => {
  for (let y = 5; y <= 10; y++) if (lum(src.get(x, y)) < lum(cleanBg(src, x, y)) + 60) return false;
  return true;
};

/**
 * Composite `word` onto `dst` starting at column x0 (rows 5..10). Source
 * columns are converted to coverage via the source's own background and
 * text colour `fg`, then re-blended over `dstBg`.
 */
function drawWord(src: Px, srcDx: number, dst: Px, dstBg: (x: number, y: number) => RGB, x0: number, word: Piece[], fg: RGB) {
  let x = x0;
  for (const p of word) {
    if ('cols' in p) {
      const [a, b] = p.cols;
      for (let i = 0; i < b - a; i++) {
        for (let y = 5; y <= 10; y++) {
          const sx = a + srcDx + i;
          const s = src.get(sx, y);
          const q = cleanBg(src, sx, y);
          let al = 0;
          for (let k = 0; k < 3; k++) al += fg[k] === q[k] ? 0 : (s[k] - q[k]) / (fg[k] - q[k]);
          dst.put(x + i, y, mix(dstBg(x + i, y), fg, Math.max(0, Math.min(1, al / 3))));
        }
      }
    } else {
      MASKS[p.mask].forEach((row, r) => {
        for (let i = 0; i < row.length; i++) dst.put(x + i, 5 + r, mix(dstBg(x + i, 5 + r), fg, parseInt(row[i], 16) / 15));
      });
    }
    // blank gap columns
    for (let i = pieceWidth(p) - p.gap; i < pieceWidth(p); i++) for (let y = 5; y <= 10; y++) dst.put(x + i, y, dstBg(x + i, y));
    x += pieceWidth(p);
  }
}

/**
 * Main window title bar (275x14).
 *  full bar: gold lines end at frame column x=113 (cap 112), WINAMP at
 *    x=118..157, right lines start at frame x=161 (cap 162).
 *  shade bar: same glyphs 98px further left (x=20..59), then a short line
 *    stub and the black mini-vis box at x=78.
 */
function patchMainBar(src: Px, shade: boolean): Px | null {
  if (src.w !== 275 || src.h !== 14) return null;
  const dx = shade ? -98 : 0;
  if (!isStem(src, 128 + dx)) return null; // the "I" of WINAMP
  if (!shade && (lum(src.get(113, 7)) > 45 || lum(src.get(161, 7)) > 45)) return null;
  const fg = src.get(128 + dx, 5);
  const out = new Px(new ImageData(new Uint8ClampedArray(src.img.data), src.w, src.h));
  const bg = (x: number, y: number) => cleanBg(src, x, y);

  const width = wordWidth(MAIN_WORD);
  // Full bar: centred like the original (centre 137.5) with the same 4px/3px
  // clearance to the line frames. Shade: left-aligned after the option
  // button; the short line stub no longer fits and is dropped.
  const start = shade ? 18 : Math.round(137.5 - width / 2 + 0.5);
  const zoneStart = shade ? 16 : start - 4;
  const zoneEnd = shade ? 78 : start + width + 3; // exclusive
  for (let x = zoneStart; x < zoneEnd; x++) for (let y = 4; y <= 10; y++) out.put(x, y, bg(x, y));
  if (!shade) {
    // move the line end caps + frame columns in to meet the wider word
    for (let y = 4; y <= 10; y++) {
      out.put(zoneStart - 2, y, src.get(112, y));
      out.put(zoneStart - 1, y, src.get(113, y));
      out.put(zoneEnd, y, src.get(161, y));
      out.put(zoneEnd + 1, y, src.get(162, y));
    }
  }
  drawWord(src, dx, out, bg, start, MAIN_WORD, fg);
  return out;
}

/**
 * Playlist title piece (100x20 -> PLAYLIST_TITLE_W x20). Lines + frame at
 * x=0..3 and x=96..99, text "WINAMP PLAYLIST" at x=7..93, rows 5..10. The
 * background is a symmetric horizontal gradient; it is stretched to the new
 * width, the edge line/frame columns are kept, and the text re-laid.
 */
function patchPlaylistTitle(src: Px): Px | null {
  if (src.w !== 100 || src.h !== 20) return null;
  if (!isStem(src, 17) || !isStem(src, 91)) return null; // "I" of WINAMP, stem of T
  if (lum(src.get(3, 7)) > 45 || lum(src.get(96, 7)) > 45) return null; // frame columns
  const fg = src.get(17, 5);
  const W = PLAYLIST_TITLE_W;
  const out = new Px(new ImageData(W, src.h));
  // map a new column to the old one for the stretched gradient
  const ox = (x: number) => Math.round((x * (src.w - 1)) / (W - 1));
  const bg = (x: number, y: number) => cleanBg(src, ox(x), y);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < src.h; y++) {
      if (x < 4) out.put(x, y, src.get(x, y)); // left line ends + frame
      else if (x >= W - 4) out.put(x, y, src.get(x - W + src.w, y)); // frame + right line ends
      else out.put(x, y, y >= 4 && y <= 10 ? bg(x, y) : src.get(ox(x), y));
    }
  }
  drawWord(src, 0, out, bg, 7, PLAYLIST_WORD, fg);
  return out;
}

function findSpriteUrl(selector: string): string | null {
  let url: string | null = null;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule) || rule.selectorText !== selector) continue;
      const m = /url\((['"]?)(.*?)\1\)/.exec(rule.style.backgroundImage);
      if (m) url = m[2]; // last one wins, like the cascade
    }
  }
  return url;
}

async function loadPixels(url: string): Promise<Px> {
  // onload rather than img.decode(): decode() can stall while the page isn't
  // being painted (seen in an occluded/background webview).
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('sprite failed to load'));
    img.src = url;
  });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return new Px(ctx.getImageData(0, 0, c.width, c.height));
}

const SPRITES: { selector: string; patch: (src: Px) => Px | null; group: 'main' | 'playlist' }[] = [
  { selector: '#webamp #title-bar', patch: (s) => patchMainBar(s, false), group: 'main' },
  { selector: '#webamp .selected #title-bar', patch: (s) => patchMainBar(s, false), group: 'main' },
  { selector: '#webamp .shade #title-bar', patch: (s) => patchMainBar(s, true), group: 'main' },
  { selector: '#webamp .shade.selected #title-bar', patch: (s) => patchMainBar(s, true), group: 'main' },
  { selector: '#webamp .playlist-top-title', patch: patchPlaylistTitle, group: 'playlist' },
  { selector: '#webamp .selected .playlist-top-title', patch: patchPlaylistTitle, group: 'playlist' },
];

/**
 * Patch the title sprites. Call after Webamp has rendered (skin CSS present).
 * Returns how many of the six sprites were replaced.
 */
export async function patchTitleBar(): Promise<number> {
  const main: string[] = [];
  const playlist: string[] = [];
  for (const { selector, patch, group } of SPRITES) {
    const url = findSpriteUrl(selector);
    if (!url) {
      console.warn('[titlebar] no sprite for', selector);
      continue;
    }
    try {
      const out = patch(await loadPixels(url));
      if (!out) {
        console.warn('[titlebar] sprite does not match the default skin, left as is:', selector);
        continue;
      }
      // "html body" raises specificity by two type selectors so these beat
      // Webamp's identical selectors regardless of stylesheet order, while
      // keeping the original relative ordering (.shade/.selected still win).
      (group === 'main' ? main : playlist).push(`html body ${selector} {background-image: url(${out.toDataURL()})}`);
    } catch (e) {
      console.error('[titlebar] patch failed for', selector, e);
    }
  }
  const rules = [...main];
  if (playlist.length === 2) {
    // The wider word doesn't fit the 100px title piece; widen it. The
    // flex-grow fill tiles either side absorb the difference (9px each at the
    // default width), so the bar's total width is unchanged at any size, and
    // the even delta keeps the title centred with Webamp's parity spacers.
    rules.push(...playlist, `html body #webamp .playlist-top-title {width: ${PLAYLIST_TITLE_W}px}`);
  } else if (playlist.length) {
    console.warn('[titlebar] only one playlist title state patched; leaving the playlist title unchanged');
  }
  if (rules.length) {
    let style = document.getElementById('wamptube-titlebar');
    if (!style) {
      style = document.createElement('style');
      style.id = 'wamptube-titlebar';
      document.head.appendChild(style);
    }
    style.textContent = rules.join('\n');
  }
  return main.length + (playlist.length === 2 ? 2 : 0);
}
