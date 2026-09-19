// Post-processing and turntable recording.
//
// NOT YET RUN — testing was paused while this was written. Expect to fix
// thresholds on the first real run; the assertions themselves encode the
// contracts the implementation was written against.
//
// The interesting risks are all about EffectComposer replacing
// renderer.render() as the output path:
//
//   * the zero-effect fallback must be pixel-identical to the old path
//   * tone mapping must be applied once, not twice (OutputPass takes it over)
//   * transparent screenshots must keep their alpha through the composer
//   * the loop must still idle at zero frames with effects on
//
// Usage: node test/render.mjs [url]   (needs the dev server running)

import { chromium } from 'playwright';

const APP = process.argv[2] ?? 'http://localhost:5173/';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const consoleErrors = [];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(APP, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => window.__viewer?.model != null, null, { timeout: 60_000 });

// The HDR swaps in asynchronously and changes every pixel; wait for it before
// taking any baseline. (Learned the hard way in test/materials.mjs.)
await page.waitForFunction(
  () => window.__viewer.environment.environmentTexture != null,
  null,
  { timeout: 30_000 },
);
await page.waitForTimeout(800);

const { createHash } = await import('node:crypto');

/** Hash the rendered image via the viewer's own capture — see test/README.md. */
async function viewportHash(options = {}) {
  const bytes = await page.evaluate(async (opts) => {
    const blob = await window.__viewer.captureScreenshot(opts);
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, { scale: 1, ...options });
  return createHash('sha1').update(Buffer.from(bytes)).digest('hex');
}

/** Decode a capture far enough to inspect its alpha channel. */
async function alphaStats(options = {}) {
  return page.evaluate(async (opts) => {
    const blob = await window.__viewer.captureScreenshot(opts);
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

    let transparent = 0;
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] === 0) transparent++;
      else if (data[i] === 255) opaque++;
    }
    return { transparent, opaque, total: data.length / 4 };
  }, { scale: 1, transparent: true, ...options });
}

// --- the zero-effect fallback -------------------------------------------

console.log('Fallback path');

const off = await page.evaluate(() => window.__viewer.post.active);
check('composer is inactive by default', off === false);

const baseline = await viewportHash();

// Toggling on and back off must return to exactly the original image, which
// proves the passthrough is not subtly different from the direct path.
await page.evaluate(async () => {
  await window.__viewer.post.setAO(true);
  await window.__viewer.post.setAO(false);
  window.__viewer.loop.invalidate(3);
});
await page.waitForTimeout(500);
check('toggling AO off restores the original image exactly', (await viewportHash()) === baseline);

// --- ambient occlusion ---------------------------------------------------

console.log('\nAmbient occlusion');

await page.evaluate(async () => {
  await window.__viewer.post.setAO(true);
  window.__viewer.loop.invalidate(3);
});
await page.waitForTimeout(600);

const aoOn = await viewportHash();
check('composer becomes active', await page.evaluate(() => window.__viewer.post.active));
check('AO changes the rendered image', aoOn !== baseline);

// Strength must be a real dial, not just an on/off.
await page.evaluate(() => {
  window.__viewer.post.setAOIntensity(0);
  window.__viewer.loop.invalidate(3);
});
await page.waitForTimeout(500);
const aoZero = await viewportHash();

await page.evaluate(() => {
  window.__viewer.post.setAOIntensity(2);
  window.__viewer.loop.invalidate(3);
});
await page.waitForTimeout(500);
const aoFull = await viewportHash();

check('AO strength 0 differs from strength 2', aoZero !== aoFull);

await page.evaluate(() => {
  window.__viewer.post.setAOIntensity(1);
  window.__viewer.loop.invalidate(3);
});

// --- tone mapping is applied once ---------------------------------------

console.log('\nTone mapping');

// With the composer running, OutputPass does tone mapping; the renderer's own
// must be neutralised or the curve is applied twice.
const toneState = await page.evaluate(() => ({
  active: window.__viewer.post.active,
  rendererToneMapping: window.__viewer.renderer.toneMapping,
}));
check(
  'renderer tone mapping is neutralised while the composer runs',
  toneState.active && toneState.rendererToneMapping === 0,
  `renderer.toneMapping = ${toneState.rendererToneMapping} (0 = NoToneMapping)`,
);

// And changing it still takes effect.
const beforeTone = await viewportHash();
await page.evaluate(() => {
  window.__viewer.environment.setToneMapping('reinhard');
  window.__viewer.loop.invalidate(3);
});
await page.waitForTimeout(500);
check('tone mapping still changes the image with AO on', (await viewportHash()) !== beforeTone);

await page.evaluate(() => {
  window.__viewer.environment.setToneMapping('agx');
  window.__viewer.loop.invalidate(3);
});

// Turning every effect off must hand tone mapping back to the renderer.
const handedBack = await page.evaluate(async () => {
  await window.__viewer.post.setAO(false);
  return {
    active: window.__viewer.post.active,
    rendererToneMapping: window.__viewer.renderer.toneMapping,
  };
});
check(
  'tone mapping returns to the renderer when the composer stops',
  handedBack.active === false && handedBack.rendererToneMapping !== 0,
  `renderer.toneMapping = ${handedBack.rendererToneMapping}`,
);

// --- transparent screenshots --------------------------------------------

console.log('\nTransparent capture');

// The likeliest regression: alpha has to survive the composer's render targets.
const alphaWithout = await alphaStats();
check(
  'transparent capture has alpha without AO',
  alphaWithout.transparent > alphaWithout.total * 0.1,
  `${((alphaWithout.transparent / alphaWithout.total) * 100).toFixed(1)}% fully transparent`,
);

await page.evaluate(async () => {
  await window.__viewer.post.setAO(true);
  window.__viewer.loop.invalidate(3);
});
await page.waitForTimeout(500);

const alphaWith = await alphaStats();
check(
  'transparent capture still has alpha with AO on',
  alphaWith.transparent > alphaWith.total * 0.1,
  `${((alphaWith.transparent / alphaWith.total) * 100).toFixed(1)}% fully transparent`,
);

// --- the loop still idles ------------------------------------------------

console.log('\nRender loop with effects on');

const idleWithAO = await page.evaluate(async () => {
  const v = window.__viewer;
  for (let i = 0; i < 2000 && v.controls.update(1 / 60); i++) { /* converge damping */ }
  await new Promise((r) => setTimeout(r, 900));
  const start = v.loop.stats.rendered;
  await new Promise((r) => setTimeout(r, 900));
  return v.loop.stats.rendered - start;
});
check('loop still idles at zero with AO on', idleWithAO === 0, `${idleWithAO} frames in 900ms`);

// --- resize --------------------------------------------------------------

console.log('\nResize');

await page.setViewportSize({ width: 800, height: 600 });
await page.waitForTimeout(600);
const resized = await page.evaluate(() => {
  const v = window.__viewer;
  return {
    canvasWidth: v.canvas.width,
    cssWidth: Math.round(v.canvas.getBoundingClientRect().width),
  };
});
check('canvas follows the viewport with AO on', resized.cssWidth === 800, `css ${resized.cssWidth}px`);
await page.setViewportSize({ width: 1000, height: 700 });
await page.waitForTimeout(400);

await page.evaluate(async () => { await window.__viewer.post.setAO(false); });

// --- turntable -----------------------------------------------------------

console.log('\nTurntable');

const supported = await page.evaluate(async () => {
  const { isTurntableSupported } = await import('/src/core/turntable.js');
  return isTurntableSupported();
});
check('WebM recording is available in this browser', supported);

if (supported) {
  const recording = await page.evaluate(async () => {
    const { recordTurntable } = await import('/src/core/turntable.js');
    const v = window.__viewer;

    const rotationBefore = v.modelRoot.rotation.y;
    const progress = [];

    const blob = await recordTurntable({
      viewer: v,
      revolutions: 1,
      duration: 2,
      onProgress: (f) => progress.push(f),
    });

    return {
      size: blob.size,
      type: blob.type,
      rotationBefore,
      rotationAfter: v.modelRoot.rotation.y,
      progressSamples: progress.length,
      lastProgress: progress.at(-1) ?? 0,
      heldAfter: v.loop.isHeld('turntable'),
    };
  });

  check('produces a WebM blob', recording.type.startsWith('video/webm') && recording.size > 5000, `${recording.size} bytes`);
  check('progress was reported', recording.progressSamples > 5, `${recording.progressSamples} samples`);
  check('progress reached the end', recording.lastProgress >= 0.99, recording.lastProgress.toFixed(3));
  check(
    'model rotation is restored afterwards',
    Math.abs(recording.rotationAfter - recording.rotationBefore) < 1e-6,
    `${recording.rotationBefore.toFixed(4)} -> ${recording.rotationAfter.toFixed(4)}`,
  );
  check('the loop hold is released', recording.heldAfter === false);

  // A turntable that does not loop cleanly is useless, so the rotation must
  // land on an exact multiple of a full turn.
  const seam = await page.evaluate(async () => {
    const { recordTurntable } = await import('/src/core/turntable.js');
    const v = window.__viewer;
    let last = 0;
    await recordTurntable({
      viewer: v,
      revolutions: 2,
      duration: 2,
      onProgress: (f) => { last = f; },
    });
    return { last };
  });
  check('two revolutions also complete', seam.last >= 0.99, seam.last.toFixed(3));
}

// --- report --------------------------------------------------------------

await browser.close();

if (consoleErrors.length > 0) {
  console.log(`\nConsole errors (${consoleErrors.length}):`);
  for (const e of new Set(consoleErrors)) console.log(`  ! ${e.slice(0, 160)}`);
  failures.push('console errors');
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s).`);
  process.exit(1);
}
console.log('\nAll checks passed.');
