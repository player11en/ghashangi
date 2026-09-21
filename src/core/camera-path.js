// Camera-keyframe path: a short, ordered list of waypoints played back over
// a fixed duration, for exporting a camera move as a clip (Track 4.2).
//
// Deliberately not a full timeline editor - a handful of waypoints (position
// + look-at + an optional hold at each one), lerped between, is enough for a
// social clip and mirrors animation.js's own scope decision (a real
// AnimationMixer, but no curve editor). A smoother Catmull-Rom interpolation
// is a cheap upgrade later if straight lerp looks too mechanical in practice
// - not worth building before anyone has judged the simple version.
//
// Shaped like animation.js on purpose: play/pause/seek/update, loop.hold()
// while active, so a camera path behaves consistently with the model-clip
// playback already in this app rather than inventing a second convention.
//
// onBeforeRender is viewer.js's single exclusive per-frame hook (also used
// by turntable.js and recordCameraPath() below) - live preview playback and
// a recording can't both own it at once, same restriction that already
// exists between turntable and auto-rotate today.

import { recordClip } from './recorder.js';

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {() => void} [options.onChange]  Called whenever the waypoint list
 *   changes, so a UI can rebuild.
 */
export function createCameraPath({ viewer, onChange = () => {} }) {
  const { camera, controls, loop } = viewer;

  /** @type {Array<{position: Vector3, target: Vector3, holdMs: number}>} */
  const waypoints = [];

  let playing = false;
  let elapsedMs = 0;
  let durationSeconds = 8;
  let looping = false;

  function snapshot(position, target) {
    return {
      position: (position ?? camera.position).clone(),
      target: (target ?? controls.target).clone(),
      holdMs: 0,
    };
  }

  /** Add a waypoint at an explicit pose, or at the current view if omitted. */
  function addWaypoint(position, target) {
    waypoints.push(snapshot(position, target));
    onChange();
  }

  function addWaypointAtCurrentView() {
    addWaypoint();
  }

  function removeWaypoint(index) {
    if (index < 0 || index >= waypoints.length) return false;
    waypoints.splice(index, 1);
    onChange();
    return true;
  }

  function setHold(index, holdMs) {
    if (!waypoints[index]) return;
    waypoints[index].holdMs = Math.max(0, holdMs);
  }

  function clear() {
    waypoints.length = 0;
    onChange();
  }

  /**
   * Segment boundaries in normalized path-time for a playback of
   * `forDurationSeconds` seconds. Each waypoint's hold is a dwell before
   * departing toward the next one; holds are capped at 80% of the total so a
   * wall of holds can never collapse travel time to zero.
   */
  function segments(forDurationSeconds) {
    const n = waypoints.length;
    if (n < 2) return [];

    const totalMs = forDurationSeconds * 1000;
    const rawHold = waypoints.reduce((sum, w) => sum + w.holdMs, 0);
    const holdMs = Math.min(rawHold, totalMs * 0.8);
    const holdScale = rawHold > 0 ? holdMs / rawHold : 0;
    const travelPerSegmentMs = (totalMs - holdMs) / (n - 1);

    const bounds = [];
    let t = 0;
    for (let i = 0; i < n - 1; i++) {
      t += (waypoints[i].holdMs * holdScale) / totalMs;
      const holdEnd = t;
      t += travelPerSegmentMs / totalMs;
      bounds.push({ from: i, to: i + 1, holdEnd, travelEnd: t });
    }
    // Floating-point round-off can leave the last segment just short of 1;
    // pin it so evaluate(1) always resolves to the final waypoint exactly.
    bounds[bounds.length - 1].travelEnd = 1;
    return bounds;
  }

  /** Interpolated {position, target} at normalized path-time t (0..1). */
  function evaluate(t, forDurationSeconds = durationSeconds) {
    if (waypoints.length === 0) return null;
    if (waypoints.length === 1) {
      const w = waypoints[0];
      return { position: w.position.clone(), target: w.target.clone() };
    }

    const clamped = Math.max(0, Math.min(t, 1));
    const bounds = segments(forDurationSeconds);
    const seg = bounds.find((b) => clamped <= b.travelEnd) ?? bounds[bounds.length - 1];
    const a = waypoints[seg.from];
    const b = waypoints[seg.to];
    const localT = clamped <= seg.holdEnd
      ? 0
      : (clamped - seg.holdEnd) / Math.max(seg.travelEnd - seg.holdEnd, 1e-6);

    return {
      position: a.position.clone().lerp(b.position, localT),
      target: a.target.clone().lerp(b.target, localT),
    };
  }

  function apply(pose) {
    if (!pose) return;
    camera.position.copy(pose.position);
    controls.target.copy(pose.target);
    controls.update();
  }

  /** Scrub the whole path for live UI feedback, without playing it. */
  function preview(t) {
    apply(evaluate(t));
    loop.invalidate();
  }

  /**
   * Apply the pose at normalized path-time `fraction`, for a playback of
   * `forDurationSeconds` seconds - used by recordCameraPath() below, where
   * recorder.js already keeps the loop ticking every frame (via loop.hold),
   * so no extra invalidate() is needed here the way preview() needs one.
   */
  function driveFrom(fraction, forDurationSeconds) {
    apply(evaluate(fraction, forDurationSeconds));
  }

  /** Play the path live in the viewport. */
  function play({ duration = durationSeconds, loop: shouldLoop = false } = {}) {
    if (waypoints.length < 2 || playing) return;
    durationSeconds = duration;
    looping = shouldLoop;
    playing = true;
    elapsedMs = 0;
    loop.hold('cameraPath');
    viewer.onBeforeRender((delta) => update(delta));
    loop.invalidate();
  }

  function stop() {
    if (!playing) return;
    playing = false;
    viewer.onBeforeRender(null);
    loop.release('cameraPath');
  }

  /** Advance live playback. Installed as the render loop's per-frame hook. */
  function update(delta) {
    if (!playing) return;
    elapsedMs += delta * 1000;
    const t = elapsedMs / (durationSeconds * 1000);
    if (t >= 1) {
      apply(evaluate(1));
      if (looping) elapsedMs = 0;
      else stop();
      return;
    }
    apply(evaluate(t));
  }

  return {
    waypoints,
    addWaypoint,
    addWaypointAtCurrentView,
    removeWaypoint,
    setHold,
    clear,
    evaluate,
    preview,
    driveFrom,
    play,
    stop,
    // Exposed alongside play()/stop() so tests can drive playback with fixed
    // deltas instead of real wall-clock waits - the same reason
    // animation.js's update() is exported, not just used internally.
    update,
    get playing() {
      return playing;
    },
  };
}

/**
 * Record a camera path as a clip, reusing recorder.js exactly like
 * turntable.js does - this is the "onFrame drives a camera path instead of a
 * rotation" case the recorder generalization in 4.1 was built for.
 *
 * @param {object} options
 * @param {ReturnType<typeof createCameraPath>} options.cameraPath
 * @param {object} options.viewer
 * @param {number} options.duration  Seconds.
 * @param {number} [options.fps=30]
 * @param {(fraction:number) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Blob>} a .webm
 */
export function recordCameraPath({ cameraPath, viewer, duration, fps = 30, onProgress, signal }) {
  if (cameraPath.waypoints.length < 2) {
    return Promise.reject(new Error('Add at least two waypoints before recording a camera path.'));
  }

  const { camera, controls } = viewer;
  const startPosition = camera.position.clone();
  const startTarget = controls.target.clone();

  return recordClip({
    viewer,
    duration,
    fps,
    holdKey: 'cameraPath',
    onSetup() {
      const wasAutoRotating = viewer.isAutoRotating();
      viewer.setAutoRotate(false);
      return () => {
        camera.position.copy(startPosition);
        controls.target.copy(startTarget);
        controls.update();
        viewer.setAutoRotate(wasAutoRotating);
      };
    },
    onFrame(fraction) {
      cameraPath.driveFrom(fraction, duration);
    },
    onProgress,
    signal,
  });
}
