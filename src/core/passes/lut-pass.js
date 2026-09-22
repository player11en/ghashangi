// Colour grading through real lookup tables.
//
// three ships LUTPass and three LUT loaders (.cube, .3dl, and HALD images) and
// this app had never used any of them. That mattered more than "one more
// effect": a .cube file is the format a colourist actually hands over, and the
// format DaVinci Resolve, Premiere and every camera manufacturer export. Being
// able to drop one in is the difference between "has colour sliders" and "takes
// the same grade as the rest of a pipeline".
//
// colour-grade-pass.js stays as it is and is not replaced by this. They answer
// different questions: that one is live maths on brightness/contrast/hue, which
// is what you want while dialling a look in; this one applies a fixed table
// somebody else authored. A LUT cannot be tweaked by ear and maths cannot
// reproduce a specific film stock, so both earn their place.
//
// The built-in presets exist so the effect does something the moment it is
// switched on. Without them, enabling "LUT" with no file loaded would appear
// broken - a toggle that does nothing until you go and find an asset is a bad
// first experience of a feature. They are generated rather than bundled
// because a 33-cube .cube file is a few hundred KB of text each, and these are
// simple enough to express as functions.

import { Data3DTexture, RGBAFormat, UnsignedByteType, LinearFilter, ClampToEdgeWrapping } from 'three';

/** Resolution of a generated preset. 32 is past the point of visible banding. */
const PRESET_SIZE = 32;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Per-preset colour transforms. Each takes linear-ish 0..1 rgb and returns the
 * graded rgb - the same shape a real LUT encodes, just computed.
 */
const PRESET_TRANSFORMS = {
  // Warm highlights, cool shadows: the most common "cinematic" grade there is.
  teal_orange(r, g, b) {
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const shadow = 1 - luma;
    return [
      clamp01(r + luma * 0.16 - shadow * 0.06),
      clamp01(g + luma * 0.04 + shadow * 0.02),
      clamp01(b - luma * 0.12 + shadow * 0.18),
    ];
  },

  // Bleach bypass: retained silver, so heavy contrast and washed-out colour.
  bleach(r, g, b) {
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const contrast = clamp01((luma - 0.5) * 1.6 + 0.5);
    return [
      clamp01(r * 0.35 + contrast * 0.72),
      clamp01(g * 0.35 + contrast * 0.72),
      clamp01(b * 0.35 + contrast * 0.74),
    ];
  },

  // Warm, slightly lifted blacks - a faded-print look.
  warm(r, g, b) {
    return [
      clamp01(r * 0.95 + 0.07),
      clamp01(g * 0.94 + 0.04),
      clamp01(b * 0.90 + 0.02),
    ];
  },

  // Cool and clean, blacks pushed down.
  cool(r, g, b) {
    return [
      clamp01(r * 0.92 - 0.01),
      clamp01(g * 0.97),
      clamp01(b * 1.04 + 0.02),
    ];
  },

  // Desaturated with a green cast - the "surveillance/sci-fi" look.
  matrix(r, g, b) {
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return [
      clamp01(luma * 0.75 + r * 0.15),
      clamp01(luma * 0.85 + g * 0.25),
      clamp01(luma * 0.70 + b * 0.12),
    ];
  },
};

export const LUT_PRESETS = Object.keys(PRESET_TRANSFORMS);

/**
 * Build a Data3DTexture in the exact layout LUTPass expects.
 *
 * The axis order is load-bearing and is the thing to check first if a grade
 * comes out looking scrambled: the shader samples with `vec3(r, g, b)`, so
 * blue has to be the slowest-varying axis (depth) and red the fastest.
 *
 * @param {string} name  A key of LUT_PRESETS.
 * @returns {Data3DTexture}
 */
export function createPresetLut(name) {
  const transform = PRESET_TRANSFORMS[name] ?? PRESET_TRANSFORMS.teal_orange;
  const size = PRESET_SIZE;
  const data = new Uint8Array(size * size * size * 4);

  let i = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const [r, g, b] = transform(ri / (size - 1), gi / (size - 1), bi / (size - 1));
        data[i++] = Math.round(r * 255);
        data[i++] = Math.round(g * 255);
        data[i++] = Math.round(b * 255);
        data[i++] = 255;
      }
    }
  }

  const texture = new Data3DTexture(data, size, size, size);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  // Linear so the 32-step table interpolates smoothly instead of posterising,
  // and clamped so values at the very ends of the range do not wrap around to
  // the opposite corner of the cube.
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.wrapR = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Parse a user-supplied LUT file into the same kind of texture.
 *
 * Loaded through the loaders' own `parse()` rather than `load()`: the file
 * comes from a file picker as text, so there is nothing to fetch, and going
 * through load() would mean minting an object URL just to read it straight
 * back.
 *
 * @param {File} file
 * @returns {Promise<{texture: Data3DTexture, title: string}>}
 */
export async function parseLutFile(file) {
  const name = file.name.toLowerCase();

  if (name.endsWith('.cube')) {
    const { LUTCubeLoader } = await import('three/addons/loaders/LUTCubeLoader.js');
    const result = new LUTCubeLoader().parse(await file.text());
    return { texture: result.texture3D, title: result.title || file.name };
  }

  if (name.endsWith('.3dl')) {
    const { LUT3dlLoader } = await import('three/addons/loaders/LUT3dlLoader.js');
    const result = new LUT3dlLoader().parse(await file.text());
    return { texture: result.texture3D, title: file.name };
  }

  throw new Error('Unsupported LUT format. Use a .cube or .3dl file.');
}
