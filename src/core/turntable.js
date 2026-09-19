// Turntable recording.
//
// A turntable is the standard product deliverable in both KeyShot and Marmoset
// Toolbag. The app already spins the model on screen via setAutoRotate(); there
// was simply no way to get that out as a file.
//
// MediaRecorder + canvas.captureStream() is built into the browser, so this
// needs no dependency, and it pairs naturally with colourways: one turntable
// per colour variant.
//
// Two things that are easy to get wrong:
//
// Seamless looping. Rotation is driven from *elapsed time*, not from the
// existing auto-rotate speed, so the clip is exactly N revolutions and the last
// frame lands back on the first. A turntable that does not loop cleanly is
// useless for a product page.
//
// Frame supply. Rendering is on demand, so a loop that has gone idle would
// starve the recorder of frames and produce a stuttering or truncated video.
// The recording holds the loop open for its whole duration.

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

export function isTurntableSupported() {
  return supportedCodec() !== null;
}

/**
 * Spin the model through a whole number of revolutions and record it.
 *
 * @param {object} options
 * @param {object} options.viewer
 * @param {number} [options.revolutions=1]
 * @param {number} [options.duration=6]      Seconds.
 * @param {number} [options.fps=30]
 * @param {(fraction:number) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Blob>} a .webm
 */
export function recordTurntable({
  viewer,
  revolutions = 1,
  duration = 6,
  fps = 30,
  onProgress = () => {},
  signal,
} = {}) {
  const mimeType = supportedCodec();
  if (!mimeType) {
    return Promise.reject(new Error('This browser cannot record WebM video.'));
  }
  if (!viewer.model) {
    return Promise.reject(new Error('Load a model before recording a turntable.'));
  }

  return new Promise((resolve, reject) => {
    const { modelRoot, loop, canvas } = viewer;

    // Auto-rotate would fight us for the same Euler; remember whether it was on
    // and put it back afterwards.
    const wasAutoRotating = viewer.isAutoRotating();
    const startRotation = modelRoot.rotation.y;

    viewer.setAutoRotate(false);

    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      // Enough for a clean product turntable without producing a huge file.
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
      loop.release('turntable');
      viewer.onBeforeRender(null);
      for (const track of stream.getTracks()) track.stop();

      modelRoot.rotation.y = startRotation;
      viewer.setAutoRotate(wasAutoRotating);
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

    // Driven per rendered frame rather than on a timer, so the rotation the
    // recorder captures is always the rotation that was drawn.
    viewer.onBeforeRender(() => {
      if (startedAt === null) startedAt = performance.now();
      const elapsed = performance.now() - startedAt;
      const fraction = Math.min(elapsed / totalMs, 1);

      // Exactly N revolutions over the duration: the final frame coincides with
      // the first, so the clip loops without a visible seam.
      modelRoot.rotation.y = startRotation + fraction * revolutions * Math.PI * 2;
      viewer.lights.requestShadowUpdate();
      onProgress(fraction);

      if (fraction >= 1 && recorder.state === 'recording') {
        // One extra frame has already been drawn at the final rotation; stopping
        // here keeps the last frame identical to the first.
        recorder.stop();
      }
    });

    // Keep the on-demand loop running for the whole recording, or it would idle
    // and starve the recorder.
    loop.hold('turntable');
    loop.invalidate();

    recorder.start();

    // Belt and braces: if frames stop arriving the recorder would never reach
    // fraction >= 1, so stop on wall-clock time too.
    setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, totalMs + 2000);
  });
}
