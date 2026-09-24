// Keyframing (Phase 10).
//
// The design decision these checks exist to protect: there is no second
// registry of "what is animatable". keyframes.js reads settings.js's FIELDS,
// so anything that is a persisted setting is keyframable, and values are
// written through settings.js's own writeField - the same path load() and
// reset() use, which dispatches the event a real edit fires. That is what
// keeps the readouts, dependent rows and engine calls in sync without a
// parallel setter path.
//
// Two behaviours are easy to get wrong and are asserted directly:
//
//   * Continuous kinds (range, color) blend between keys; stepped kinds
//     (checkbox, select, text) jump at them. A dropdown blended halfway
//     produces a value that was never a valid option.
//   * Playback must not write to localStorage. settings.js saves on a debounce
//     after any tracked control changes, and a scrub changes many of them per
//     frame - without suspension the saved session would end up wherever the
//     playhead stopped.
//
// Usage: node test/keyframes.mjs [url]   (needs the dev server running)

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
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(APP, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => window.__viewer?.model != null, null, { timeout: 60_000 });
await page.waitForTimeout(800);

// --- arming and capture ----------------------------------------------------

console.log('Arming and capture');

const unarmed = await page.evaluate(() => {
  const set = (id, v) => {
    const el = document.getElementById(id);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('ambientSlider', 1.5);
  return window.__keyframes.keyCount;
});
check('editing while unarmed creates no keys', unarmed === 0, `${unarmed} keys`);

const armedResult = await page.evaluate(() => {
  const kf = window.__keyframes;
  const set = (id, v) => {
    const el = document.getElementById(id);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  document.getElementById('kfArm').click();
  set('cpScrub', 0);
  set('ambientSlider', 0.2);
  set('cpScrub', 1);
  set('ambientSlider', 2);
  return { tracks: kf.trackIds(), keys: kf.keyCount };
});
check('an armed edit keys the control it touched',
  armedResult.tracks.length === 1 && armedResult.tracks[0] === 'ambientSlider',
  armedResult.tracks.join(', '));
check('one key lands per playhead position', armedResult.keys === 2, `${armedResult.keys} keys`);

// A real click, not a synthesised event - the panel-level delegation depends
// on the event bubbling, which is true of genuine interaction and of the
// bubbling events above, but deliberately NOT of settings.js's own restore
// writes. A session restore must not manufacture keyframes.
await page.evaluate(() => {
  const el = document.getElementById('cpScrub');
  el.value = '0.5';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
// Navigate the way a person would: the control lives in a collapsed section
// on another tab, and a click only counts as real interaction if it reaches a
// visible element.
await page.evaluate(() => {
  document.querySelector('.tab[data-tab="look"]').click();
  const body = document.getElementById('environmentBody');
  if (body.hidden) body.closest('.group').querySelector('.group-title').click();
});
await page.waitForTimeout(250);
await page.click('#aaToggle');
await page.waitForTimeout(300);
const realClick = await page.evaluate(() => window.__keyframes.trackIds().includes('aaToggle'));
check('a real click on a checkbox is captured', realClick);

const restoreSafe = await page.evaluate(() => {
  const before = window.__keyframes.keyCount;
  // writeFieldById is what load() and reset() use; its events do not bubble.
  window.__settings.writeFieldById('sunSlider', 3.2);
  return { before, after: window.__keyframes.keyCount };
});
check('a settings restore does not manufacture keys',
  restoreSafe.before === restoreSafe.after,
  `${restoreSafe.before} -> ${restoreSafe.after}`);

// --- interpolation ---------------------------------------------------------

console.log('\nInterpolation');

const mid = await page.evaluate(() => window.__keyframes.valueAt('ambientSlider', 0.5));
check('a range blends between keys', Math.abs(mid - 1.1) < 0.001, String(mid));

const held = await page.evaluate(() => ({
  before: window.__keyframes.valueAt('ambientSlider', 0),
  after: window.__keyframes.valueAt('ambientSlider', 1),
}));
check('values hold at the ends rather than extrapolating',
  Math.abs(held.before - 0.2) < 0.001 && Math.abs(held.after - 2) < 0.001,
  `${held.before} .. ${held.after}`);

const colour = await page.evaluate(() => {
  const kf = window.__keyframes;
  kf.setKey('leftColor', 0, '#000000');
  kf.setKey('leftColor', 1, '#ffffff');
  return kf.valueAt('leftColor', 0.5);
});
check('a colour blends in RGB', colour === '#808080', colour);

const stepped = await page.evaluate(() => {
  const kf = window.__keyframes;
  kf.setKey('toneMapping', 0, 'agx');
  kf.setKey('toneMapping', 1, 'aces');
  return { low: kf.valueAt('toneMapping', 0.4), high: kf.valueAt('toneMapping', 0.95) };
});
check('a dropdown steps and never blends',
  stepped.low === 'agx' && stepped.high === 'agx',
  `0.4 -> ${stepped.low}, 0.95 -> ${stepped.high}`);

// --- driving the app -------------------------------------------------------

console.log('\nDriving the app');

const driven = await page.evaluate(() => {
  const kf = window.__keyframes;
  kf.apply(0.5);
  return {
    slider: document.getElementById('ambientSlider').value,
    light: window.__viewer.lights.ambient.intensity,
  };
});
check('applying drives the control and the engine together',
  Math.abs(parseFloat(driven.slider) - 1.1) < 0.001 && Math.abs(driven.light - 1.1) < 0.001,
  `slider ${driven.slider}, light ${driven.light}`);

// The camera path owns the clock; keyframes ride the same one via onTick.
const scrubbed = await page.evaluate(() => {
  const el = document.getElementById('cpScrub');
  const at = (v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return window.__viewer.lights.ambient.intensity;
  };
  return { start: at(0), end: at(1) };
});
check('scrubbing the path drives keyframed values',
  Math.abs(scrubbed.start - 0.2) < 0.01 && Math.abs(scrubbed.end - 2) < 0.01,
  `${scrubbed.start} -> ${scrubbed.end}`);

const storageUntouched = await page.evaluate(() => {
  const before = localStorage.getItem('3dmviewer.settings');
  for (let i = 0; i <= 10; i++) window.__keyframes.apply(i / 10);
  return before === localStorage.getItem('3dmviewer.settings');
});
check('playback does not write to localStorage', storageUntouched);

// --- keyframed on/off state ------------------------------------------------
//
// The case the pre-roll exists for. Enabling a Style effect is async the first
// time - it imports every pass module - so a keyframe switching one on during
// playback would trigger that download inside a recording. post.prewarm()
// builds the composer up front, after which a toggle is a synchronous
// pass.enabled assignment.
//
// The feedback guard is the other thing under test here, and it was a real bug:
// writeField on a checkbox calls .click(), whose event bubbles, so an armed
// session captured apply()'s own writes as new keyframes and fed each track
// back into itself.

console.log('\nOn/off keys');

await page.evaluate(() => window.__viewer.post.prewarm());
await page.waitForTimeout(2000);

const toggleKeys = await page.evaluate(() => {
  const kf = window.__keyframes;
  kf.clear();
  kf.setKey('bloomToggle', 0, false);
  kf.setKey('bloomToggle', 1, true);
  const read = () => ({
    box: document.getElementById('bloomToggle').checked,
    count: window.__viewer.post.styleEffectCount,
  });
  kf.apply(0); const off = read();
  kf.apply(1); const on = read();
  kf.apply(0); const back = read();
  return { off, on, back, keys: kf.keysFor('bloomToggle').length };
});

check('a keyed toggle switches the real pass on',
  toggleKeys.on.box === true && toggleKeys.on.count === 1,
  `checkbox ${toggleKeys.on.box}, active effects ${toggleKeys.on.count}`);
check('and switches it back off when the playhead returns',
  toggleKeys.back.box === false && toggleKeys.back.count === 0,
  `checkbox ${toggleKeys.back.box}, active effects ${toggleKeys.back.count}`);
check('applying does not keyframe its own writes',
  toggleKeys.keys === 2, `${toggleKeys.keys} keys on the track`);

const toggleStep = await page.evaluate(() => {
  const kf = window.__keyframes;
  return { early: kf.valueAt('bloomToggle', 0.4), late: kf.valueAt('bloomToggle', 0.99) };
});
check('a toggle holds its value until the next key, never partially on',
  toggleStep.early === false && toggleStep.late === false,
  `0.4 -> ${toggleStep.early}, 0.99 -> ${toggleStep.late}`);

// With the composer pre-warmed there is nothing left to await, so this has to
// complete inside a frame budget rather than stalling a capture.
const toggleSpeed = await page.evaluate(() => {
  const started = performance.now();
  window.__keyframes.apply(1);
  return { ms: performance.now() - started, count: window.__viewer.post.styleEffectCount };
});
// The contract is that the pre-roll left nothing to await, so the effect is
// already applied by the time apply() returns - not that a software rasterizer
// under batch load meets a 60fps budget. An earlier version asserted 16ms and
// failed at 65ms in a batch run, which is the same wall-clock guesswork that
// settle() was rewritten to stop doing. The count check is the real contract;
// the generous ceiling still catches what it guards against, since a lost
// pre-roll means importing every pass module, which takes seconds.
check('a pre-warmed toggle applies synchronously, with no module load',
  toggleSpeed.count === 1 && toggleSpeed.ms < 500,
  `effect active immediately, ${toggleSpeed.ms.toFixed(1)}ms`);

await page.evaluate(() => window.__keyframes.clear());

// --- managing tracks -------------------------------------------------------

console.log('\nTrack management');

const removal = await page.evaluate(() => {
  const kf = window.__keyframes;
  // Set up its own state rather than inheriting whatever the previous section
  // left behind - a test that depends on earlier state breaks whenever those
  // sections are reordered, which is exactly what happened here.
  kf.clear();
  kf.setKey('toneMapping', 0, 'agx');
  kf.setKey('ambientSlider', 0, 0.5);
  const before = kf.trackCount;
  kf.clearTrack('toneMapping');
  const after = kf.trackCount;
  kf.clear();
  return { before, after, cleared: kf.trackCount };
});
check('a single track can be removed', removal.after === removal.before - 1,
  `${removal.before} -> ${removal.after}`);
check('clearing removes every track', removal.cleared === 0);

const roundTrip = await page.evaluate(() => {
  const kf = window.__keyframes;
  kf.setKey('ambientSlider', 0, 0.3);
  kf.setKey('ambientSlider', 1, 1.9);
  const json = JSON.parse(JSON.stringify(kf.toJSON()));
  kf.clear();
  kf.fromJSON(json);
  return { tracks: kf.trackCount, mid: kf.valueAt('ambientSlider', 0.5) };
});
check('tracks survive a JSON round trip',
  roundTrip.tracks === 1 && Math.abs(roundTrip.mid - 1.1) < 0.001,
  `${roundTrip.tracks} track, midpoint ${roundTrip.mid}`);

// --- the timeline ----------------------------------------------------------
//
// What turns the engine into something usable: before this, a track list could
// say "ambient light, 3 keys" and nothing more - no way to see when those keys
// were, move one, or delete one without clearing the whole track.

console.log('\nTimeline');

await page.evaluate(() => {
  document.querySelector('.tab[data-tab="output"]').click();
  const body = document.getElementById('cameraPathBody');
  if (body.hidden) body.closest('.group').querySelector('.group-title').click();
  const kf = window.__keyframes;
  kf.clear();
  kf.setKey('ambientSlider', 0.2, 0.4);
  kf.setKey('ambientSlider', 0.8, 1.8);
});
await page.waitForTimeout(400);

const drawn = await page.evaluate(() => ({
  visible: !document.getElementById('kfTimeline').hidden,
  lanes: document.querySelectorAll('.tl-lane').length,
  keys: [...document.querySelectorAll('.tl-key')].map((k) => k.style.left),
  name: document.querySelector('.tl-name')?.textContent,
}));
check('the timeline draws a lane per track', drawn.visible && drawn.lanes === 1, `${drawn.lanes} lanes`);
check('keys are drawn at their times', drawn.keys.join() === '20%,80%', drawn.keys.join(', '));
check('lanes are labelled with the control name, not its id', drawn.name === 'Ambient', drawn.name);

// Dragging a key is the whole reason for a timeline rather than a list.
const dragBox = await page.evaluate(() => {
  const key = document.querySelector('.tl-key');
  const box = key.getBoundingClientRect();
  const lane = key.closest('.tl-lane').getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, laneX: lane.x, laneW: lane.width };
});
await page.mouse.move(dragBox.x, dragBox.y);
await page.mouse.down();
await page.mouse.move(dragBox.laneX + dragBox.laneW * 0.6, dragBox.y, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(400);

const dragged = await page.evaluate(() =>
  window.__keyframes.keysFor('ambientSlider').map((k) => Number(k.t.toFixed(2))));
check('dragging a key moves it in time', dragged[0] > 0.5 && dragged[0] < 0.7,
  `keys at ${dragged.join(', ')}`);
check('the track keeps its other keys', dragged.length === 2, `${dragged.length} keys`);

await page.dblclick('.tl-key');
await page.waitForTimeout(400);
const afterDelete = await page.evaluate(() => window.__keyframes.keyCount);
check('double-clicking a key deletes it', afterDelete === 1, `${afterDelete} keys left`);

// --- persistence -----------------------------------------------------------
//
// An animation that vanishes on reload while every other setting survives is
// the kind of inconsistency people notice immediately. This also pins the
// ordering bug it exposed: saving from the redraw path wrote an empty track
// set during wiring, which runs BEFORE load(), so load() then read back
// nothing. Saving now happens on an actual change instead.

console.log('\nPersistence');

await page.evaluate(() => {
  const kf = window.__keyframes;
  kf.setKey('sunSlider', 0.1, 0.5);
  kf.setKey('sunSlider', 0.9, 4);
});
await page.waitForTimeout(600);

const beforeReload = await page.evaluate(() => window.__keyframes.keyCount);
await page.reload({ waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => window.__viewer?.model != null, null, { timeout: 60_000 });
await page.waitForTimeout(1500);

const restored = await page.evaluate(() => ({
  keys: window.__keyframes.keyCount,
  tracks: window.__keyframes.trackIds(),
  armed: document.getElementById('kfArm').checked,
}));
check('keyframes survive a reload', restored.keys === beforeReload,
  `${beforeReload} -> ${restored.keys}`);
check('every track is restored', restored.tracks.length === 2, restored.tracks.join(', '));

// Arming controls capture, not visibility. A restored animation that is live
// but unreachable is the failure this project rejected a Pro/Open split over.
await page.evaluate(() => {
  document.querySelector('.tab[data-tab="output"]').click();
  const body = document.getElementById('cameraPathBody');
  if (body.hidden) body.closest('.group').querySelector('.group-title').click();
});
await page.waitForTimeout(400);
const visibility = await page.evaluate(() => ({
  timeline: !document.getElementById('kfTimeline').hidden,
  lanes: document.querySelectorAll('.tl-lane').length,
  armed: document.getElementById('kfArm').checked,
}));
check('a restored animation is visible without re-arming',
  visibility.timeline && visibility.lanes === 2 && visibility.armed === false,
  `timeline ${visibility.timeline}, lanes ${visibility.lanes}, armed ${visibility.armed}`);

await page.evaluate(() => window.__keyframes.clear());
await page.waitForTimeout(300);
const emptied = await page.evaluate(() => document.getElementById('kfTimeline').hidden);
check('clearing every track hides the timeline', emptied);

// --- report ----------------------------------------------------------------

await browser.close();

if (consoleErrors.length > 0) {
  console.log(`\n${consoleErrors.length} console error(s):`);
  for (const e of consoleErrors.slice(0, 5)) console.log(`  x ${e}`);
  failures.push('console errors');
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s).`);
  process.exit(1);
}

console.log('\nAll checks passed.');
