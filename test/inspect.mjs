// Ad-hoc scene inspector: dumps what is actually in the scene and where, and
// captures the viewport with the stage on and off.
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';

const url = process.argv[2] ?? 'http://localhost:5173/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => window.__viewer?.model != null, null, { timeout: 60_000 });
await page.waitForTimeout(1500);

const report = await page.evaluate(() => {
  const v = window.__viewer;
  const THREE_Box3 = v.modelRoot.constructor;

  function boundsOf(obj) {
    if (!obj) return null;
    obj.updateWorldMatrix(true, true);
    const box = new (Object.getPrototypeOf(v.scene).constructor === Object ? null : window.__Box3)();
    return null;
  }

  // Use the viewer's own measure via bounds where possible, and read transforms
  // directly otherwise.
  const describe = (obj, label) => obj && ({
    label,
    visible: obj.visible,
    position: obj.position.toArray().map((n) => +n.toFixed(3)),
    scale: obj.scale.toArray().map((n) => +n.toFixed(4)),
    children: obj.children.length,
  });

  return {
    modelRoot: describe(v.modelRoot, 'modelRoot'),
    stageRoot: describe(v.stageRoot, 'stageRoot'),
    stageChild: describe(v.stageRoot.children[0], 'stage[0]'),
    modelChild: describe(v.modelRoot.children[0], 'model[0]'),
    bounds: v.bounds && {
      radius: +v.bounds.radius.toFixed(3),
      center: v.bounds.center.toArray().map((n) => +n.toFixed(3)),
      size: v.bounds.size.toArray().map((n) => +n.toFixed(3)),
    },
    camera: {
      position: v.camera.position.toArray().map((n) => +n.toFixed(2)),
      target: v.controls.target.toArray().map((n) => +n.toFixed(2)),
      near: +v.camera.near.toFixed(4),
      far: +v.camera.far.toFixed(1),
    },
    overlayHidden: document.getElementById('dropOverlay').hidden,
    overlayDisplay: getComputedStyle(document.getElementById('dropOverlay')).display,
    loadingHidden: document.getElementById('loading').hidden,
    loadingDisplay: getComputedStyle(document.getElementById('loading')).display,
  };
});

console.log(JSON.stringify(report, null, 2));

await mkdir('test/artifacts', { recursive: true });

// Hide the UI so the captures show only the 3D content.
await page.evaluate(() => {
  document.getElementById('panel').style.display = 'none';
  document.getElementById('dropOverlay').style.display = 'none';
});
await page.waitForTimeout(300);

await page.evaluate(() => { window.__viewer.setStageVisible(true); window.__viewer.loop.invalidate(3); });
await page.waitForTimeout(500);
await writeFile('test/artifacts/stage-on.png', await page.screenshot());

await page.evaluate(() => { window.__viewer.setStageVisible(false); window.__viewer.loop.invalidate(3); });
await page.waitForTimeout(500);
await writeFile('test/artifacts/stage-off.png', await page.screenshot());

console.log('\nWrote test/artifacts/stage-on.png and stage-off.png');
await browser.close();
