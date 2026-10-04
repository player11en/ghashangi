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

/**
 * Container and codec preferences, best first.
 *
 * MP4/H.264 leads, and that ordering is the whole point. WebM does not play on
 * iOS or in Safari and does not import into most editors, so a clip made here
 * to be posted somewhere frequently could not be. MP4 plays everywhere that
 * matters and drops straight into a timeline.
 *
 * No transcoding step is involved. MediaRecorder encodes H.264 natively in
 * Chromium and Safari, which was worth checking before reaching for
 * ffmpeg.wasm - that would have been roughly 25 MB of WebAssembly to do what
 * the browser already does in hardware. Firefox records WebM only, so it falls
 * through to the entries below and keeps working exactly as before.
 *
 * avc1.42E01E is Constrained Baseline, the most widely decodable H.264 profile
 * there is; 4D401E is Main, listed after it as a better-quality fallback for
 * anything that offers Main but not Baseline.
 */
const WEBM_CODECS = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

const MP4_CODECS = [
  // Constrained Baseline first - the most widely decodable H.264 profile
  // there is. Main is listed after it as a better-quality fallback for
  // anything that offers Main but not Baseline.
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1.4D401E',
  'video/mp4',
];

/**
 * WebM leads, and MP4 is an explicit choice rather than the silent default.
 *
 * MP4 is what plays on iOS and imports into editors, so it is the format most
 * people actually want - but it is offered rather than assumed, because it
 * could not be verified working here. Measured directly: MediaRecorder encodes
 * H.264 fine from a 2D canvas (2 KB from a 20-frame test) and produces zero
 * bytes from a WebGL canvas in the same browser, while VP9 from that same
 * WebGL canvas produces a valid file. The H.264 path also starved the render
 * loop - 3 frames against VP9's 14 over the same interval.
 *
 * That may well be specific to this software-rendered headless build, and on a
 * real GPU MP4 may be flawless. But defaulting to a container that was never
 * once observed producing a file is not a trade worth making silently, so the
 * default is the one with evidence behind it and MP4 is one click away with a
 * fallback behind it.
 */
const CODECS = [...WEBM_CODECS, ...MP4_CODECS];

/** Codec lists by the format a user asked for. */
const BY_FORMAT = {
  webm: [...WEBM_CODECS, ...MP4_CODECS],
  mp4: [...MP4_CODECS, ...WEBM_CODECS],
};

/**
 * The file extension matching whatever codec was negotiated.
 *
 * Derived from the recorder's actual mimeType rather than assumed: naming an
 * MP4 file .webm produces something players refuse to open even though the
 * bytes are fine, which is a worse failure than not supporting MP4 at all.
 */
export function extensionFor(mimeType) {
  return String(mimeType).includes('mp4') ? 'mp4' : 'webm';
}

/** The first supported codec, or null if the browser cannot record video. */
export function supportedCodec(format = 'webm') {
  if (typeof MediaRecorder === 'undefined') return null;
  const order = BY_FORMAT[format] ?? CODECS;
  return order.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

/**
 * A codec of a different container than the ones already tried.
 *
 * Used for the fallback below: retrying MP4 with a second H.264 profile after
 * MP4 produced nothing is pointless, since the container is the suspect part.
 * Jumping to WebM is what actually changes the outcome.
 */
function differentContainer(tried) {
  if (typeof MediaRecorder === 'undefined') return null;
  const triedMp4 = String(tried).includes('mp4');
  const others = triedMp4 ? WEBM_CODECS : MP4_CODECS;
  return others.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
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
function recordOnce({
  viewer,
  duration,
  fps = 30,
  holdKey = 'clip',
  onFrame = () => {},
  onSetup = () => () => {},
  onProgress = () => {},
  signal,
  mimeType,
  // Accepted and ignored here: recordClip() resolves it into a mimeType before
  // calling this, and listing it keeps it out of the rest-spread below.
  format,
} = {}) {
  if (!mimeType) {
    return Promise.reject(new Error('This browser cannot record video.'));
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

/**
 * Record a clip, falling back to another container if the first produces
 * nothing.
 *
 * MediaRecorder.isTypeSupported() reports what the browser is willing to
 * *accept*, not what it will successfully produce from a given source, and the
 * two are not the same thing - MP4 was advertised as supported while a WebGL
 * canvas capture yielded zero bytes. Rather than trust the advertisement or
 * abandon MP4 (which is the only container that plays on iOS and imports into
 * editors), a recording that comes back empty is retried once in a different
 * container.
 *
 * Bounded at two attempts, and only ever triggered by the empty case, so a
 * working first attempt costs nothing. The worst case is a recording that
 * takes twice as long; there is no case where a browser that could have
 * produced a file returns an error instead.
 *
 * @param {object} options  As recordOnce, minus mimeType.
 * @returns {Promise<Blob>}
 */
export async function recordClip(options = {}) {
  const first = supportedCodec(options.format);
  if (!first) throw new Error('This browser cannot record video.');

  try {
    return await recordOnce({ ...options, mimeType: first });
  } catch (error) {
    // Only an empty result is worth retrying. An abort is the user's choice,
    // and a genuine encoder error will not be fixed by a different container.
    if (error?.name === 'AbortError' || !/produced no data/i.test(String(error?.message))) {
      throw error;
    }

    const second = differentContainer([first]);
    if (!second) throw error;

    console.warn(
      `[Ghashangi] ${first} recorded nothing; retrying as ${second}. `
      + 'The browser reported support for a container it could not produce from this canvas.',
    );
    return recordOnce({ ...options, mimeType: second });
  }
}
