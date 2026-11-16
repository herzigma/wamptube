/**
 * Builds public/skins/wamptube.wsz: Webamp's own default skin art with the
 * title lettering changed (main bar WINAMP -> WAMPTUBE, playlist and
 * equalizer bars "WINAMP PLAYLIST" / "WINAMP EQUALIZER" -> "PLAYLIST" / "EQUALIZER"). The app loads it as Webamp's initial skin,
 * so a custom skin simply replaces it and renders only what it contains.
 *
 * Only the title sprites differ from the stock look. EQMAIN.BMP also carries
 * two non-sprite strips (see below); the rest of the skin falls back to Webamp's built-in art. Run after upgrading webamp:
 *
 *   deno run -A tools/make-skin.ts
 *
 * Sprites are read from the webamp bundle (name -> PNG data URL, plus the
 * sprite sheet coordinates), edited at the pixel level, then packed back into
 * 24-bit BMP sheets inside a zip.
 */
import { PNG } from 'pngjs';
import { zipSync } from 'fflate';

const bundle = Deno.readTextFileSync('node_modules/webamp/built/webamp.bundle.min.mjs');

type RGB = [number, number, number];
type Sprite = { name: string; x: number; y: number; width: number; height: number };

function sheetSprites(key: string): Sprite[] {
  const i = bundle.indexOf(`${key}:[{name:`);
  if (i < 0) throw new Error(`sprite list ${key} not found in the webamp bundle`);
  let depth = 0;
  let j = i + key.length + 1;
  for (; j < bundle.length; j++) {
    if (bundle[j] === '[') depth++;
    else if (bundle[j] === ']' && --depth === 0) break;
  }
  return new Function(`return ${bundle.slice(i + key.length + 1, j + 1)}`)();
}

/**
 * Default-skin sprites by name. The bundle holds them as one generated
 * stylesheet (`#webamp <selector> {background-image: url(data:...)}`) and,
 * separately, a name -> selectors table; join the two on the first selector.
 */
function spriteImages(): Record<string, PNG> {
  const at = bundle.indexOf('MAIN_TITLE_BAR:["#title-bar"]');
  let s = at;
  while (bundle.slice(s - 1, s + 1) !== '={') s--;
  let depth = 0;
  let j = s;
  for (; j < bundle.length; j++) {
    if (bundle[j] === '{') depth++;
    else if (bundle[j] === '}' && --depth === 0) break;
  }
  const selectors: Record<string, string[]> = new Function(`return ${bundle.slice(s, j + 1)}`)();
  const rules = new Map<string, string>();
  for (const m of bundle.matchAll(/#webamp ([^{}\\]*?) \{background-image: url\(data:image\/png;base64,([A-Za-z0-9+\/=]+)\)\}/g)) {
    rules.set(m[1], m[2]);
  }
  const out: Record<string, PNG> = {};
  for (const [name, sels] of Object.entries(selectors)) {
    const data = rules.get(sels[0]);
    if (data) out[name] = PNG.sync.read(Buffer.from(data, 'base64'));
  }
  return out;
}

class Px {
  constructor(public png: PNG) {}
  get(x: number, y: number): RGB {
    const i = (y * this.png.width + x) * 4;
    return [this.png.data[i], this.png.data[i + 1], this.png.data[i + 2]];
  }
  put(x: number, y: number, p: RGB) {
    const i = (y * this.png.width + x) * 4;
    this.png.data[i] = p[0];
    this.png.data[i + 1] = p[1];
    this.png.data[i + 2] = p[2];
    this.png.data[i + 3] = 255;
  }
  clone() {
    const p = new PNG({ width: this.png.width, height: this.png.height });
    this.png.data.copy(p.data);
    return new Px(p);
  }
}

const lum = (p: RGB) => (p[0] + p[1] + p[2]) / 3;
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t)) as RGB;
/** Background of a glyph row: constant down each column; rows 3 and 11 are free of artwork. */
const cleanBg = (s: Px, x: number, y: number) => mix(s.get(x, 3), s.get(x, 11), (y - 3) / 8);
const isStem = (s: Px, x: number) => {
  for (let y = 5; y <= 10; y++) if (lum(s.get(x, y)) < lum(cleanBg(s, x, y)) + 60) return false;
  return true;
};

/** Coverage masks (rows 5..10, hex 0..f) for letters the stock sprites don't have. T is the skin's own, from "PLAYLIST". */
const MASKS: Record<string, string[]> = {
  T: ['4ffffb', '007f40', '007f40', '007f40', '007f40', '007f40'],
  U: ['bf00bf', 'bf00bf', 'bf00bf', 'bf00bf', '9f31cf', '3dffe7'],
  B: ['7fffd3', '7f41fa', '7fccd2', '7f41db', '7f41ed', '7fffe4'],
  E: ['7ffff', '7f400', '7fcc8', '7f400', '7f400', '7ffff'],
};
type Piece = { cols: [number, number]; gap: number } | { mask: string; gap: number };
const pw = (p: Piece) => ('cols' in p ? p.cols[1] - p.cols[0] : MASKS[p.mask][0].length) + p.gap;
const width = (w: Piece[]) => w.reduce((n, p) => n + pw(p), 0);

// WAMPTUBE from the main bar's WINAMP (x=118..157); W/A/M/P are re-used from it.
const MAIN_WORD: Piece[] = [
  { cols: [118, 126], gap: 0 },
  { cols: [136, 144], gap: 0 },
  { cols: [144, 152], gap: 0 },
  { cols: [152, 157], gap: 1 }, // P; the sprite's own trailing blank columns are left out
  { mask: 'T', gap: 1 },
  { mask: 'U', gap: 1 },
  { mask: 'B', gap: 1 },
  { mask: 'E', gap: 0 },
];
// "PLAYLIST" from the playlist title's "WINAMP PLAYLIST" (x=50..93)
const PLAYLIST_WORD: Piece[] = [{ cols: [50, 94], gap: 0 }];
// "EQUALIZER" from the equalizer title's "WINAMP EQUALIZER" (x=138..187)
const EQ_WORD: Piece[] = [{ cols: [138, 188], gap: 0 }];

/** Composite `word` onto dst at column x0 (rows 5..10), glyph columns taken from `src` shifted by srcDx. */
function drawWord(src: Px, srcDx: number, dst: Px, x0: number, word: Piece[], fg: RGB) {
  let x = x0;
  for (const p of word) {
    if ('cols' in p) {
      for (let i = 0; i < p.cols[1] - p.cols[0]; i++) {
        for (let y = 5; y <= 10; y++) {
          const sx = p.cols[0] + srcDx + i;
          const s = src.get(sx, y);
          const q = cleanBg(src, sx, y);
          let al = 0;
          for (let k = 0; k < 3; k++) al += fg[k] === q[k] ? 0 : (s[k] - q[k]) / (fg[k] - q[k]);
          dst.put(x + i, y, mix(cleanBg(src, x + i, y), fg, Math.max(0, Math.min(1, al / 3))));
        }
      }
    } else {
      MASKS[p.mask].forEach((row, r) => {
        for (let i = 0; i < row.length; i++) dst.put(x + i, 5 + r, mix(cleanBg(src, x + i, 5 + r), fg, parseInt(row[i], 16) / 15));
      });
    }
    x += pw(p);
  }
}

function patchMainBar(src: Px, shade: boolean): Px {
  if (src.png.width !== 275 || src.png.height !== 14) throw new Error('main title sprite has an unexpected size');
  const dx = shade ? -98 : 0;
  if (!isStem(src, 128 + dx)) throw new Error('main title sprite does not look like the default skin');
  const fg = src.get(128 + dx, 5);
  const out = src.clone();
  const w = width(MAIN_WORD);
  // Full bar: centred like the original, line end caps moved in to meet the word.
  // Shade bar: left-aligned after the option button; the short line stub is dropped.
  const start = shade ? 18 : Math.round(137.5 - w / 2 + 0.5);
  const zoneStart = shade ? 16 : start - 4;
  const zoneEnd = shade ? 78 : start + w + 3;
  for (let x = zoneStart; x < zoneEnd; x++) for (let y = 4; y <= 10; y++) out.put(x, y, cleanBg(src, x, y));
  if (!shade) {
    for (let y = 4; y <= 10; y++) {
      out.put(zoneStart - 2, y, src.get(112, y));
      out.put(zoneStart - 1, y, src.get(113, y));
      out.put(zoneEnd, y, src.get(161, y));
      out.put(zoneEnd + 1, y, src.get(162, y));
    }
  }
  drawWord(src, dx, out, start, MAIN_WORD, fg);
  return out;
}

/**
 * Playlist title piece (100x20): frame/line-end columns at x=0..3 and 96..99,
 * lettering at x=7..93. The shorter "PLAYLIST" gets its own frame columns moved
 * in around it, with the plain line pattern (taken from the top-bar fill tile)
 * on either side, like the main bar.
 */
function patchPlaylistTitle(src: Px, tile: Px): Px {
  if (src.png.width !== 100 || src.png.height !== 20) throw new Error('playlist title sprite has an unexpected size');
  if (!isStem(src, 17) || !isStem(src, 91)) throw new Error('playlist title sprite does not look like the default skin');
  const fg = src.get(17, 5);
  const out = src.clone();
  const w = width(PLAYLIST_WORD);
  const start = Math.round((100 - w) / 2);
  const left = start - 7; // where src columns 0..3 go
  const right = start + w + 2; // where src columns 96..99 go
  // stretch the (symmetric) background gradient over the new zone
  const ox = (x: number) => Math.round(4 + ((x - (left + 4)) * 91) / (right - left - 4));
  for (let x = 0; x < 100; x++) {
    for (let y = 0; y < 20; y++) {
      if (x < left || x >= right + 4) out.put(x, y, tile.get(10, y));
      else if (x < left + 4) out.put(x, y, src.get(x - left, y));
      else if (x >= right) out.put(x, y, src.get(96 + x - right, y));
      else out.put(x, y, y >= 4 && y <= 10 ? cleanBg(src, ox(x), y) : src.get(ox(x), y));
    }
  }
  drawWord(src, 0, out, start, PLAYLIST_WORD, fg);
  return out;
}

/**
 * Equalizer title bar (275x14): line end cap + frame at x=89,90 and 192,193,
 * "WINAMP EQUALIZER" at x=95..187. Same treatment as the main bar: "EQUALIZER"
 * centred, frame columns moved in, line pattern filled out to meet them.
 */
function patchEqTitle(src: Px): Px {
  if (src.png.width !== 275 || src.png.height !== 14) throw new Error('equalizer title sprite has an unexpected size');
  if (!isStem(src, 104) || lum(src.get(90, 7)) > 45 || lum(src.get(192, 7)) > 45) {
    throw new Error('equalizer title sprite does not look like the default skin');
  }
  const fg = src.get(104, 5);
  const out = src.clone();
  const w = width(EQ_WORD);
  const start = Math.round(137.5 - w / 2);
  const capL = start - 6; // cap, frame, 4 blank columns, lettering
  const capR = start + w + 4 - 1; // 4 blank columns, frame, cap  (frame at capR+1)
  for (let y = 4; y <= 10; y++) {
    for (let x = 89; x < 194; x++) {
      if (x === capL || x === capL + 1) out.put(x, y, src.get(89 + x - capL, y));
      else if (x === capR + 1 || x === capR + 2) out.put(x, y, src.get(192 + x - (capR + 1), y));
      else if (x < capL) out.put(x, y, src.get(60, y)); // left line pattern
      else if (x > capR + 2) out.put(x, y, src.get(230, y)); // right line pattern
      else out.put(x, y, cleanBg(src, 95 + ((x - capL) % 90), y)); // purple zone
    }
  }
  drawWord(src, 0, out, start, EQ_WORD, fg);
  return out;
}

/** 24-bit bottom-up BMP, as Winamp skins use. */
function bmp(sheet: PNG): Uint8Array {
  const { width: w, height: h } = sheet;
  const stride = Math.ceil((w * 3) / 4) * 4;
  const out = new Uint8Array(54 + stride * h);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(2, out.length, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, stride * h, true);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const o = 54 + (h - 1 - y) * stride + x * 3;
      out[o] = sheet.data[s + 2];
      out[o + 1] = sheet.data[s + 1];
      out[o + 2] = sheet.data[s];
    }
  }
  return out;
}

function sheet(w: number, h: number, key: string, imgs: Record<string, PNG>, edits: Record<string, (p: Px) => Px>): PNG {
  const sheet = new PNG({ width: w, height: h });
  for (let i = 0; i < sheet.data.length; i += 4) sheet.data[i + 3] = 255;
  for (const s of sheetSprites(key)) {
    let img = imgs[s.name];
    if (!img) continue;
    if (edits[s.name]) img = edits[s.name](new Px(img)).png;
    PNG.bitblt(img, sheet, 0, 0, s.width, s.height, s.x, s.y);
  }
  return sheet;
}

const imgs = spriteImages();
imgs.EQ_GRAPH_LINE_COLORS ??= PNG.sync.read(Buffer.from(bundle.match(/EQ_GRAPH_LINE_COLORS:"data:image\/png;base64,([^"]+)"/)![1], 'base64'));
imgs.EQ_PREAMP_LINE ??= PNG.sync.read(Buffer.from(bundle.match(/EQ_PREAMP_LINE:"data:image\/png;base64,([^"]+)"/)![1], 'base64'));
const titlebar = sheet(344, 87, 'TITLEBAR', imgs, {
  MAIN_TITLE_BAR: (p) => patchMainBar(p, false),
  MAIN_TITLE_BAR_SELECTED: (p) => patchMainBar(p, false),
  MAIN_SHADE_BACKGROUND: (p) => patchMainBar(p, true),
  MAIN_SHADE_BACKGROUND_SELECTED: (p) => patchMainBar(p, true),
});
// EQMAIN also carries two non-sprite strips Webamp derives its graph colours
// from; without them the EQ graph loses its centre line.
const eqmain = sheet(275, 315, 'EQMAIN', imgs, {
  EQ_TITLE_BAR: patchEqTitle,
  EQ_TITLE_BAR_SELECTED: patchEqTitle,
});
PNG.bitblt(imgs.EQ_GRAPH_LINE_COLORS, eqmain, 0, 0, 1, 19, 115, 294);
PNG.bitblt(imgs.EQ_PREAMP_LINE, eqmain, 0, 0, 113, 1, 0, 314);
const pledit = sheet(280, 186, 'PLEDIT', imgs, {
  PLAYLIST_TITLE_BAR: (p) => patchPlaylistTitle(p, new Px(imgs.PLAYLIST_TOP_TILE)),
  PLAYLIST_TITLE_BAR_SELECTED: (p) => patchPlaylistTitle(p, new Px(imgs.PLAYLIST_TOP_TILE_SELECTED)),
});

// Webamp's stock playlist colours, so the list looks the same as with the built-in skin.
const pleditTxt = '[Text]\r\nNormal=#00FF00\r\nCurrent=#FFFFFF\r\nNormalbg=#000000\r\nSelectedbg=#0000FF\r\nFont=Arial\r\n';
const files = {
  'TITLEBAR.BMP': bmp(titlebar),
  'EQMAIN.BMP': bmp(eqmain),
  'PLEDIT.BMP': bmp(pledit),
  'PLEDIT.TXT': new TextEncoder().encode(pleditTxt),
};

const GLYPHS: Record<string, string[]> = {
  V: ['x.x', 'x.x', 'x.x', 'x.x', '.x.'], I: ['xxx', '.x.', '.x.', '.x.', 'xxx'],
  F: ['.xx', 'x..', 'xxx', 'x..', 'x..'], X: ['x.x', 'x.x', '.x.', 'x.x', 'x.x'],
  A: ['.x.', 'x.x', 'xxx', 'x.x', 'x.x'], U: ['x.x', 'x.x', 'x.x', 'x.x', '.xx'],
  W: ['x.x', 'x.x', 'x.x', 'xxx', 'x.x'], C: ['.xx', 'x..', 'x..', 'x..', '.xx'],
  O: ['.x.', 'x.x', 'x.x', 'x.x', '.x.'], M: ['x.x', 'xxx', 'xxx', 'x.x', 'x.x'],
  P: ['xxx', 'x.x', 'xxx', 'x..', 'x..'], S: ['.xx', 'x..', '.x.', '..x', 'xx.'],
  '1': ['.x.', 'xx.', '.x.', '.x.', 'xxx'], '2': ['xx.', '..x', '.x.', 'x..', 'xxx'],
  '3': ['xx.', '..x', '.x.', '..x', 'xx.'], '4': ['x.x', 'x.x', 'xxx', '..x', '..x'],
  '5': ['xxx', 'x..', 'xx.', '..x', 'xx.'],
};
/**
 * Toggle-button art that isn't a Webamp sprite (so not part of the skin): the EQ
 * button's four sprites with the "EQ" letters redrawn as `label`, one or two of
 * the glyphs above. A 23x48 strip, top to bottom: off, on, off pressed, on pressed.
 */
function letterButtons(label: string): PNG {
  const names = ['MAIN_EQ_BUTTON', 'MAIN_EQ_BUTTON_SELECTED', 'MAIN_EQ_BUTTON_DEPRESSED', 'MAIN_EQ_BUTTON_DEPRESSED_SELECTED'];
  const out = new PNG({ width: 23, height: 12 * names.length });
  const at = label.length === 1 ? [12] : [10, 14];
  names.forEach((n, k) => {
    const src = imgs[n];
    if (!src) throw new Error(`sprite ${n} not found in the webamp bundle`);
    const px = new Px(src.width === 23 && src.height === 12 ? src : (() => { throw new Error(`${n}: unexpected size`); })());
    const face = px.get(10, 2), ink = px.get(11, 3); // button face; the letters' ink colour
    const e = px.clone();
    for (let y = 3; y <= 7; y++) for (let x = 9; x <= 18; x++) e.put(x, y, face);
    [...label].forEach((ch, c) => GLYPHS[ch].forEach((row, r) => {
      for (let i = 0; i < 3; i++) if (row[i] === 'x') e.put(at[c] + i, 3 + r, ink);
    }));
    PNG.bitblt(e.png, out, 0, 0, 23, 12, 0, 12 * k);
  });
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  return out;
}

/** The FX pane's control strip (src/videowindow.ts, FX_CONTROLS): one 23x48 column per button, in this order. */
const FX_STRIP = ['1', '2', '3', '4', '5', 'WV', 'CO', 'MI', 'SP', 'AU'];
function fxStrip(): PNG {
  const out = new PNG({ width: 23 * FX_STRIP.length, height: 48 });
  FX_STRIP.forEach((label, k) => PNG.bitblt(letterButtons(label), out, 0, 0, 23, 48, 23 * k, 0));
  return out;
}

/**
 * Minimize button for the video / FX window's title bar: the playlist window's
 * shade button, cut out of its title-bar corner (the gen-window art has only a
 * close button). 9x18: normal, then pressed.
 */
function genShade(): PNG {
  const corner = imgs.PLAYLIST_TOP_RIGHT_CORNER_SELECTED, pressed = imgs.PLAYLIST_COLLAPSE_SELECTED;
  if (!corner || !pressed) throw new Error('playlist shade sprites not found in the webamp bundle');
  const out = new PNG({ width: 9, height: 18 });
  PNG.bitblt(corner, out, 25 - 12 - 9, 3, 9, 9, 0, 0); // #playlist-shade-button: right 12, top 3
  PNG.bitblt(pressed, out, 0, 0, 9, 9, 0, 9);
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  return out;
}

Deno.mkdirSync('public/skins', { recursive: true });
Deno.writeFileSync('public/skins/vi-button.png', PNG.sync.write(letterButtons('VI')));
Deno.writeFileSync('public/skins/fx-button.png', PNG.sync.write(letterButtons('FX')));
Deno.writeFileSync('public/skins/fx-strip.png', PNG.sync.write(fxStrip()));
Deno.writeFileSync('public/skins/gen-shade.png', PNG.sync.write(genShade()));
Deno.writeFileSync('public/skins/wamptube.wsz', zipSync(files));
