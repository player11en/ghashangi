// Screenshot the control panel and a recoloured render, for eyeballing.
// Usage: node test/ui-shot.mjs [url]
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';

const APP = process.argv[2] ?? 'http://localhost:5173/';
const OUT = 'test/artifacts';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
// Tall enough that the whole control panel fits without Playwright trying to
// scroll it into view, which it cannot do for an internally scrolling element.
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));

await page.goto(APP, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => window.__viewer?.model != null, null, { timeout: 60_000 });
await page.waitForTimeout(2500);

await mkdir(OUT, { recursive: true });

// Drive the real DOM rather than calling the viewer directly, so this also
// checks the panel's own wiring: selecting a material, setting its colour, and
// the list swatch following the edit.
const colors = ['#c8202e', '#101014', '#d8d4c8', '#2b6fd4'];

for (const [index, color] of colors.entries()) {
  const item = page.locator('.material-item').nth(index);
  if ((await item.count()) === 0) break;
  await item.click();
  // <input type="color"> cannot be typed into; set it and dispatch the event
  // the panel listens for.
  await page.evaluate((value) => {
    const input = document.getElementById('matColor');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, color);
  await page.waitForTimeout(120);
}

// Save two colourways through the form.
await page.fill('#colorwayName', 'Red');
await page.click('#colorwayForm button[type="submit"]');

await page.locator('.material-item').first().click();
await page.evaluate(() => {
  const input = document.getElementById('matColor');
  input.value = '#f0f0f0';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.fill('#colorwayName', 'Cream');
await page.click('#colorwayForm button[type="submit"]');

// Back to Red, via its button in the colourway list.
await page.locator('.colorway-apply', { hasText: 'Red' }).click();
await page.waitForTimeout(600);

const swatches = await page.evaluate(() =>
  [...document.querySelectorAll('.material-item .swatch')].map((s) => s.style.background),
);
console.log('swatches after UI edits:', swatches.slice(0, 4));

// Best-effort: the panel is plain DOM, but any screenshot on this page still
// goes through the compositor alongside a WebGL canvas, which is occasionally
// slow to produce a frame. A missing panel shot should not fail the run.
try {
  const box = await page.locator('#panel').boundingBox();
  await writeFile(`${OUT}/ui-panel.png`, await page.screenshot({ clip: box, timeout: 20_000 }));
  console.log(`wrote ${OUT}/ui-panel.png`);
} catch (error) {
  console.log('panel screenshot skipped:', error.message.split('\n')[0]);
}

// The render goes through the viewer's own capture.
const bytes = await page.evaluate(async () => {
  const blob = await window.__viewer.captureScreenshot({ scale: 1 });
  return [...new Uint8Array(await blob.arrayBuffer())];
});
await writeFile(`${OUT}/recoloured.png`, Buffer.from(bytes));
console.log(`wrote ${OUT}/recoloured.png`);

await browser.close();
