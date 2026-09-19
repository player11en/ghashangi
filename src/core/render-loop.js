// One render loop, rendering only when the image would actually change.
//
// The original code ran two loops at once:
//
//   function animate() {
//     requestAnimationFrame(animate);   // loop A
//     controls.update();
//     ...
//     renderer.setAnimationLoop(render); // re-registered every frame
//   }
//
// So the scene was drawn twice per frame, and the WebXR animation callback was
// re-assigned ~60 times a second. Both are fixed by registering
// setAnimationLoop exactly once: outside XR three drives it with
// requestAnimationFrame, and inside an XR session it switches to the headset's
// frame callback automatically. There is never a reason to run both.
//
// On top of that, a model viewer is static almost all of the time. Rendering
// unconditionally burns GPU (and laptop battery) drawing identical frames. This
// loop renders when something has invalidated the view, and otherwise idles.

// Timer, not Clock: r186 deprecates Clock in favour of Timer. Timer is also the
// better fit here — it takes the timestamp the animation loop already hands us
// rather than reading the wall clock again, and connect(document) makes it
// absorb tab-visibility changes. With Clock, backgrounding a tab for a minute
// and returning produced a single 60-second delta, which teleported every
// animation forward and, with damping, threw the camera across the scene.
import { Timer } from 'three';

/**
 * @param {object} options
 * @param {import('three').WebGLRenderer} options.renderer
 * @param {(delta:number, time:number, frame:XRFrame|undefined) => void} options.update
 *   Advance animation/controls state. Call `invalidate()` from here (or let the
 *   returned continuous holds do it) when the view needs redrawing.
 * @param {(frame:XRFrame|undefined) => void} options.render
 *   Draw one frame.
 */
export function createRenderLoop({ renderer, update, render }) {
  const timer = new Timer();
  timer.connect(document);

  // Frames still owed. Some changes do not settle in a single frame — a texture
  // finishing its decode, a material compiling, OrbitControls damping coming to
  // rest — so callers can ask for a short burst instead of exactly one frame.
  let pendingFrames = 1;

  // Reasons the view must redraw every frame: a playing animation clip,
  // auto-rotate, an active XR session. Keyed by name so a caller can release
  // its own hold without tracking a reference count.
  const holds = new Set();

  let running = false;

  // Rolling frame-time stats for the HUD and for adaptive resolution.
  const stats = { fps: 0, frameTime: 0, rendered: 0, skipped: 0 };
  let statWindowStart = 0;
  let statWindowFrames = 0;

  /**
   * Mark the view as needing a redraw.
   * @param {number} [frames=1] How many frames to draw before idling again.
   */
  function invalidate(frames = 1) {
    pendingFrames = Math.max(pendingFrames, frames);
  }

  /** Redraw every frame until `release(reason)` is called. */
  function hold(reason) {
    holds.add(reason);
    invalidate();
  }

  /** Drop a continuous-render hold. */
  function release(reason) {
    holds.delete(reason);
    // One more frame so whatever was animating settles on its final image.
    invalidate();
  }

  function isHeld(reason) {
    return holds.has(reason);
  }

  function tick(time, frame) {
    // Timer requires an explicit update per frame, unlike Clock's implicit
    // read-on-getDelta.
    timer.update(time);
    const delta = timer.getDelta();

    update(delta, time, frame);

    // An XR session owns its frame pacing; never skip a frame while presenting
    // or the headset will reproject a stale image.
    const mustRender = renderer.xr.isPresenting || holds.size > 0;

    if (!mustRender && pendingFrames <= 0) {
      stats.skipped++;
      return;
    }

    const started = performance.now();
    render(frame);
    stats.frameTime = performance.now() - started;
    stats.rendered++;
    if (pendingFrames > 0) pendingFrames--;

    // FPS over a ~500ms window: long enough to be readable, short enough to
    // react to a stutter.
    statWindowFrames++;
    if (statWindowStart === 0) statWindowStart = started;
    const elapsed = started - statWindowStart;
    if (elapsed >= 500) {
      stats.fps = (statWindowFrames * 1000) / elapsed;
      statWindowFrames = 0;
      statWindowStart = started;
    }
  }

  function start() {
    if (running) return;
    running = true;
    timer.reset();
    renderer.setAnimationLoop(tick);
  }

  function stop() {
    if (!running) return;
    running = false;
    renderer.setAnimationLoop(null);
  }

  function dispose() {
    stop();
    timer.disconnect();
    timer.dispose();
  }

  return { start, stop, dispose, invalidate, hold, release, isHeld, stats };
}
