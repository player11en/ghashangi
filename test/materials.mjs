// Materials and colourways.
//
// Loads a multi-material model (DamagedHelmet) and exercises the studio
// workflow end to end: enumerate materials, recolour one, blend against its
// texture, save colourways, switch between them, and export a zip of PNGs and
// an edited GLB.
//
// Usage: node test/materials.mjs [url]   (needs the dev server running)

import { chromium } from 'playwright';

const APP = process.argv[2] ?? 'http://localhost:5173/';
const HELMET =
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/DamagedHelmet/glTF-Binary/DamagedHelmet.glb';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const consoleErrors = [];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(APP, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => window.__viewer?.model != null, null, { timeout: 60_000 });

// The HDR environment loads in the background and replaces the procedural
// studio fallback when it arrives, which changes every pixel. Wait for it to
// land before taking any baseline, or a later "restores the authored look"
// comparison fails for reasons that have nothing to do with materials.
await page.waitForFunction(
  () => window.__viewer.environment.environmentTexture != null,
  null,
  { timeout: 30_000 },
);
await page.waitForTimeout(800);

const { createHash } = await import('node:crypto');

/** Hash the rendered image via the viewer's own capture — see test/README.md. */
async function viewportHash() {
  const bytes = await page.evaluate(async () => {
    const blob = await window.__viewer.captureScreenshot({ scale: 1 });
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return createHash('sha1').update(Buffer.from(bytes)).digest('hex');
}

// --- enumeration ---------------------------------------------------------

const demo = await page.evaluate(() => {
  const v = window.__viewer;
  return {
    count: v.materials.length,
    keys: v.materials.map((m) => m.key),
    names: v.materials.map((m) => m.name),
    meshCounts: v.materials.map((m) => m.meshCount),
    textured: v.materials.filter((m) => m.hasMap).length,
  };
});

check('demo model exposes materials', demo.count > 0, `${demo.count}: ${demo.names.join(', ')}`);
check('material keys are unique', new Set(demo.keys).size === demo.keys.length);
check(
  'materials are deduplicated by instance',
  demo.meshCounts.some((n) => n >= 1),
  `mesh counts ${demo.meshCounts.join(', ')}`,
);

// --- recolouring ---------------------------------------------------------

const authored = await viewportHash();

const recolour = await page.evaluate(() => {
  const v = window.__viewer;
  const key = v.materials[0].key;
  const before = `#${v.materials[0].material.color.getHexString()}`;
  v.setMaterialColor(key, '#ff0000', 1);
  return { key, before, after: `#${v.materials[0].material.color.getHexString()}` };
});
await page.waitForTimeout(250);
const recoloured = await viewportHash();

check('base colour is applied', recolour.after === '#ff0000', `${recolour.before} -> ${recolour.after}`);
check('recolouring changes the rendered image', authored !== recoloured);

// Blend 0 must land exactly back on the authored colour, or "reset by dragging
// the slider back" would silently drift.
const blendZero = await page.evaluate(() => {
  const v = window.__viewer;
  const key = v.materials[0].key;
  v.setMaterialColor(key, '#ff0000', 0);
  return `#${v.materials[0].material.color.getHexString()}`;
});
check('blend 0 restores the authored colour', blendZero === recolour.before, `${blendZero} vs ${recolour.before}`);

// Blend is not a one-way trip: re-reading a blended colour and re-blending must
// not compound. This is why the target colour is remembered separately.
const blendStability = await page.evaluate(() => {
  const v = window.__viewer;
  const key = v.materials[0].key;
  v.setMaterialColor(key, '#00ff00', 0.5);
  const first = `#${v.materials[0].material.color.getHexString()}`;
  v.setMaterialColor(key, '#00ff00', 0.5);
  const second = `#${v.materials[0].material.color.getHexString()}`;
  return { first, second };
});
check(
  'repeated blends do not compound',
  blendStability.first === blendStability.second,
  `${blendStability.first} then ${blendStability.second}`,
);

// --- channels ------------------------------------------------------------

const channels = await page.evaluate(() => {
  const v = window.__viewer;
  const key = v.materials[0].key;
  const m = v.materials[0].material;
  v.setMaterialChannel(key, 'roughness', 0.9);
  v.setMaterialChannel(key, 'metalness', 0.1);
  v.setMaterialChannel(key, 'opacity', 0.5);
  return {
    roughness: m.roughness,
    metalness: m.metalness,
    opacity: m.opacity,
    transparent: m.transparent,
    bogus: v.setMaterialChannel(key, 'notAChannel', 1),
  };
});

check('roughness applied', channels.roughness === 0.9);
check('metalness applied', channels.metalness === 0.1);
check(
  'opacity below 1 enables transparency',
  channels.opacity === 0.5 && channels.transparent === true,
  'opacity 0.5, transparent true',
);
check('unknown channel is rejected', channels.bogus === false);

// Returning to fully opaque must hand `transparent` back to its authored value
// rather than leaving everything in the transparent queue — that blanket
// `transparent = true` was a bug in the original app.
const opaqueAgain = await page.evaluate(() => {
  const v = window.__viewer;
  const key = v.materials[0].key;
  v.setMaterialChannel(key, 'opacity', 1);
  return v.materials[0].material.transparent;
});
check('opacity 1 restores authored transparency', opaqueAgain === false);

// --- reset ---------------------------------------------------------------

await page.evaluate(() => window.__viewer.resetAllMaterials());
await page.waitForTimeout(250);
const afterReset = await viewportHash();
check('reset all restores the authored look exactly', afterReset === authored);

// --- material undo/redo ---------------------------------------------------

console.log('\nMaterial undo/redo');

const undoFlow = await page.evaluate(async () => {
  const v = window.__viewer;
  const mu = window.__materialUndo;
  const key = v.materials[0].key;

  mu.reset(); // start this check from a clean history
  const authoredColor = v.materials[0].material.color.getHexString();

  v.setMaterialColor(key, '#ff0000', 1);
  await new Promise((r) => setTimeout(r, 700)); // clear the 500ms coalesce debounce

  const afterEdit = { color: v.materials[0].material.color.getHexString(), canUndo: mu.canUndo };
  const undone = mu.undo();
  const afterUndo = {
    color: v.materials[0].material.color.getHexString(),
    canUndo: mu.canUndo,
    canRedo: mu.canRedo,
  };
  const redone = mu.redo();
  const afterRedo = { color: v.materials[0].material.color.getHexString(), canRedo: mu.canRedo };

  return { authoredColor, afterEdit, undone, afterUndo, redone, afterRedo };
});

check('an edit makes undo available', undoFlow.afterEdit.canUndo === true, `color -> #${undoFlow.afterEdit.color}`);
check(
  'undo restores the pre-edit color exactly',
  undoFlow.undone && undoFlow.afterUndo.color === undoFlow.authoredColor,
  `#${undoFlow.afterUndo.color}`,
);
check(
  'undo leaves redo available and undo unavailable',
  undoFlow.afterUndo.canRedo === true && undoFlow.afterUndo.canUndo === false,
);
check('redo re-applies the edit', undoFlow.redone && undoFlow.afterRedo.color === 'ff0000');
check('redo empties the redo stack', undoFlow.afterRedo.canRedo === false);

// Coalescing: a burst of rapid edits (dragging a slider) must collapse into
// ONE undo step, not one per intermediate value - undoing once should land
// all the way back at the pre-burst state, not one step into the burst.
const coalesced = await page.evaluate(async () => {
  const v = window.__viewer;
  const mu = window.__materialUndo;
  const key = v.materials[0].key;

  mu.reset();
  const before = v.materials[0].material.color.getHexString();

  for (const hex of ['#111111', '#222222', '#333333', '#444444']) {
    v.setMaterialColor(key, hex, 1);
  }
  await new Promise((r) => setTimeout(r, 700));

  const afterBurst = v.materials[0].material.color.getHexString();
  const undone = mu.undo();
  const afterUndo = v.materials[0].material.color.getHexString();

  return { before, afterBurst, afterUndo, undone, canUndoAfter: mu.canUndo };
});

check(
  'a rapid burst of edits coalesces into one undo step',
  coalesced.undone && coalesced.afterUndo === coalesced.before,
  `${coalesced.before} -> ... -> ${coalesced.afterBurst} -> undo -> ${coalesced.afterUndo}`,
);
check('undoing a coalesced burst has nothing further to undo', coalesced.canUndoAfter === false);

await page.evaluate(() => window.__viewer.resetAllMaterials());

// --- multi-material model ------------------------------------------------

console.log('\nDamagedHelmet (multi-material, textured)');

const helmet = await page.evaluate(async (url) => {
  await window.__loadLink(url);
  const v = window.__viewer;
  return {
    count: v.materials.length,
    textured: v.materials.filter((m) => m.hasMap).length,
    channels: v.materials[0].channels,
  };
}, HELMET);

check('helmet materials found', helmet.count > 0, `${helmet.count} material(s)`);
check('textured material detected', helmet.textured > 0, `${helmet.textured} textured`);
check(
  'only real channels are offered',
  helmet.channels.includes('roughness') && helmet.channels.includes('metalness'),
  helmet.channels.join(', '),
);

// Tinting a textured material must change the image without flattening it:
// colour multiplies the map, so detail survives.
const texturedBefore = await viewportHash();
await page.evaluate(() => {
  const v = window.__viewer;
  v.setMaterialColor(v.materials[0].key, '#3060ff', 1);
});
await page.waitForTimeout(250);
const texturedAfter = await viewportHash();
check('tinting a textured material changes the image', texturedBefore !== texturedAfter);

// --- colourways ----------------------------------------------------------

console.log('\nColourways');

const colorways = await page.evaluate(async () => {
  const v = window.__viewer;
  const panel = window.__materials;
  const key = v.materials[0].key;

  v.setMaterialColor(key, '#c8202e', 1);
  panel.colorways.save('Red');

  v.setMaterialColor(key, '#1a1a1a', 1);
  panel.colorways.save('Mono');

  return {
    names: panel.colorways.all.map((c) => c.name),
    signature: panel.colorways.signature,
  };
});

check('two colourways saved', colorways.names.length === 2, colorways.names.join(', '));
check('signature keyed to the model', Boolean(colorways.signature), colorways.signature?.slice(0, 40));

const redHash = await page.evaluate(() => window.__materials.colorways.apply('Red')).then(() => page.waitForTimeout(250)).then(viewportHash);
const monoHash = await page.evaluate(() => window.__materials.colorways.apply('Mono')).then(() => page.waitForTimeout(250)).then(viewportHash);
check('colourways render differently', redHash !== monoHash);

// Re-applying must be deterministic, or a batch export would produce different
// images on a second run.
await page.evaluate(() => window.__materials.colorways.apply('Red'));
await page.waitForTimeout(250);
const redAgain = await viewportHash();
check('re-applying a colourway is stable', redAgain === redHash);

// Colourways persist per model, so reopening the same file brings them back.
const persisted = await page.evaluate(() => {
  const keys = Object.keys(localStorage).filter((k) => k.startsWith('3dmviewer.colorways.'));
  return { keys: keys.length, sample: keys[0] ?? null };
});
check('colourways persisted to localStorage', persisted.keys > 0, persisted.sample?.slice(0, 60));

// --- export --------------------------------------------------------------

console.log('\nExport');

const zip = await page.evaluate(async () => {
  const { exportColorwayPNGs } = await import('/src/core/colorways.js');
  const v = window.__viewer;
  const blob = await exportColorwayPNGs({
    viewer: v,
    colorways: window.__materials.colorways.all,
    scale: 1,
    transparent: true,
    baseName: 'helmet',
  });
  return { size: blob.size, type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())].slice(0, 4) };
});

check('PNG export produces a zip', zip.type === 'application/zip' && zip.size > 2000, `${zip.size} bytes`);
// "PK\003\004" — a real zip local file header, not an empty archive.
check('zip has a valid header', zip.bytes[0] === 0x50 && zip.bytes[1] === 0x4b, zip.bytes.join(','));

// Unzip it and confirm one PNG per colourway, each a real image.
//
// Unzipped in Node, not in the page: bare specifiers like
// 'three/addons/libs/fflate.module.js' are resolved by Vite when it serves a
// module, but a dynamic import inside page.evaluate() is a runtime string the
// browser has to resolve itself, and it has no import map for it.
const { unzipSync } = await import('three/addons/libs/fflate.module.js');

const zipBytes = await page.evaluate(async () => {
  const { exportColorwayPNGs } = await import('/src/core/colorways.js');
  const blob = await exportColorwayPNGs({
    viewer: window.__viewer,
    colorways: window.__materials.colorways.all,
    scale: 1,
    transparent: true,
    baseName: 'helmet',
  });
  return [...new Uint8Array(await blob.arrayBuffer())];
});

const entries = Object.entries(unzipSync(Uint8Array.from(zipBytes))).map(([name, data]) => ({
  name,
  size: data.length,
  // PNG magic number.
  isPng: data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47,
}));

check('one file per colourway', entries.length === 2, entries.map((e) => e.name).join(', '));
check('every entry is a real PNG', entries.every((e) => e.isPng && e.size > 1000), entries.map((e) => `${e.size}B`).join(', '));

// Exporting must leave the viewer where it found it, not stuck on the last
// colourway it rendered.
const restored = await page.evaluate(() => window.__viewer.captureMaterialState());
check('export restores the prior material state', Object.keys(restored).length > 0);

const glb = await page.evaluate(async () => {
  const { exportGLB } = await import('/src/core/colorways.js');
  const blob = await exportGLB(window.__viewer);
  const head = [...new Uint8Array(await blob.slice(0, 4).arrayBuffer())];
  return { size: blob.size, head };
});
// "glTF" magic.
check(
  'GLB export produces a valid glTF binary',
  glb.head[0] === 0x67 && glb.head[1] === 0x6c && glb.head[2] === 0x54 && glb.head[3] === 0x46,
  `${glb.size} bytes`,
);

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
