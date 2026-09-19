// Model statistics.
//
// The HUD used to report renderer.info.render.triangles as "Triangles". That is
// whatever the last frame drew — it includes the stage and the shadow pass, and
// it shrinks when frustum culling kicks in — so it overstated Duck.glb as
// 28,962 against a real 4,212. These checks pin the counts to known-good
// numbers for published sample models.
//
// Usage: node test/stats.mjs [url]   (needs the dev server running)

import { chromium } from 'playwright';

const APP = process.argv[2] ?? 'http://localhost:5173/';
const BASE = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models';

// Triangle counts as published for these assets.
const CASES = [
  { name: 'Duck.glb', url: `${BASE}/Duck/glTF-Binary/Duck.glb`, triangles: 4212, meshes: 1 },
  { name: 'DamagedHelmet.glb', url: `${BASE}/DamagedHelmet/glTF-Binary/DamagedHelmet.glb`, triangles: 15452, meshes: 1 },
  { name: 'BoxAnimated.glb', url: `${BASE}/BoxAnimated/glTF-Binary/BoxAnimated.glb`, triangles: 254, meshes: 2 },
];

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));

await page.goto(APP, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => window.__viewer?.model != null, null, { timeout: 60_000 });

for (const testCase of CASES) {
  console.log(`\n${testCase.name}`);

  const result = await page.evaluate(async (url) => {
    await window.__loadLink(url);
    const v = window.__viewer;
    return {
      stats: v.modelStats,
      // What the old HUD would have shown, for the comparison below.
      lastFrame: v.renderer.info.render.triangles,
      hudTris: document.getElementById('statTris').textContent,
      hudMeshes: document.getElementById('statMeshes').textContent,
    };
  }, testCase.url);

  check(
    '  triangle count matches the asset',
    result.stats.triangles === testCase.triangles,
    `${result.stats.triangles.toLocaleString()} (expected ${testCase.triangles.toLocaleString()})`,
  );
  check('  mesh count matches', result.stats.meshes === testCase.meshes, `${result.stats.meshes}`);
  check('  vertices counted', result.stats.vertices > 0, `${result.stats.vertices.toLocaleString()}`);
  check('  materials counted', result.stats.materials > 0, `${result.stats.materials}`);

  // The HUD must show the geometry figure, not the per-frame one.
  await page.waitForTimeout(600);
  const hud = await page.evaluate(() => document.getElementById('statTris').textContent);
  check(
    '  HUD shows the geometry count',
    hud === testCase.triangles.toLocaleString(),
    `HUD "${hud}" vs last-frame ${result.lastFrame.toLocaleString()}`,
  );
}

// Culling changes what the last frame drew but must not change the model's size.
console.log('\nStability');
const stable = await page.evaluate(async () => {
  const v = window.__viewer;
  const before = v.modelStats.triangles;
  v.camera.position.multiplyScalar(0.02); // push the camera inside the model
  v.loop.invalidate(2);
  await new Promise((r) => setTimeout(r, 300));
  const after = v.modelStats.triangles;
  const lastFrame = v.renderer.info.render.triangles;
  v.resetCamera();
  return { before, after, lastFrame };
});
check(
  'geometry count is unaffected by culling',
  stable.before === stable.after,
  `${stable.before} stayed ${stable.after}, while the frame drew ${stable.lastFrame.toLocaleString()}`,
);

await browser.close();

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s).`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
