// Keyframing any control over the clip's timeline.
//
// The shape of this is chosen to avoid the thing that would make it rot: a
// second list of "what is animatable". settings.js already maintains a registry
// of every tracked control and its kind, and this reads that registry. Anything
// that is a persisted setting is keyframable for free, including controls that
// do not exist yet - adding a slider to FIELDS is the only step needed to make
// it animatable too.
//
// Values are applied through settings.js's own writeField(), which assigns the
// DOM element and dispatches the same 'input'/'change' event a real edit fires.
// That is deliberately the slow-looking option: it means every apply path,
// readout sync, dependent-row toggle and engine call runs exactly as it would
// for a human moving the slider, so there is no parallel setter path that can
// drift from the UI's own. The alternative - calling engine setters directly -
// would be faster and would silently desync every readout on screen.
//
// Interpolation depends on kind, and the distinction is not cosmetic:
//
//   range / color  interpolated. A hue sweep or a focus rack is a continuum.
//   checkbox       stepped. A CRT that is 40% enabled is not a thing; it is
//                  off until its key and on afterwards.
//   select / text  stepped, same reasoning - there is no halfway between
//                  "Bayer 4x4" and "Bayer 8x8".
//
// Time is the normalised 0..1 the camera path already runs on, so camera moves,
// parameter animation and clip recording share one clock instead of three.

/** Linear blend between two numbers. */
const lerp = (a, b, t) => a + (b - a) * t;

/** '#rrggbb' -> [r, g, b] 0..255. */
function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [r, g, b] 0..255 -> '#rrggbb'. */
function rgbToHex(rgb) {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * @param {object} options
 * @param {object} options.settings  From createSettings() - supplies the field
 *   registry, the writer, and the ability to suspend auto-saving during
 *   playback.
 * @param {() => void} [options.onChange]  Fired when tracks are added, removed
 *   or cleared, so the UI can redraw.
 */
export function createKeyframes({ settings, onChange = () => {} }) {
  /** fieldId -> [{ t, value }], kept sorted by t. */
  const tracks = new Map();

  let armed = false;

  /**
   * Whether a kind blends between keys or jumps at them.
   *
   * Anything not explicitly continuous is stepped. That default is the safe
   * direction: a wrongly-stepped slider looks coarse, while a wrongly-blended
   * dropdown produces values that were never valid options.
   */
  function isContinuous(kind) {
    return kind === 'range' || kind === 'color';
  }

  function keysFor(id) {
    return tracks.get(id) ?? [];
  }

  /** Add or replace the key at `t` for `id`. */
  function setKey(id, t, value) {
    if (!settings.fieldKind(id)) return false;
    const time = Math.max(0, Math.min(1, t));
    const keys = tracks.get(id) ?? [];
    // Keys closer together than this are the same key being re-set - dragging
    // a slider while armed would otherwise leave a smear of near-identical
    // keys a frame apart.
    const existing = keys.findIndex((k) => Math.abs(k.t - time) < 0.001);

    if (existing === -1) keys.push({ t: time, value });
    else keys[existing].value = value;

    keys.sort((a, b) => a.t - b.t);
    tracks.set(id, keys);
    onChange();
    return true;
  }

  function removeKey(id, t) {
    const keys = tracks.get(id);
    if (!keys) return;
    const index = keys.findIndex((k) => Math.abs(k.t - t) < 0.001);
    if (index === -1) return;
    keys.splice(index, 1);
    if (keys.length === 0) tracks.delete(id);
    onChange();
  }

  function clearTrack(id) {
    if (tracks.delete(id)) onChange();
  }

  function clear() {
    if (tracks.size === 0) return;
    tracks.clear();
    onChange();
  }

  /**
   * The value a track holds at normalised time `t`.
   *
   * Before the first key and after the last, the value is held rather than
   * extrapolated - a track that starts at t=0.5 should not imply anything
   * about the first half of the clip.
   */
  function valueAt(id, t) {
    const keys = keysFor(id);
    if (keys.length === 0) return undefined;
    if (t <= keys[0].t) return keys[0].value;
    if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].value;

    let index = 0;
    while (index < keys.length - 1 && keys[index + 1].t < t) index++;

    const a = keys[index];
    const b = keys[index + 1];
    const kind = settings.fieldKind(id);

    if (!isContinuous(kind)) return a.value;

    const span = b.t - a.t;
    const local = span <= 0 ? 0 : (t - a.t) / span;

    if (kind === 'color') {
      const from = hexToRgb(a.value);
      const to = hexToRgb(b.value);
      return rgbToHex(from.map((c, i) => lerp(c, to[i], local)));
    }

    return lerp(parseFloat(a.value), parseFloat(b.value), local);
  }

  /**
   * Write every track's value for time `t` into the UI.
   *
   * Auto-saving is suspended around this: settings.js writes to localStorage on
   * a debounce after any tracked control changes, and playback changes many of
   * them sixty times a second. Without this, scrubbing a clip would hammer
   * storage with states nobody asked to keep.
   */
  function apply(t) {
    if (tracks.size === 0) return;
    settings.suspend();
    try {
      for (const id of tracks.keys()) {
        const value = valueAt(id, t);
        if (value !== undefined) settings.writeFieldById(id, value);
      }
    } finally {
      settings.resume();
    }
  }

  return {
    setKey,
    removeKey,
    clearTrack,
    clear,
    valueAt,
    apply,
    keysFor,

    /** Capture a control's current value as a key at `t`. */
    keyCurrent(id, t) {
      const value = settings.readFieldById(id);
      if (value === undefined) return false;
      return setKey(id, t, value);
    },

    get armed() {
      return armed;
    },

    set armed(on) {
      armed = on;
    },

    /** Track ids that currently hold at least one key, in insertion order. */
    trackIds() {
      return [...tracks.keys()];
    },

    get trackCount() {
      return tracks.size;
    },

    get keyCount() {
      let total = 0;
      for (const keys of tracks.values()) total += keys.length;
      return total;
    },

    /** Serialisable form, for saving a clip's animation alongside its path. */
    toJSON() {
      return Object.fromEntries([...tracks.entries()].map(([id, keys]) => [id, keys]));
    },

    fromJSON(data) {
      tracks.clear();
      for (const [id, keys] of Object.entries(data ?? {})) {
        if (Array.isArray(keys) && keys.length > 0 && settings.fieldKind(id)) {
          tracks.set(id, [...keys].sort((a, b) => a.t - b.t));
        }
      }
      onChange();
    },
  };
}
