// One-off asset compression for the bundled demo model.
//
// Measured before choosing a strategy rather than reaching for Draco by
// reflex: of the demo GLB's 4.4 MB, geometry is only ~780 KB while its 13
// textures - every one of them 2048x2048 JPEG - account for ~3.5 MB. So
// geometry compression was never where the win was. Resizing to 1024 and
// re-encoding as WebP is.
//
// 1024 rather than 2048: this is a viewer whose whole pitch is opening
// fast, the subject rarely fills more than half the frame, and the
// difference is invisible at any normal camera distance. WebP rather than
// KTX2/Basis: GLTFLoader supports EXT_texture_webp out of the box, whereas
// toktx needs a separate native CLI that isn't an npm dependency - and the
// download size, not VRAM, is the problem being solved here.
//
// The original stays on disk as assets-src/RTX3090Ti.src.glb so this is
// re-runnable and reviewable. It lives OUTSIDE public/ deliberately: Vite
// copies everything under public/ into dist verbatim, so keeping the
// pristine 4.4 MB source next to the compressed one shipped both to every
// visitor - which is exactly the cost this script exists to remove.
// (Caught by measuring the built dist rather than trusting the script.)
//
// Usage: npm run assets

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, prune, dedup } from '@gltf-transform/functions';
import sharp from 'sharp';
import { statSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';

const SOURCE = 'assets-src/RTX3090Ti.src.glb';
const ORIGINAL = 'public/model/RTX3090Ti.glb';
const MAX_TEXTURE_SIZE = 1024;

// First run promotes the shipped file to be the pristine source, so re-runs
// never compress an already-compressed file (which would degrade it further
// every time).
if (!existsSync(SOURCE)) {
  mkdirSync('assets-src', { recursive: true });
  copyFileSync(ORIGINAL, SOURCE);
  console.log(`kept original as ${SOURCE}`);
}

const before = statSync(SOURCE).size;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(SOURCE);

await doc.transform(
  dedup(),
  prune(),
  textureCompress({
    encoder: sharp,
    targetFormat: 'webp',
    resize: [MAX_TEXTURE_SIZE, MAX_TEXTURE_SIZE],
  }),
);

await io.write(ORIGINAL, doc);

const after = statSync(ORIGINAL).size;
const pct = Math.round((1 - after / before) * 100);
console.log(
  `${ORIGINAL}: ${(before / 1024 / 1024).toFixed(2)} MB -> ${(after / 1024 / 1024).toFixed(2)} MB (${pct}% smaller)`,
);
