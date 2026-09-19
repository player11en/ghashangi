// Bootstrap: build the viewer, wire the controls, wire the sources.

import { createViewer } from './core/viewer.js';
import { createToasts } from './ui/toast.js';
import { createProgress, formatBytes } from './ui/progress.js';
import { createFileSource } from './sources/file.js';
import { createFileSystem, pickPrimary } from './loaders/fs-map.js';
import { loadModel, SUPPORTED_EXTENSIONS, UnsupportedFormatError } from './loaders/index.js';
import { DEFAULT_HDR } from './core/environment.js';

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

    install(object, animations, fs);

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
function install(object, animations, fs) {
  viewer.setModel(object, { animations });
  currentFs?.dispose();
  currentFs = fs ?? null;
  refreshStats();
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
    install(object, animations, null);
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
  $('statTris').textContent = render.triangles.toLocaleString();
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
  window.__loadDemo = () => loadBundled(DEMO_MODEL, 'demo model');
  window.__loadFiles = loadFromFiles;
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
