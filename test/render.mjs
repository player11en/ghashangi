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

// Correction after the first real run: this used to assert renderer.
// toneMapping === NoToneMapping while the composer was active, on the theory
// that OutputPass double-applies otherwise. That theory was wrong, and the
// "fix" it justified was the actual bug — post.js's first version forced
// NoToneMapping for the *entire* composer.render() call, which also blinded
// OutputPass (it reads that same property), so the curve was never applied at
// all. The real mechanism, in three's own WebGLPrograms.js: a standard
// material only gets tone-mapped when rendered straight to the canvas
// (`currentRenderTarget === null`); RenderPass renders into an off-screen
// buffer, so scene materials are structurally guaranteed NoToneMapping there
// regardless of renderer.toneMapping. OutputPass is the pass that writes to
// the real canvas and separately, explicitly reads renderer.toneMapping to
// choose its curve. The two cannot fight, and post.js now leaves
// renderer.toneMapping alone entirely — it should read as the real,
// unmodified user setting at all times, active or not.
const toneState = await page.evaluate(() => ({
  active: window.__viewer.post.active,
  rendererToneMapping: window.__viewer.renderer.toneMapping,
}));
check(
  'renderer tone mapping holds the real value while the composer runs',
  toneState.active && toneState.rendererToneMapping !== 0,
  `renderer.toneMapping = ${toneState.rendererToneMapping} (0 would mean something blinded it)`,
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

async function settle(ms = 500) {
  await page.evaluate(() => window.__viewer.loop.invalidate(3));
  await page.waitForTimeout(ms);
}

// --- depth of field (Track 6.1) -------------------------------------------
//
// DOF lives in the fidelity band next to AO/AA rather than in the reorderable
// Style chain, because BokehPass renders its own depth pass - it needs real
// scene depth, which no longer exists once a Style pass has rewritten the
// image. So it gets AO's checks, not the Style chain's.

console.log('\nDepth of field');

// The focus distance must arrive seeded from the subject, not left at the
// module default: a slider you have to hunt across three times before the
// image looks focused is worse than no feature. Regression guard for a real
// bug found while building this - bindSlider()'s initial apply() marked focus
// as user-touched at wiring time, before any model existed, which suppressed
// the seeding permanently.
const dofSeed = await page.evaluate(() => ({
  focus: window.__viewer.post.dofFocus,
  radius: window.__viewer.bounds?.radius ?? null,
}));
check(
  'DOF focus is seeded from the subject, not left at the default',
  dofSeed.radius !== null && Math.abs(dofSeed.focus - dofSeed.radius * 2.2) < 0.01,
  `focus ${dofSeed.focus}, radius ${dofSeed.radius}`,
);

await page.evaluate(async () => { await window.__viewer.post.setDof(true); });
await settle(600);
const dofOn = await viewportHash();
check('DOF changes the rendered image', dofOn !== baseline);
check('composer is active with DOF alone', await page.evaluate(() => window.__viewer.post.active));

// Aperture must be a real dial, same standard AO's intensity is held to.
await page.evaluate(() => window.__viewer.post.setDofAperture(0));
await settle();
const dofNoAperture = await viewportHash();

await page.evaluate(() => window.__viewer.post.setDofAperture(0.02));
await settle();
check('DOF aperture 0 differs from a wide aperture', dofNoAperture !== (await viewportHash()));

// The same fallback guarantee AO and every Style pass carry.
await page.evaluate(async () => { await window.__viewer.post.setDof(false); });
await settle();
check('toggling DOF off restores the original image exactly', (await viewportHash()) === baseline);
await page.evaluate(() => window.__viewer.post.setDofAperture(0.002));

// --- global settings reset (Phase 7) --------------------------------------
//
// The same pixel-exact guarantee every individual pass carries, applied to the
// whole panel at once: mutate a spread of unrelated controls, reset, and the
// image has to land back on the untouched baseline. This is the check that
// makes the reset trustworthy enough to reach for after over-cranking a setup,
// which is the only reason it exists.

console.log('\nSettings reset');

// Driven through the DOM, not the viewer API, and that distinction is the
// whole point: reset works by replaying index.html's own values back through
// the same events a real edit fires. An earlier version of this test cranked
// everything via window.__viewer directly, which left the engine enabled while
// the checkboxes stayed false - so reset had nothing to undo and the checks
// below passed vacuously while the image stayed wrong. Drive the controls the
// way a person does, or this proves nothing.
async function setControl(id, value) {
  await page.evaluate(([elId, v]) => {
    const el = document.getElementById(elId);
    el.value = String(v);
    el.dispatchEvent(new Event('input'));
  }, [id, value]);
}

await page.evaluate(() => document.getElementById('bloomToggle').click());
await page.evaluate(() => document.getElementById('pixelateToggle').click());
// Both toggles lazy-load their pass modules, so wait for the engine to catch up
// with the clicks rather than assuming it already has.
await page.waitForFunction(() => window.__viewer.post.styleEffectCount === 2, null, { timeout: 20_000 });

// Bloom threshold is in here deliberately: it was implemented and unreachable
// until Phase 7, so nothing had ever verified it changes the image at all.
await setControl('bloomThreshold', 0);
await setControl('bloomStrength', 1.5);
await setControl('ambientSlider', 2.4);
await setControl('leftColor', '#00ff00');
await setControl('pixelateSize', 24);
await settle(700);

const cranked = await viewportHash();
check('an over-cranked setup changes the image', cranked !== baseline);

// Threshold 0 vs 1 with everything else held still - the control that decides
// what blooms, rather than how much.
await setControl('bloomThreshold', 1);
await settle();
check('bloom threshold 0 differs from threshold 1', (await viewportHash()) !== cranked);

const resetState = await page.evaluate(() => {
  window.__settingsReset();
  return {
    bloomOn: document.getElementById('bloomToggle').checked,
    pixelateOn: document.getElementById('pixelateToggle').checked,
    ambient: document.getElementById('ambientSlider').value,
    leftColor: document.getElementById('leftColor').value,
    threshold: document.getElementById('bloomThreshold').value,
  };
});
// Reset unchecks toggles via .click(), whose handlers are async.
await page.waitForFunction(() => window.__viewer.post.styleEffectCount === 0, null, { timeout: 20_000 });
await settle(700);

check('reset unchecks the effects it turned on',
  resetState.bloomOn === false && resetState.pixelateOn === false,
  `bloom ${resetState.bloomOn}, pixelate ${resetState.pixelateOn}`);
check('reset restores slider values', resetState.ambient === '0.3' && resetState.threshold === '0.7',
  `ambient ${resetState.ambient}, threshold ${resetState.threshold}`);
check('reset restores colour pickers', resetState.leftColor === '#b2b2ff', resetState.leftColor);
check('reset returns the image to the baseline exactly', (await viewportHash()) === baseline);

// --- style effects (Track 4.3/4.4) ----------------------------------------
//
// Same fallback guarantee as AO: cycling every Style effect on and back off
// must land pixel-identical to the untouched baseline, or the pipeline is
// leaking state between the composer path and the direct-render fallback.
// Each check re-converges damping (loop.invalidate + a real wait) before
// capturing - skipping that produced a false "doesn't restore exactly"
// result while this was being written, traced to OrbitControls damping
// still settling between two back-to-back captures, not to anything these
// passes did. Worth the extra few lines per check to not repeat that.

console.log('\nStyle effects');

await page.evaluate(async () => { await window.__viewer.post.setCrt(true); });
await settle();
const crtOn = await viewportHash();
check('CRT changes the rendered image', crtOn !== baseline);

await page.evaluate(() => window.__viewer.post.setCrtPreset('vhs'));
await settle();
check('CRT preset change changes the rendered image', (await viewportHash()) !== crtOn);
await page.evaluate(async () => { await window.__viewer.post.setCrt(false); });

await page.evaluate(async () => { await window.__viewer.post.setBloom(true); });
await settle();
check('Bloom changes the rendered image', (await viewportHash()) !== baseline);
await page.evaluate(async () => { await window.__viewer.post.setBloom(false); });

await page.evaluate(async () => { await window.__viewer.post.setGlitch(true); });
await settle();
check('Glitch changes the rendered image', (await viewportHash()) !== baseline);
await page.evaluate(async () => { await window.__viewer.post.setGlitch(false); });

await page.evaluate(async () => { await window.__viewer.post.setPalette(true); });
await settle();
const paletteOn = await viewportHash();
check('Palette changes the rendered image', paletteOn !== baseline);

await page.evaluate(() => window.__viewer.post.setPaletteName('genesis'));
await settle();
check('Palette swap changes the rendered image', (await viewportHash()) !== paletteOn);
await page.evaluate(async () => { await window.__viewer.post.setPalette(false); });

// --- Track 5.3: the cheap effect batch ------------------------------------

await page.evaluate(async () => { await window.__viewer.post.setRepeat(true); });
await settle();
const repeatOn = await viewportHash();
check('Repeat changes the rendered image', repeatOn !== baseline);
await page.evaluate(() => window.__viewer.post.setRepeatMode('kaleido'));
await settle();
check('Repeat mode swap changes the rendered image', (await viewportHash()) !== repeatOn);
await page.evaluate(async () => { await window.__viewer.post.setRepeat(false); });

await page.evaluate(async () => { await window.__viewer.post.setColorGrade(true); });
await settle();
const colorGradeOn = await viewportHash();
check('Color grade changes the rendered image', colorGradeOn !== baseline);
await page.evaluate(() => window.__viewer.post.setColorGradeStyle('duotone'));
await settle();
check('Color grade style swap changes the rendered image', (await viewportHash()) !== colorGradeOn);
await page.evaluate(async () => { await window.__viewer.post.setColorGrade(false); });

await page.evaluate(async () => { await window.__viewer.post.setTone(true); });
await settle();
const toneOn = await viewportHash();
check('Tone changes the rendered image', toneOn !== baseline);
await page.evaluate(() => window.__viewer.post.setToneMode('edges'));
await settle();
check('Tone mode swap changes the rendered image', (await viewportHash()) !== toneOn);
await page.evaluate(async () => { await window.__viewer.post.setTone(false); });

await page.evaluate(async () => { await window.__viewer.post.setDisplace(true); });
await settle();
const displaceOn = await viewportHash();
check('Displace changes the rendered image', displaceOn !== baseline);
await page.evaluate(() => window.__viewer.post.setDisplaceMode('wobble'));
await settle();
check('Displace mode swap changes the rendered image', (await viewportHash()) !== displaceOn);
await page.evaluate(async () => { await window.__viewer.post.setDisplace(false); });

await page.evaluate(async () => { await window.__viewer.post.setAfterimage(true); });
await settle();
check('Afterimage/trails changes the rendered image', (await viewportHash()) !== baseline);
await page.evaluate(async () => { await window.__viewer.post.setAfterimage(false); });

// Track 4.5: ASCII, built after being deferred through Tracks 4 and 5
// specifically because the DOM-table approach (three's own AsciiEffect,
// and the separate reference project that adapted it) can't survive
// EffectComposer or canvas.captureStream() - this is a real ShaderPass
// instead, so it gets the same fallback/toggle checks every other pass
// here does, not a different verification story.
await page.evaluate(async () => { await window.__viewer.post.setAscii(true); });
await settle();
const asciiOn = await viewportHash();
check('ASCII changes the rendered image', asciiOn !== baseline);
await page.evaluate(() => window.__viewer.post.setAsciiRamp('blocks'));
await settle();
const asciiBlocks = await viewportHash();
check('ASCII character set swap changes the rendered image', asciiBlocks !== asciiOn);
await page.evaluate(() => window.__viewer.post.setAsciiRamp('custom', ' .oO@'));
await settle();
check('ASCII custom ramp changes the rendered image', (await viewportHash()) !== asciiBlocks);
await page.evaluate(async () => { await window.__viewer.post.setAscii(false); });

// Print reproduction (Dot matrix / CMYK / LinoCut) and film emulation - the
// two families deferred as "bigger asks" back in Track 4's catalog
// evaluation, built once the cheap batch had proven the pass architecture.

await page.evaluate(async () => { await window.__viewer.post.setHalftone(true); });
await settle();
const halftoneDots = await viewportHash();
// LUT (Phase 9). three ships LUTPass and three LUT loaders and none of them
// had ever been used here. The reason this earns a place next to the
// colour-grade pass rather than replacing it: a .cube file is what a colourist
// actually hands over, and no amount of brightness/contrast maths reproduces
// one.
await page.evaluate(async () => { await window.__viewer.post.setLut(true); });
await settle(700);
const lutOn = await viewportHash();
check('LUT changes the rendered image', lutOn !== baseline);

await page.evaluate(() => window.__viewer.post.setLutPreset('bleach'));
await settle();
check('LUT preset swap changes the rendered image', (await viewportHash()) !== lutOn);

// Intensity is a real dial. Deliberately NOT asserted as "intensity 0 is
// byte-identical to no LUT at all": with every effect off the app renders
// straight to the canvas, and enabling any effect switches to the composer
// path (RenderPass -> ... -> OutputPass). Those two paths are not
// bit-for-bit equal and were never claimed to be - measured, intensity 0
// touches ~2% of pixels against the direct path while intensity 1 touches
// ~92%. What matters is that the slider does something across its range, and
// that switching the pass off returns to the direct path exactly, which the
// block at the end of this section already covers for every effect.
await page.evaluate(() => window.__viewer.post.setLutIntensity(0));
await settle();
const lutZero = await viewportHash();
await page.evaluate(() => window.__viewer.post.setLutIntensity(1));
await settle();
check('LUT intensity 0 differs from full strength', lutZero !== (await viewportHash()));

// A real .cube file, parsed through the same path the file picker uses.
const lutFile = await page.evaluate(async () => {
  const text = [
    'TITLE "Test"', 'LUT_3D_SIZE 2',
    '1.0 1.0 1.0', '0.0 1.0 1.0', '1.0 0.0 1.0', '0.0 0.0 1.0',
    '1.0 1.0 0.0', '0.0 1.0 0.0', '1.0 0.0 0.0', '0.0 0.0 0.0',
  ].join('\n');
  const { parseLutFile } = await import('/src/core/passes/lut-pass.js');
  const file = new File([text], 'test.cube', { type: 'text/plain' });
  const { texture, title } = await parseLutFile(file);
  window.__viewer.post.setLutTexture(texture);
  return { title, size: texture.image.width };
});
await settle(700);
check('a .cube file parses into a usable LUT', lutFile.title === 'Test' && lutFile.size === 2,
  `title "${lutFile.title}", size ${lutFile.size}`);
check('a loaded .cube changes the rendered image', (await viewportHash()) !== baseline);

await page.evaluate(async () => { await window.__viewer.post.setLut(false); });
await settle();

check('Halftone changes the rendered image', halftoneDots !== baseline);

await page.evaluate(() => window.__viewer.post.setHalftoneMode('cmyk'));
await settle();
const halftoneCmyk = await viewportHash();
check('CMYK separation differs from dot matrix', halftoneCmyk !== halftoneDots);

await page.evaluate(() => window.__viewer.post.setHalftoneMode('linocut'));
await settle();
check('LinoCut differs from CMYK', (await viewportHash()) !== halftoneCmyk);
await page.evaluate(async () => { await window.__viewer.post.setHalftone(false); });

await page.evaluate(async () => { await window.__viewer.post.setFilm(true); });
await settle();
const filmSuper8 = await viewportHash();
check('Film changes the rendered image', filmSuper8 !== baseline);

// Deliberately NOT a pixel comparison: the film pass animates its grain from
// uTime, so two captures differ frame-to-frame whether or not the preset
// changed anything - a hash check here would pass even if setFilmPreset()
// were a no-op. Driving the real <select> and asserting the sliders followed
// tests the thing that actually has to work, deterministically.
const filmPresetSwap = await page.evaluate(() => {
  const select = document.getElementById('filmPreset');
  const before = document.getElementById('filmGrain').value;
  select.value = 'trashed';
  select.dispatchEvent(new Event('change'));
  const after = document.getElementById('filmGrain').value;
  select.value = 'super8';
  select.dispatchEvent(new Event('change'));
  return { before, after, restored: document.getElementById('filmGrain').value };
});
check(
  'film stock swap rewrites the film sliders',
  filmPresetSwap.after !== filmPresetSwap.before && filmPresetSwap.restored === filmPresetSwap.before,
  `grain ${filmPresetSwap.before} -> ${filmPresetSwap.after} -> ${filmPresetSwap.restored}`,
);
await page.evaluate(async () => { await window.__viewer.post.setFilm(false); });

await settle();
check('cycling every Style effect off restores the original image exactly', (await viewportHash()) === baseline);

// --- Track 5.2: reorderable Style chain -----------------------------------

const reorder = await page.evaluate(() => {
  const post = window.__viewer.post;
  const original = post.styleOrder;
  const swapped = [...original];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  post.setStyleOrder(swapped);
  const applied = post.styleOrder;
  post.setStyleOrder(original); // restore, so later checks see the default order
  return { original, swapped, applied };
});
check(
  'setStyleOrder() actually permutes the composite order',
  JSON.stringify(reorder.applied) === JSON.stringify(reorder.swapped) &&
    JSON.stringify(reorder.applied) !== JSON.stringify(reorder.original),
  `${reorder.original[0]},${reorder.original[1]} -> ${reorder.applied[0]},${reorder.applied[1]}`,
);

await page.evaluate(async () => {
  const v = window.__viewer;
  await v.post.setCrt(true);
  await v.post.setBloom(true);
});
await settle();
const defaultOrderHash = await viewportHash();
await page.evaluate(() => {
  const post = window.__viewer.post;
  post.setStyleOrder(['glitch', 'crt', 'bloom', 'colorGrade', 'tone', 'palette', 'halftone', 'repeat', 'displace', 'afterimage', 'ascii', 'film']);
});
await settle();
check(
  'reordering CRT/Bloom actually changes the composited image',
  (await viewportHash()) !== defaultOrderHash,
  'CRT-before-Bloom vs Bloom-before-CRT should composite differently',
);
await page.evaluate(async () => {
  const post = window.__viewer.post;
  post.setStyleOrder(['bloom', 'colorGrade', 'tone', 'palette', 'halftone', 'repeat', 'displace', 'afterimage', 'ascii', 'crt', 'film', 'glitch']);
  await post.setCrt(false);
  await post.setBloom(false);
});

const idleWithCrt = await page.evaluate(async () => {
  const v = window.__viewer;
  await v.post.setCrt(true);
  for (let i = 0; i < 2000 && v.controls.update(1 / 60); i++) { /* converge damping */ }
  await new Promise((r) => setTimeout(r, 900));
  const start = v.loop.stats.rendered;
  await new Promise((r) => setTimeout(r, 900));
  const rendered = v.loop.stats.rendered - start;
  await v.post.setCrt(false);
  return rendered;
});
check('loop still idles at zero with CRT on', idleWithCrt === 0, `${idleWithCrt} frames in 900ms`);

// --- turntable -----------------------------------------------------------
//
// Diagnosed on the first real run, before writing any of this: canvas
// .captureStream() + MediaRecorder produce no real frame data under headless
// Chromium + SwiftShader software rendering, independent of turntable.js
// entirely. A standalone repro (captureStream(30) + MediaRecorder with a
// 200ms timeslice, zero app code involved) delivered exactly one
// `dataavailable` event, containing zero bytes, over a 1.5s window that
// should have produced ~7 chunks — confirmed unaffected by --headless=new and
// by --autoplay-policy. This is a known category of headless-testing
// limitation for canvas video capture, not a defect turntable.js could fix.
//
// What IS real app logic, independent of whether MediaRecorder ever gets
// usable frames, and so is still worth a hard check: the render-loop hold
// during recording, and restoring the model's rotation and the hold
// afterwards. onBeforeRender() itself was separately confirmed still ticking
// normally (~18-21/s) under this same environment, so the render-loop wiring
// is not in question — only the browser's media-capture pipeline is.

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

  // Hard checks: real app lifecycle, unaffected by whether the browser's
  // media pipeline cooperates.
  check(
    'model rotation is restored afterwards',
    Math.abs(recording.rotationAfter - recording.rotationBefore) < 1e-6,
    `${recording.rotationBefore.toFixed(4)} -> ${recording.rotationAfter.toFixed(4)}`,
  );
  check('the loop hold is released', recording.heldAfter === false);
  check('resolves with a WebM-typed blob', recording.type.startsWith('video/webm'), recording.type);

  // Diagnostic only, not gated: whether real frame data came through depends
  // on the browser's media pipeline, which this environment cannot exercise
  // (see the note above the loop). Report it so a real regression is still
  // visible without failing the suite on an environment limitation.
  const looksReal = recording.size > 5000 && recording.progressSamples > 5 && recording.lastProgress >= 0.99;
  console.log(
    `  i  frame capture: ${recording.size} bytes, ${recording.progressSamples} progress sample(s), ` +
      `reached ${recording.lastProgress.toFixed(3)} — ${looksReal ? 'looks real' : 'no usable frame data in this environment (expected here; verify manually in a real browser)'}`,
  );
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
