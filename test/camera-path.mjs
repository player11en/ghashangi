// Camera-keyframe path: waypoints, preview, deterministic playback, and clip
// recording (Track 4.2).
//
// The interesting risks mirror animation.mjs's: playback must be
// deterministic (drive with fixed deltas, not wall-clock sleeps, or the
// assertions flake with machine load), and the render-loop hold must be
// taken while playing/recording and released afterward, or an on-demand
// loop would either starve a recording of frames or stay pinned open
// forever.
//
// Usage: node test/camera-path.mjs [url]   (needs the dev server running)

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
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(APP, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => window.__viewer?.model != null, null, { timeout: 60_000 });

// --- waypoints and preview -------------------------------------------------

console.log('Waypoints and preview');

const waypointState = await page.evaluate(() => {
  const v = window.__viewer;
  const cp = window.__cameraPath;
  cp.clear();

  v.camera.position.set(0, 5, 20);
  v.controls.target.set(0, 1, 0);
  cp.addWaypointAtCurrentView();

  v.camera.position.set(10, 2, 0);
  v.controls.target.set(0, 0, 0);
  cp.addWaypointAtCurrentView();

  return {
    count: cp.waypoints.length,
    first: { position: cp.waypoints[0].position.toArray(), target: cp.waypoints[0].target.toArray() },
    second: { position: cp.waypoints[1].position.toArray(), target: cp.waypoints[1].target.toArray() },
  };
});

check('two waypoints recorded', waypointState.count === 2);
check(
  'first waypoint captured the view at the time it was added',
  waypointState.first.position[0] === 0 && waypointState.first.position[2] === 20,
  `${waypointState.first.position}`,
);
check(
  'second waypoint captured the view at the time it was added',
  waypointState.second.position[0] === 10 && waypointState.second.position[2] === 0,
  `${waypointState.second.position}`,
);

const previewEnds = await page.evaluate(() => {
  const cp = window.__cameraPath;
  const at0 = cp.evaluate(0);
  const at1 = cp.evaluate(1);
  return {
    at0: { position: at0.position.toArray(), target: at0.target.toArray() },
    at1: { position: at1.position.toArray(), target: at1.target.toArray() },
  };
});

check(
  'preview(0) lands exactly on the first waypoint',
  JSON.stringify(previewEnds.at0.position) === JSON.stringify(waypointState.first.position) &&
    JSON.stringify(previewEnds.at0.target) === JSON.stringify(waypointState.first.target),
);
check(
  'preview(1) lands exactly on the last waypoint',
  JSON.stringify(previewEnds.at1.position) === JSON.stringify(waypointState.second.position) &&
    JSON.stringify(previewEnds.at1.target) === JSON.stringify(waypointState.second.target),
);

// --- deterministic playback ------------------------------------------------
//
// Same reasoning as test/animation.mjs's speed check: driven with fixed
// deltas against the exported update(), not timed sleeps, so this doesn't
// flake under machine load.

console.log('\nDeterministic playback');

const playback = await page.evaluate(() => {
  const v = window.__viewer;
  const cp = window.__cameraPath;

  v.loop.stop();

  cp.play({ duration: 2, loop: false });
  const heldWhilePlaying = v.loop.isHeld('cameraPath');

  const step = 1 / 60;
  for (let elapsed = 0; elapsed < 1; elapsed += step) cp.update(step);
  const halfway = v.camera.position.toArray();

  for (let elapsed = 0; elapsed < 1.1; elapsed += step) cp.update(step);
  const atEnd = v.camera.position.toArray();
  const heldAfterFinish = v.loop.isHeld('cameraPath');

  v.loop.start();

  return { heldWhilePlaying, halfway, atEnd, heldAfterFinish };
});

check('playback holds the loop open while playing', playback.heldWhilePlaying === true);
check(
  'camera is partway between waypoints at the midpoint',
  Math.abs(playback.halfway[0] - 5) < 1.5,
  `x=${playback.halfway[0].toFixed(2)} (expected roughly 5, halfway between 0 and 10)`,
);
check(
  'camera reaches the final waypoint by the end of a non-looping path',
  Math.abs(playback.atEnd[0] - 10) < 0.01,
  `x=${playback.atEnd[0].toFixed(3)}`,
);
check('a finished non-looping path releases the loop hold', playback.heldAfterFinish === false);

// --- recording ---------------------------------------------------------

console.log('\nRecording');

const supported = await page.evaluate(() => {
  return import('/src/core/recorder.js').then((m) => m.isClipRecordingSupported());
});
check('WebM recording is available in this browser', supported);

if (supported) {
  const recording = await page.evaluate(async () => {
    const v = window.__viewer;
    const cp = window.__cameraPath;
    const { recordCameraPath } = await import('/src/core/camera-path.js');

    const positionBefore = v.camera.position.toArray();
    const targetBefore = v.controls.target.toArray();

    const blob = await recordCameraPath({ cameraPath: cp, viewer: v, duration: 2 });

    return {
      size: blob.size,
      type: blob.type,
      positionBefore,
      positionAfter: v.camera.position.toArray(),
      targetBefore,
      targetAfter: v.controls.target.toArray(),
      heldAfter: v.loop.isHeld('cameraPath'),
    };
  });

  check('resolves with a WebM-typed blob', recording.type.startsWith('video/webm'), recording.type);
  check(
    'camera position is restored afterwards',
    JSON.stringify(recording.positionAfter) === JSON.stringify(recording.positionBefore),
  );
  check(
    'camera target is restored afterwards',
    JSON.stringify(recording.targetAfter) === JSON.stringify(recording.targetBefore),
  );
  check('the loop hold is released', recording.heldAfter === false);

  // Diagnostic only, not gated: whether real frame data came through depends
  // on the browser's media pipeline, which headless Chromium + SwiftShader
  // cannot exercise — the same documented limitation test/render.mjs's
  // turntable section hits. See test/README.md.
  console.log(`  i  recorded blob: ${recording.size} bytes (frame-data quality not checked here; verify manually in a real browser)`);
}

// --- aspect lock (Track 4.6) ------------------------------------------

console.log('\nAspect lock');

// Found necessary, not assumed: measured the ResizeObserver viewer.js
// resizes from taking longer than 300ms to actually resize the canvas in
// roughly 2 of every 3 runs under headless Chromium + SwiftShader before
// lockAspect() started forcing viewer.resize() synchronously. This check
// takes zero wait time deliberately - if the fix regresses back to relying
// on the observer's own timing, this should start flaking exactly the way
// manual testing did.
const aspectLock = await page.evaluate(async () => {
  const v = window.__viewer;
  const container = document.getElementById('viewport');
  const { lockAspect, unlockAspect } = await import('/src/ui/aspect-lock.js');

  const before = { w: v.canvas.width, h: v.canvas.height };
  const snapshot = lockAspect(container, v, '9:16');
  const locked = { w: v.canvas.width, h: v.canvas.height, ratio: v.canvas.height / v.canvas.width };
  unlockAspect(container, v, snapshot);
  const restored = { w: v.canvas.width, h: v.canvas.height };

  return { before, locked, restored };
});

check(
  '9:16 lock resizes the canvas immediately, no wait needed',
  Math.abs(aspectLock.locked.ratio - 16 / 9) < 0.01,
  `ratio ${aspectLock.locked.ratio.toFixed(3)} (${aspectLock.locked.w}x${aspectLock.locked.h})`,
);
check(
  'unlocking restores the original canvas size exactly',
  aspectLock.restored.w === aspectLock.before.w && aspectLock.restored.h === aspectLock.before.h,
  `${aspectLock.before.w}x${aspectLock.before.h} -> ${aspectLock.restored.w}x${aspectLock.restored.h}`,
);

const rejectedWithoutWaypoints = await page.evaluate(async () => {
  const v = window.__viewer;
  const { createCameraPath, recordCameraPath } = await import('/src/core/camera-path.js');
  const empty = createCameraPath({ viewer: v });
  try {
    await recordCameraPath({ cameraPath: empty, viewer: v, duration: 1 });
    return false;
  } catch {
    return true;
  }
});
check('recording without enough waypoints is rejected', rejectedWithoutWaypoints);

// --- report ----------------------------------------------------------------

await browser.close();

const unexpected = [...new Set(consoleErrors)];
if (unexpected.length > 0) {
  console.log(`\nConsole errors (${unexpected.length}):`);
  for (const e of unexpected) console.log(`  ! ${e.slice(0, 160)}`);
  failures.push('console errors');
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s).`);
  process.exit(1);
}
console.log('\nAll checks passed.');
