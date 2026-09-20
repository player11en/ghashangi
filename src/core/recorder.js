// Generic clip recording: MediaRecorder + canvas.captureStream(), driven by
// the render loop rather than a timer.
//
// Factored out of turntable.js (Track 4.1) so camera-path recording (Track
// 4.2) and turntable recording can share one mechanism. Everything here is
// truly generic; the only thing that made turntable.js look recorder-
// specific was its own rotation math, which now lives in the caller's
// `onFrame` instead.
//
// Two things that are easy to get wrong, inherited from turntable.js:
//
// Frame supply. Rendering is on demand, so a loop that has gone idle would
// starve the recorder of frames and produce a stuttering or truncated video.
// The recording holds the loop open for its whole duration.
//
// Exact duration. Driven from *elapsed time* against the render loop's own
// frames (not a fixed timer), so `onFrame` always receives the fraction that
// corresponds to the frame actually being drawn - required for a turntable
// to loop seamlessly, and just as true for a camera path.

/** Codecs to try, best first. Safari has historically supported none of these. */
const CODECS = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

/** The first supported codec, or null if the browser cannot record WebM. */
export function supportedCodec() {
  if (typeof MediaRecorder === 'undefined') return null;
  return CODECS.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export function isClipRecordingSupported() {
  return supportedCodec() !== null;
}

/**
 * Record `duration` seconds of the viewport, driving whatever changes per
 * frame (rotation, camera position, ...) via `onFrame`.
 *
 * @param {object} options
 * @param {object} options.viewer
 * @param {number} options.duration       Seconds.
 * @param {number} [options.fps=30]
 * @param {string} [options.holdKey='clip']  Passed to `loop.hold()`/
 *   `release()` - callers that want a specific, testable key (turntable.js
 *   uses 'turntable') can set this; otherwise it's just an implementation
 *   detail.
 * @param {(fraction:number, elapsedMs:number) => void} [options.onFrame]
 *   Called once per rendered frame with progress through the clip (0..1).
 *   This is where a rotation or camera-path driver does its per-frame work.
 * @param {() => (() => void)} [options.onSetup]  Called once before
 *   recording starts; its return value is called during cleanup. Used for
 *   state a driver needs saved/restored around the recording (turntable.js
 *   pausing and restoring auto-rotate, for example) without recorder.js
 *   needing to know what that state is.
 * @param {(fraction:number) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Blob>} a .webm
 */
export function recordClip({
  viewer,
  duration,
  fps = 30,
  holdKey = 'clip',
  onFrame = () => {},
  onSetup = () => () => {},
  onProgress = () => {},
  signal,
} = {}) {
  const mimeType = supportedCodec();
  if (!mimeType) {
    return Promise.reject(new Error('This browser cannot record WebM video.'));
  }

  return new Promise((resolve, reject) => {
    const { loop, canvas } = viewer;

    const teardown = onSetup();

    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      // Enough for a clean clip without producing a huge file.
      videoBitsPerSecond: 12_000_000,
    });

    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    let finished = false;

    function cleanup() {
      if (finished) return;
      finished = true;
      loop.release(holdKey);
      viewer.onBeforeRender(null);
      for (const track of stream.getTracks()) track.stop();
      teardown();
      loop.invalidate(2);
    }

    recorder.addEventListener('stop', () => {
      cleanup();
      if (chunks.length === 0) {
        reject(new Error('The recorder produced no data.'));
        return;
      }
      resolve(new Blob(chunks, { type: mimeType }));
    });

    recorder.addEventListener('error', (event) => {
      cleanup();
      reject(event.error ?? new Error('Recording failed.'));
    });

    signal?.addEventListener('abort', () => {
      if (recorder.state !== 'inactive') recorder.stop();
      cleanup();
      reject(new DOMException('Recording cancelled', 'AbortError'));
    }, { once: true });

    const totalMs = duration * 1000;
    let startedAt = null;

    // Driven per rendered frame rather than on a timer, so whatever onFrame
    // animates is always at the position that was actually drawn.
    viewer.onBeforeRender(() => {
      if (startedAt === null) startedAt = performance.now();
      const elapsed = performance.now() - startedAt;
      const fraction = Math.min(elapsed / totalMs, 1);

      onFrame(fraction, elapsed);
      onProgress(fraction);

      if (fraction >= 1 && recorder.state === 'recording') {
        // One extra frame has already been drawn at fraction 1; stopping here
        // keeps that frame in the output rather than cutting it short.
        recorder.stop();
      }
    });

    // Keep the on-demand loop running for the whole recording, or it would
    // idle and starve the recorder.
    loop.hold(holdKey);
    loop.invalidate();

    recorder.start();

    // Belt and braces: if frames stop arriving the recorder would never reach
    // fraction >= 1, so stop on wall-clock time too.
    setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, totalMs + 2000);
  });
}
