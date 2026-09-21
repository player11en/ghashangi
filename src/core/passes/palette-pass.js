// Retro palette pass: pixelation + a fixed console-style palette + ordered
// dithering, combined in one shader pass rather than three separate ones.
//
// three r186 ships RenderPixelatedPass, but it's the wrong shape for this
// pipeline - checked its source before using it: it replaces RenderPass
// entirely (it renders the scene itself, at reduced internal resolution,
// with its own normal/depth edge-detection passes), which only makes sense
// as the *first* pass in a composer. Here it would need to sit after GTAO/
// SMAA/Bloom, filtering an already-rendered image - which is a UV-grid
// resample of the existing frame, not a re-render. That's a small, ordinary
// ShaderPass, not RenderPixelatedPass's job.
//
// A real fixed palette and ordered dithering are new work - the CRTTV
// reference project's own posterization (per-channel level reduction) does
// not produce either: posterizing each channel independently produces
// colors that were never in a real console's palette, and produces visible
// flat-color banding that ordered dithering exists specifically to break up.

const paletteVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

// Up to 16 palette entries; unused slots repeat the last real color so the
// nearest-color search below never picks a slot no one set.
const MAX_PALETTE_SIZE = 16;

const paletteFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float pixelSize;
uniform vec3 palette[${MAX_PALETTE_SIZE}];
uniform int paletteSize;
uniform float ditherStrength;

varying vec2 vUv;

// Standard 4x4 Bayer matrix, normalized to 0..1 and re-centered to -0.5..0.5
// so it can be added as dither noise rather than used as a hard threshold -
// applied before quantization so flat gradients break into a dot pattern
// instead of banding.
float bayer4x4(vec2 fragCoord){
    int x = int(mod(fragCoord.x, 4.0));
    int y = int(mod(fragCoord.y, 4.0));
    mat4 bayer = mat4(
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0,  5.0, 13.0
    );
    float value = bayer[y][x];
    return value / 16.0 - 0.5;
}

vec3 nearestPaletteColor(vec3 color){
    float bestDist = 1e9;
    vec3 best = palette[0];
    for (int i = 0; i < ${MAX_PALETTE_SIZE}; i++){
        if (i >= paletteSize) break;
        float d = distance(color, palette[i]);
        if (d < bestDist){
            bestDist = d;
            best = palette[i];
        }
    }
    return best;
}

void main(){
    // Pixelation: snap the sample point to a coarse grid in screen pixels,
    // so a block of source pixels shares one sampled color.
    vec2 pixels = uResolution / max(pixelSize, 1.0);
    vec2 blockUv = (floor(vUv * pixels) + 0.5) / pixels;

    vec3 color = texture2D(tDiffuse, blockUv).rgb;

    // Ordered dither before quantization - one dither cell per output block,
    // not per source pixel, so the dither pattern reads as part of the
    // pixel art rather than a texture crawling underneath it.
    float dither = bayer4x4(floor(vUv * pixels)) * ditherStrength;
    color = clamp(color + dither, 0.0, 1.0);

    color = nearestPaletteColor(color);

    gl_FragColor = vec4(color, 1.0);
}
`;

function paddedPalette(colors) {
  const flat = [];
  const last = colors.at(-1) ?? [0, 0, 0];
  for (let i = 0; i < MAX_PALETTE_SIZE; i++) {
    const c = colors[i] ?? last;
    flat.push(c[0], c[1], c[2]);
  }
  return flat;
}

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createPaletteShader() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: [1, 1] },
      pixelSize: { value: 4 },
      palette: { value: paddedPalette(PALETTES.gba) },
      paletteSize: { value: PALETTES.gba.length },
      ditherStrength: { value: 0.06 },
    },
    vertexShader: paletteVertexShader,
    fragmentShader: paletteFragmentShader,
  };
}

// Colors as [r,g,b] in 0..1. Curated approximations, not licensed hardware
// data - the goal is "reads as that console," not color-accurate emulation.
export const PALETTES = {
  // Game Boy Color-ish: 4-shade green ramp.
  gba: [
    [0.06, 0.22, 0.06],
    [0.19, 0.38, 0.19],
    [0.55, 0.68, 0.06],
    [0.61, 0.74, 0.06],
  ],
  // A 16-color approximation in the spirit of the Genesis/Mega Drive's
  // per-scanline palette limits - not its literal 512-color space.
  genesis: [
    [0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.8, 0.2, 0.2], [0.2, 0.8, 0.2],
    [0.2, 0.2, 0.8], [0.9, 0.9, 0.2], [0.9, 0.5, 0.1], [0.6, 0.2, 0.8],
    [0.2, 0.8, 0.8], [0.9, 0.4, 0.6], [0.4, 0.3, 0.2], [0.7, 0.7, 0.7],
    [0.3, 0.3, 0.3], [0.5, 0.9, 0.3], [0.1, 0.4, 0.7], [0.9, 0.8, 0.6],
  ],
  // Atari 2600-ish: a small, chunky, low-saturation set.
  atari: [
    [0.0, 0.0, 0.0], [0.8, 0.8, 0.8], [0.7, 0.3, 0.1], [0.1, 0.5, 0.7],
    [0.6, 0.6, 0.1], [0.3, 0.6, 0.2], [0.6, 0.2, 0.5], [0.8, 0.5, 0.2],
  ],
};

export function applyPalette(pass, name) {
  const colors = PALETTES[name];
  if (!colors || !pass) return;
  pass.uniforms.palette.value = paddedPalette(colors);
  pass.uniforms.paletteSize.value = colors.length;
}
