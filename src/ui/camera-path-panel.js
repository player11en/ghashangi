// The Camera Path panel: waypoint list, duration, live preview, and clip
// export.
//
// Shaped like animation-panel.js (list + transport + scrubber) — a camera
// path is conceptually the same kind of thing as a clip's timeline, just
// driving the camera instead of a skinned mesh, so it reuses that shape
// rather than inventing a second convention.

import { recordCameraPath, recordStatic } from '../core/camera-path.js';
import { formatBytes } from './progress.js';
import { logExport } from '../core/telemetry.js';
import { withAspectLock, lockAspect, unlockAspect } from './aspect-lock.js';

const $ = (id) => document.getElementById(id);

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {ReturnType<typeof import('../core/camera-path.js').createCameraPath>} options.cameraPath
 * @param {object} options.toasts
 * @param {() => string} options.getModelName
 * @param {HTMLElement} options.container  The viewport element - locked to
 *   the chosen aspect ratio (Track 4.6) for the duration of preview/record.
 * @param {boolean} [options.recordingSupported=true]  False when the browser
 *   can't record WebM at all (checked by the caller) - keeps the Record
 *   button disabled regardless of waypoint count, since syncButtons() would
 *   otherwise re-enable it the moment there are two waypoints.
 */
export function createCameraPathPanel({
  viewer, cameraPath, toasts, getModelName, container, recordingSupported = true,
}) {
  const select = $('cpWaypoints');
  const addButton = $('cpAddWaypoint');
  const removeButton = $('cpRemoveWaypoint');
  const durationSlider = $('cpDuration');
  const durationOut = $('cpDurationOut');
  const aspectSelect = $('cpAspect');
  const scrub = $('cpScrub');
  const previewButton = $('cpPreviewPlay');
  const recordButton = $('cpRecord');
  const recordStaticButton = $('cpRecordStatic');

  function duration() {
    return parseFloat(durationSlider.value);
  }

  function aspect() {
    return aspectSelect.value;
  }

  function syncButtons() {
    // One waypoint is enough: it is a locked-off shot, not an unfinished move
    // (see camera-path.js's play() for why evaluate() handles it already).
    const ready = cameraPath.waypoints.length >= 1;
    previewButton.disabled = !ready;
    recordButton.disabled = !ready || !recordingSupported;
    removeButton.disabled = cameraPath.waypoints.length === 0;
    // Recording the live view needs no waypoints at all.
    recordStaticButton.disabled = !recordingSupported;
  }

  /** Rebuild the waypoint <select> after any add/remove. */
  function rebuildList() {
    const previous = select.value;
    select.replaceChildren();
    cameraPath.waypoints.forEach((_, i) => {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `Waypoint ${i + 1}`;
      select.appendChild(option);
    });
    if (cameraPath.waypoints.length > 0) {
      const keepIndex = Number(previous);
      select.value = Number.isInteger(keepIndex) && keepIndex < cameraPath.waypoints.length
        ? previous
        : String(cameraPath.waypoints.length - 1);
    }
    syncButtons();
  }

  function syncPreviewButton() {
    previewButton.textContent = cameraPath.playing ? '■ Stop' : '▶ Preview';
  }

  // Preview is open-ended (the user stops it whenever), unlike recording's
  // single bounded call - lockAspect/unlockAspect as a pair rather than
  // withAspectLock's wrap-a-function shape.
  let previewAspectLock = null;

  // --- wiring ----------------------------------------------------------

  addButton.addEventListener('click', () => {
    cameraPath.addWaypointAtCurrentView();
  });

  removeButton.addEventListener('click', () => {
    const index = parseInt(select.value, 10);
    if (!Number.isNaN(index)) cameraPath.removeWaypoint(index);
  });

  durationSlider.addEventListener('input', () => {
    durationOut.textContent = `${durationSlider.value}s`;
  });

  scrub.addEventListener('input', () => {
    if (cameraPath.playing) cameraPath.stop();
    syncPreviewButton();
    cameraPath.preview(parseFloat(scrub.value));
  });

  previewButton.addEventListener('click', () => {
    if (cameraPath.playing) {
      cameraPath.stop();
      unlockAspect(container, viewer, previewAspectLock);
      previewAspectLock = null;
    } else {
      previewAspectLock = lockAspect(container, viewer, aspect());
      cameraPath.play({ duration: duration(), loop: true });
    }
    syncPreviewButton();
  });

  /**
   * Everything a recording needs apart from which recorder runs: stop a live
   * preview first, hold the aspect lock, report progress on the button that
   * was pressed, download the result, and restore the button either way.
   *
   * Shared rather than duplicated because the locked-off and camera-path
   * recordings differ only in the call in the middle - and a second copy of
   * the object-URL cleanup is exactly the kind of thing that rots.
   */
  async function runRecording({ button, suffix, label: what, record }) {
    if (cameraPath.playing) {
      cameraPath.stop();
      unlockAspect(container, viewer, previewAspectLock);
      previewAspectLock = null;
      syncPreviewButton();
    }

    const label = button.textContent;
    button.disabled = true;

    try {
      const blob = await withAspectLock(container, viewer, aspect(), () => record({
        onProgress: (fraction) => {
          button.textContent = `Recording ${Math.round(fraction * 100)}%`;
        },
      }));

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${(getModelName() || 'model').replace(/\.[^.]+$/, '')}-${suffix}.webm`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);

      logExport('webm');
      toasts.info(`${what} recorded`, formatBytes(blob.size));
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error(`[Ghashangi] ${suffix} recording failed`, error);
        toasts.error(`Could not record the ${what.toLowerCase()}`, String(error.message));
      }
    } finally {
      button.disabled = false;
      button.textContent = label;
      syncButtons();
    }
  }

  recordButton.addEventListener('click', () => runRecording({
    button: recordButton,
    suffix: 'camera-path',
    label: 'Camera path',
    record: ({ onProgress }) => recordCameraPath({
      cameraPath,
      viewer,
      duration: duration(),
      onProgress,
    }),
  }));

  // No waypoints involved: records the view as it currently sits, for a model
  // playing its own animation or for the time-varying Style passes, both of
  // which move on their own with the camera still.
  recordStaticButton.addEventListener('click', () => runRecording({
    button: recordStaticButton,
    suffix: 'clip',
    label: 'Clip',
    record: ({ onProgress }) => recordStatic({
      viewer,
      duration: duration(),
      onProgress,
    }),
  }));

  rebuildList();

  return { rebuildList };
}
