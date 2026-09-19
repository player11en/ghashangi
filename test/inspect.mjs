// Visual spot-check: renders the current model in several states and writes
// PNGs to test/artifacts/. Not a test — for eyeballing a change.
//
// Usage: node test/inspect.mjs [url]
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';

const url = process.argv[2] ?? 'http://localhost:5173/';
const OUT = 'test/artifacts';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => window.__viewer?.model != null, null, { timeout: 60_000 });
await page.waitForTimeout(1500);

await mkdir(OUT, { recursive: true });

/**
 * Render one state to a PNG. Uses the viewer's own capture rather than a
 * Playwright screenshot: the compositor capture path intermittently hangs on a
 * software-rendered WebGL canvas driven by an on-demand render loop.
 */
async function shot(name, setup) {
  const bytes = await page.evaluate(async (fnBody) => {
    // eslint-disable-next-line no-new-func
    await new Function(`return (${fnBody})`)()(window.__viewer);
    window.__viewer.loop.invalidate(3);
    await new Promise((r) => setTimeout(r, 400));
    const blob = await window.__viewer.captureScreenshot({ scale: 1 });
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, setup.toString());

  await writeFile(`${OUT}/${name}.png`, Buffer.from(bytes));
  console.log(`wrote ${OUT}/${name}.png`);
}

await shot('orient-default', (v) => { v.orientation.reset(); });
await shot('orient-z-up', (v) => { v.orientation.setUpAxis('z'); });
await shot('orient-tilt', (v) => { v.orientation.reset(); v.orientation.setAxis('z', 30); });
await shot('orient-reset', (v) => { v.orientation.reset(); });

const state = await page.evaluate(() => {
  const v = window.__viewer;
  const m = v.measure(v.modelRoot);
  return {
    angles: v.orientation.angles,
    preset: v.orientation.preset,
    minY: +m.box.min.y.toFixed(4),
    size: m.size.toArray().map((n) => +n.toFixed(2)),
    stageScale: +v.stageRoot.scale.x.toFixed(3),
  };
});
console.log(JSON.stringify(state, null, 2));

await browser.close();
