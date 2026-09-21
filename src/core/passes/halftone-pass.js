// Print-reproduction pass: Dot Matrix / CMYK Half-tone / LinoCut.
//
// One shader with a mode dropdown, same shape as the other Style passes -
// all three are the same underlying idea (rebuild the image out of marks on
// a grid, sized or weighted by tone), differing only in what mark they draw
// and how the grid is oriented. Three separate passes would triple the
// full-screen cost for no benefit.
//
// Deliberately distinct from palette-pass.js, which also samples on a grid:
// that one quantizes *color* to a fixed console palette. This one throws
// color away almost entirely and reproduces *tone* as coverage - the
// difference between a Game Boy screenshot and a newspaper photo.
//
// Screen angles in CMYK mode (15/75/0/45 degrees) are the traditional
// print ones: offsetting each separation's screen is what stops the four
// plates forming a moire pattern when overprinted.

const halftoneVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

const halftoneFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float mode;   // 0 dots, 1 cmyk, 2 linocut
uniform float scale;  // cell size in pixels
uniform float angle;
uniform float invert;

varying vec2 vUv;

float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

vec2 rotate(vec2 p, float a){
    float s = sin(a);
    float c = cos(a);
    return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

// Coverage of one screened dot for "value" tone, on a grid rotated by "a".
float screenDot(vec2 pixel, float a, float value, float cell){
    vec2 rotated = rotate(pixel, a) / cell;
    vec2 within = fract(rotated) - 0.5;
    // sqrt keeps apparent density roughly linear in tone: dot *area* is what
    // the eye integrates, and area goes with the square of the radius.
    float radius = sqrt(clamp(value, 0.0, 1.0)) * 0.55;
    return 1.0 - smoothstep(radius - 0.05, radius + 0.05, length(within));
}

void main(){
    vec2 pixel = vUv * uResolution;
    float cell = max(scale, 2.0);

    // Tone is sampled once per cell, not per pixel - otherwise the mark
    // would be shaded by the image inside it rather than representing it.
    vec2 cellCenterUv = (floor(pixel / cell) + 0.5) * cell / uResolution;
    vec3 src = texture2D(tDiffuse, cellCenterUv).rgb;
    float l = luma(src);
    if (invert > 0.5) l = 1.0 - l;

    vec3 color;

    if (mode < 0.5) {
        // Dot Matrix: source-colored dots on black, sized by brightness -
        // the stadium-display reading rather than the printed-page one.
        float ink = screenDot(pixel, angle, l, cell);
        color = src * ink;
    } else if (mode < 1.5) {
        // CMYK half-tone: four separations, each on its own screen angle,
        // overprinted subtractively onto white.
        vec3 cmy = 1.0 - src;
        float k = min(cmy.r, min(cmy.g, cmy.b));
        // Pull the common black out so the colored plates carry only their
        // own ink, the way real process separation does.
        vec3 cmyNoK = (cmy - k) / max(1.0 - k, 0.001);

        float c = screenDot(pixel, angle + 0.2618, cmyNoK.r, cell); // 15 deg
        float m = screenDot(pixel, angle + 1.3090, cmyNoK.g, cell); // 75 deg
        float y = screenDot(pixel, angle, cmyNoK.b, cell);          //  0 deg
        float kk = screenDot(pixel, angle + 0.7854, k, cell);       // 45 deg

        color = vec3(1.0);
        color -= vec3(0.0, c, c) * 0.9; // cyan absorbs red
        color -= vec3(m, 0.0, m) * 0.9; // magenta absorbs green
        color -= vec3(y, y, 0.0) * 0.9; // yellow absorbs blue
        color -= vec3(kk) * 0.9;
        color = clamp(color, 0.0, 1.0);
    } else {
        // LinoCut: carved strokes along "angle", thickening into shadow.
        vec2 rotated = rotate(pixel, angle) / cell;
        float wave = abs(fract(rotated.y) - 0.5) * 2.0;
        float thickness = 1.0 - clamp(l, 0.0, 1.0);
        float ink = 1.0 - smoothstep(thickness - 0.15, thickness + 0.15, wave);
        color = vec3(1.0 - ink);
    }

    gl_FragColor = vec4(color, 1.0);
}
`;

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createHalftoneShader() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: [1, 1] },
      mode: { value: 0 },
      scale: { value: 6 },
      angle: { value: 0 },
      invert: { value: 0 },
    },
    vertexShader: halftoneVertexShader,
    fragmentShader: halftoneFragmentShader,
  };
}

export const HALFTONE_MODES = { dots: 0, cmyk: 1, linocut: 2 };

export function setHalftoneMode(pass, name) {
  const mode = HALFTONE_MODES[name];
  if (mode === undefined || !pass) return;
  pass.uniforms.mode.value = mode;
}
