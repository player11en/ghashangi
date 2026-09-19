// Print whatever the page logs or throws on load, then watch for a canvas whose
// size will not settle. Diagnostic helper, not a test.
// Usage: node test/errors.mjs [url]
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

page.on('pageerror', (e) => {
  console.log('PAGEERROR:', e.message);
  if (e.stack) console.log(e.stack.split('\n').slice(0, 6).join('\n'));
});
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') {
    console.log(`${m.type().toUpperCase()}: ${m.text().slice(0, 400)}`);
  }
});

await page.goto(process.argv[2] ?? 'http://localhost:5173/', { waitUntil: 'load', timeout: 30_000 });
await page.waitForTimeout(5000);

console.log('typeof __viewer:', await page.evaluate(() => typeof window.__viewer));
console.log('model loaded:', await page.evaluate(() => window.__viewer?.model != null));

// Is the canvas geometry actually oscillating? Sample the backing-store size and
// the CSS box over a second; anything more than one distinct value means a
// resize feedback loop, which would also explain Playwright refusing to
// screenshot the element.
const samples = await page.evaluate(async () => {
  const canvas = document.querySelector('canvas');
  const seen = [];
  for (let i = 0; i < 20; i++) {
    const r = canvas.getBoundingClientRect();
    seen.push(`${canvas.width}x${canvas.height} css ${Math.round(r.width)}x${Math.round(r.height)}`);
    await new Promise((res) => requestAnimationFrame(res));
  }
  return [...new Set(seen)];
});

console.log('distinct canvas sizes over 20 frames:', samples.length);
for (const s of samples) console.log('  ', s);

// And is the render loop actually idle?
const idle = await page.evaluate(async () => {
  const loop = window.__viewer.loop;
  const start = loop.stats.rendered;
  await new Promise((r) => setTimeout(r, 1000));
  return loop.stats.rendered - start;
});
console.log('frames rendered while idle:', idle);

await browser.close();
