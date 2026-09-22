// Bootstrap: build the viewer, wire the controls, wire the sources.

import { createViewer } from './core/viewer.js';
import { createToasts } from './ui/toast.js';
import { createProgress, formatBytes } from './ui/progress.js';
import { createFileSource } from './sources/file.js';
import { createMaterialsPanel } from './ui/materials-panel.js';
import { createAnimationPanel } from './ui/animation-panel.js';
import { createAccordion } from './ui/accordion.js';
import { createTabs } from './ui/tabs.js';
import { createFrameGuide } from './ui/frame-guide.js';
import { createAdvanced } from './ui/advanced.js';
import { createShortcuts } from './ui/shortcuts.js';
import { createSettings } from './core/settings.js';
import { createFileSystem, pickPrimary } from './loaders/fs-map.js';
import {
  loadModel,
  needsSiblings,
  SUPPORTED_EXTENSIONS,
  UnsupportedFormatError,
} from './loaders/index.js';
import { DEFAULT_HDR } from './core/environment.js';
import {
  normalizeUrl,
  filenameFromUrl,
  fetchAsBlob,
  InvalidUrlError,
  RemoteFetchError,
} from './sources/url.js';
import { fetchFromDrive, looksLikeDriveLink, isDriveConfigured } from './sources/drive.js';
import { trackObjectUrl, revokeObjectUrl } from './core/dispose.js';
import { recordTurntable, isTurntableSupported } from './core/turntable.js';
import { createCameraPath } from './core/camera-path.js';
import { createKeyframes } from './core/keyframes.js';
import { createCameraPathPanel } from './ui/camera-path-panel.js';
import { isClipRecordingSupported } from './core/recorder.js';
import { createMaterialUndo } from './core/material-undo.js';
import { FILM_PRESETS } from './core/passes/film-pass.js';
import { parseLutFile } from './core/passes/lut-pass.js';
import { logSessionStart, logExport, markStyleTouched, readTelemetry } from './core/telemetry.js';

const $ = (id) => document.getElementById(id);

const DEMO_MODEL = 'model/RTX3090Ti.glb';
const STAGE_MODEL = 'model/Stage.glb';

const viewer = createViewer({ container: $('viewport') });
const toasts = createToasts($('toasts'));
const progress = createProgress({
  root: $('loading'),
  fill: $('loadingFill'),
  label: $('loadingLabel'),
});

viewer.start();
logSessionStart();

const materialsPanel = createMaterialsPanel({ viewer, toasts });

const materialUndo = createMaterialUndo({ viewer });
viewer.onMaterialChange(() => materialUndo.recordChange());

function syncMaterialUndoButtons() {
  $('materialUndo').disabled = !materialUndo.canUndo;
  $('materialRedo').disabled = !materialUndo.canRedo;
}
materialUndo.onChange(syncMaterialUndoButtons);

$('materialUndo').addEventListener('click', () => materialUndo.undo());
$('materialRedo').addEventListener('click', () => materialUndo.redo());

// Accordion built before animationPanel: #animationGroup's own `hidden`
// (whether the model has clips at all) is independent of the accordion's
// open/closed state, and a tab whose sections have all hidden themselves should
// drop out of the tab bar — animation-panel.js calls tabs.syncVisibility() at
// the end of its own rebuild(), since viewer.onAnimationChange() only holds one
// callback.
const accordion = createAccordion($('panelBody'));
const tabs = createTabs($('tabBar'), $('panelBody'));

createShortcuts();

// Overlays the viewport, so it is built against the same container the viewer
// renders into. Purely visual - see frame-guide.js for why this is not the
// aspect lock.
const frameGuide = createFrameGuide($('viewport'));

const settings = createSettings({
  accordion,
  tabs,
  orientation: viewer.orientation,
  post: viewer.post,
});

// Built after settings so it can ask which controls are still at their
// shipped defaults - the rule that keeps a changed control visible even with
// Advanced off, so nothing affecting the render is ever hidden.
const advanced = createAdvanced($('panelBody'), { isAtDefault: settings.isAtDefault });

bindCheckbox('advancedToggle', (on) => advanced.setEnabled(on));

// Registers its own viewer callback, so it rebuilds itself on every load.
const animationPanel = createAnimationPanel({ viewer, onRebuild: tabs.syncVisibility });

// The filesystem backing the current model, kept so its blob URLs can be
// revoked when the next model replaces it.
let currentFs = null;

// Used to name exported files after the model they came from.
let currentModelName = 'model';

// Camera path: not tied to a model load the way animation clips are, so it
// persists across model swaps (a camera move framed for one product is a
// reasonable starting point for the next one, unlike a model's own clips).
let rebuildWaypointList = () => {};
let rebuildKeyframeList = () => {};

// Built before the camera path so its onTick can reach it: the path owns the
// clock, keyframes are a second track on that same clock.
const keyframes = createKeyframes({
  settings,
  onChange: () => rebuildKeyframeList(),
});

const cameraPath = createCameraPath({
  viewer,
  onChange: () => rebuildWaypointList(),
  onTick: (t) => keyframes.apply(t),
});
const cameraPathPanel = createCameraPathPanel({
  viewer,
  cameraPath,
  toasts,
  getModelName: () => currentModelName,
  container: $('viewport'),
  recordingSupported: isClipRecordingSupported(),
});
rebuildWaypointList = cameraPathPanel.rebuildList;

if (!isClipRecordingSupported()) {
  $('cameraPathHint').textContent =
    'This browser cannot record WebM, so clips can’t be exported here, but Preview still works. Try Chrome or Firefox to record.';
  $('cameraPathHint').dataset.level = 'warn';
}

// --- loading -------------------------------------------------------------

/**
 * Load a model from a set of local files.
 * @param {File[]} files
 */
async function loadFromFiles(files) {
  const picked = pickPrimary(files);

  if (!picked) {
    const names = files.map((f) => f.name).join(', ');
    toasts.error(
      'Nothing loadable in that drop',
      `Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}. Got: ${names}`,
    );
    return;
  }

  const { primary, extension } = picked;
  const fs = createFileSystem(files);
  const url = fs.urlFor(primary.webkitRelativePath || primary.name);

  progress.begin(`Loading ${primary.name} (${formatBytes(primary.size)})`);

  try {
    const { object, animations } = await loadModel({
      url,
      extension,
      manager: fs.manager,
      renderer: viewer.renderer,
      files,
      fs,
      onProgress: (fraction) => progress.update(fraction),
    });

    await install(object, animations, fs, primary.name);

    const extra = files.length > 1 ? ` (+${files.length - 1} linked files)` : '';
    toasts.info(`Loaded ${primary.name}${extra}`);
  } catch (error) {
    fs.dispose();
    reportLoadFailure(error, primary.name, extension);
  } finally {
    progress.end();
  }
}

/** Swap in a freshly loaded object and retire the previous one's resources. */
async function install(object, animations, fs, name = 'model') {
  await viewer.setModel(object, {
    animations,
    // Simplification is a synchronous WASM call under the hood; this only
    // fires if the model actually exceeds the triangle budget, turning what
    // would otherwise read as a frozen tab into a visible "still working".
    onSimplifyStart: () => progress.update(null, 'Simplifying geometry…'),
  });
  currentFs?.dispose();
  currentFs = fs ?? null;
  currentModelName = name;
  refreshStats();
  // setModel resets orientation to the new file's authored pose; the sliders
  // have to follow or they would show the previous model's correction.
  syncOrientationUI();
  // Rebuild the material list and reattach this model's saved colourways.
  materialsPanel.refresh(name);
  // A new model starts a fresh undo history - the previous one's material
  // states describe materials that no longer exist.
  materialUndo.reset();
  // setModel() -> refreshBounds() -> post.setSubject() has just re-seeded the
  // DOF focus distance for this model's scale; pull the slider onto it.
  syncDofFocusFromSubject();
}

/** Turn a loader failure into something a person can act on. */
function reportLoadFailure(error, name, extension) {
  console.error('[3DMViewer] load failed', error);

  if (error instanceof UnsupportedFormatError) {
    toasts.error(
      `Cannot open ${name}`,
      `${error.message} Supported: ${SUPPORTED_EXTENSIONS.join(', ')}.`,
    );
    return;
  }

  const message = String(error?.message ?? error);
  let hint = message;

  if (/draco/i.test(message)) {
    hint = 'The file uses Draco compression and the decoder could not be loaded. Check your network connection and reload.';
  } else if (/ktx2|basis|transcoder/i.test(message)) {
    hint = 'The file uses KTX2 textures and the transcoder could not be loaded. Check your network connection and reload.';
  } else if (extension === 'gltf' && /\.bin|buffer/i.test(message)) {
    hint = 'This .gltf references external files. Drop the .gltf together with its .bin and texture files, or drop the whole folder.';
  } else if (extension === 'obj' && /mtl|material/i.test(message)) {
    hint = 'The .mtl could not be read. Drop the .obj, .mtl and its textures together, or drop the whole folder.';
  }

  toasts.error(`Could not load ${name}`, hint);
}

/** Fetch a model shipped with the app. */
async function loadBundled(url, label) {
  const extension = url.split('.').pop().toLowerCase();
  progress.begin(`Loading ${label}`);
  try {
    const { object, animations } = await loadModel({
      url,
      extension,
      renderer: viewer.renderer,
      onProgress: (fraction) => progress.update(fraction),
    });
    await install(object, animations, null, url.split('/').pop());
    return object;
  } catch (error) {
    reportLoadFailure(error, label, extension);
    return null;
  } finally {
    progress.end();
  }
}

// --- sources -------------------------------------------------------------

createFileSource({
  input: $('fileInput'),
  openButton: $('openFile'),
  overlay: $('dropOverlay'),
  onFiles: loadFromFiles,
  onError: (error) => toasts.error('Could not read that drop', String(error.message)),
});

$('loadDemo').addEventListener('click', () => {
  loadBundled(DEMO_MODEL, 'demo model');
});

// --- remote sources: Drive links and direct URLs --------------------------

const urlForm = $('urlForm');
const urlInput = $('urlInput');
const urlHint = $('urlHint');

// Lets a second paste cancel the first download instead of racing it.
let remoteAbort = null;

function setHint(text, level) {
  urlHint.textContent = text;
  if (level) urlHint.dataset.level = level;
  else delete urlHint.dataset.level;
}

const DEFAULT_HINT = isDriveConfigured()
  ? 'Google Drive, Dropbox, GitHub or any direct link.'
  : 'Dropbox, GitHub or any direct link. (Drive needs VITE_GOOGLE_API_KEY.)';

setHint(DEFAULT_HINT);

/**
 * Load from a pasted link. Drive goes through the Drive API; everything else is
 * a plain CORS fetch. Both end up as a Blob, so the loader path is identical to
 * a local file's.
 */
async function loadFromLink(input) {
  const trimmed = input.trim();
  if (!trimmed) return;

  remoteAbort?.abort();
  remoteAbort = new AbortController();
  const { signal } = remoteAbort;

  const isDrive = looksLikeDriveLink(trimmed);
  let objectUrl = null;

  progress.begin(isDrive ? 'Contacting Google Drive…' : 'Downloading…');
  setHint('Loading…');

  try {
    let blob;
    let name;
    // Directory the entry file came from, so a .gltf's .bin and textures can be
    // fetched from the server even though the entry file itself is a blob.
    let resourcePath;

    if (isDrive) {
      const result = await fetchFromDrive(trimmed, {
        signal,
        onProgress: (fraction, loaded, total) => {
          progress.update(
            fraction,
            total ? `${formatBytes(loaded)} of ${formatBytes(total)}` : 'Downloading…',
          );
        },
      });
      blob = result.blob;
      name = result.name;
    } else {
      const { url: direct, source } = normalizeUrl(trimmed);
      name = filenameFromUrl(direct);
      resourcePath = direct.slice(0, direct.lastIndexOf('/') + 1);
      progress.update(null, `Downloading ${name}`);
      blob = await fetchAsBlob(direct, {
        signal,
        onProgress: (fraction, loaded, total) => {
          progress.update(
            fraction,
            total ? `${formatBytes(loaded)} of ${formatBytes(total)}` : `Downloading ${name}`,
          );
        },
      });
      if (source !== 'direct') {
        console.info(`[3DMViewer] rewrote ${source} share link to a direct download`);
      }
    }

    const extension = name.split('.').pop()?.toLowerCase() ?? '';
    objectUrl = trackObjectUrl(blob);

    // Drive addresses files by opaque id, so there is no directory a sibling
    // could be fetched from. A .glb is fine (self-contained); a .gltf that
    // references an external .bin cannot work, and saying so up front beats a
    // confusing "Failed to load buffer" from deep inside the parser.
    if (isDrive && needsSiblings(extension)) {
      toasts.warn(
        `.${extension} from Drive may be incomplete`,
        'Drive cannot serve the linked .bin or texture files alongside it. Upload a self-contained .glb, or zip the folder and drop it in instead.',
      );
    }

    const { object, animations } = await loadModel({
      url: objectUrl,
      extension,
      renderer: viewer.renderer,
      resourcePath,
      onProgress: (fraction) => progress.update(fraction, `Parsing ${name}`),
    });

    await install(object, animations, null, name);
    // The loader has the geometry now; the blob behind the URL can go.
    revokeObjectUrl(objectUrl);
    objectUrl = null;

    toasts.info(`Loaded ${name}`, `${formatBytes(blob.size)} from ${isDrive ? 'Google Drive' : 'link'}`);
    setHint(DEFAULT_HINT);
    urlInput.value = '';
  } catch (error) {
    if (objectUrl) revokeObjectUrl(objectUrl);

    if (error.name === 'AbortError') return; // superseded by a newer request

    if (error instanceof InvalidUrlError || error instanceof RemoteFetchError) {
      // These already carry a human-readable explanation.
      toasts.error(isDrive ? 'Could not load from Drive' : 'Could not load that link', error.message);
      setHint(error.message, 'error');
    } else {
      reportLoadFailure(error, filenameFromUrl(trimmed), '');
      setHint('That file could not be opened.', 'error');
    }
  } finally {
    progress.end();
  }
}

urlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  loadFromLink(urlInput.value);
});

// --- control wiring ------------------------------------------------------

/**
 * Bind a range input to a setter, keeping a paired value field in sync in both
 * directions.
 *
 * The paired field (`#{id}Out` / `#{id-without-Slider}Out`) used to be a
 * read-only `<output>`; it is now an `<input type="text">` styled to look the
 * same, so the exact value can be typed instead of only dragged — useful for
 * "rotate exactly 37°" or "scale exactly 1.375×" in a way a slider can't do.
 *
 * `parseFloat` on the typed value ignores a trailing unit character, so the
 * same formatted string the slider produces (`"53°"`, `"1.00×"`) can be typed
 * straight back in unedited — no separate unit-stripping needed.
 *
 * @param {string} id
 * @param {(value:number) => void} apply
 * @param {(value:number) => string} format
 */
function bindSlider(id, apply, format) {
  const input = $(id);
  const output = $(`${id.replace('Slider', '')}Out`) ?? $(`${id}Out`);
  const min = input.min !== '' ? parseFloat(input.min) : -Infinity;
  const max = input.max !== '' ? parseFloat(input.max) : Infinity;

  const sync = (value) => {
    apply(value);
    input.value = String(value);
    if (output) output.value = format(value);
  };

  input.addEventListener('input', () => sync(parseFloat(input.value)));

  if (output) {
    const commit = () => {
      const parsed = parseFloat(output.value);
      const clamped = Number.isFinite(parsed)
        ? Math.min(max, Math.max(min, parsed))
        : parseFloat(input.value); // invalid entry: fall back to the last good value
      sync(clamped);
    };
    output.addEventListener('change', commit);
    // Enter commits immediately rather than waiting for blur.
    output.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') output.blur();
    });
  }

  sync(parseFloat(input.value));
}

function bindCheckbox(id, apply) {
  const input = $(id);
  input.addEventListener('change', () => apply(input.checked));
}

const fixed2 = (v) => v.toFixed(2);
const fixed1 = (v) => v.toFixed(1);

/** '#rrggbb' -> [r,g,b] in 0..1, the shape every color-grade/tone shader uniform expects. */
function hexToRgbArray(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Model
bindSlider('scaleSlider', (v) => viewer.setScale(v), (v) => `${v.toFixed(2)}×`);
bindSlider('heightSlider', (v) => viewer.setHeight(v), fixed1);
bindCheckbox('autoRotate', (on) => viewer.setAutoRotate(on));
bindCheckbox('stageToggle', (on) => {
  viewer.setStageVisible(on);
  syncStageRows();
});
$('stageColor').addEventListener('input', (e) => viewer.setStageColor(e.target.value));
bindSlider('stageRoughness', (v) => viewer.setStageRoughness(v), fixed2);

/** Stage appearance only means anything while the stage is actually shown. */
function syncStageRows() {
  const on = $('stageToggle').checked;
  for (const row of document.querySelectorAll('[data-stage]')) row.hidden = !on;
}
syncStageRows();
bindCheckbox('wireframe', (on) => viewer.setWireframe(on));
$('frameButton').addEventListener('click', () => viewer.frame());
$('resetButton').addEventListener('click', () => viewer.resetCamera());

// --- keyframes -----------------------------------------------------------

/** Where the playhead currently sits, as normalised 0..1. */
function playheadTime() {
  return parseFloat($('cpScrub').value) || 0;
}

/**
 * Key every armed change at the playhead.
 *
 * Listening on the panel rather than per control is what makes this work for
 * all ~100 tracked settings, and for any added later, without a registration
 * step per control. The event target's own id is the field id.
 */
function handleArmedEdit(event) {
  if (!keyframes.armed) return;
  const id = event.target?.id;
  if (!id || id === 'cpScrub' || id === 'kfArm') return;
  // Paired readouts mirror their slider and would key the same field twice.
  if (event.target.classList?.contains('value-input')) return;
  keyframes.keyCurrent(id, playheadTime());
}

$('panelBody').addEventListener('input', handleArmedEdit);
$('panelBody').addEventListener('change', handleArmedEdit);

function syncKeyframeRows() {
  const on = $('kfArm').checked;
  for (const row of document.querySelectorAll('[data-kf]')) row.hidden = !on;
}

rebuildKeyframeList = () => {
  const list = $('kfTrackList');
  list.replaceChildren();

  const ids = keyframes.trackIds();
  $('kfCount').textContent = ids.length === 0
    ? 'none'
    : `${ids.length} track${ids.length === 1 ? '' : 's'}, ${keyframes.keyCount} keys`;

  for (const id of ids) {
    const item = document.createElement('li');
    item.className = 'kf-track';
    item.dataset.field = id;

    const name = document.createElement('span');
    name.className = 'kf-track-name';
    // The control's own label is what the user recognises; the field id is an
    // implementation detail they never chose.
    const label = document.querySelector(`label[for="${id}"]`);
    name.textContent = label?.textContent.trim() || id;
    name.title = `${id} — ${keyframes.keysFor(id).length} keys`;
    item.appendChild(name);

    const count = document.createElement('span');
    count.className = 'kf-track-keys';
    count.textContent = String(keyframes.keysFor(id).length);
    item.appendChild(count);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'nudge';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove all keys for ${name.textContent}`);
    remove.addEventListener('click', () => keyframes.clearTrack(id));
    item.appendChild(remove);

    list.appendChild(item);
  }
};

bindCheckbox('kfArm', (on) => {
  keyframes.armed = on;
  syncKeyframeRows();
});

$('kfClear').addEventListener('click', () => keyframes.clear());

syncKeyframeRows();
rebuildKeyframeList();

// --- frame guide ---------------------------------------------------------

/**
 * Show the guide's real output size, rather than leaving "9:16" to be mentally
 * multiplied out against the viewport. Reads the screenshot scale too, so the
 * number is what a capture at the current settings would actually produce.
 */
function syncFrameGuide() {
  const on = $('frameGuideToggle').checked;
  for (const row of document.querySelectorAll('[data-frame-guide]')) row.hidden = !on;

  const dims = frameGuide.dimensions();
  const scale = parseFloat($('shotScale').value) || 1;
  $('frameGuideHint').textContent = dims
    ? `${Math.round(dims.width * scale)} × ${Math.round(dims.height * scale)} px — guide only, the render is unchanged.`
    : 'Guide only — the render is unchanged.';
}

bindCheckbox('frameGuideToggle', (on) => {
  frameGuide.setEnabled(on);
  syncFrameGuide();
});

$('frameGuideRatio').addEventListener('change', (event) => {
  frameGuide.setRatio(event.target.value);
  syncFrameGuide();
});

syncFrameGuide();

// Saved views. Delegated from the row rather than one listener per button,
// since the set is markup-driven - adding a view means adding a button, not
// touching this file.
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => viewer.setView(button.dataset.view));
}

/**
 * Put every control back to its shipped default.
 *
 * Split from the click handler below so the test suite can drive it without a
 * confirm() dialog - the same reason window.__viewer exists at all.
 */
function resetAllSettings() {
  settings.reset();
  // The tier re-applies afterwards for the same reason it applies at startup:
  // "default" on a low-tier device means AO, AA and Style off, which is not
  // what the markup's own values say.
  applyQualityTier(viewer.detectedTier);
  $('qualityTier').value = viewer.detectedTier;
  renderStyleOrder();
  syncStyleRows();
  syncStageRows();
  syncDofFocusFromSubject();
  // Everything is back at its default, so every advanced row that was pinned
  // visible by having been touched should tuck itself away again.
  advanced.refresh();
}

// Confirmed first: this discards a whole session of lighting, Style and
// fidelity work in one click and has no undo (material edits have their own
// history; these settings do not).
$('resetSettings').addEventListener('click', () => {
  const ok = window.confirm(
    'Reset all settings to defaults?\n\n'
    + 'Lighting, Style effects, fidelity and quality go back to how the app '
    + 'shipped.\n\n'
    + 'Not affected: the loaded model, its scale, height and rotation, and your '
    + 'saved colourways. Those have their own reset buttons.',
  );
  if (!ok) return;

  resetAllSettings();
  toasts.info('Settings reset to defaults');
});

// Dense-model triangle budget (Stats group). Takes effect on the next model
// loaded, not retroactively - the pre-simplification geometry of whatever is
// on screen right now has already been disposed.
bindCheckbox('simplifyToggle', (on) => viewer.setSimplificationEnabled(on));
bindSlider('simplifyBudget', (v) => viewer.setSimplificationBudget(v), (v) => String(Math.round(v)));

// Orientation
//
// The viewer owns the angles (it has to re-ground the model after every
// change), so the controls push changes in and then read the result back out
// rather than keeping their own copy. That keeps the sliders honest when a
// preset or a nudge changes an axis the user did not touch.
const AXES = ['x', 'y', 'z'];

function syncOrientationUI() {
  const { angles, preset } = viewer.orientation;

  for (const axis of AXES) {
    const slider = $(`rot${axis.toUpperCase()}`);
    const output = $(`rot${axis.toUpperCase()}Out`);
    slider.value = String(Math.round(angles[axis]));
    output.value = `${Math.round(angles[axis])}°`;
  }

  for (const button of document.querySelectorAll('.seg[data-up]')) {
    button.setAttribute('aria-pressed', String(button.dataset.up === preset));
  }
}

for (const axis of AXES) {
  const slider = $(`rot${axis.toUpperCase()}`);
  const output = $(`rot${axis.toUpperCase()}Out`);

  slider.addEventListener('input', (event) => {
    viewer.orientation.setAxis(axis, parseFloat(event.target.value));
    syncOrientationUI();
  });

  // Typed entry: rotXOut etc. were read-only <output>s, now editable so an
  // exact angle can be entered rather than dragged to the nearest degree.
  const commitTypedAngle = () => {
    const parsed = parseFloat(output.value); // ignores the trailing "°"
    const clamped = Number.isFinite(parsed)
      ? Math.min(180, Math.max(-180, parsed))
      : viewer.orientation.angles[axis];
    viewer.orientation.setAxis(axis, clamped);
    syncOrientationUI();
  };
  output.addEventListener('change', commitTypedAngle);
  output.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') output.blur();
  });
}

for (const button of document.querySelectorAll('.nudge[data-axis]')) {
  button.addEventListener('click', () => {
    viewer.orientation.nudge(button.dataset.axis, parseFloat(button.dataset.delta));
    syncOrientationUI();
  });
}

for (const button of document.querySelectorAll('.seg[data-up]')) {
  button.addEventListener('click', () => {
    viewer.orientation.setUpAxis(button.dataset.up);
    syncOrientationUI();
  });
}

$('resetOrientation').addEventListener('click', () => {
  viewer.orientation.reset();
  syncOrientationUI();
});

// Lighting
bindSlider('ambientSlider', (v) => viewer.lights.setAmbient(v), fixed2);
bindSlider('sunSlider', (v) => viewer.lights.setSun(v), fixed2);
bindSlider('leftSlider', (v) => viewer.lights.setLeft(v), fixed1);
bindSlider('rightSlider', (v) => viewer.lights.setRight(v), fixed1);
bindSlider('angleSlider', (v) => viewer.lights.setAngle(v), (v) => `${Math.round(v)}°`);
// three's Color.set() takes an '#rrggbb' string directly, so these need no
// hexToRgbArray() conversion - that helper is for raw shader uniforms.
$('sunColor').addEventListener('input', (e) => viewer.lights.setSunColor(e.target.value));
$('leftColor').addEventListener('input', (e) => viewer.lights.setLeftColor(e.target.value));
$('rightColor').addEventListener('input', (e) => viewer.lights.setRightColor(e.target.value));
bindCheckbox('shadowToggle', (on) => viewer.setShadowsEnabled(on));

// Environment
bindSlider('exposureSlider', (v) => viewer.environment.setExposure(v), fixed2);
bindSlider('envIntensity', (v) => viewer.environment.setIntensity(v), fixed2);
bindSlider('envRotation', (v) => viewer.environment.setRotation((v * Math.PI) / 180), (v) => `${Math.round(v)}°`);
bindCheckbox('bgToggle', (on) => viewer.environment.setBackgroundVisible(on));

$('toneMapping').addEventListener('change', (event) => {
  viewer.environment.setToneMapping(event.target.value);
});

// Post-processing. The AO sliders are only meaningful once AO is on, so they
// follow the toggle rather than sitting there inert.
function syncPostRows() {
  const on = $('aoToggle').checked;
  for (const row of document.querySelectorAll('[data-ao]')) row.hidden = !on;
  const dofOn = $('dofToggle').checked;
  for (const row of document.querySelectorAll('[data-dof]')) row.hidden = !dofOn;
}

/**
 * Pull the focus slider onto whatever post.js seeded from the subject's
 * bounds, so enabling DOF on a freshly loaded model starts focused on the
 * model rather than at a stale distance from the previous one. Skipped once
 * the slider has been touched - post.js stops re-seeding at that point too.
 */
function syncDofFocusFromSubject() {
  const slider = $('dofFocus');
  const seeded = viewer.post.dofFocus;
  if (!Number.isFinite(seeded)) return;
  slider.value = String(Math.min(parseFloat(slider.max), Math.max(parseFloat(slider.min), seeded)));
  $('dofFocusOut').value = parseFloat(slider.value).toFixed(1);
}

bindCheckbox('aoToggle', async (on) => {
  // Reveal the sliders straight away; the composer's passes are imported on
  // demand and the UI should not wait on a network round trip.
  syncPostRows();
  try {
    await viewer.post.setAO(on);
  } catch (error) {
    console.error('[3DMViewer] ambient occlusion failed to initialise', error);
    toasts.error('Could not enable ambient occlusion', String(error.message));
    $('aoToggle').checked = false;
    syncPostRows();
  }
});

bindCheckbox('aaToggle', async (on) => {
  try {
    await viewer.post.setAA(on);
  } catch (error) {
    console.error('[3DMViewer] antialiasing failed to initialise', error);
    toasts.error('Could not enable antialiasing', String(error.message));
    $('aaToggle').checked = false;
  }
});
bindSlider('aoIntensity', (v) => viewer.post.setAOIntensity(v), fixed2);
bindSlider('aoRadius', (v) => viewer.post.setAORadius(v), fixed2);

bindCheckbox('dofToggle', async (on) => {
  syncPostRows();
  if (on) syncDofFocusFromSubject();
  try {
    await viewer.post.setDof(on);
  } catch (error) {
    console.error('[3DMViewer] depth of field failed to initialise', error);
    toasts.error('Could not enable depth of field', String(error.message));
    $('dofToggle').checked = false;
    syncPostRows();
  }
});
bindSlider('dofFocus', (v) => viewer.post.setDofFocus(v), fixed1);
// A real drag (or settings.js restoring a saved value, which dispatches the
// same event) is an explicit choice; bindSlider's own initial sync calls
// apply() directly without dispatching, so it correctly doesn't count.
$('dofFocus').addEventListener('input', () => viewer.post.markDofFocusTouched());
bindSlider('dofAperture', (v) => viewer.post.setDofAperture(v), (v) => v.toFixed(4));
bindSlider('dofMaxBlur', (v) => viewer.post.setDofMaxBlur(v), (v) => v.toFixed(3));

syncPostRows();

// Style effects (CRT / bloom / glitch / retro palette). Same pipeline, same
// pattern as AO/AA just above - each toggle reveals its own rows, lazy-
// builds the composer on first enable, and reports failure the same way.
// markStyleTouched() fires on the first control actually used, wherever that
// is - the checkbox toggles cover it, since nothing else here can be reached
// without one of those being on first.
function syncStyleRows() {
  for (const [flag, selector] of [
    ['crtToggle', '[data-crt]'],
    ['bloomToggle', '[data-bloom]'],
    ['lutToggle', '[data-lut]'],
    ['voronoiToggle', '[data-voronoi]'],
    ['ditherToggle', '[data-dither]'],
    ['pixelSortToggle', '[data-pixelsort]'],
    ['outlineToggle', '[data-outline]'],
    ['kuwaharaToggle', '[data-kuwahara]'],
    ['pixelateToggle', '[data-pixelate]'],
    ['glitchToggle', '[data-glitch]'],
    ['paletteToggle', '[data-palette]'],
    ['colorGradeToggle', '[data-colorgrade]'],
    ['toneToggle', '[data-tone]'],
    ['repeatToggle', '[data-repeat]'],
    ['displaceToggle', '[data-displace]'],
    ['afterimageToggle', '[data-afterimage]'],
    ['asciiToggle', '[data-ascii]'],
    ['halftoneToggle', '[data-halftone]'],
    ['filmToggle', '[data-film]'],
  ]) {
    const on = $(flag).checked;
    for (const row of document.querySelectorAll(selector)) row.hidden = !on;
  }
  syncColorGradeSubrows();
  syncToneSubrows();
  syncAsciiSubrows();
  renderStyleOrder();
}

function syncAsciiSubrows() {
  const isCustom = $('asciiToggle').checked && $('asciiRamp').value === 'custom';
  for (const row of document.querySelectorAll('[data-ascii-custom]')) row.hidden = !isCustom;
}

function syncColorGradeSubrows() {
  const isDuotone = $('colorGradeToggle').checked && $('colorGradeStyle').value === 'duotone';
  for (const row of document.querySelectorAll('[data-colorgrade-duotone]')) row.hidden = !isDuotone;
}

function syncToneSubrows() {
  const on = $('toneToggle').checked;
  const mode = $('toneMode').value;
  for (const row of document.querySelectorAll('[data-tone-posterize]')) row.hidden = !(on && mode === 'posterize');
  for (const row of document.querySelectorAll('[data-tone-solarize]')) row.hidden = !(on && mode === 'solarize');
  for (const row of document.querySelectorAll('[data-tone-edges]')) row.hidden = !(on && mode === 'edges');
}

// Track 5.1: a one-time nudge, not a silent auto-disable - stacking Style
// effects is a real, visible cost the person doing it should know about,
// but their choice to keep them all on stands, same as every other control.
let styleCostWarned = false;
function checkStyleCost() {
  if (styleCostWarned) return;
  const tier = $('qualityTier').value;
  if (tier !== 'high' && viewer.post.styleEffectCount >= 3) {
    styleCostWarned = true;
    toasts.warn(
      'Multiple Style effects together may be slow on this device',
      "Try Quality: Low in Environment, or turn one of them off.",
    );
  }
}

// Track 5.2: composite order as a small ordered list with up/down buttons,
// not drag-and-drop - keeps this keyboard/screen-reader accessible without
// extra work, matching every other control in this app.
const STYLE_LABELS = {
  bloom: 'Bloom', colorGrade: 'Color grade', lut: 'LUT', tone: 'Tone',
  kuwahara: 'Painterly', voronoi: 'Voronoi', pixelate: 'Pixelate', dither: 'Dither',
  pixelSort: 'Pixel sort',
  palette: 'Retro palette',
  halftone: 'Halftone / print', repeat: 'Repeat', displace: 'Glitch displace', afterimage: 'Trails',
  ascii: 'ASCII', crt: 'CRT', film: 'Film', glitch: 'Glitch',
};
const STYLE_TOGGLE_IDS = {
  bloom: 'bloomToggle', colorGrade: 'colorGradeToggle', lut: 'lutToggle', tone: 'toneToggle',
  kuwahara: 'kuwaharaToggle', voronoi: 'voronoiToggle', dither: 'ditherToggle',
  pixelSort: 'pixelSortToggle',
  pixelate: 'pixelateToggle', palette: 'paletteToggle',
  halftone: 'halftoneToggle', repeat: 'repeatToggle', displace: 'displaceToggle',
  afterimage: 'afterimageToggle', ascii: 'asciiToggle', crt: 'crtToggle', film: 'filmToggle',
  glitch: 'glitchToggle',
};

/** Move `key` to `toIndex` and commit the new chain order. */
/** The effects actually switched on, in composite order. */
function enabledStyleKeys() {
  return viewer.post.styleOrder.filter((key) => $(STYLE_TOGGLE_IDS[key]).checked);
}

/**
 * Move an effect to a new position *among the enabled effects*, and fold that
 * back into the full 17-key order.
 *
 * The list on screen shows only what is switched on, but the composite order
 * the engine uses covers every effect including the off ones. Reordering two
 * visible rows must not silently shuffle the invisible entries between them,
 * or switching a third effect on later would put it somewhere the user never
 * chose. So the disabled keys keep their slots: the reordered enabled keys are
 * poured back into the positions the enabled keys previously occupied.
 */
function moveStyle(key, toIndex) {
  const full = viewer.post.styleOrder;
  const enabled = enabledStyleKeys();

  const reordered = enabled.filter((k) => k !== key);
  reordered.splice(Math.max(0, Math.min(reordered.length, toIndex)), 0, key);

  let cursor = 0;
  const next = full.map((k) => (enabled.includes(k) ? reordered[cursor++] : k));

  viewer.post.setStyleOrder(next);
  renderStyleOrder();
  settings.save();
}

function renderStyleOrder() {
  const list = $('styleOrderList');
  // Only the enabled effects. Listing all 17 regardless meant the Style tab
  // showed 17 checkboxes and then the same 17 names again directly underneath,
  // most of them inert - roughly twice the length it needed to be, and the
  // second list carried no information the first did not.
  const order = enabledStyleKeys();
  list.replaceChildren();

  const empty = $('styleOrderEmpty');
  empty.hidden = order.length > 0;
  // One effect has nothing to reorder against, so the list is only meaningful
  // from two upward - but it is still shown at one, because seeing the single
  // entry appear is what explains what the list is for.
  $('styleOrderRow').hidden = order.length === 0;
  list.hidden = order.length === 0;

  order.forEach((key, index) => {
    const item = document.createElement('li');
    item.className = 'style-order-item';
    const enabled = $(STYLE_TOGGLE_IDS[key]).checked;
    item.dataset.enabled = String(enabled);

    // Dragging is an addition, not a replacement: the up/down buttons below
    // stay because they are the keyboard and screen-reader path, and HTML5
    // drag-and-drop offers neither. Anyone who can drag gets the faster
    // route; anyone who cannot loses nothing.
    item.draggable = true;
    item.dataset.key = key;

    item.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', key);
      event.dataTransfer.effectAllowed = 'move';
      item.dataset.dragging = 'true';
    });
    item.addEventListener('dragend', () => {
      delete item.dataset.dragging;
      for (const el of list.children) delete el.dataset.dropTarget;
    });
    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      item.dataset.dropTarget = 'true';
    });
    item.addEventListener('dragleave', () => {
      delete item.dataset.dropTarget;
    });
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      const dragged = event.dataTransfer.getData('text/plain');
      delete item.dataset.dropTarget;
      if (dragged && dragged !== key) moveStyle(dragged, index);
    });

    const name = document.createElement('span');
    name.className = 'style-order-name';
    name.textContent = STYLE_LABELS[key] ?? key;
    item.appendChild(name);

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'nudge';
    up.textContent = '▲';
    up.disabled = index === 0;
    up.setAttribute('aria-label', `Move ${STYLE_LABELS[key]} earlier in the chain`);
    up.addEventListener('click', () => moveStyle(key, index - 1));
    item.appendChild(up);

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'nudge';
    down.textContent = '▼';
    down.disabled = index === order.length - 1;
    down.setAttribute('aria-label', `Move ${STYLE_LABELS[key]} later in the chain`);
    down.addEventListener('click', () => moveStyle(key, index + 1));
    item.appendChild(down);

    list.appendChild(item);
  });
}

bindCheckbox('crtToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setCrt(on);
    checkStyleCost();
    syncStyleRows();
  } catch (error) {
    console.error('[3DMViewer] CRT effect failed to initialise', error);
    toasts.error('Could not enable CRT', String(error.message));
    $('crtToggle').checked = false;
    syncStyleRows();
  }
});
$('crtPreset').addEventListener('change', (event) => {
  markStyleTouched();
  viewer.post.setCrtPreset(event.target.value);
});

bindCheckbox('bloomToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setBloom(on);
    checkStyleCost();
    syncStyleRows();
  } catch (error) {
    console.error('[3DMViewer] bloom failed to initialise', error);
    toasts.error('Could not enable bloom', String(error.message));
    $('bloomToggle').checked = false;
    syncStyleRows();
  }
});
bindSlider('bloomStrength', (v) => viewer.post.setBloomStrength(v), fixed2);
// setBloomThreshold/setBloomRadius existed in post.js from the day bloom
// shipped and were wired to nothing, so threshold sat at 0.7 permanently -
// the actual reason "turn every light up and enable bloom" blew the whole
// frame out with no way to pull it back.
bindCheckbox('pixelateToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setPixelate(on);
    renderStyleOrder();
    if (on) checkStyleCost();
  } catch (error) {
    console.error('[Ghashangi] pixelate failed to initialise', error);
    toasts.error('Could not enable pixelate', String(error.message));
    $('pixelateToggle').checked = false;
    syncStyleRows();
  }
});
bindSlider('pixelateSize', (v) => viewer.post.setPixelateParam('pixelSize', v), (v) => `${v}px`);
bindSlider('pixelateAspect', (v) => viewer.post.setPixelateParam('aspect', v), fixed2);
bindSlider('pixelateGrid', (v) => viewer.post.setPixelateParam('gridStrength', v), fixed2);

bindCheckbox('voronoiToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setVoronoi(on);
    renderStyleOrder();
    if (on) checkStyleCost();
  } catch (error) {
    console.error('[Ghashangi] voronoi failed to initialise', error);
    toasts.error('Could not enable Voronoi', String(error.message));
    $('voronoiToggle').checked = false;
    syncStyleRows();
  }
});
$('voronoiMode').addEventListener('change', (e) => viewer.post.setVoronoiMode(e.target.value));
bindSlider('voronoiCellSize', (v) => viewer.post.setVoronoiParam('cellSize', v), (v) => `${v}px`);
bindSlider('voronoiJitter', (v) => viewer.post.setVoronoiParam('jitter', v), fixed2);
bindSlider('voronoiShatter', (v) => viewer.post.setVoronoiParam('shatter', v), fixed2);
$('voronoiEdgeColor').addEventListener('input', (e) => {
  viewer.post.setVoronoiParam('edgeColor', hexToRgbArray(e.target.value));
});

bindCheckbox('outlineToggle', async (on) => {
  syncStyleRows();
  try {
    await viewer.post.setOutline(on);
  } catch (error) {
    console.error('[Ghashangi] outline failed to initialise', error);
    toasts.error('Could not enable the outline', String(error.message));
    $('outlineToggle').checked = false;
    syncStyleRows();
  }
});
$('outlineColor').addEventListener('input', (e) => viewer.post.setOutlineColor(e.target.value));
bindSlider('outlineThickness', (v) => viewer.post.setOutlineThickness(v), fixed1);
bindSlider('outlineStrength', (v) => viewer.post.setOutlineStrength(v), fixed1);

bindCheckbox('pixelSortToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setPixelSort(on);
    renderStyleOrder();
    if (on) checkStyleCost();
  } catch (error) {
    console.error('[Ghashangi] pixel sort failed to initialise', error);
    toasts.error('Could not enable Pixel sort', String(error.message));
    $('pixelSortToggle').checked = false;
    syncStyleRows();
  }
});
$('pixelSortAxis').addEventListener('change', (e) => {
  viewer.post.setPixelSortParam('vertical', parseFloat(e.target.value));
});
bindSlider('pixelSortWindow', (v) => viewer.post.setPixelSortParam('windowSize', v), (v) => `${v}px`);
bindSlider('pixelSortLow', (v) => viewer.post.setPixelSortParam('lowThreshold', v), fixed2);
bindSlider('pixelSortHigh', (v) => viewer.post.setPixelSortParam('highThreshold', v), fixed2);
bindCheckbox('pixelSortReverse', (on) => viewer.post.setPixelSortParam('reverse', on ? 1 : 0));

bindCheckbox('ditherToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setDither(on);
    renderStyleOrder();
    if (on) checkStyleCost();
  } catch (error) {
    console.error('[Ghashangi] dither failed to initialise', error);
    toasts.error('Could not enable Dither', String(error.message));
    $('ditherToggle').checked = false;
    syncStyleRows();
  }
});
$('ditherMatrix').addEventListener('change', (e) => {
  viewer.post.setDitherParam('matrixSize', parseFloat(e.target.value));
});
bindSlider('ditherLevels', (v) => viewer.post.setDitherParam('levels', v), (v) => String(v));
bindSlider('ditherScale', (v) => viewer.post.setDitherParam('scale', v), (v) => `${v}px`);
bindSlider('ditherAmount', (v) => viewer.post.setDitherParam('strength', v), fixed2);
bindCheckbox('ditherMono', (on) => viewer.post.setDitherParam('monochrome', on ? 1 : 0));

bindCheckbox('kuwaharaToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setKuwahara(on);
    renderStyleOrder();
    if (on) checkStyleCost();
  } catch (error) {
    console.error('[Ghashangi] painterly failed to initialise', error);
    toasts.error('Could not enable Painterly', String(error.message));
    $('kuwaharaToggle').checked = false;
    syncStyleRows();
  }
});
bindSlider('kuwaharaRadius', (v) => viewer.post.setKuwaharaParam('radius', v), (v) => String(v));
bindSlider('kuwaharaStrength', (v) => viewer.post.setKuwaharaParam('strength', v), fixed2);
bindSlider('kuwaharaPunch', (v) => viewer.post.setKuwaharaParam('punch', v), fixed2);

bindCheckbox('lutToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setLut(on);
    renderStyleOrder();
    if (on) checkStyleCost();
  } catch (error) {
    console.error('[Ghashangi] LUT failed to initialise', error);
    toasts.error('Could not enable the LUT', String(error.message));
    $('lutToggle').checked = false;
    syncStyleRows();
  }
});

$('lutPreset').addEventListener('change', (event) => {
  viewer.post.setLutPreset(event.target.value);
  $('lutHint').textContent =
    'Built-in looks, or load a .cube / .3dl from Resolve, Premiere or a camera vendor.';
});

bindSlider('lutIntensity', (v) => viewer.post.setLutIntensity(v), fixed2);

$('lutLoadButton').addEventListener('click', () => $('lutFile').click());

$('lutFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  // Cleared so picking the same file twice still fires a change event -
  // otherwise re-loading an edited LUT silently does nothing.
  event.target.value = '';
  if (!file) return;

  try {
    const { texture, title } = await parseLutFile(file);
    viewer.post.setLutTexture(texture);
    $('lutHint').textContent = `Loaded ${title}`;
    // A file overrides the preset, so leave the dropdown showing what is
    // actually in force rather than a look that is no longer applied.
    $('lutPreset').selectedIndex = -1;
    if (!$('lutToggle').checked) $('lutToggle').click();
  } catch (error) {
    console.error('[Ghashangi] LUT file failed to parse', error);
    toasts.error('Could not read that LUT', String(error.message));
  }
});

bindSlider('bloomThreshold', (v) => viewer.post.setBloomThreshold(v), fixed2);
bindSlider('bloomRadius', (v) => viewer.post.setBloomRadius(v), fixed2);

bindCheckbox('glitchToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setGlitch(on);
    checkStyleCost();
    syncStyleRows();
  } catch (error) {
    console.error('[3DMViewer] glitch failed to initialise', error);
    toasts.error('Could not enable glitch', String(error.message));
    $('glitchToggle').checked = false;
    syncStyleRows();
  }
});
bindCheckbox('glitchWild', (on) => viewer.post.setGlitchWild(on));

bindCheckbox('paletteToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setPalette(on);
    checkStyleCost();
    syncStyleRows();
  } catch (error) {
    console.error('[3DMViewer] retro palette failed to initialise', error);
    toasts.error('Could not enable the retro palette', String(error.message));
    $('paletteToggle').checked = false;
    syncStyleRows();
  }
});
$('paletteName').addEventListener('change', (event) => {
  markStyleTouched();
  viewer.post.setPaletteName(event.target.value);
});
bindSlider('pixelSize', (v) => viewer.post.setPixelSize(v), (v) => `${v}px`);
// 0 = hard banding across every gradient, which is a legitimate look; the
// shipped 0.06 is the value that was previously unreachable.
bindSlider('ditherStrength', (v) => viewer.post.setDitherStrength(v), (v) => v.toFixed(3));

bindCheckbox('colorGradeToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setColorGrade(on);
    checkStyleCost();
    syncStyleRows();
  } catch (error) {
    console.error('[3DMViewer] color grade failed to initialise', error);
    toasts.error('Could not enable color grade', String(error.message));
    $('colorGradeToggle').checked = false;
    syncStyleRows();
  }
});
$('colorGradeStyle').addEventListener('change', (event) => {
  markStyleTouched();
  viewer.post.setColorGradeStyle(event.target.value);
  syncColorGradeSubrows();
});
bindSlider('cgBrightness', (v) => viewer.post.setColorGradeParam('brightness', v), fixed2);
bindSlider('cgContrast', (v) => viewer.post.setColorGradeParam('contrast', v), fixed2);
bindSlider('cgSaturation', (v) => viewer.post.setColorGradeParam('saturation', v), fixed2);
bindSlider('cgHue', (v) => viewer.post.setColorGradeParam('hueOffset', v), (v) => `${Math.round(v * 360)}°`);
bindSlider('cgSpeed', (v) => viewer.post.setColorGradeParam('speed', v), fixed2);
$('cgLightColor').addEventListener('input', (event) => {
  viewer.post.setColorGradeParam('lightColor', hexToRgbArray(event.target.value));
});
$('cgDarkColor').addEventListener('input', (event) => {
  viewer.post.setColorGradeParam('darkColor', hexToRgbArray(event.target.value));
});

bindCheckbox('toneToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setTone(on);
    checkStyleCost();
    syncStyleRows();
  } catch (error) {
    console.error('[3DMViewer] tone effect failed to initialise', error);
    toasts.error('Could not enable tone', String(error.message));
    $('toneToggle').checked = false;
    syncStyleRows();
  }
});
$('toneMode').addEventListener('change', (event) => {
  markStyleTouched();
  viewer.post.setToneMode(event.target.value);
  syncToneSubrows();
});
bindSlider('toneLevels', (v) => viewer.post.setToneParam('levels', v), (v) => String(v));
bindSlider('toneThreshold', (v) => viewer.post.setToneParam('solarizeThreshold', v), fixed2);
bindSlider('tonePassthru', (v) => viewer.post.setToneParam('passthru', v), fixed2);
$('toneEdgeColor').addEventListener('input', (event) => {
  viewer.post.setToneParam('edgeColor', hexToRgbArray(event.target.value));
});

bindCheckbox('repeatToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setRepeat(on);
    checkStyleCost();
    syncStyleRows();
  } catch (error) {
    console.error('[3DMViewer] repeat effect failed to initialise', error);
    toasts.error('Could not enable repeat', String(error.message));
    $('repeatToggle').checked = false;
    syncStyleRows();
  }
});
$('repeatMode').addEventListener('change', (event) => {
  markStyleTouched();
  viewer.post.setRepeatMode(event.target.value);
});
bindSlider('repeatAmount', (v) => viewer.post.setRepeatAmount(v), (v) => String(v));
bindSlider('repeatAngle', (v) => viewer.post.setRepeatAngle(v), (v) => `${v}°`);

bindCheckbox('displaceToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setDisplace(on);
    checkStyleCost();
    syncStyleRows();
  } catch (error) {
    console.error('[3DMViewer] displace effect failed to initialise', error);
    toasts.error('Could not enable glitch displace', String(error.message));
    $('displaceToggle').checked = false;
    syncStyleRows();
  }
});
$('displaceMode').addEventListener('change', (event) => {
  markStyleTouched();
  viewer.post.setDisplaceMode(event.target.value);
});
bindSlider('displaceAmount', (v) => viewer.post.setDisplaceParam('amount', v), fixed1);
bindSlider('displaceSize', (v) => viewer.post.setDisplaceParam('size', v), fixed1);
bindSlider('displaceSpeed', (v) => viewer.post.setDisplaceParam('speed', v), fixed1);
bindSlider('displaceAngle', (v) => viewer.post.setDisplaceParam('angle', (v * Math.PI) / 180), (v) => `${v}°`);

bindCheckbox('afterimageToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setAfterimage(on);
    checkStyleCost();
    syncStyleRows();
  } catch (error) {
    console.error('[3DMViewer] trails failed to initialise', error);
    toasts.error('Could not enable trails', String(error.message));
    $('afterimageToggle').checked = false;
    syncStyleRows();
  }
});
bindSlider('afterimageTrail', (v) => viewer.post.setAfterimageTrail(v), fixed2);

/**
 * Pull the film sliders back in line with a preset's values. Dispatching
 * 'input' rather than setting .value alone is deliberate: that re-runs
 * bindSlider()'s own handler, which is what keeps each row's <output> text
 * correct - the same reason settings.js restores controls by dispatching
 * events instead of writing viewer state directly.
 */
function syncFilmSliders(presetName) {
  const preset = FILM_PRESETS[presetName];
  if (!preset) return;
  for (const [uniform, id] of [
    ['grain', 'filmGrain'], ['dust', 'filmDust'], ['weave', 'filmWeave'], ['burn', 'filmBurn'],
  ]) {
    const slider = $(id);
    if (!slider) continue;
    slider.value = String(preset[uniform]);
    slider.dispatchEvent(new Event('input'));
  }
}

bindCheckbox('halftoneToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setHalftone(on);
    checkStyleCost();
    syncStyleRows();
  } catch (error) {
    console.error('[3DMViewer] halftone failed to initialise', error);
    toasts.error('Could not enable halftone', String(error.message));
    $('halftoneToggle').checked = false;
    syncStyleRows();
  }
});
$('halftoneMode').addEventListener('change', (event) => {
  markStyleTouched();
  viewer.post.setHalftoneMode(event.target.value);
});
bindSlider('halftoneScale', (v) => viewer.post.setHalftoneParam('scale', v), (v) => `${v}px`);
bindSlider('halftoneAngle', (v) => viewer.post.setHalftoneParam('angle', (v * Math.PI) / 180), (v) => `${v}°`);
bindCheckbox('halftoneInvert', (on) => viewer.post.setHalftoneParam('invert', on ? 1 : 0));

bindCheckbox('filmToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setFilm(on);
    checkStyleCost();
    syncStyleRows();
  } catch (error) {
    console.error('[3DMViewer] film effect failed to initialise', error);
    toasts.error('Could not enable film', String(error.message));
    $('filmToggle').checked = false;
    syncStyleRows();
  }
});
$('filmPreset').addEventListener('change', (event) => {
  markStyleTouched();
  viewer.post.setFilmPreset(event.target.value);
  // A preset rewrites every film uniform, so the sliders showing those
  // uniforms have to follow or they would report the previous stock's values.
  syncFilmSliders(event.target.value);
});
bindSlider('filmGrain', (v) => viewer.post.setFilmParam('grain', v), fixed2);
bindSlider('filmDust', (v) => viewer.post.setFilmParam('dust', v), fixed2);
bindSlider('filmWeave', (v) => viewer.post.setFilmParam('weave', v), fixed2);
bindSlider('filmBurn', (v) => viewer.post.setFilmParam('burn', v), fixed2);

bindCheckbox('asciiToggle', async (on) => {
  markStyleTouched();
  syncStyleRows();
  try {
    await viewer.post.setAscii(on);
    checkStyleCost();
    syncStyleRows();
  } catch (error) {
    console.error('[3DMViewer] ASCII failed to initialise', error);
    toasts.error('Could not enable ASCII', String(error.message));
    $('asciiToggle').checked = false;
    syncStyleRows();
  }
});
$('asciiRamp').addEventListener('change', (event) => {
  markStyleTouched();
  viewer.post.setAsciiRamp(event.target.value, $('asciiCustomRamp').value);
  syncAsciiSubrows();
});
$('asciiCustomRamp').addEventListener('change', (event) => {
  if ($('asciiRamp').value === 'custom') viewer.post.setAsciiRamp('custom', event.target.value);
});
// Width and height are separate because a monospace glyph is not square:
// one "cell size" slider could only ever stretch the character set.
bindSlider('asciiCellW', (v) => viewer.post.setAsciiParam('cellW', v), (v) => `${v}px`);
bindSlider('asciiCellH', (v) => viewer.post.setAsciiParam('cellH', v), (v) => `${v}px`);
// Exposed as "spacing" (0 = letters touch) but sent as glyphFill (1 = fill the
// cell), because "more spacing" is the intuitive direction for a slider and
// "how much of the cell the glyph covers" is the useful direction for a shader.
bindSlider('asciiSpacing', (v) => viewer.post.setAsciiParam('glyphFill', 1 - v), fixed2);
bindSlider('asciiContrast', (v) => viewer.post.setAsciiParam('contrast', v), fixed2);
bindSlider('asciiBrightness', (v) => viewer.post.setAsciiParam('brightness', v), fixed2);
$('asciiBgColor').addEventListener('input', (e) => {
  viewer.post.setAsciiParam('bgColor', hexToRgbArray(e.target.value));
});
bindCheckbox('asciiColorize', (on) => viewer.post.setAsciiParam('colorize', on ? 1 : 0));
bindCheckbox('asciiInvert', (on) => viewer.post.setAsciiParam('invert', on ? 1 : 0));

syncStyleRows();

// Quality tier: resolution scale and shadow map size always; AO/AA/Style are
// only ever forced *off* on 'low' (see viewer.js's applyQualityTier doc
// comment) - bypassing the checkboxes' own click handlers, which would
// replay a network fetch for passes that may already be loaded, so the
// checkbox/row UI is synced here directly instead.
function applyQualityTier(tier) {
  viewer.applyQualityTier(tier);
  if (tier === 'low') {
    $('aoToggle').checked = false;
    $('aaToggle').checked = false;
    $('dofToggle').checked = false;
    $('crtToggle').checked = false;
    $('bloomToggle').checked = false;
    $('glitchToggle').checked = false;
    $('paletteToggle').checked = false;
    $('colorGradeToggle').checked = false;
    $('toneToggle').checked = false;
    $('repeatToggle').checked = false;
    $('displaceToggle').checked = false;
    $('afterimageToggle').checked = false;
    $('asciiToggle').checked = false;
    $('halftoneToggle').checked = false;
    $('filmToggle').checked = false;
    syncPostRows();
    syncStyleRows();
  }
}

$('qualityTier').addEventListener('change', (event) => applyQualityTier(event.target.value));

// Turntable
bindSlider('ttRevolutions', () => {}, (v) => String(v));
bindSlider('ttDuration', () => {}, (v) => `${v}s`);

if (!isTurntableSupported()) {
  // Safari has historically supported none of the WebM codecs. Say so rather
  // than offering a button that fails.
  $('recordTurntable').disabled = true;
  $('turntableHint').textContent =
    'This browser cannot record WebM. Try Chrome or Firefox, or use the colourway PNG export.';
  $('turntableHint').dataset.level = 'warn';
}

$('recordTurntable').addEventListener('click', async () => {
  const button = $('recordTurntable');
  const label = button.textContent;
  button.disabled = true;

  try {
    const blob = await recordTurntable({
      viewer,
      revolutions: parseInt($('ttRevolutions').value, 10),
      duration: parseInt($('ttDuration').value, 10),
      onProgress: (fraction) => {
        button.textContent = `Recording ${Math.round(fraction * 100)}%`;
      },
    });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(currentModelName || 'model').replace(/\.[^.]+$/, '')}-turntable.webm`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);

    logExport('webm');
    toasts.info('Turntable recorded', formatBytes(blob.size));
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('[3DMViewer] turntable failed', error);
      toasts.error('Could not record the turntable', String(error.message));
    }
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

// Capture
bindSlider('shotScale', () => {}, (v) => `${v}×`);

$('screenshotButton').addEventListener('click', async () => {
  try {
    const requestedScale = parseInt($('shotScale').value, 10);
    const maxScale = viewer.maxScreenshotScale();

    // Warned here rather than only relying on captureScreenshot()'s internal
    // clamp, so a smaller-than-requested image comes with an explanation
    // instead of looking like a bug.
    if (requestedScale > maxScale) {
      toasts.warn(
        `${requestedScale}× exceeds this device's limit`,
        `Using ${maxScale.toFixed(1)}× instead.`,
      );
    }

    const blob = await viewer.captureScreenshot({
      scale: requestedScale,
      transparent: $('shotTransparent').checked,
    });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `screenshot-${Date.now()}.png`;
    anchor.click();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (error) {
    toasts.error('Screenshot failed', String(error.message));
  }
});

// Panel collapse
const panel = $('panel');
$('panelToggle').addEventListener('click', (event) => {
  const collapsed = panel.dataset.collapsed === 'true';
  panel.dataset.collapsed = String(!collapsed);
  event.currentTarget.setAttribute('aria-expanded', String(collapsed));
  event.currentTarget.textContent = collapsed ? '−' : '+';
  event.currentTarget.title = collapsed ? 'Collapse panel' : 'Expand panel';
});

// --- stats ---------------------------------------------------------------

function refreshStats() {
  const { render, memory } = viewer.renderer.info;
  const stats = viewer.modelStats;

  // Triangles come from the model's geometry, not renderer.info.render.triangles
  // — the latter reports what the last frame drew, which under frustum culling
  // and on-demand rendering is a different number, and includes the stage and
  // the shadow pass. It reported Duck.glb as 28,962 against a real 4,212.
  $('statTris').textContent = stats.triangles.toLocaleString();
  $('statVerts').textContent = stats.vertices.toLocaleString();
  $('statMeshes').textContent = String(stats.meshes);
  $('statMaterials').textContent = String(stats.materials);

  // Draw calls genuinely are a per-frame property, so renderer.info is right here.
  $('statCalls').textContent = String(render.calls);
  $('statTextures').textContent = String(memory.textures);

  const simplification = viewer.simplification;
  $('statSimplify').textContent = !simplification
    ? '—'
    : simplification.applied
      ? `${simplification.original.toLocaleString()} → ${simplification.simplified.toLocaleString()}` +
        (simplification.skinnedExcluded ? ' (skinned mesh kept full-detail)' : '')
      : 'under budget';
}

// Track 5.1 follow-up: a real measured-performance nudge, not just the
// guessed effect-count one below it. "3+ effects" says nothing about
// whether a *specific* device can actually afford even one - a laptop
// with hybrid graphics can struggle if the browser happens to be
// rendering on its integrated GPU rather than a discrete one it has
// (checkable in chrome://gpu, outside this app's control either way).
//
// Auto-*applying* a downgrade here was tried and reverted: measured
// directly, under headless testing a burst of ordinary invalidate cycles
// with AO on was enough to trigger it, silently unchecking the user's own
// AO toggle and corrupting whatever the test was actually checking - the
// exact same failure mode a real user would hit during any legitimate
// temporary slowdown (a heavy shadow recompute, a big model's first
// frame), having Style effects they explicitly turned on switched off
// without asking. That breaks the one rule every tier-aware control in
// this app has followed since Track 1.5: an explicit user choice stands
// until the user changes it. A measured frame rate being bad is real
// evidence something is slow - it is not evidence the user wants their
// settings changed for them. So: same shape as checkStyleCost() below,
// informational only.
let sustainedLowFrames = 0;
let performanceCostWarned = false;
const LOW_FPS_THRESHOLD = 20;
const SUSTAINED_TICKS_NEEDED = 6; // 6 * 500ms = 3s of genuinely bad performance

function checkMeasuredPerformance(fps) {
  if (performanceCostWarned) return;
  const tier = $('qualityTier').value;
  if (!viewer.post.active || tier === 'low' || fps <= 0) {
    sustainedLowFrames = 0;
    return;
  }
  sustainedLowFrames = fps < LOW_FPS_THRESHOLD ? sustainedLowFrames + 1 : 0;
  if (sustainedLowFrames < SUSTAINED_TICKS_NEEDED) return;

  performanceCostWarned = true;
  toasts.warn(
    `Rendering has stayed under ${LOW_FPS_THRESHOLD}fps for a few seconds`,
    'Try Quality: Low in Environment, or turn off a Style effect.',
  );
}

// FPS is the only stat that needs polling; the rest change on load. 2Hz is
// enough to read and costs nothing.
setInterval(() => {
  const { fps } = viewer.loop.stats;
  $('statFps').textContent = fps > 0 ? fps.toFixed(0) : '—';
  refreshStats();
  checkMeasuredPerformance(fps);

  // Track 5.1: the same FPS number, shown inside the Style section itself
  // rather than only in the separate Stats section - so cause (a Style
  // toggle) and effect (the frame rate) are visible in the same place,
  // instead of "I turned on Glitch" and "the number over in Stats" reading
  // as two unconnected facts.
  const styleActive = viewer.post.styleEffectCount > 0;
  $('styleFpsRow').hidden = !styleActive;
  if (styleActive) $('styleFpsOut').textContent = fps > 0 ? fps.toFixed(0) : '—';
}, 500);

// --- debug surface -------------------------------------------------------

// Exposed in dev, and in any build when ?debug is present, so the browser smoke
// test (test/smoke.mjs) can assert on real viewer state instead of inferring it
// from pixels. Not exposed in a plain production load.
if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
  window.__viewer = viewer;
  window.__materials = materialsPanel;
  window.__materialUndo = materialUndo;
  // telemetry.js exists to answer three questions "in a few weeks" - but it
  // was write-only in practice until this: reading it back meant hand-
  // importing the module in devtools. window.__telemetry() is the actual
  // queryable surface its own file header promised.
  window.__telemetry = readTelemetry;
  // Reset without the confirm() dialog, for test/render.mjs's reset checks.
  window.__settingsReset = resetAllSettings;
  window.__cameraPath = cameraPath;
  window.__keyframes = keyframes;
  // Exposed so the keyframe suite can assert that a settings restore does not
  // manufacture keys — writeFieldById dispatches non-bubbling events, which is
  // exactly what keeps it invisible to the panel-level capture listener.
  window.__settings = settings;
  window.__loadDemo = () => loadBundled(DEMO_MODEL, 'demo model');
  window.__loadFiles = loadFromFiles;
  window.__loadLink = loadFromLink;
}

// --- startup -------------------------------------------------------------

(async function start() {
  // The HDR is 1.5MB and only improves on the procedural studio environment
  // already installed, so it loads in the background without blocking.
  viewer.environment.loadHDR(DEFAULT_HDR).catch((error) => {
    console.warn('[3DMViewer] HDR environment failed, keeping studio fallback', error);
    toasts.warn('Could not load the HDR environment', 'Using the built-in studio lighting instead.');
  });

  await loadBundled(DEMO_MODEL, 'demo model');

  // Pre-select the quality tier from the device probe and apply it. Placed
  // right before settings.load(): if a session had explicitly saved a
  // different tier, load()'s dispatched 'change' event runs applyQualityTier()
  // again with the saved value, overriding this auto-detected default -
  // exactly how every other restored control here already works.
  $('qualityTier').value = viewer.detectedTier;
  applyQualityTier(viewer.detectedTier);

  // Restore last session's lighting/tone-mapping/environment/AO/up-axis/panel
  // state now that a model exists for the up-axis restore to act on, then
  // start auto-saving. In that order, deliberately: load()'s own writes fire
  // the same events a user's edit would, and watch() is not listening for
  // them yet, so restoring never immediately re-triggers a save of the exact
  // data it just read.
  settings.load();
  settings.watch();

  // The stage is decorative and tiny; load it after the subject so it never
  // delays first paint.
  try {
    const { object } = await loadModel({
      url: STAGE_MODEL,
      extension: 'glb',
      renderer: viewer.renderer,
    });
    viewer.setStage(object);
    viewer.setStageVisible($('stageToggle').checked);
  } catch (error) {
    console.warn('[3DMViewer] stage failed to load', error);
    $('stageToggle').disabled = true;
  }
})();
