// Colourways: named sets of per-material overrides, and batch export.
//
// This is the feature the rest of the app exists to serve. The competing
// viewers are inspectors — they tell you what is in a file. None of them helps
// with the actual job a product model exists for: producing one image per
// colour variant.
//
// A shop with one sneaker GLB needing six product shots currently opens
// Blender, recolours, renders, and repeats six times. Here it is: recolour,
// save as "Red", repeat, export all — six PNGs in a zip.
//
// Storage is keyed by a model signature (filename plus its material names) so
// colourways reattach when the same model is opened again, and do not leak
// between unrelated models. Material entries are keyed by name + ordinal rather
// than uuid, because three regenerates uuids on every parse — see materialKey()
// in materials.js.

const STORAGE_PREFIX = '3dmviewer.colorways.';

/**
 * Identify a model well enough to reattach its colourways, without needing a
 * hash of the file itself.
 *
 * @param {string} modelName
 * @param {Array<{key: string}>} materials
 */
export function modelSignature(modelName, materials) {
  const names = materials.map((m) => m.key).sort().join('|');
  return `${modelName}::${names}`;
}

/** localStorage can be unavailable (private mode, blocked site data). */
function readStore(signature) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + signature);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(signature, colorways) {
  try {
    localStorage.setItem(STORAGE_PREFIX + signature, JSON.stringify(colorways));
    return true;
  } catch {
    // Quota exceeded, or storage blocked. The colourways still work for this
    // session; only persistence is lost.
    return false;
  }
}

/**
 * Manage the colourways belonging to one loaded model.
 *
 * @param {object} options
 * @param {object} options.viewer
 * @param {() => void} [options.onChange] Called whenever the list changes.
 */
export function createColorways({ viewer, onChange = () => {} }) {
  let signature = null;
  let list = [];

  /** Point at a newly loaded model and load its saved colourways. */
  function attach(modelName) {
    signature = modelSignature(modelName, viewer.materials);
    list = readStore(signature);
    onChange();
    return list;
  }

  function persist() {
    if (signature) writeStore(signature, list);
    onChange();
  }

  return {
    attach,

    get all() {
      return list;
    },

    get signature() {
      return signature;
    },

    /** Save the current material state under a name, replacing any namesake. */
    save(name) {
      const trimmed = String(name ?? '').trim();
      if (!trimmed) return null;

      const colorway = { name: trimmed, entries: viewer.captureMaterialState() };
      const existing = list.findIndex((c) => c.name.toLowerCase() === trimmed.toLowerCase());
      if (existing >= 0) list[existing] = colorway;
      else list.push(colorway);

      persist();
      return colorway;
    },

    apply(name) {
      const colorway = list.find((c) => c.name === name);
      if (!colorway) return null;
      const result = viewer.applyMaterialState(colorway.entries);
      return { colorway, ...result };
    },

    remove(name) {
      const before = list.length;
      list = list.filter((c) => c.name !== name);
      if (list.length === before) return false;
      persist();
      return true;
    },

    clear() {
      list = [];
      persist();
    },
  };
}

/** Filesystem-safe version of a colourway name. */
function safeFilename(name) {
  return (
    String(name)
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'colorway'
  );
}

/**
 * Render one PNG per colourway and return them zipped.
 *
 * Uses fflate, which already ships inside three (it is there for FBX and USDZ)
 * and is already in our bundle — so this needs no new dependency.
 *
 * The current material state is captured first and restored afterwards, so
 * exporting does not silently leave the viewer on the last colourway.
 *
 * @param {object} options
 * @param {object} options.viewer
 * @param {Array<{name: string, entries: object}>} options.colorways
 * @param {number} [options.scale=2]
 * @param {boolean} [options.transparent=true]
 * @param {string} [options.baseName='model']
 * @param {(done:number, total:number, name:string) => void} [options.onProgress]
 * @returns {Promise<Blob>} a .zip
 */
export async function exportColorwayPNGs({
  viewer,
  colorways,
  scale = 2,
  transparent = true,
  baseName = 'model',
  onProgress = () => {},
}) {
  const { zipSync } = await import('three/addons/libs/fflate.module.js');

  const restore = viewer.captureMaterialState();
  const files = {};

  try {
    for (const [index, colorway] of colorways.entries()) {
      onProgress(index, colorways.length, colorway.name);

      viewer.applyMaterialState(colorway.entries);
      // Let the material change reach the GPU before reading the frame back.
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const blob = await viewer.captureScreenshot({ scale, transparent });
      files[`${safeFilename(baseName)}-${safeFilename(colorway.name)}.png`] =
        new Uint8Array(await blob.arrayBuffer());
    }
  } finally {
    viewer.applyMaterialState(restore);
  }

  onProgress(colorways.length, colorways.length, '');

  // PNG is already deflated; asking fflate to compress it again costs time and
  // saves nothing.
  //
  // zipSync runs synchronously on the main thread. Measured rather than moved
  // to a worker pre-emptively: at typical sizes (a handful of already-
  // compressed PNGs, level 0 = store not deflate) this finishes well under a
  // frame budget. It could become real at high `scale` x many colourways —
  // logged here so that's a measurement, not a guess, if it's ever raised
  // again. ~150ms is the rule-of-thumb threshold above which a synchronous
  // main-thread task starts being felt as jank.
  const zipStarted = performance.now();
  const zip = zipSync(files, { level: 0 });
  const zipMs = performance.now() - zipStarted;
  if (zipMs > 150) {
    console.warn(
      `[3DMViewer] colourway zip took ${zipMs.toFixed(0)}ms for ${colorways.length} image(s) ` +
        `— consider moving zipSync to a worker if this recurs.`,
    );
  }

  return new Blob([zip], { type: 'application/zip' });
}

/**
 * Export the model with its edited materials baked in.
 *
 * Exports `orientRoot` rather than `modelRoot`: that captures the orientation
 * fix and the material edits, but leaves out the user's on-screen scale and
 * height, which are viewing preferences rather than properties of the asset.
 *
 * @param {object} viewer
 * @returns {Promise<Blob>} a .glb
 */
export async function exportGLB(viewer) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const exporter = new GLTFExporter();

  const result = await exporter.parseAsync(viewer.orientRoot, {
    binary: true,
    onlyVisible: false,
  });

  return new Blob([result], { type: 'model/gltf-binary' });
}
