// The timeline: one lane per keyframed control, keys drawn where they sit.
//
// This is what turns the keyframe engine into something usable. Before it, a
// track list could say "ambient light, 3 keys" and nothing more - you could not
// see when those keys were, move one, or delete one without clearing the whole
// track.
//
// Deliberately not a Blender dope sheet. Blender edits a scene graph with
// hundreds of animatable channels and earns its complexity; this animates a
// clip that is usually five to fifteen seconds with a handful of tracks, and
// the app's whole promise is that opening it is free. So: lanes, dots, drag to
// move, click to select, and nothing else competing for the space.
//
// Positions are percentages of the lane width rather than pixels, so the whole
// thing reflows with the panel and needs no resize handling. Time is the same
// normalised 0..1 the camera path and the keyframe engine already use - there
// is one clock in this app and this draws it.

/**
 * @param {object} options
 * @param {HTMLElement} options.root       Container the lanes are drawn into.
 * @param {HTMLElement} options.playhead   Element positioned at the current time.
 * @param {object} options.keyframes       From createKeyframes().
 * @param {() => number} options.getTime   Current normalised playhead position.
 * @param {(t: number) => void} options.onSeek  Move the playhead.
 * @param {(id: string) => string} options.labelFor  Display name for a field.
 */
export function createTimeline({ root, playhead, keyframes, getTime, onSeek, labelFor }) {
  // The key currently being dragged, so pointermove knows what to move and
  // pointerup knows what to commit. Null whenever nothing is being dragged.
  let dragging = null;

  /** Normalised time for a clientX, clamped to the lane. */
  function timeAt(lane, clientX) {
    const box = lane.getBoundingClientRect();
    if (box.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - box.left) / box.width));
  }

  function renderPlayhead() {
    playhead.style.left = `${getTime() * 100}%`;
  }

  function render() {
    root.replaceChildren();

    const ids = keyframes.trackIds();
    root.hidden = ids.length === 0;
    if (ids.length === 0) return;

    for (const id of ids) {
      const row = document.createElement('div');
      row.className = 'tl-row';

      const name = document.createElement('span');
      name.className = 'tl-name';
      name.textContent = labelFor(id);
      name.title = id;
      row.appendChild(name);

      const lane = document.createElement('div');
      lane.className = 'tl-lane';
      lane.dataset.field = id;

      // Clicking empty lane seeks rather than creating a key: creating one
      // there would need a value, and the only honest value is whatever the
      // control currently holds - which is what arming plus editing already
      // expresses, unambiguously.
      lane.addEventListener('pointerdown', (event) => {
        if (event.target !== lane) return;
        onSeek(timeAt(lane, event.clientX));
      });

      for (const key of keyframes.keysFor(id)) {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'tl-key';
        dot.style.left = `${key.t * 100}%`;
        dot.dataset.time = String(key.t);
        dot.title = `${labelFor(id)} at ${Math.round(key.t * 100)}% — drag to move, double-click to delete`;
        dot.setAttribute('aria-label', dot.title);

        dot.addEventListener('pointerdown', (event) => {
          event.stopPropagation();
          // Pointer capture keeps the drag alive when the cursor leaves the
          // 8px dot, which it does immediately on any real drag.
          dot.setPointerCapture(event.pointerId);
          dragging = { id, from: key.t, dot, lane };
        });

        dot.addEventListener('pointermove', (event) => {
          if (!dragging || dragging.dot !== dot) return;
          const t = timeAt(dragging.lane, event.clientX);
          dot.style.left = `${t * 100}%`;
          dragging.to = t;
        });

        dot.addEventListener('pointerup', (event) => {
          if (!dragging || dragging.dot !== dot) return;
          dot.releasePointerCapture(event.pointerId);
          const { id: field, from, to } = dragging;
          dragging = null;
          // A drag that never moved is a click; leave the key alone rather
          // than rewriting it at an imperceptibly different time.
          if (to === undefined || Math.abs(to - from) < 0.002) {
            onSeek(from);
            return;
          }
          const value = keyframes.valueAt(field, from);
          keyframes.removeKey(field, from);
          keyframes.setKey(field, to, value);
        });

        // Double-click rather than a delete button per key: at 8px across there
        // is no room for one, and a modifier-click is not discoverable.
        dot.addEventListener('dblclick', (event) => {
          event.stopPropagation();
          keyframes.removeKey(id, key.t);
        });

        lane.appendChild(dot);
      }

      row.appendChild(lane);
      root.appendChild(row);
    }

    renderPlayhead();
  }

  return { render, renderPlayhead };
}
