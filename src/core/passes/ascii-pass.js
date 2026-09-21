// ASCII render mode (Track 4.5) - deferred through Tracks 4 and 5 for a
// reason: the reference implementations both explored for this app
// (three.js's own examples/jsm/effects/AsciiEffect.js, and the separate
// "Asscii" reference project's adaptation of it) render to a DOM <table>
// of text, replacing the canvas entirely. That's incompatible with this
// app's whole pipeline - EffectComposer expects a render target, and
// canvas.captureStream() (what every recording in this app uses) needs an
// actual <canvas>, not a table of styled <span>s. A DOM-table renderer
// can be looked at, but not exported.
//
// This is a real ShaderPass instead: a font atlas (a monospace character
// ramp baked to a canvas texture once, synchronously - no network fetch,
// no async build step unlike the WASM-backed passes elsewhere in this
// folder) sampled per-cell based on that cell's luminance. Composer- and
// capture-compatible like everything else in this app, because it never
// leaves the canvas/render-target world the DOM approach abandons.
//
// Ramp order encodes a deliberate choice, not an arbitrary string: this
// pass always composites to black wherever a glyph is "off" (see the
// shader's `color = fg * glyph`), which is a phosphor-terminal look, not
// print-on-paper. So the default ramps run sparse-for-dark to dense-for-
// bright (space for shadow, '@' for a highlight) - a bright source pixel
// "lights up" more character, matching how a real terminal or CRT actually
// looks, rather than the inverse convention print-based ASCII art uses.
// `invert` exists for that inverse look when someone wants it.

import { CanvasTexture, NearestFilter, ClampToEdgeWrapping } from 'three';

const asciiVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

const asciiFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform sampler2D uFontAtlas;
uniform vec2 uResolution;
uniform float cellSize;
uniform float rampLength;
uniform float colorize;
uniform float invert;

varying vec2 vUv;

float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

void main(){
    vec2 pixel = vUv * uResolution;
    vec2 cellOrigin = floor(pixel / cellSize) * cellSize;

    // Luminance sampled once at the cell's center, not averaged across it -
    // the standard real-time-ASCII shortcut, and cheap enough to run every
    // frame at typical cell sizes without a separate downsample pass.
    vec2 cellCenterUv = (cellOrigin + cellSize * 0.5) / uResolution;
    vec3 srcColor = texture2D(tDiffuse, cellCenterUv).rgb;

    float l = luma(srcColor);
    if (invert > 0.5) l = 1.0 - l;
    float charIndex = min(floor(l * rampLength), rampLength - 1.0);

    vec2 withinCell = (pixel - cellOrigin) / cellSize;
    // uFontAtlas has flipY disabled at upload (see buildFontAtlas) so this
    // maps directly to the canvas's own row order.
    vec2 atlasUv = vec2((charIndex + withinCell.x) / rampLength, withinCell.y);
    float glyph = texture2D(uFontAtlas, atlasUv).r;

    vec3 fg = colorize > 0.5 ? srcColor : vec3(1.0);
    gl_FragColor = vec4(fg * glyph, 1.0);
}
`;

// Curated presets rather than requiring everyone to type their own ramp -
// "Custom Chars" (a free-text ramp) is still offered, matching the
// reference catalog's own "seven built-in character sets, and you can
// type your own."
export const ASCII_RAMPS = {
  classic: ' .:-=+*#%@',
  blocks: ' ░▒▓█',
  binary: ' 01',
  matrix: ' .,-~:;=!*#$@ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘ',
};

const atlasCache = new Map();

/**
 * Bake a character ramp to a canvas texture: `ramp.length` cells side by
 * side, one glyph per cell, white-on-black (the shader treats the red
 * channel as "how much glyph is here," not a literal color).
 *
 * @param {string} ramp
 * @param {number} [cellPixels=48]  Resolution baked per cell - independent
 *   of the on-screen cell size (`cellSize` uniform), which is a display
 *   choice; this only affects glyph crispness.
 */
function buildFontAtlas(ramp, cellPixels = 48) {
  const cached = atlasCache.get(ramp);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = ramp.length * cellPixels;
  canvas.height = cellPixels;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.font = `${Math.floor(cellPixels * 0.85)}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < ramp.length; i++) {
    ctx.fillText(ramp[i], i * cellPixels + cellPixels / 2, cellPixels * 0.54);
  }

  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  // Predictable row order for the shader's cell math, rather than reasoning
  // about three's default upload flip on top of it.
  texture.flipY = false;
  texture.needsUpdate = true;

  atlasCache.set(ramp, texture);
  return texture;
}

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createAsciiShader() {
  const ramp = ASCII_RAMPS.classic;
  return {
    uniforms: {
      tDiffuse: { value: null },
      uFontAtlas: { value: buildFontAtlas(ramp) },
      uResolution: { value: [1, 1] },
      cellSize: { value: 12 },
      rampLength: { value: ramp.length },
      colorize: { value: 0 },
      invert: { value: 0 },
    },
    vertexShader: asciiVertexShader,
    fragmentShader: asciiFragmentShader,
  };
}

/** Switch to a named preset ramp, or a custom string when name is 'custom'. */
export function setAsciiRamp(pass, name, customRamp) {
  if (!pass) return;
  const ramp = name === 'custom' ? (customRamp || ' .#').trim() || ' .#' : (ASCII_RAMPS[name] ?? ASCII_RAMPS.classic);
  pass.uniforms.uFontAtlas.value = buildFontAtlas(ramp);
  pass.uniforms.rampLength.value = ramp.length;
}
