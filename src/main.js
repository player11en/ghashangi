// Bootstrap: build the viewer, wire the controls, wire the sources.

import { createViewer } from './core/viewer.js';
import { createToasts } from './ui/toast.js';
import { createProgress, formatBytes } from './ui/progress.js';
import { createFileSource } from './sources/file.js';
import { createMaterialsPanel } from './ui/materials-panel.js';
import { createAnimationPanel } from './ui/animation-panel.js';
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

const materialsPanel = createMaterialsPanel({ viewer, toasts });
// Registers its own viewer callbacks, so it rebuilds itself on every load.
const animationPanel = createAnimationPanel({ viewer });

// The filesystem backing the current model, kept so its blob URLs can be
// revoked when the next model replaces it.
let currentFs = null;

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

    install(object, animations, fs, primary.name);

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
function install(object, animations, fs, name = 'model') {
  viewer.setModel(object, { animations });
  currentFs?.dispose();
  currentFs = fs ?? null;
  refreshStats();
  // setModel resets orientation to the new file's authored pose; the sliders
  // have to follow or they would show the previous model's correction.
  syncOrientationUI();
  // Rebuild the material list and reattach this model's saved colourways.
  materialsPanel.refresh(name);
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
    install(object, animations, null, url.split('/').pop());
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

    install(object, animations, null, name);
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
 * Bind a range input to a setter, keeping its <output> in sync.
 *
 * @param {string} id
 * @param {(value:number) => void} apply
 * @param {(value:number) => string} format
 */
function bindSlider(id, apply, format) {
  const input = $(id);
  const output = $(`${id.replace('Slider', '')}Out`) ?? $(`${id}Out`);
  const sync = () => {
    const value = parseFloat(input.value);
    apply(value);
    if (output) output.textContent = format(value);
  };
  input.addEventListener('input', sync);
  sync();
}

function bindCheckbox(id, apply) {
  const input = $(id);
  input.addEventListener('change', () => apply(input.checked));
}

const fixed2 = (v) => v.toFixed(2);
const fixed1 = (v) => v.toFixed(1);

// Model
bindSlider('scaleSlider', (v) => viewer.setScale(v), (v) => `${v.toFixed(2)}×`);
bindSlider('heightSlider', (v) => viewer.setHeight(v), fixed1);
bindCheckbox('autoRotate', (on) => viewer.setAutoRotate(on));
bindCheckbox('stageToggle', (on) => viewer.setStageVisible(on));
bindCheckbox('wireframe', (on) => viewer.setWireframe(on));
$('frameButton').addEventListener('click', () => viewer.frame());
$('resetButton').addEventListener('click', () => viewer.resetCamera());

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
    output.textContent = `${Math.round(angles[axis])}°`;
  }

  for (const button of document.querySelectorAll('.seg[data-up]')) {
    button.setAttribute('aria-pressed', String(button.dataset.up === preset));
  }
}

for (const axis of AXES) {
  $(`rot${axis.toUpperCase()}`).addEventListener('input', (event) => {
    viewer.orientation.setAxis(axis, parseFloat(event.target.value));
    syncOrientationUI();
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
bindCheckbox('shadowToggle', (on) => viewer.setShadowsEnabled(on));

// Environment
bindSlider('exposureSlider', (v) => viewer.environment.setExposure(v), fixed2);
bindSlider('envIntensity', (v) => viewer.environment.setIntensity(v), fixed2);
bindSlider('envRotation', (v) => viewer.environment.setRotation((v * Math.PI) / 180), (v) => `${Math.round(v)}°`);
bindCheckbox('bgToggle', (on) => viewer.environment.setBackgroundVisible(on));

$('toneMapping').addEventListener('change', (event) => {
  viewer.environment.setToneMapping(event.target.value);
});

// Capture
bindSlider('shotScale', () => {}, (v) => `${v}×`);

$('screenshotButton').addEventListener('click', async () => {
  try {
    const blob = await viewer.captureScreenshot({
      scale: parseInt($('shotScale').value, 10),
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
}

// FPS is the only stat that needs polling; the rest change on load. 2Hz is
// enough to read and costs nothing.
setInterval(() => {
  const { fps } = viewer.loop.stats;
  $('statFps').textContent = fps > 0 ? fps.toFixed(0) : '—';
  refreshStats();
}, 500);

// --- debug surface -------------------------------------------------------

// Exposed in dev, and in any build when ?debug is present, so the browser smoke
// test (test/smoke.mjs) can assert on real viewer state instead of inferring it
// from pixels. Not exposed in a plain production load.
if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
  window.__viewer = viewer;
  window.__materials = materialsPanel;
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
