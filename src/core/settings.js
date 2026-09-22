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
  { id: 'sunColor', kind: 'color' },
  { id: 'leftColor', kind: 'color' },
  { id: 'rightColor', kind: 'color' },
  { id: 'shadowToggle', kind: 'checkbox' },
  { id: 'stageColor', kind: 'color' },
  { id: 'stageRoughness', kind: 'range' },
  { id: 'exposureSlider', kind: 'range' },
  { id: 'envIntensity', kind: 'range' },
  { id: 'envRotation', kind: 'range' },
  { id: 'toneMapping', kind: 'select' },
  { id: 'bgToggle', kind: 'checkbox' },
  { id: 'aoToggle', kind: 'checkbox' },
  { id: 'aaToggle', kind: 'checkbox' },
  { id: 'aoIntensity', kind: 'range' },
  { id: 'aoRadius', kind: 'range' },
  { id: 'outlineToggle', kind: 'checkbox' },
  { id: 'outlineColor', kind: 'color' },
  { id: 'outlineThickness', kind: 'range' },
  { id: 'outlineStrength', kind: 'range' },
  { id: 'dofToggle', kind: 'checkbox' },
  { id: 'dofFocus', kind: 'range' },
  { id: 'dofAperture', kind: 'range' },
  { id: 'dofMaxBlur', kind: 'range' },
  { id: 'advancedToggle', kind: 'checkbox' },
  { id: 'frameGuideToggle', kind: 'checkbox' },
  { id: 'frameGuideRatio', kind: 'select' },
  { id: 'qualityTier', kind: 'select' },
  { id: 'simplifyToggle', kind: 'checkbox' },
  { id: 'simplifyBudget', kind: 'range' },
  { id: 'crtToggle', kind: 'checkbox' },
  { id: 'crtPreset', kind: 'select' },
  { id: 'bloomToggle', kind: 'checkbox' },
  { id: 'bloomStrength', kind: 'range' },
  { id: 'bloomThreshold', kind: 'range' },
  { id: 'bloomRadius', kind: 'range' },
  { id: 'glitchToggle', kind: 'checkbox' },
  { id: 'glitchWild', kind: 'checkbox' },
  { id: 'ditherToggle', kind: 'checkbox' },
  { id: 'ditherMatrix', kind: 'select' },
  { id: 'ditherLevels', kind: 'range' },
  { id: 'ditherScale', kind: 'range' },
  { id: 'ditherAmount', kind: 'range' },
  { id: 'ditherMono', kind: 'checkbox' },
  { id: 'voronoiToggle', kind: 'checkbox' },
  { id: 'voronoiMode', kind: 'select' },
  { id: 'voronoiCellSize', kind: 'range' },
  { id: 'voronoiJitter', kind: 'range' },
  { id: 'voronoiShatter', kind: 'range' },
  { id: 'voronoiEdgeColor', kind: 'color' },
  { id: 'kuwaharaToggle', kind: 'checkbox' },
  { id: 'kuwaharaRadius', kind: 'range' },
  { id: 'kuwaharaStrength', kind: 'range' },
  { id: 'kuwaharaPunch', kind: 'range' },
  { id: 'pixelateToggle', kind: 'checkbox' },
  { id: 'pixelateSize', kind: 'range' },
  { id: 'pixelateAspect', kind: 'range' },
  { id: 'pixelateGrid', kind: 'range' },
  { id: 'paletteToggle', kind: 'checkbox' },
  { id: 'paletteName', kind: 'select' },
  { id: 'pixelSize', kind: 'range' },
  { id: 'ditherStrength', kind: 'range' },
  { id: 'cpDuration', kind: 'range' },
  { id: 'cpAspect', kind: 'select' },
  { id: 'lutToggle', kind: 'checkbox' },
  { id: 'lutPreset', kind: 'select' },
  { id: 'lutIntensity', kind: 'range' },
  { id: 'colorGradeToggle', kind: 'checkbox' },
  { id: 'colorGradeStyle', kind: 'select' },
  { id: 'cgBrightness', kind: 'range' },
  { id: 'cgContrast', kind: 'range' },
  { id: 'cgSaturation', kind: 'range' },
  { id: 'cgHue', kind: 'range' },
  { id: 'cgSpeed', kind: 'range' },
  { id: 'cgLightColor', kind: 'color' },
  { id: 'cgDarkColor', kind: 'color' },
  { id: 'toneToggle', kind: 'checkbox' },
  { id: 'toneMode', kind: 'select' },
  { id: 'toneLevels', kind: 'range' },
  { id: 'toneThreshold', kind: 'range' },
  { id: 'tonePassthru', kind: 'range' },
  { id: 'toneEdgeColor', kind: 'color' },
  { id: 'repeatToggle', kind: 'checkbox' },
  { id: 'repeatMode', kind: 'select' },
  { id: 'repeatAmount', kind: 'range' },
  { id: 'repeatAngle', kind: 'range' },
  { id: 'displaceToggle', kind: 'checkbox' },
  { id: 'displaceMode', kind: 'select' },
  { id: 'displaceAmount', kind: 'range' },
  { id: 'displaceSize', kind: 'range' },
  { id: 'displaceSpeed', kind: 'range' },
  { id: 'displaceAngle', kind: 'range' },
  { id: 'afterimageToggle', kind: 'checkbox' },
  { id: 'afterimageTrail', kind: 'range' },
  { id: 'asciiToggle', kind: 'checkbox' },
  { id: 'asciiRamp', kind: 'select' },
  { id: 'asciiCustomRamp', kind: 'text' },
  { id: 'asciiCellW', kind: 'range' },
  { id: 'asciiCellH', kind: 'range' },
  { id: 'asciiSpacing', kind: 'range' },
  { id: 'asciiContrast', kind: 'range' },
  { id: 'asciiBrightness', kind: 'range' },
  { id: 'asciiBgColor', kind: 'color' },
  { id: 'asciiColorize', kind: 'checkbox' },
  { id: 'asciiInvert', kind: 'checkbox' },
  { id: 'halftoneToggle', kind: 'checkbox' },
  { id: 'halftoneMode', kind: 'select' },
  { id: 'halftoneScale', kind: 'range' },
  { id: 'halftoneAngle', kind: 'range' },
  { id: 'halftoneInvert', kind: 'checkbox' },
  { id: 'filmToggle', kind: 'checkbox' },
  { id: 'filmPreset', kind: 'select' },
  { id: 'filmGrain', kind: 'range' },
  { id: 'filmDust', kind: 'range' },
  { id: 'filmWeave', kind: 'range' },
  { id: 'filmBurn', kind: 'range' },
];

// Linear scans over ~100 fields were fine when only load() and save() walked
// this list. isAtDefault() is called per control on every edit, so it needs a
// lookup rather than a search.
const FIELD_BY_ID = new Map(FIELDS.map((f) => [f.id, f]));

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
    // 'select' and 'text' fields are wired to 'change' (commit-on-blur,
    // matching the hex/custom-ramp text inputs elsewhere in this app);
    // everything else ('range', 'color') is wired to 'input' for live feedback.
    el.dispatchEvent(new Event(kind === 'select' || kind === 'text' ? 'change' : 'input'));
  }
}

/**
 * @param {object} options
 * @param {object} options.accordion   From createAccordion() — for restoring
 *   which sections were left open.
 * @param {object} options.tabs        From createTabs() — for restoring which
 *   tab was active. Not a FIELDS entry: it is a key, not a control's value.
 * @param {object} options.orientation From viewer.orientation — for restoring
 *   the up-axis preset only (see the file header for why not the fine angles).
 * @param {object} options.post        From viewer.post — for restoring the
 *   Style effect chain's composite order (Track 5.2). Not a FIELDS entry:
 *   it's a permutation of effect keys, not a single DOM element's value.
 */
export function createSettings({ accordion, tabs, orientation, post }) {
  // The shipped defaults, captured from the DOM itself at construction.
  //
  // Timing is the whole trick and it is load-bearing: createSettings() runs
  // early in main.js, while applyQualityTier(detectedTier) and load() both run
  // much later, near the end. So what is in the DOM right now is exactly what
  // index.html authored - not a tier-adjusted state, and not a restored
  // session. Reading the markup rather than maintaining a second table of
  // default values means the two can never drift apart.
  const shippedDefaults = Object.fromEntries(FIELDS.map((f) => [f.id, readField(f)]));
  const shippedStyleOrder = [...post.styleOrder];

  function save() {
    const data = {
      fields: Object.fromEntries(FIELDS.map((f) => [f.id, readField(f)])),
      upAxis: orientation.preset,
      styleOrder: post.styleOrder,
      activeTab: tabs.active(),
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

    if (Array.isArray(data.styleOrder)) {
      post.setStyleOrder(data.styleOrder);
    }

    for (const [id, open] of Object.entries(data.sections ?? {})) {
      accordion.setSectionOpen(id, open);
    }

    if (data.activeTab) tabs.activate(data.activeTab);
  }

  /**
   * Put every tracked control back to the value index.html shipped with, and
   * forget the saved session.
   *
   * Deliberately not a page reload, which would be the cheap way to do this:
   * a reload also throws away the loaded model, and someone who has spent ten
   * minutes on a colourway should not lose the model to undo the lighting.
   *
   * Replays the snapshot through the same writeField() that load() uses, so
   * every apply path, readout sync and dependent-row toggle runs exactly as it
   * would for a real edit. There is no second setter path here that could
   * drift from the UI's own.
   */
  /**
   * Whether a control still holds the value index.html shipped with.
   *
   * Exposed for the Advanced reveal, whose safety rule is that a control the
   * user has actually changed stays visible even when Advanced is off - so
   * nothing that is affecting the render can ever be hidden. Unknown ids
   * count as default: a control this set does not track has no saved value to
   * differ from, and pinning it visible on that basis would be noise.
   */
  function isAtDefault(id) {
    if (!(id in shippedDefaults)) return true;
    const field = FIELD_BY_ID.get(id);
    if (!field) return true;
    return String(readField(field)) === String(shippedDefaults[id]);
  }

  function reset() {
    for (const field of FIELDS) writeField(field, shippedDefaults[field.id]);
    post.setStyleOrder(shippedStyleOrder);

    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Same tolerance as save(): inaccessible storage is not an error here.
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
    for (const tabButton of document.querySelectorAll('#tabBar .tab')) {
      tabButton.addEventListener('click', scheduleSave);
    }
  }

  return { save, load, watch, reset, isAtDefault };
}
