// Copies the DRACO and Basis/KTX2 decoders out of node_modules into public/,
// so Vite serves them in dev and copies them into dist/ on build.
//
// DRACOLoader.setDecoderPath() and KTX2Loader.setTranscoderPath() take a
// *directory* and fetch several files from it at runtime, so these cannot be
// handled with Vite's `?url` asset imports — they need to exist as real static
// files. Serving them from our own origin rather than a CDN keeps the viewer
// working offline and avoids a third-party request on every compressed model.
//
// Runs automatically via the `predev` / `prebuild` npm scripts.
// public/decoders/ is gitignored: it is generated, never edited.

import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const jobs = [
  {
    from: 'node_modules/three/examples/jsm/libs/draco/gltf/',
    to: 'public/decoders/draco/',
    what: 'DRACO (glTF variant)',
  },
  {
    from: 'node_modules/three/examples/jsm/libs/basis/',
    to: 'public/decoders/basis/',
    what: 'Basis / KTX2 transcoder',
  },
];

for (const { from, to, what } of jobs) {
  if (!existsSync(from)) {
    console.error(`copy-decoders: missing ${from} — is three installed?`);
    process.exitCode = 1;
    continue;
  }
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });
  console.log(`copy-decoders: ${what} -> ${to}`);
}
