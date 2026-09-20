// End-to-end remote loading, against real public models over the network.
//
// Covers the whole path a pasted link takes: fetch -> Blob -> object URL ->
// format dispatch -> decoders -> scene -> framing -> disposal of the previous
// model. Two of these cases are things the original app could not do at all:
// a Draco-compressed glTF (no decoder was registered), and a .gltf with
// external .bin and texture files (the multi-file logic required exactly
// obj+mtl+texture).
//
// Usage: node test/remote.mjs [appUrl]   (needs the dev server running)

import { chromium } from 'playwright';

const APP = process.argv[2] ?? 'http://localhost:5173/';
const BASE = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models';

const CASES = [
  {
    name: 'Duck.glb (plain binary glTF)',
    url: `${BASE}/Duck/glTF-Binary/Duck.glb`,
    expect: { minTriangles: 1000, animated: false },
  },
  {
    name: 'DamagedHelmet.glb (PBR, 5 textures)',
    url: `${BASE}/DamagedHelmet/glTF-Binary/DamagedHelmet.glb`,
    expect: { minTriangles: 10_000, animated: false, minTextures: 4 },
  },
  {
    name: 'BoxAnimated.glb (animation clips)',
    url: `${BASE}/BoxAnimated/glTF-Binary/BoxAnimated.glb`,
    expect: { minTriangles: 10, animated: true },
  },
  {
    // Two things the original could not do at once: Draco decompression (no
    // decoder was ever registered) and a .gltf whose .bin and textures are
    // separate files (resolved here via setResourcePath).
    name: 'Avocado.gltf (DRACO-compressed, external .bin + 3 textures)',
    url: `${BASE}/Avocado/glTF-Draco/Avocado.gltf`,
    expect: { minTriangles: 400, animated: false, minTextures: 3 },
  },
];

// Errors the test deliberately provokes while checking the failure paths.
// Anything else appearing on the console is a real problem.
const EXPECTED_CONSOLE = [
  /status of 404/,
  /blocked by CORS policy/,
  /net::ERR_FAILED/,
];

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

// A loader that never calls onLoad or onError hangs forever, and a hung test is
// worse than a failing one — it says nothing and costs everything. Every
// in-page step gets a deadline.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms),
    ),
  ]);
}

console.log(`Testing ${APP}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(APP, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => window.__viewer?.model != null, null, { timeout: 60_000 });

let previous = null;

for (const testCase of CASES) {
  console.log(`\n${testCase.name}`);

  const result = await withTimeout(page.evaluate(async (url) => {
    const before = { ...window.__viewer.renderer.info.memory };
    const started = performance.now();
    try {
      await window.__loadLink(url);
    } catch (error) {
      return { error: error.message };
    }
    const v = window.__viewer;

    // Count from the geometry, not renderer.info.render.triangles — that
    // reports whatever the last frame happened to draw, which under
    // on-demand rendering plus frustum culling is not the model's size.
    let triangles = 0;
    v.model?.traverse((node) => {
      const g = node.geometry;
      if (!g) return;
      triangles += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
    });

    return {
      elapsed: Math.round(performance.now() - started),
      hasModel: v.model != null,
      triangles: Math.round(triangles),
      textures: v.renderer.info.memory.textures,
      geometriesBefore: before.geometries,
      geometriesAfter: v.renderer.info.memory.geometries,
      // v.mixer was replaced by v.animation (a full playback controller) when
      // Track A added clip selection/scrub/speed — this test predates that
      // and was missed at the time; test/animation.mjs got the equivalent
      // update and already covers the controller thoroughly.
      animated: v.animation != null,
      radius: v.bounds?.radius ?? 0,
      cameraDistance: v.camera.position.distanceTo(v.controls.target),
      // The whole point of normalisation: wildly different source scales all
      // end up the same size on screen.
      normalizedSize: v.measure(v.modelRoot).size.toArray().map((n) => +n.toFixed(2)),
    };
  }, testCase.url), 90_000, testCase.name).catch((error) => ({ error: error.message }));

  if (result.error) {
    check(testCase.name, false, result.error);
    continue;
  }

  check('  loaded', result.hasModel, `${result.elapsed}ms`);
  check(
    '  geometry present',
    result.triangles >= testCase.expect.minTriangles,
    `${result.triangles.toLocaleString()} tris`,
  );

  if (testCase.expect.minTextures) {
    check('  textures uploaded', result.textures >= testCase.expect.minTextures, `${result.textures}`);
  }

  check(
    '  animation detected',
    result.animated === testCase.expect.animated,
    result.animated ? 'controller created' : 'static',
  );

  check(
    '  framed to subject',
    result.cameraDistance > result.radius && result.cameraDistance < result.radius * 8,
    `distance ${result.cameraDistance.toFixed(2)} for radius ${result.radius.toFixed(2)}`,
  );

  const largest = Math.max(...result.normalizedSize);
  check('  normalised to a consistent size', Math.abs(largest - 10) < 0.01, `largest axis ${largest}`);

  if (previous) {
    check(
      '  previous model disposed',
      result.geometriesAfter <= result.geometriesBefore + 5,
      `${result.geometriesBefore} -> ${result.geometriesAfter} geometries`,
    );
  }
  previous = result;
}

// --- error paths ---------------------------------------------------------

console.log('\nError handling');

const errorCases = await withTimeout(page.evaluate(async () => {
  const out = {};
  const tryLink = async (key, link) => {
    const toastsBefore = document.querySelectorAll('.toast').length;
    await window.__loadLink(link);
    const toasts = [...document.querySelectorAll('.toast')];
    out[key] = {
      newToast: toasts.length > toastsBefore,
      level: toasts.at(-1)?.dataset.level ?? null,
      text: toasts.at(-1)?.textContent ?? '',
    };
  };

  await tryLink('notFound', 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/NoSuchModel.glb');
  await tryLink('noCors', 'https://example.com/model.glb');
  await tryLink('badUrl', 'not a url at all');
  await tryLink('drivePrivate', 'https://drive.google.com/file/d/1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW/view');
  return out;
}), 90_000, 'error cases').catch((error) => {
  check('error handling completed', false, error.message);
  return { notFound: {}, noCors: {}, badUrl: {}, drivePrivate: {} };
});

check('  404 reports an error', errorCases.notFound.level === 'error', errorCases.notFound.text.slice(0, 90));
check('  CORS failure reports an error', errorCases.noCors.level === 'error', errorCases.noCors.text.slice(0, 90));
check('  malformed URL reports an error', errorCases.badUrl.level === 'error', errorCases.badUrl.text.slice(0, 90));
check('  Drive link reports an error', errorCases.drivePrivate.level === 'error', errorCases.drivePrivate.text.slice(0, 110));

// A failed load must leave the previous model on screen, not a blank viewport.
const survived = await page.evaluate(() => window.__viewer.model != null);
check('  viewer still has a model after failures', survived);

await browser.close();

const unexpected = [...new Set(consoleErrors)].filter(
  (text) => !EXPECTED_CONSOLE.some((pattern) => pattern.test(text)),
);

if (unexpected.length > 0) {
  console.log(`\nUnexpected console errors (${unexpected.length}):`);
  for (const e of unexpected) console.log(`  ! ${e.slice(0, 160)}`);
  failures.push('unexpected console errors');
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s).`);
  process.exit(1);
}
console.log('\nAll checks passed.');
