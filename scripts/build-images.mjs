// Generate the app's icon and social-card images from the source artwork.
//
// The sources are large on purpose - 500-650px icons and a ~3000px screenshot -
// because they are the masters. What gets shipped is derived from them here, at
// the sizes each target actually needs, rather than serving a 223 KB favicon
// and a 920 KB social card.
//
// Sources live in assets-src/ for the same reason the demo model's does: Vite
// copies everything under public/ into dist verbatim, so keeping masters there
// would ship both the master and the derivative to every visitor.
//
// Usage: npm run images

import sharp from 'sharp';
import { statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

const SRC = 'assets-src';
const OUT = 'public';

await mkdir(OUT, { recursive: true });

/**
 * Each target, and why it is that size:
 *
 * - favicon-32: the browser tab. Anything larger is downscaled by the browser
 *   at every paint for no gain.
 * - favicon-180: apple-touch-icon, the iOS home-screen size. Taken from
 *   Icon.png rather than favicon.png because iOS composites the icon onto a
 *   solid tile with no transparency, and Icon.png already has its own
 *   background - a transparent source would get an arbitrary one.
 * - icon-512: Android home screen and the general "large icon" slot.
 * - og-image: link previews. 1200x630 is what Open Graph and Twitter both
 *   document; cover-cropping to it loses ~9% of the screenshot's height, which
 *   is the panel's empty margin rather than anything that matters.
 */
const TARGETS = [
  { from: 'favicon.png', to: 'favicon-32.png', width: 32, height: 32, fit: 'contain' },
  { from: 'Icon.png', to: 'favicon-180.png', width: 180, height: 180, fit: 'cover' },
  { from: 'Icon.png', to: 'icon-512.png', width: 512, height: 512, fit: 'cover' },
  { from: 'Screenshot.png', to: 'og-image.png', width: 1200, height: 630, fit: 'cover' },
];

for (const { from, to, width, height, fit } of TARGETS) {
  const source = `${SRC}/${from}`;
  const dest = `${OUT}/${to}`;

  await sharp(source)
    .resize(width, height, {
      fit,
      // Only used by 'contain': keeps a transparent source transparent rather
      // than matting it onto black.
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    // compressionLevel 9 and palette quantisation: these are flat-colour
    // graphics and a screenshot of flat UI, both of which palette well.
    .png({ compressionLevel: 9, palette: true })
    .toFile(dest);

  const before = statSync(source).size;
  const after = statSync(dest).size;
  console.log(
    `${dest.padEnd(26)} ${width}x${height}  `
    + `${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB`,
  );
}
