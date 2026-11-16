// FX: a large 90s-style music visualizer in the spirit of MilkDrop, shown in
// the video window's frame instead of the picture.
//
// It is our own small WebGL program, not MilkDrop itself: real MilkDrop presets
// (butterchurn) compile code at runtime, which the app's CSP forbids. The trick
// is the same one though: every frame the previous frame is drawn back slightly
// zoomed, rotated and bent, a little darker, and the live waveform is drawn on
// top, so the waveform smears into tunnels, swirls and ripples.

/** Where the audio numbers come from: fill `wave` (time domain) and `freq` (spectrum), both 0..255. */
export interface FxSource {
  read(wave: Uint8Array<ArrayBuffer>, freq: Uint8Array<ArrayBuffer>): void;
  /** Told when the pane starts and stops showing, so the source can stop working while unseen. */
  setActive?(on: boolean): void;
}

/** One look. All motion values are per frame at 60 fps. */
interface Preset {
  name: string;
  zoom: number;    // > 0 flies into the picture, < 0 backs out
  rot: number;     // whole-picture rotation
  swirl: number;   // extra rotation that grows towards the edge
  ripple: number;  // rings of zoom moving outwards
  warp: number;    // wobbly sideways bending
  decay: number;   // how much of the last frame survives (0..1)
  shift: number;   // how fast trails change color
  wave: 0 | 1 | 2 | 3; // 0 circle, 1 line, 2 mirrored lines, 3 x/y scope
}

const PRESETS: Preset[] = [
  { name: 'tunnel',   zoom: 0.030, rot: 0.004,  swirl: 0,      ripple: 0,     warp: 0.2, decay: 0.965, shift: 0.03, wave: 0 },
  { name: 'whirlpool', zoom: 0.012, rot: 0.010,  swirl: 0.06,   ripple: 0,     warp: 0.0, decay: 0.975, shift: 0.02, wave: 1 },
  { name: 'ripples',  zoom: 0.008, rot: -0.003, swirl: 0,      ripple: 0.035, warp: 0.3, decay: 0.970, shift: 0.05, wave: 2 },
  { name: 'lava',     zoom: 0.004, rot: 0.002,  swirl: -0.02,  ripple: 0.010, warp: 1.6, decay: 0.982, shift: 0.02, wave: 3 },
  { name: 'implode',  zoom: -0.022, rot: -0.008, swirl: 0.03,  ripple: 0,     warp: 0.4, decay: 0.960, shift: 0.06, wave: 0 },
];

const QUAD_VS = `
attribute vec2 pos; varying vec2 uv;
void main() { uv = pos * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }`;

/** Draw the last frame back, bent: this is what makes the trails move. */
const WARP_FS = `
precision mediump float;
uniform sampler2D prev;
uniform float t, aspect, bass, zoom, rot, swirl, ripple, warp, decay, shift;
varying vec2 uv;
void main() {
  vec2 c = uv - 0.5; c.x *= aspect;
  float r = length(c);
  float z = zoom * (1.0 + bass * 2.5) + ripple * sin(r * 14.0 - t * 3.0);
  c *= 1.0 - z;
  float a = rot + swirl * r;
  c = mat2(cos(a), -sin(a), sin(a), cos(a)) * c;
  c += warp * 0.004 * vec2(sin(c.y * 9.0 + t * 1.1), cos(c.x * 7.0 - t * 0.9));
  c.x /= aspect;
  vec3 col = texture2D(prev, c + 0.5).rgb;
  col = mix(col, col.gbr, shift);
  gl_FragColor = vec4(max(col * decay - 0.004, 0.0), 1.0);
}`;

const WAVE_VS = `
attribute vec2 pos; uniform vec2 off;
void main() { gl_Position = vec4(pos + off, 0.0, 1.0); }`;
const WAVE_FS = `
precision mediump float; uniform vec3 color;
void main() { gl_FragColor = vec4(color, 1.0); }`;

/** Spectrum bars: color runs from the palette's base at the bottom to its hot end at the top. */
const BARS_VS = `
attribute vec2 pos; varying float h;
void main() { h = pos.y * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }`;
const BARS_FS = `
precision mediump float; uniform vec3 low, mid, high; varying float h;
void main() {
  float k = clamp(h / 0.6, 0.0, 1.0);
  vec3 c = k < 0.5 ? mix(low, mid, k * 2.0) : mix(mid, high, k * 2.0 - 1.0);
  gl_FragColor = vec4(c, 1.0);
}`;

const SHOW_FS = `
precision mediump float; uniform sampler2D prev; uniform float mirror; varying vec2 uv;
void main() {
  // mirror: the bottom-left quarter of the picture, folded four ways
  vec2 u = mirror > 0.5 ? 0.5 - abs(uv - 0.5) : uv;
  vec3 c = texture2D(prev, u).rgb;
  gl_FragColor = vec4(pow(c, vec3(0.85)) * 1.15, 1.0);
}`;

/**
 * Color sets: the waveform's color (null = cycle through the rainbow), and
 * the spectrum bars' bottom / middle / top colors.
 */
const PALETTES: { name: string; wave: [number, number, number] | null; bars: number[][] }[] = [
  { name: 'rainbow', wave: null, bars: [[0, 0.75, 0], [0.9, 0.85, 0], [0.95, 0.1, 0]] },
  { name: 'fire', wave: [0.75, 0.3, 0.05], bars: [[0.6, 0.05, 0], [1, 0.5, 0], [1, 0.95, 0.5]] },
  { name: 'ice', wave: [0.1, 0.35, 0.75], bars: [[0, 0.15, 0.6], [0.1, 0.6, 1], [0.8, 0.95, 1]] },
  { name: 'green', wave: [0.05, 0.7, 0.1], bars: [[0, 0.35, 0], [0, 0.85, 0], [0.6, 1, 0.6]] },
];

/** What the control strip shows and changes. */
export interface FxState {
  preset: number;
  /** Change effect by itself on a beat every PRESET_SECONDS or so. */
  auto: boolean;
  mirror: boolean;
  /** Large spectrum bars over the effect. */
  bars: boolean;
}
export const FX_PRESET_COUNT = PRESETS.length;

const BARS = 32;
const POINTS = 256;
/** Seconds a preset stays before the next beat moves on. */
const PRESET_SECONDS = 20;

export class Fx {
  private gl: WebGLRenderingContext | null;
  private raf = 0;
  private preset = 0;
  private auto = true;
  private mirror = false;
  private bars = false;
  /** Waveform shape picked with WV; null = the preset's own. */
  private waveMode: Preset['wave'] | null = null;
  private palette = 0;
  private barLevel = new Float32Array(BARS);
  private barPeak = new Float32Array(BARS);
  private barVerts = new Float32Array(BARS * 2 * 12);
  /** Called whenever `state` changes, including when the effect moves on by itself. */
  onState: () => void = () => {};
  private presetSince = 0;
  private wave = new Uint8Array(1024);
  private freq = new Uint8Array(512);
  private verts = new Float32Array(POINTS * 2);
  private bass = 0;
  private bassAvg = 0;
  private level = 0;
  private gain = 1;
  private w = 0;
  private h = 0;
  private tex: WebGLTexture[] = [];
  private fbo: WebGLFramebuffer[] = [];
  private cur = 0;
  private prog: Record<'warp' | 'wave' | 'bars' | 'show', WebGLProgram> | undefined;
  private quad: WebGLBuffer | null = null;
  private line: WebGLBuffer | null = null;

  constructor(private canvas: HTMLCanvasElement, private source: FxSource) {
    this.gl = canvas.getContext('webgl', { antialias: false, alpha: false });
    if (!this.gl) { console.error('[fx] no WebGL'); return; }
    const gl = this.gl;
    this.prog = {
      warp: this.program(QUAD_VS, WARP_FS),
      wave: this.program(WAVE_VS, WAVE_FS),
      bars: this.program(BARS_VS, BARS_FS),
      show: this.program(QUAD_VS, SHOW_FS),
    };
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.line = gl.createBuffer();
    canvas.addEventListener('click', () => this.next());
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl!;
    const p = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('[fx] shader', gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, 'pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error('[fx] link', gl.getProgramInfoLog(p));
    return p;
  }

  /** Next look; also what a click on the picture does. */
  next() { this.setPreset(this.preset + 1); }

  setPreset(i: number) {
    this.preset = ((i % PRESETS.length) + PRESETS.length) % PRESETS.length;
    this.presetSince = performance.now();
    console.warn(`[fx] preset ${PRESETS[this.preset].name}`);
    this.onState();
  }

  get state(): FxState {
    return { preset: this.preset, auto: this.auto, mirror: this.mirror, bars: this.bars };
  }

  toggle(what: 'auto' | 'mirror' | 'bars') {
    this[what] = !this[what];
    if (what === 'auto') this.presetSince = performance.now();
    this.onState();
  }

  /** Step the waveform's shape: circle, line, mirrored lines, x/y scope. It then stays put across effects. */
  nextWave() {
    this.waveMode = (((this.waveMode ?? PRESETS[this.preset].wave) + 1) % 4) as Preset['wave'];
  }

  /** Step the color set. */
  nextColor() {
    this.palette = (this.palette + 1) % PALETTES.length;
    console.warn(`[fx] color ${PALETTES[this.palette].name}`);
  }

  start() {
    if (!this.gl || this.raf) return;
    this.source.setActive?.(true);
    this.presetSince = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.source.setActive?.(false);
  }

  /** Two same-size textures: each frame reads one and draws into the other. */
  private resize() {
    const gl = this.gl!;
    // Chunky on purpose: draw at half the canvas's CSS size (which is in the UI's 1x
    // pixels); style.css scales it up without smoothing.
    const w = Math.max(2, Math.round(this.canvas.clientWidth / 2)), h = Math.max(2, Math.round(this.canvas.clientHeight / 2));
    if (w === this.w && h === this.h) return;
    this.w = this.canvas.width = w;
    this.h = this.canvas.height = h;
    this.tex.forEach((t) => gl.deleteTexture(t));
    this.fbo.forEach((f) => gl.deleteFramebuffer(f));
    this.tex = [];
    this.fbo = [];
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.tex.push(t);
      this.fbo.push(f);
    }
  }

  /** Fill `verts` with the waveform's shape for this preset. Returns how many points. */
  private shape(mode: Preset['wave'], t: number, mirror: boolean): number {
    const { wave, verts } = this;
    const aspect = this.w / this.h;
    const step = Math.floor(wave.length / POINTS);
    for (let i = 0; i < POINTS; i++) {
      const s = Math.max(-1, Math.min(1, ((wave[i * step] - 128) / 128) * this.gain)); // -1..1
      const k = i / (POINTS - 1);
      let x = 0, y = 0;
      if (mode === 0) {
        // circle: ends meet because the sample is faded out towards both ends
        const fade = Math.sin(k * Math.PI);
        const r = 0.32 + this.bass * 0.25 + s * 0.3 * fade;
        const a = k * Math.PI * 2 + t * 0.3;
        x = (Math.cos(a) * r) / aspect;
        y = Math.sin(a) * r;
      } else if (mode === 1) {
        x = k * 2 - 1;
        y = s * 0.6;
      } else if (mode === 2) {
        x = k * 2 - 1;
        y = (mirror ? -1 : 1) * (0.45 + s * 0.4);
      } else {
        // x/y scope: the signal against itself a little later
        const s2 = Math.max(-1, Math.min(1, ((wave[(i * step + 90) % wave.length] - 128) / 128) * this.gain));
        x = (s * 0.9) / aspect + Math.cos(t * 0.4) * 0.25;
        y = s2 * 0.9 + Math.sin(t * 0.5) * 0.25;
      }
      verts[i * 2] = x;
      verts[i * 2 + 1] = y;
    }
    return POINTS;
  }

  /**
   * Fill `barVerts` with BARS bars across the bottom 60% of the picture, each
   * with a falling peak cap. Bars cover equal steps of pitch (about 40 Hz to 16 kHz).
   * Returns the vertex count.
   */
  private barShape(): number {
    const { freq, barLevel, barPeak, barVerts } = this;
    const top = Math.min(freq.length - 1, 372);
    let n = 0;
    const quad = (x0: number, x1: number, y0: number, y1: number) => {
      barVerts.set([x0, y0, x1, y0, x0, y1, x1, y0, x1, y1, x0, y1], n);
      n += 12;
    };
    const cap = 2 / this.h; // one drawn pixel
    for (let b = 0; b < BARS; b++) {
      const from = Math.round(Math.pow(top, b / BARS)), to = Math.max(from + 1, Math.round(Math.pow(top, (b + 1) / BARS)));
      let v = 0;
      for (let i = from; i < to; i++) v = Math.max(v, freq[i]);
      // Bytes are decibels (see pcm.ts); below about 70 is noise floor. Highs read lower, so lift them a little.
      v = Math.min(1, Math.max(0, (v - 70) / 150) * (1 + b / BARS));
      barLevel[b] = Math.max(v, barLevel[b] - 0.035);
      barPeak[b] = Math.max(barLevel[b], barPeak[b] - 0.008);
      const x0 = -1 + (2 * b) / BARS, x1 = x0 + (2 / BARS) * 0.8;
      quad(x0, x1, -1, -1 + barLevel[b] * 1.2);
      const py = -1 + barPeak[b] * 1.2;
      quad(x0, x1, py + cap, py + cap * 2);
    }
    return n / 2;
  }

  private frame(now: number) {
    const gl = this.gl!, prog = this.prog!;
    this.resize();
    const t = now / 1000;
    const p = PRESETS[this.preset];

    this.source.read(this.wave, this.freq);
    let b = 0;
    for (let i = 1; i <= 8; i++) b += this.freq[i];
    b /= 8 * 255;
    // The spectrum is on a decibel scale, so the bass reading sits high all the
    // time; what moves the picture is how far it jumps above its recent average.
    const kick = Math.min(1, Math.max(0, b - this.bassAvg) * 5);
    this.bass += (kick - this.bass) * 0.35;
    this.bassAvg += (b - this.bassAvg) * 0.02;
    // Quiet and loud tracks should draw the same size waveform: follow the recent peak.
    let peak = 0;
    for (let i = 0; i < this.wave.length; i += 4) peak = Math.max(peak, Math.abs(this.wave[i] - 128) / 128);
    this.level = Math.max(peak, this.level * 0.995);
    this.gain = 0.7 / Math.max(this.level, 0.05);
    // Move on at a beat once the preset has had its time (or regardless, a while after that).
    const age = (now - this.presetSince) / 1000;
    if (this.auto && ((age > PRESET_SECONDS && kick > 0.4) || age > PRESET_SECONDS * 1.5)) this.next();
    const pal = PALETTES[this.palette];
    const waveMode = this.waveMode ?? p.wave;

    const src = this.cur, dst = 1 - this.cur;
    gl.viewport(0, 0, this.w, this.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]);
    gl.enableVertexAttribArray(0);

    // 1. last frame, bent and dimmed
    gl.disable(gl.BLEND);
    gl.useProgram(prog.warp);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[src]);
    const u = (name: string, v: number) => gl.uniform1f(gl.getUniformLocation(prog.warp, name), v);
    u('t', t % 1000); u('aspect', this.w / this.h); u('bass', this.bass);
    u('zoom', p.zoom); u('rot', p.rot); u('swirl', p.swirl); u('ripple', p.ripple);
    u('warp', p.warp); u('decay', p.decay); u('shift', pal.wave ? 0 : p.shift);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 2. the live waveform on top, a few passes a pixel apart so the line is thick
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(prog.wave);
    const hue = t * 0.07;
    const wc = pal.wave ?? [0, 0.33, 0.67].map((o) => 0.35 + 0.35 * Math.cos(6.283 * (hue + o)));
    gl.uniform3f(gl.getUniformLocation(prog.wave, 'color'), wc[0], wc[1], wc[2]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.line);
    const off = gl.getUniformLocation(prog.wave, 'off');
    const px = 2 / this.w, py = 2 / this.h;
    for (const mirror of waveMode === 2 ? [false, true] : [false]) {
      const n = this.shape(waveMode, t, mirror);
      gl.bufferData(gl.ARRAY_BUFFER, this.verts, gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      for (const [ox, oy] of [[0, 0], [px, 0], [0, py]]) {
        gl.uniform2f(off, ox, oy);
        gl.drawArrays(gl.LINE_STRIP, 0, n);
      }
    }

    // 3. to the screen
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(prog.show);
    gl.uniform1f(gl.getUniformLocation(prog.show, 'mirror'), this.mirror ? 1 : 0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[dst]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 4. spectrum bars straight onto the screen, not into the feedback: they stay crisp,
    //    and solid bars would otherwise smear until they flood the picture
    if (this.bars) {
      const n = this.barShape();
      gl.useProgram(prog.bars);
      (['low', 'mid', 'high'] as const).forEach((name, k) =>
        gl.uniform3f(gl.getUniformLocation(prog.bars, name), pal.bars[k][0], pal.bars[k][1], pal.bars[k][2]));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.line);
      gl.bufferData(gl.ARRAY_BUFFER, this.barVerts, gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, n);
    }
    this.cur = dst;
  }
}

/** Made-up audio for looking at FX in a plain browser (`?fxdemo`), where nothing can play. */
export const demoSource: FxSource = {
  read(wave, freq) {
    const t = performance.now() / 1000;
    const beat = Math.pow(1 - ((t * 2) % 1), 3);
    for (let i = 0; i < wave.length; i++) {
      const x = i / wave.length;
      const s = Math.sin(x * 20 + t * 5) * 0.35 + Math.sin(x * 57 - t * 9) * 0.2 * beat + Math.sin(x * 131 + t * 3) * 0.1;
      wave[i] = 128 + s * 127 * (0.5 + beat * 0.5);
    }
    for (let i = 0; i < freq.length; i++) {
      freq[i] = 70 + (i < 10 ? 150 * beat : 90 * Math.exp(-i / 120) * (0.6 + 0.4 * Math.sin(i * 0.35 + t * 4)));
    }
  },
};
