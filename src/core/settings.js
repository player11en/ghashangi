// Global session preferences: lighting, tone mapping, environment, AO/AA, the
// up-axis default, and which panel sections were left open.
//
// Persisted to localStorage under one fixed key, not per-model the way
// colorways.js persists per model: these are workflow habits ("I always view
// in AgX with the fill lights turned up"), not properties of a specific asset.
//
// Deliberately NOT persisted:
//   - Camera position/target. frameCamera() already computes a correct one for
//     whatever model loads next; a stale saved position would fight that.
//   - Fine rotation degrees (rotX/Y/Z). A custom tilt tuned for one model's
//     geometry is meaningless applied to an unrelated one on the next load.
//     Only the up-axis PRESET (Y/Z/X) is restored — "I always work with Z-up
//     CAD exports" is a real habit; "this one part was tilted 37° on X" is not.
//
// Implementation note: every restored control is written via its DOM element
// and a dispatched 'input'/'change' event, the same event main.js's own
// bindSlider()/bindCheckbox() already listen for — restoring a value re-runs
// 100% of the existing apply logic (viewer calls, <output> sync, everything),
// so there is no second setter path that could drift out of sync with the UI.

const STORAGE_KEY = '3dmviewer.settings';

const $ = (id) => document.getElementById(id);

/** Every plain control this settings set tracks, and how to read/write it. */
const FIELDS = [
  { id: 'ambientSlider', kind: 'range' },
  { id: 'sunSlider', kind: 'range' },
  { id: 'leftSlider', kind: 'range' },
  { id: 'rightSlider', kind: 'range' },
  { id: 'angleSlider', kind: 'range' },
  { id: 'shadowToggle', kind: 'checkbox' },
  { id: 'exposureSlider', kind: 'range' },
  { id: 'envIntensity', kind: 'range' },
  { id: 'envRotation', kind: 'range' },
  { id: 'toneMapping', kind: 'select' },
  { id: 'bgToggle', kind: 'checkbox' },
  { id: 'aoToggle', kind: 'checkbox' },
  { id: 'aaToggle', kind: 'checkbox' },
  { id: 'aoIntensity', kind: 'range' },
  { id: 'aoRadius', kind: 'range' },
  { id: 'qualityTier', kind: 'select' },
  { id: 'simplifyToggle', kind: 'checkbox' },
  { id: 'simplifyBudget', kind: 'range' },
  { id: 'crtToggle', kind: 'checkbox' },
  { id: 'crtPreset', kind: 'select' },
  { id: 'bloomToggle', kind: 'checkbox' },
  { id: 'bloomStrength', kind: 'range' },
  { id: 'glitchToggle', kind: 'checkbox' },
  { id: 'glitchWild', kind: 'checkbox' },
  { id: 'paletteToggle', kind: 'checkbox' },
  { id: 'paletteName', kind: 'select' },
  { id: 'pixelSize', kind: 'range' },
  { id: 'cpDuration', kind: 'range' },
  { id: 'cpAspect', kind: 'select' },
];

function readField({ id, kind }) {
  const el = $(id);
  if (!el) return undefined;
  return kind === 'checkbox' ? el.checked : el.value;
}

function writeField({ id, kind }, value) {
  const el = $(id);
  if (!el || value === undefined) return;

  if (kind === 'checkbox') {
    // .click() rather than setting .checked directly, matching shortcuts.js —
    // it fires the same 'change' event a real click would, so bindCheckbox()'s
    // listener (and anything toggled off it, like AO's dependent sliders) runs.
    if (el.checked !== Boolean(value)) el.click();
  } else {
    el.value = value;
    el.dispatchEvent(new Event(kind === 'select' ? 'change' : 'input'));
  }
}

/**
 * @param {object} options
 * @param {object} options.accordion   From createAccordion() — for restoring
 *   which sections were left open.
 * @param {object} options.orientation From viewer.orientation — for restoring
 *   the up-axis preset only (see the file header for why not the fine angles).
 */
export function createSettings({ accordion, orientation }) {
  function save() {
    const data = {
      fields: Object.fromEntries(FIELDS.map((f) => [f.id, readField(f)])),
      upAxis: orientation.preset,
      sections: Object.fromEntries(
        accordion.sectionIds().map((id) => [id, accordion.isSectionOpen(id)]),
      ),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Private browsing, blocked site data, or quota exceeded. Settings
      // simply don't persist this session; nothing else depends on them.
    }
  }

  /**
   * Restore from localStorage. Call once at startup, after the first model has
   * loaded (the up-axis restore needs a model to act on) and before wiring
   * `watch()`, so this function's own writes don't immediately re-trigger a save.
   */
  function load() {
    let data;
    try {
      data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    } catch {
      return; // corrupt or inaccessible storage — start from defaults
    }
    if (!data || typeof data !== 'object') return;

    for (const field of FIELDS) writeField(field, data.fields?.[field.id]);

    // 'custom' means the saved session had free-dragged rotation rather than a
    // preset — nothing meaningful to reapply to a different model.
    if (data.upAxis && data.upAxis !== 'custom') {
      orientation.setUpAxis(data.upAxis);
    }

    for (const [id, open] of Object.entries(data.sections ?? {})) {
      accordion.setSectionOpen(id, open);
    }
  }

  /**
   * Start auto-saving on every change to a tracked control or a section being
   * opened/closed. Separate from load() so load()'s own writes — which
   * dispatch the same events a user's edit would — can never be mistaken for
   * a change to save, without needing a restoring-flag/debounce race.
   */
  function watch() {
    let saveTimer = null;
    const scheduleSave = () => {
      clearTimeout(saveTimer);
      // Debounced past a single drag: a slider fires 'input' on every pixel of
      // movement, and saving to localStorage on each one is wasted work.
      saveTimer = setTimeout(save, 400);
    };

    for (const { id } of FIELDS) {
      $(id)?.addEventListener('input', scheduleSave);
      $(id)?.addEventListener('change', scheduleSave);
    }
    for (const id of accordion.sectionIds()) {
      const button = $(`${id}Body`)?.closest('.group')?.querySelector('.group-title');
      button?.addEventListener('click', scheduleSave);
    }
  }

  return { save, load, watch };
}
