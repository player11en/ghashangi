// Browser smoke test.
//
// `vite build` only proves the module graph resolves. It says nothing about
// whether the app runs — a temporal-dead-zone reference, a null element lookup,
// a three API used with the wrong signature all build cleanly and then throw at
// runtime. Exactly the class of bug that left the original's AR path broken
// (`plane` was never declared) without anyone noticing.
//
// This drives a real Chromium against the dev server, fails on any console error
// or page exception, and asserts the things that were broken before:
// the model loads and is framed, the RectAreaLights actually contribute, the
// render loop idles instead of spinning, and nothing leaks on model swap.
//
// Usage: node test/smoke.mjs [url]
// Assumes a server is already running (npm run dev).

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';

const URL_UNDER_TEST = process.argv[2] ?? 'http://localhost:5173/';
const ARTIFACT_DIR = 'test/artifacts';

const errors = [];
const warnings = [];

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) errors.push(`${name}${detail ? `: ${detail}` : ''}`);
  return ok;
}

const browser = await chromium.launch({
  args: [
    // Headless Chromium has no GPU; SwiftShader gives it a real WebGL2
    // implementation so the renderer, shaders and shadow maps all execute.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

page.on('console', (msg) => {
  const text = msg.text();
  if (msg.type() === 'error') errors.push(`console.error: ${text}`);
  else if (msg.type() === 'warning') warnings.push(text);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

console.log(`Loading ${URL_UNDER_TEST}`);
await page.goto(URL_UNDER_TEST, { waitUntil: 'load', timeout: 60_000 });

// Expose the viewer so assertions can read real state rather than guess from
// pixels. main.js keeps it module-scoped, so reach it through the debug hook.
await page.waitForFunction(() => window.__viewer?.model != null, null, { timeout: 60_000 });

// --- geometry actually arrived -------------------------------------------

const model = await page.evaluate(() => {
  const v = window.__viewer;
  const info = v.renderer.info;
  return {
    hasModel: v.model != null,
    triangles: info.render.triangles,
    calls: info.render.calls,
    textures: info.memory.textures,
    geometries: info.memory.geometries,
    radius: v.bounds?.radius ?? 0,
    cameraDistance: v.camera.position.distanceTo(v.controls.target),
    near: v.camera.near,
    far: v.camera.far,
  };
});

check('model loaded', model.hasModel);
check('triangles rendered', model.triangles > 0, `${model.triangles.toLocaleString()} tris`);
check('draw calls issued', model.calls > 0, `${model.calls} calls`);

// B5: framing. The camera must end up at a distance proportional to the
// subject, not at the hardcoded z=50 the original always used.
check(
  'camera framed to subject',
  model.cameraDistance > model.radius && model.cameraDistance < model.radius * 8,
  `distance ${model.cameraDistance.toFixed(2)} for radius ${model.radius.toFixed(2)}`,
);

// B5: depth range derived from bounds rather than the fixed 0.05/2000.
check(
  'near/far derived from bounds',
  model.near > 0 && model.far > model.near && model.far < 100_000,
  `near ${model.near.toFixed(4)} far ${model.far.toFixed(1)}`,
);

// --- B3: the two RectAreaLight sliders actually affect the image ----------

// This is the assertion that would have caught B3. Introspecting the uniforms
// library would only prove init() was called; comparing rendered pixels proves
// the light reaches the screen, which is what was broken.

const { createHash } = await import('node:crypto');

async function viewportHash() {
  const buffer = await page.locator('canvas').screenshot();
  return createHash('sha1').update(buffer).digest('hex');
}

/** Set a light via the viewer, let it render, and report whether pixels moved. */
async function imageChangesWhen(label, mutate, restore) {
  const before = await viewportHash();
  await page.evaluate(mutate);
  await page.waitForTimeout(350);
  const after = await viewportHash();
  await page.evaluate(restore);
  await page.waitForTimeout(250);
  check(`${label} changes the rendered image`, before !== after);
}

await imageChangesWhen(
  'left fill light',
  () => { window.__viewer.lights.setLeft(28); window.__viewer.loop.invalidate(2); },
  () => { window.__viewer.lights.setLeft(4.5); window.__viewer.loop.invalidate(2); },
);

await imageChangesWhen(
  'right fill light',
  () => { window.__viewer.lights.setRight(28); window.__viewer.loop.invalidate(2); },
  () => { window.__viewer.lights.setRight(2.1); window.__viewer.loop.invalidate(2); },
);

// A control that was already working, as a control for the two above.
await imageChangesWhen(
  'sun light',
  () => { window.__viewer.lights.setSun(5); window.__viewer.loop.invalidate(2); },
  () => { window.__viewer.lights.setSun(1.8); window.__viewer.loop.invalidate(2); },
);

// Shadows are rendered on demand (shadow.autoUpdate = false plus an explicit
// needsUpdate), which is a real perf win and also a real way to accidentally
// render no shadows at all. Toggling must move pixels.
await imageChangesWhen(
  'shadow toggle',
  () => { window.__viewer.setShadowsEnabled(false); window.__viewer.loop.invalidate(2); },
  () => { window.__viewer.setShadowsEnabled(true); window.__viewer.loop.invalidate(2); },
);

// The sun angle slider moves the light, so the shadow must move with it — this
// is what proves the on-demand shadow map is actually being re-rendered rather
// than baked once and left stale.
await imageChangesWhen(
  'sun angle (moves the shadow)',
  () => { window.__viewer.lights.setAngle(200); window.__viewer.loop.invalidate(3); },
  () => { window.__viewer.lights.setAngle(53); window.__viewer.loop.invalidate(3); },
);

// B5 follow-up: normalizeObject() rests the subject's base on y = 0 so it sits
// on the stage floor rather than floating above or sinking through it.
const grounded = await page.evaluate(() => {
  const v = window.__viewer;
  const { box } = v.measure(v.modelRoot);
  return { minY: box.min.y, radius: v.bounds.radius };
});
check(
  'subject rests on the ground plane',
  Math.abs(grounded.minY) < grounded.radius * 0.02,
  `base at y=${grounded.minY.toFixed(4)}`,
);

// --- B2: one loop, and it idles ------------------------------------------

const idle = await page.evaluate(async () => {
  const loop = window.__viewer.loop;
  // Let anything in flight settle, then measure a quiet second.
  await new Promise((r) => setTimeout(r, 900));
  const start = loop.stats.rendered;
  await new Promise((r) => setTimeout(r, 1000));
  return { framesWhileIdle: loop.stats.rendered - start };
});

check(
  'render loop idles when nothing changes',
  idle.framesWhileIdle <= 3,
  `${idle.framesWhileIdle} frames in 1s at rest`,
);

// Orbiting must wake it up again, or on-demand rendering has broken interaction.
const active = await page.evaluate(async () => {
  const loop = window.__viewer.loop;
  const start = loop.stats.rendered;
  window.__viewer.setAutoRotate(true);
  await new Promise((r) => setTimeout(r, 600));
  window.__viewer.setAutoRotate(false);
  return { framesWhileRotating: loop.stats.rendered - start };
});

check(
  'render loop wakes for auto-rotate',
  active.framesWhileRotating > 10,
  `${active.framesWhileRotating} frames in 600ms`,
);

// --- B9: disposal on model swap ------------------------------------------

const leak = await page.evaluate(async () => {
  const v = window.__viewer;
  const before = { ...v.renderer.info.memory };
  for (let i = 0; i < 3; i++) {
    await window.__loadDemo();
  }
  return { before, after: { ...v.renderer.info.memory } };
});

check(
  'geometries do not accumulate across loads',
  leak.after.geometries <= leak.before.geometries + 2,
  `${leak.before.geometries} -> ${leak.after.geometries} after 3 reloads`,
);
check(
  'textures do not accumulate across loads',
  leak.after.textures <= leak.before.textures + 2,
  `${leak.before.textures} -> ${leak.after.textures} after 3 reloads`,
);

// --- B7: controls are safe before anything has loaded --------------------

const guards = await page.evaluate(() => {
  const v = window.__viewer;
  const thrown = [];
  // Exercise the two that used to throw when clicked during startup.
  try { v.setWireframe(true); v.setWireframe(false); } catch (e) { thrown.push(`wireframe: ${e.message}`); }
  try { v.setStageVisible(false); v.setStageVisible(true); } catch (e) { thrown.push(`stage: ${e.message}`); }
  try { v.setShadowsEnabled(false); v.setShadowsEnabled(true); } catch (e) { thrown.push(`shadows: ${e.message}`); }
  return thrown;
});

check('toggles do not throw', guards.length === 0, guards.join('; '));

// --- screenshot capture round-trips --------------------------------------

const shot = await page.evaluate(async () => {
  const blob = await window.__viewer.captureScreenshot({ scale: 1, transparent: false });
  return { size: blob.size, type: blob.type };
});

check('screenshot produces a PNG', shot.type === 'image/png' && shot.size > 1000, `${shot.size} bytes`);

// --- reference image -----------------------------------------------------

await mkdir(ARTIFACT_DIR, { recursive: true });
const reference = await page.locator('canvas').screenshot();
await writeFile(`${ARTIFACT_DIR}/viewport.png`, reference);
console.log(`\nReference image written to ${ARTIFACT_DIR}/viewport.png`);

// --- report --------------------------------------------------------------

await browser.close();

if (warnings.length > 0) {
  console.log(`\n${warnings.length} console warning(s):`);
  for (const w of new Set(warnings)) console.log(`  ! ${w}`);
}

if (errors.length > 0) {
  console.log(`\n${errors.length} failure(s):`);
  for (const e of errors) console.log(`  x ${e}`);
  process.exit(1);
}

console.log('\nAll checks passed.');
