// Turntable recording: a product spin, exported as a clip.
//
// A turntable is the standard product deliverable in both KeyShot and Marmoset
// Toolbag. The app already spins the model on screen via setAutoRotate(); there
// was simply no way to get that out as a file.
//
// The recording mechanism itself (MediaRecorder, canvas.captureStream(), the
// render-loop hold) lives in recorder.js and is shared with camera-path
// recording (Track 4.2) - this file supplies only what's actually turntable-
// specific: driving rotation from elapsed time so the clip is exactly N
// revolutions and loops seamlessly, and pausing/restoring auto-rotate around
// the recording so the two don't fight over the same Euler angle.

import { recordClip, supportedCodec, isClipRecordingSupported } from './recorder.js';

export { supportedCodec };

export function isTurntableSupported() {
  return isClipRecordingSupported();
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
  if (!viewer.model) {
    return Promise.reject(new Error('Load a model before recording a turntable.'));
  }

  const { modelRoot } = viewer;
  const startRotation = modelRoot.rotation.y;

  return recordClip({
    viewer,
    duration,
    fps,
    // Kept as the literal string 'turntable', not a generic default: this is
    // what test/render.mjs asserts against via loop.isHeld('turntable').
    holdKey: 'turntable',
    onSetup() {
      // Auto-rotate would fight us for the same Euler; remember whether it
      // was on and put it back afterwards.
      const wasAutoRotating = viewer.isAutoRotating();
      viewer.setAutoRotate(false);
      return () => {
        modelRoot.rotation.y = startRotation;
        viewer.setAutoRotate(wasAutoRotating);
      };
    },
    onFrame(fraction) {
      // Exactly N revolutions over the duration: the final frame coincides
      // with the first, so the clip loops without a visible seam.
      modelRoot.rotation.y = startRotation + fraction * revolutions * Math.PI * 2;
      viewer.lights.requestShadowUpdate();
    },
    onProgress,
    signal,
  });
}
