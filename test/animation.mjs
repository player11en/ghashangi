// Animation playback.
//
// The app used to call mixer.clipAction(clips[0]).play() and nothing else, so
// the first clip autoplayed forever and no other clip was reachable.
//
// The interesting failure modes are around the on-demand render loop: a playing
// clip must hold the loop open, a paused one must release it, and scrubbing
// while paused must still produce the one frame that shows the new pose.
//
// Usage: node test/animation.mjs [url]   (needs the dev server running)

import { chromium } from 'playwright';

const APP = process.argv[2] ?? 'http://localhost:5173/';
const BASE = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models';
const ANIMATED = `${BASE}/BoxAnimated/glTF-Binary/BoxAnimated.glb`;
const STATIC = `${BASE}/Duck/glTF-Binary/Duck.glb`;

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const consoleErrors = [];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(APP, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => window.__viewer?.model != null, null, { timeout: 60_000 });

const { createHash } = await import('node:crypto');
async function viewportHash() {
  const bytes = await page.evaluate(async () => {
    const blob = await window.__viewer.captureScreenshot({ scale: 1 });
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return createHash('sha1').update(Buffer.from(bytes)).digest('hex');
}

// --- static model: the panel stays out of the way ------------------------

console.log('Static model');

const staticState = await page.evaluate(async (url) => {
  await window.__loadLink(url);
  return {
    hasAnimation: window.__viewer.animation != null,
    panelHidden: document.getElementById('animationGroup').hidden,
  };
}, STATIC);

check('no animation controller for a static model', staticState.hasAnimation === false);
check('animation panel is hidden', staticState.panelHidden === true);

// --- animated model ------------------------------------------------------

console.log('\nAnimated model');

const loaded = await page.evaluate(async (url) => {
  await window.__loadLink(url);
  const anim = window.__viewer.animation;
  return {
    hasAnimation: anim != null,
    clips: anim?.clips.length ?? 0,
    names: anim?.names ?? [],
    index: anim?.index,
    playing: anim?.playing,
    duration: anim?.duration ?? 0,
    panelHidden: document.getElementById('animationGroup').hidden,
    optionCount: document.getElementById('clipSelect').options.length,
  };
}, ANIMATED);

check('animation controller created', loaded.hasAnimation);
check('clips found', loaded.clips > 0, `${loaded.clips}: ${loaded.names.join(', ')}`);
check('clip duration known', loaded.duration > 0, `${loaded.duration.toFixed(2)}s`);
check('panel is shown', loaded.panelHidden === false);
check('clip list populated', loaded.optionCount === loaded.clips, `${loaded.optionCount} options`);

// The original autoplayed. Opening on a still frame is the deliberate change:
// a product shot should not start moving on its own.
check('starts paused on the first frame', loaded.playing === false && loaded.index === 0);

// --- the render loop contract -------------------------------------------

console.log('\nRender loop');

/**
 * Wait until the render loop has actually gone quiet.
 *
 * A fixed sleep is not enough. Loading a model reframes the camera, and
 * OrbitControls damping then converges over a long tail: `controls.update()`
 * runs on every tick and returns true — re-invalidating the loop — until it
 * settles, so stray frames keep trickling out for seconds after the load looks
 * finished. Drive damping to convergence first, then poll for quiet.
 */
async function waitForIdle(timeoutMs = 8000) {
  return page.evaluate(async (limit) => {
    const v = window.__viewer;
    const loop = v.loop;

    // Run the damping to completion rather than waiting it out in real time.
    for (let i = 0; i < 2000 && v.controls.update(1 / 60); i++) { /* converge */ }

    const started = performance.now();
    let quiet = 0;
    while (performance.now() - started < limit) {
      const before = loop.stats.rendered;
      await new Promise((r) => setTimeout(r, 250));
      if (loop.stats.rendered === before) {
        if (++quiet >= 3) return true;
      } else {
        quiet = 0;
      }
    }
    return false;
  }, timeoutMs);
}

/** Frames rendered over a window, having first waited for quiet. */
async function framesOver(ms) {
  return page.evaluate(async (duration) => {
    const loop = window.__viewer.loop;
    const start = loop.stats.rendered;
    await new Promise((r) => setTimeout(r, duration));
    return loop.stats.rendered - start;
  }, ms);
}

// The contract is about the loop *hold*, not about how many frames a
// software renderer manages to produce in a given wall-clock window. Assert
// the hold directly — it is deterministic, and it is the thing that actually
// makes playback render.
const holds = await page.evaluate(async () => {
  const v = window.__viewer;
  const loop = v.loop;

  const whenPaused = loop.isHeld('animation');
  v.animation.play();
  const whenPlaying = loop.isHeld('animation');
  const timeBefore = v.animation.time;

  // One real frame, to confirm the loop is genuinely driving playback and not
  // just flagged as held.
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));
  const timeAfter = v.animation.time;

  v.animation.pause();
  const afterPause = loop.isHeld('animation');

  return { whenPaused, whenPlaying, afterPause, advanced: timeAfter > timeBefore };
});

check('paused animation holds nothing', holds.whenPaused === false);
check('playing holds the loop open', holds.whenPlaying === true);
check('the loop actually advances playback', holds.advanced);
check('pausing releases the hold', holds.afterPause === false);

// And the hold really does translate into an idle loop once released.
const settled = await waitForIdle();
check('loop settles once paused', settled);

// --- scrubbing -----------------------------------------------------------

console.log('\nScrubbing');

// AnimationMixer has no seek; the implementation sets action.time and advances
// the mixer by zero. If that is wrong, the pose will not move.
await page.evaluate(() => window.__viewer.animation.seek(0));
await page.waitForTimeout(300);
const atStart = await viewportHash();

await page.evaluate(() => {
  const anim = window.__viewer.animation;
  anim.seek(anim.duration * 0.5);
});
await page.waitForTimeout(300);
const atMiddle = await viewportHash();

check('scrubbing while paused changes the pose', atStart !== atMiddle);

await page.evaluate(() => window.__viewer.animation.seek(0));
await page.waitForTimeout(300);
const backAtStart = await viewportHash();
check('scrubbing back restores the pose', backAtStart === atStart);

const clamped = await page.evaluate(() => {
  const anim = window.__viewer.animation;
  anim.seek(-5);
  const low = anim.time;
  anim.seek(anim.duration + 100);
  const high = anim.time;
  anim.seek(0);
  return { low, high, duration: anim.duration };
});
check('seek clamps to the clip', clamped.low === 0 && clamped.high === clamped.duration, `0..${clamped.duration.toFixed(2)}`);

// --- speed and loop ------------------------------------------------------

console.log('\nSpeed and loop');

// Driven with fixed deltas rather than timed against the wall clock. Sleeping
// and measuring how far the playhead got depends on how many frames a software
// renderer manages to produce, which varies with machine load — it produced
// 0.00s on a loaded machine and passed on an idle one. animation.update(delta)
// is exported precisely so this can be deterministic: stop the real loop, feed
// it known deltas, and assert the playhead advanced in exact proportion.
const speed = await page.evaluate(() => {
  const v = window.__viewer;
  const anim = v.animation;

  // Halt the real loop so nothing else advances the mixer underneath us.
  v.loop.stop();

  const advanceBy = (rate, seconds, step = 1 / 60) => {
    anim.setSpeed(rate);
    anim.seek(0);
    anim.play();
    for (let elapsed = 0; elapsed < seconds; elapsed += step) anim.update(step);
    const reached = anim.time;
    anim.pause();
    return reached;
  };

  // One second of wall time at each rate. Keep well inside the clip so a loop
  // wrap cannot muddy the comparison.
  const half = advanceBy(0.5, 1);
  const double = advanceBy(2, 1);

  anim.setSpeed(1);
  anim.seek(0);
  v.loop.start();

  return { half, double };
});

check(
  'playhead advances in proportion to speed',
  Math.abs(speed.half - 0.5) < 0.05 && Math.abs(speed.double - 2) < 0.05,
  `0.5x -> ${speed.half.toFixed(3)}s, 2x -> ${speed.double.toFixed(3)}s over 1s`,
);
check(
  'double speed is exactly four times half speed',
  Math.abs(speed.double / speed.half - 4) < 0.05,
  `ratio ${(speed.double / speed.half).toFixed(3)}`,
);

// A non-looping clip must stop at the end and hand the render loop back,
// rather than pinning it open forever on a finished animation. Driven with
// fixed deltas again, so this does not depend on the clip finishing inside
// some guessed wall-clock window.
const once = await page.evaluate(() => {
  const v = window.__viewer;
  const anim = v.animation;

  v.loop.stop();
  anim.setLooping(false);
  anim.setSpeed(1);
  anim.seek(0);
  anim.play();

  const held = v.loop.isHeld('animation');

  // Run past the end of the clip in 1/60s steps.
  const steps = Math.ceil((anim.duration + 0.5) * 60);
  for (let i = 0; i < steps; i++) anim.update(1 / 60);

  const result = {
    heldWhilePlaying: held,
    playing: anim.playing,
    heldAfter: v.loop.isHeld('animation'),
    time: anim.time,
    duration: anim.duration,
  };

  anim.setLooping(true);
  anim.seek(0);
  v.loop.start();
  return result;
});

check('non-looping clip held the loop while running', once.heldWhilePlaying === true);
check(
  'non-looping clip stops at the end',
  once.playing === false && Math.abs(once.time - once.duration) < 0.02,
  `t=${once.time.toFixed(2)}/${once.duration.toFixed(2)}s`,
);
check('and releases the loop hold', once.heldAfter === false);

// A looping clip, by contrast, must keep going past the end.
const loops = await page.evaluate(() => {
  const v = window.__viewer;
  const anim = v.animation;

  v.loop.stop();
  anim.setLooping(true);
  anim.setSpeed(1);
  anim.seek(0);
  anim.play();

  const steps = Math.ceil((anim.duration + 0.5) * 60);
  for (let i = 0; i < steps; i++) anim.update(1 / 60);

  const result = { playing: anim.playing, time: anim.time, duration: anim.duration };

  anim.pause();
  anim.seek(0);
  v.loop.start();
  return result;
});

check(
  'looping clip wraps and keeps playing',
  loops.playing === true && loops.time < loops.duration,
  `wrapped to t=${loops.time.toFixed(2)}s`,
);

await page.evaluate(() => {
  const anim = window.__viewer.animation;
  anim.setLooping(true);
  anim.setSpeed(1);
  anim.seek(0);
});

// --- clip switching ------------------------------------------------------

console.log('\nClip switching');

const switching = await page.evaluate(() => {
  const anim = window.__viewer.animation;
  const results = [];
  for (let i = 0; i < anim.clips.length; i++) {
    results.push({ ok: anim.select(i), index: anim.index, time: anim.time });
  }
  return { results, outOfRange: anim.select(999), afterBad: anim.index };
});

check('every clip can be selected', switching.results.every((r) => r.ok), `${switching.results.length} clips`);
check('selecting resets the playhead', switching.results.every((r) => r.time === 0));
check('out-of-range select is rejected', switching.outOfRange === false);
check('a rejected select leaves the current clip alone', switching.afterBad >= 0);

// --- disposal ------------------------------------------------------------

console.log('\nDisposal');

// Loading a static model while a clip is playing must release the loop hold,
// or the viewer would render flat out forever with nothing animating.
const disposal = await page.evaluate(async (url) => {
  const v = window.__viewer;
  v.animation.play();
  await new Promise((r) => setTimeout(r, 200));
  await window.__loadLink(url);
  return {
    animation: v.animation,
    held: v.loop.isHeld('animation'),
    panelHidden: document.getElementById('animationGroup').hidden,
  };
}, STATIC);

check('loading a static model clears the controller', disposal.animation === null);
check('and hides the panel again', disposal.panelHidden === true);
check('and drops the loop hold', disposal.held === false);

await waitForIdle();
const framesAfterSwap = await framesOver(700);
check('so the loop idles again', framesAfterSwap === 0, `${framesAfterSwap} frames in 700ms`);

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
