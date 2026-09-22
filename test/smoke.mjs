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

/**
 * Hash the rendered image.
 *
 * Deliberately not `page.screenshot()` or `locator.screenshot()`. Both drive
 * Chromium's compositor capture path, which under software rendering
 * (SwiftShader) intermittently never returns for a WebGL canvas fed by an
 * on-demand `setAnimationLoop` — the capture waits for a frame commit that a
 * deliberately idle render loop has no reason to produce.
 *
 * The viewer's own captureScreenshot() renders and reads back inside one
 * synchronous task, which is exactly the guarantee needed here. It also means
 * these assertions exercise the same code path the app's Screenshot button
 * uses, so a regression in capture shows up as a test failure rather than
 * silently passing.
 */
async function viewportHash() {
  const bytes = await page.evaluate(async () => {
    const blob = await window.__viewer.captureScreenshot({ scale: 1 });
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return createHash('sha1').update(Buffer.from(bytes)).digest('hex');
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

// --- S1: orientation -----------------------------------------------------

// Nothing in the original touched model rotation, so a Z-up export (Blender,
// 3ds Max, most CAD, most STL) loaded on its side permanently. The subtle part
// is not the rotation itself but staying grounded: frame.js rests the base on
// y = 0, and rotating afterwards swings half the model below the stage floor
// unless it is re-grounded.

const orientation = await page.evaluate(() => {
  const v = window.__viewer;
  const read = () => ({
    angles: v.orientation.angles,
    preset: v.orientation.preset,
    minY: v.measure(v.modelRoot).box.min.y,
    size: v.measure(v.modelRoot).size.toArray(),
  });

  const authored = read();
  v.orientation.setUpAxis('z');
  const zUp = read();
  v.orientation.reset();
  const afterReset = read();

  return { authored, zUp, afterReset };
});

check(
  'up-axis Z rotates the model',
  orientation.zUp.angles.x === -90,
  `x=${orientation.zUp.angles.x}°, preset=${orientation.zUp.preset}`,
);
check(
  'up-axis Z keeps the base on the floor',
  Math.abs(orientation.zUp.minY) < 0.01,
  `base at y=${orientation.zUp.minY.toFixed(4)}`,
);
check(
  'up-axis Z swaps the Y and Z extents',
  Math.abs(orientation.zUp.size[1] - orientation.authored.size[2]) < 0.01,
  `${orientation.authored.size.map((n) => n.toFixed(1))} -> ${orientation.zUp.size.map((n) => n.toFixed(1))}`,
);
check(
  'reset returns to the authored pose',
  orientation.afterReset.angles.x === 0 &&
    orientation.afterReset.angles.y === 0 &&
    orientation.afterReset.angles.z === 0 &&
    Math.abs(orientation.afterReset.size[1] - orientation.authored.size[1]) < 0.01,
  `preset=${orientation.afterReset.preset}`,
);

// A free rotation on an arbitrary angle must ground just as well as a preset.
const tilted = await page.evaluate(() => {
  const v = window.__viewer;
  v.orientation.setAxis('x', 37);
  const minY = v.measure(v.modelRoot).box.min.y;
  v.orientation.reset();
  return minY;
});
check('an arbitrary tilt still rests on the floor', Math.abs(tilted) < 0.01, `base at y=${tilted.toFixed(4)}`);

// The reason orientation needs its own group: auto-rotate writes
// modelRoot.rotation.y every frame, so a user Y-rotation sharing that Euler
// would be overwritten continuously.
const coexist = await page.evaluate(async () => {
  const v = window.__viewer;
  v.orientation.setAxis('y', 45);
  v.setAutoRotate(true);
  await new Promise((r) => setTimeout(r, 400));
  v.setAutoRotate(false);
  const result = {
    orientationY: v.orientation.angles.y,
    spun: Math.abs(v.modelRoot.rotation.y) > 0.01,
    minY: v.measure(v.modelRoot).box.min.y,
  };
  v.orientation.reset();
  v.modelRoot.rotation.set(0, 0, 0);
  return result;
});

check(
  'auto-rotate does not clobber orientation',
  coexist.orientationY === 45 && coexist.spun,
  `orientation Y still ${coexist.orientationY}°, spin applied`,
);
check(
  'model stays grounded while spinning',
  Math.abs(coexist.minY) < 0.01,
  `base at y=${coexist.minY.toFixed(4)}`,
);

await imageChangesWhen(
  'orientation',
  () => { window.__viewer.orientation.setUpAxis('z'); window.__viewer.loop.invalidate(3); },
  () => { window.__viewer.orientation.reset(); window.__viewer.loop.invalidate(3); },
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
const reference = await page.evaluate(async () => {
  const blob = await window.__viewer.captureScreenshot({ scale: 1 });
  return [...new Uint8Array(await blob.arrayBuffer())];
});
await writeFile(`${ARTIFACT_DIR}/viewport.png`, Buffer.from(reference));
console.log(`\nReference image written to ${ARTIFACT_DIR}/viewport.png`);

// --- frame guide (Phase 8) -----------------------------------------------
//
// A passepartout overlay marking where an export will crop. The two things
// that would make it worse than not having it, and so the two things checked
// hardest: it must not appear in the exported image, and it must not intercept
// a single pointer event. A guide that ends up in the render, or that blocks
// orbiting, is a regression rather than a feature.

console.log('\nFrame guide');

const preGuideShot = await viewportHash();
const preGuideCam = await page.evaluate(() => window.__viewer.camera.position.toArray());

await page.evaluate(() => {
  document.getElementById('frameGuideToggle').click();
  const select = document.getElementById('frameGuideRatio');
  select.value = '9:16';
  select.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(300);

const guide = await page.evaluate(() => {
  const root = document.querySelector('.frame-guide');
  const outline = document.querySelector('.frame-guide-outline').getBoundingClientRect();
  const viewport = document.getElementById('viewport').getBoundingClientRect();
  return {
    visible: !root.hidden,
    ratio: outline.width / outline.height,
    contained: outline.width <= viewport.width + 1 && outline.height <= viewport.height + 1,
    centered: Math.abs((outline.left - viewport.left) - (viewport.right - outline.right)) < 2
      && Math.abs((outline.top - viewport.top) - (viewport.bottom - outline.bottom)) < 2,
    pointerEvents: getComputedStyle(root).pointerEvents,
    sideBar: Math.round(document.querySelector('.frame-guide-left').getBoundingClientRect().width),
    topBar: Math.round(document.querySelector('.frame-guide-top').getBoundingClientRect().height),
  };
});

check('the frame guide shows when enabled', guide.visible);
check(
  'the guide matches the requested ratio',
  Math.abs(guide.ratio - 9 / 16) < 0.01,
  `${guide.ratio.toFixed(4)} vs ${(9 / 16).toFixed(4)}`,
);
check('the guide is contained in the viewport and centred', guide.contained && guide.centered);
check('the guide never intercepts pointer events', guide.pointerEvents === 'none');
check(
  'a portrait ratio dims the sides, not the top',
  guide.sideBar > 0 && guide.topBar === 0,
  `left ${guide.sideBar}px, top ${guide.topBar}px`,
);

// The whole promise of "guide only": the export has to be byte-identical.
check('the guide does not appear in the exported image', (await viewportHash()) === preGuideShot);

// And the canvas underneath still has to be draggable.
await page.mouse.move(400, 350);
await page.mouse.down();
await page.mouse.move(520, 330, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
const orbited = await page.evaluate(
  (before) => window.__viewer.camera.position.toArray().some((n, i) => Math.abs(n - before[i]) > 0.01),
  preGuideCam,
);
check('orbiting still works through the overlay', orbited);

await page.evaluate(() => {
  const select = document.getElementById('frameGuideRatio');
  select.value = 'free';
  select.dispatchEvent(new Event('change'));
  document.getElementById('frameGuideToggle').click();
});
await page.waitForTimeout(200);
check(
  'disabling the guide hides it',
  await page.evaluate(() => document.querySelector('.frame-guide').hidden),
);

// --- saved views (Phase 8) ------------------------------------------------
//
// Five one-click views. They go through frameCamera()'s existing distance,
// near/far and controls-limit maths via a new `direction` option rather than
// each one computing its own camera position - so the check that matters is
// that all five frame at the *same* distance. A view that drifts from that
// means the shared path got bypassed.

console.log('\nSaved views');

const viewNames = ['front', 'threeQuarter', 'side', 'top', 'back'];
const views = {};
for (const name of viewNames) {
  views[name] = await page.evaluate((n) => {
    const v = window.__viewer;
    v.setView(n);
    return {
      pos: v.camera.position.toArray().map((x) => Number(x.toFixed(3))),
      targetY: Number(v.controls.target.y.toFixed(3)),
      dist: Number(v.camera.position.distanceTo(v.controls.target).toFixed(3)),
      finite: v.camera.matrixWorld.elements.every(Number.isFinite),
    };
  }, name);
}

const distinct = new Set(viewNames.map((n) => views[n].pos.join(',')));
check('each saved view is a distinct camera position', distinct.size === viewNames.length, `${distinct.size} of ${viewNames.length}`);

const distances = new Set(viewNames.map((n) => views[n].dist));
check(
  'every view frames at the same distance',
  distances.size === 1,
  [...distances].join(', '),
);

check(
  'front and back are opposed',
  Math.abs(views.front.pos[2] + views.back.pos[2]) < 0.01,
  `${views.front.pos[2]} vs ${views.back.pos[2]}`,
);

// Top is the one that can break: a view direction parallel to the camera's up
// vector has no unique orientation, which shows up as a non-finite matrix.
check('top looks down from above', views.top.pos[1] > views.top.targetY);
check('top is not a degenerate orientation', views.top.finite);

await page.evaluate(() => window.__viewer.setView('threeQuarter'));
await page.waitForTimeout(200);

// --- panel tabs -----------------------------------------------------------
//
// The panel's 13 sections moved from one scrolling column into 5 tabs. The
// thing that can silently break is a section ending up on no tab at all -
// still in the markup, still wired, and unreachable. So this counts sections
// across every tab rather than trusting the grouping.

console.log('\nPanel tabs');

const tabKeys = await page.$$eval('#tabBar .tab', (els) => els.map((e) => e.dataset.tab));
check('the tab bar replaced the jump rail', tabKeys.length === 5, tabKeys.join(', '));
check('the old rail is gone', (await page.$('#rail')) === null);

let reachable = 0;
let isolated = true;
for (const key of tabKeys) {
  await page.click(`#tabBar .tab[data-tab="${key}"]`);
  await page.waitForTimeout(80);
  const info = await page.evaluate((k) => {
    const panelId = document.querySelector(`#tabBar .tab[data-tab="${k}"]`).getAttribute('aria-controls');
    const panel = document.getElementById(panelId);
    const others = [...document.querySelectorAll('.tab-panel')].filter((el) => el.id !== panelId);
    return {
      shown: !panel.hidden,
      sections: panel.querySelectorAll('.group').length,
      othersHidden: others.every((el) => el.hidden),
    };
  }, key);
  reachable += info.sections;
  if (!info.shown || !info.othersHidden) isolated = false;
}

check('every section lives on exactly one tab', reachable === 13, `${reachable} sections across ${tabKeys.length} tabs`);
check('switching tabs shows one panel and hides the rest', isolated);

// A control buried on a non-default tab has to still be operable, not just
// present - this is the check that would catch a tab panel that renders but
// leaves its contents display:none or zero-height.
await page.click('#tabBar .tab[data-tab="style"]');
await page.waitForTimeout(80);
const styleReachable = await page.evaluate(() => {
  const body = document.getElementById('styleBody');
  if (body.hidden) body.closest('.group').querySelector('.group-title').click();
  return document.getElementById('bloomToggle').offsetParent !== null;
});
check('a control on a non-default tab is actually operable', styleReachable);

// The active tab is persisted like every other panel preference, so returning
// to the app puts you back where you were working. settings.js debounces its
// writes by 400ms (a slider drag would otherwise hit localStorage on every
// pixel), so wait past that before reloading rather than racing it.
await page.waitForTimeout(700);
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.__viewer?.model != null, null, { timeout: 60_000 });
await page.waitForTimeout(600);
const restored = await page.evaluate(
  () => document.querySelector('#tabBar .tab[aria-selected="true"]')?.dataset.tab,
);
check('the active tab survives a reload', restored === 'style', `restored: ${restored}`);

// Put it back so this suite leaves no state behind for the next run.
await page.evaluate(() => document.querySelector('#tabBar .tab[data-tab="model"]').click());
await page.waitForTimeout(400);

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
