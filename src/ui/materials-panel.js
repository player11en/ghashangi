// The Materials and Colourways panels.
//
// Kept out of main.js because this is the only part of the UI with real state
// of its own: which material is selected, and keeping every control in sync
// when the selection changes or a colourway is applied under it.

import { readMaterial } from '../core/materials.js';
import { createColorways, exportColorwayPNGs, exportGLB } from '../core/colorways.js';

const $ = (id) => document.getElementById(id);

/** Normalise free-typed hex text to '#rrggbb', or null if it isn't valid hex. */
function normalizeHex(text) {
  const v = text.trim().replace(/^#/, '').toLowerCase();
  return /^[0-9a-f]{6}$/.test(v) ? `#${v}` : null;
}

/** Channels with a plain numeric slider, and how to format the readout. */
const NUMERIC = [
  { channel: 'metalness', id: 'matMetalness', format: (v) => v.toFixed(2) },
  { channel: 'roughness', id: 'matRoughness', format: (v) => v.toFixed(2) },
  { channel: 'emissiveIntensity', id: 'matEmissiveIntensity', format: (v) => v.toFixed(2) },
  { channel: 'opacity', id: 'matOpacity', format: (v) => v.toFixed(2) },
];

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {object} options.toasts
 * @param {(name:string) => void} [options.onDownload] Override for tests.
 */
export function createMaterialsPanel({ viewer, toasts }) {
  const list = $('materialList');
  const controls = $('materialControls');
  const countEl = $('materialCount');

  let selectedKey = null;
  let modelName = 'model';
  // Set while applying state to the controls, so the resulting `input` events
  // do not echo straight back into the viewer.
  let syncing = false;

  const colorways = createColorways({ viewer, onChange: renderColorways });

  // --- material list -------------------------------------------------------

  function renderList() {
    const materials = viewer.materials;
    list.replaceChildren();

    countEl.textContent = materials.length ? `(${materials.length})` : '';

    if (materials.length === 0) {
      controls.hidden = true;
      const empty = document.createElement('li');
      empty.className = 'hint';
      empty.textContent = 'This model has no editable materials.';
      list.appendChild(empty);
      return;
    }

    for (const entry of materials) {
      const item = document.createElement('li');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'material-item';
      button.dataset.key = entry.key;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(entry.key === selectedKey));

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = entry.material.color
        ? `#${entry.material.color.getHexString()}`
        : 'transparent';

      const name = document.createElement('span');
      name.className = 'material-name';
      name.textContent = entry.name;

      const meta = document.createElement('span');
      meta.className = 'material-meta';
      // Flagging a texture matters: it explains why the colour tints rather
      // than replacing, and why Blend is the useful control on this material.
      meta.textContent = [
        entry.meshCount > 1 ? `${entry.meshCount} meshes` : '',
        entry.hasMap ? 'textured' : '',
      ]
        .filter(Boolean)
        .join(' · ');

      button.append(swatch, name, meta);
      button.addEventListener('click', () => select(entry.key));
      item.appendChild(button);
      list.appendChild(item);
    }

    if (!materials.some((m) => m.key === selectedKey)) {
      select(materials[0].key);
    }
  }

  function select(key) {
    selectedKey = key;
    for (const button of list.querySelectorAll('.material-item')) {
      button.setAttribute('aria-selected', String(button.dataset.key === key));
    }
    syncControls();
  }

  /** Push the selected material's values into the controls. */
  function syncControls() {
    const entry = viewer.materialByKey(selectedKey);
    if (!entry) {
      controls.hidden = true;
      return;
    }

    controls.hidden = false;
    syncing = true;

    const state = readMaterial(entry.material);

    if (state.targetColor) {
      $('matColor').value = state.targetColor;
      $('matColorOut').value = state.targetColor;
    }
    $('matBlend').value = String(state.blend);
    $('matBlendOut').value = `${Math.round(state.blend * 100)}%`;

    // Blend only means something when there is a texture to blend against.
    // On an untextured material the colour is the colour.
    setRowVisible('matBlend', entry.hasMap);

    for (const { channel, id, format } of NUMERIC) {
      const has = channel in entry.material;
      setRowVisible(id, has);
      if (!has) continue;
      $(id).value = String(state[channel]);
      $(`${id}Out`).value = format(state[channel]);
    }

    const hasEmissive = Boolean(entry.material.emissive);
    setRowVisible('matEmissive', hasEmissive);
    if (hasEmissive) {
      $('matEmissive').value = state.emissive;
      $('matEmissiveOut').value = state.emissive;
    }

    syncing = false;
  }

  function setRowVisible(controlId, visible) {
    const row = $(controlId)?.closest('.row');
    if (row) row.hidden = !visible;
  }

  /** Keep the list swatch in step with an edit. */
  function refreshSwatch() {
    const entry = viewer.materialByKey(selectedKey);
    if (!entry?.material.color) return;
    const swatch = list.querySelector(`.material-item[data-key="${CSS.escape(selectedKey)}"] .swatch`);
    if (swatch) swatch.style.background = `#${entry.material.color.getHexString()}`;
  }

  // --- material controls ---------------------------------------------------

  /**
   * @param {string} color  '#rrggbb'
   * @param {number} blend  0..1
   */
  function applyColor(color, blend) {
    if (syncing || !selectedKey) return;
    viewer.setMaterialColor(selectedKey, color, blend);
    $('matColor').value = color;
    $('matColorOut').value = color;
    $('matBlend').value = String(blend);
    $('matBlendOut').value = `${Math.round(blend * 100)}%`;
    refreshSwatch();
  }

  const currentColor = () => $('matColor').value;
  const currentBlend = () => parseFloat($('matBlend').value);

  $('matColor').addEventListener('input', () => applyColor(currentColor(), currentBlend()));
  $('matBlend').addEventListener('input', () => applyColor(currentColor(), currentBlend()));

  // Typed hex entry. matColorOut was a read-only <output>; picking a colour
  // from the native swatch is imprecise for matching a brand hex exactly, so
  // it is now also a text field.
  $('matColorOut').addEventListener('change', () => {
    if (syncing || !selectedKey) return;
    const hex = normalizeHex($('matColorOut').value);
    if (hex) applyColor(hex, currentBlend());
    else $('matColorOut').value = currentColor(); // reject silently, restore
  });
  $('matColorOut').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.target.blur();
  });

  // Typed blend entry. Displayed as a percentage but the underlying domain is
  // 0..1 (see applyColor / setBaseColor), so the /100 conversion happens here,
  // not in the shared numeric-field pattern the plain sliders below use.
  $('matBlendOut').addEventListener('change', () => {
    if (syncing || !selectedKey) return;
    const parsed = parseFloat($('matBlendOut').value); // "75%" -> 75
    const clamped = Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) / 100 : currentBlend();
    applyColor(currentColor(), clamped);
  });
  $('matBlendOut').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.target.blur();
  });

  for (const { channel, id, format } of NUMERIC) {
    const slider = $(id);
    const output = $(`${id}Out`);
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);

    slider.addEventListener('input', () => {
      if (syncing || !selectedKey) return;
      const value = parseFloat(slider.value);
      viewer.setMaterialChannel(selectedKey, channel, value);
      output.value = format(value);
    });

    // Typed entry, clamped to the same range the slider allows.
    output.addEventListener('change', () => {
      if (syncing || !selectedKey) return;
      const parsed = parseFloat(output.value);
      const clamped = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : parseFloat(slider.value);
      slider.value = String(clamped);
      viewer.setMaterialChannel(selectedKey, channel, clamped);
      output.value = format(clamped);
    });
    output.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.target.blur();
    });
  }

  $('matEmissive').addEventListener('input', () => {
    if (syncing || !selectedKey) return;
    const color = $('matEmissive').value;
    viewer.setMaterialEmissive(selectedKey, color);
    $('matEmissiveOut').value = color;
  });

  $('matEmissiveOut').addEventListener('change', () => {
    if (syncing || !selectedKey) return;
    const hex = normalizeHex($('matEmissiveOut').value);
    if (hex) {
      $('matEmissive').value = hex;
      viewer.setMaterialEmissive(selectedKey, hex);
    } else {
      $('matEmissiveOut').value = $('matEmissive').value; // reject silently
    }
  });
  $('matEmissiveOut').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.target.blur();
  });

  $('resetMaterial').addEventListener('click', () => {
    if (!selectedKey) return;
    viewer.resetMaterial(selectedKey);
    syncControls();
    refreshSwatch();
  });

  $('resetAllMaterials').addEventListener('click', () => {
    viewer.resetAllMaterials();
    renderList();
    syncControls();
  });

  // --- colourways ----------------------------------------------------------

  const colorwayList = $('colorwayList');
  const colorwayHint = $('colorwayHint');

  function renderColorways() {
    colorwayList.replaceChildren();

    if (colorways.all.length === 0) {
      colorwayHint.textContent = 'Recolour the materials above, then save the result as a colourway.';
      return;
    }

    colorwayHint.textContent = `${colorways.all.length} saved. Export writes one PNG per colourway.`;

    for (const colorway of colorways.all) {
      const item = document.createElement('li');
      item.className = 'colorway';

      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'colorway-apply';
      apply.textContent = colorway.name;
      apply.addEventListener('click', () => {
        const result = colorways.apply(colorway.name);
        if (result?.missing.length) {
          toasts.warn(
            `Applied "${colorway.name}" partially`,
            `${result.missing.length} material(s) in this model were not in the saved set.`,
          );
        }
        renderList();
        syncControls();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'colorway-remove';
      remove.setAttribute('aria-label', `Delete colourway ${colorway.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => colorways.remove(colorway.name));

      item.append(apply, remove);
      colorwayList.appendChild(item);
    }
  }

  $('colorwayForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('colorwayName');
    const saved = colorways.save(input.value);
    if (!saved) {
      toasts.warn('Name the colourway first', 'For example "Red" or "Matte black".');
      return;
    }
    input.value = '';
    toasts.info(`Saved colourway "${saved.name}"`);
  });

  // --- export --------------------------------------------------------------

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function exportPNGs() {
    const scope = $('exportScope').value;
    const scale = parseInt($('shotScale').value, 10) || 1;
    const transparent = $('shotTransparent').checked;

    // "Current view" still goes through the same path, as a one-entry set, so
    // there is only one code path to get right.
    const set =
      scope === 'current'
        ? [{ name: 'current', entries: viewer.captureMaterialState() }]
        : colorways.all;

    if (set.length === 0) {
      toasts.warn('No colourways saved', 'Save at least one, or export the current view.');
      return;
    }

    // Warn up front rather than silently clamping — viewer.captureScreenshot()
    // clamps to the device's real texture-size limit internally as a safety
    // floor either way, but a batch of colourways rendered one scale lower
    // than asked for, with no explanation, would look like a bug.
    const maxScale = viewer.maxScreenshotScale();
    if (scale > maxScale) {
      toasts.warn(
        `${scale}× exceeds this device's limit`,
        `Using ${maxScale.toFixed(1)}× instead for all ${set.length} image(s).`,
      );
    }

    const button = $('exportPngs');
    button.disabled = true;
    const label = button.textContent;

    try {
      const zip = await exportColorwayPNGs({
        viewer,
        colorways: set,
        scale,
        transparent,
        baseName: modelName,
        onProgress: (done, total, name) => {
          button.textContent = name ? `Rendering ${done + 1}/${total}…` : 'Zipping…';
        },
      });
      download(zip, `${modelName}-colorways.zip`);
      toasts.info(`Exported ${set.length} image${set.length === 1 ? '' : 's'}`);
    } catch (error) {
      console.error('[3DMViewer] colourway export failed', error);
      toasts.error('Export failed', String(error.message));
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  $('exportPngs').addEventListener('click', exportPNGs);

  $('exportGlb').addEventListener('click', async () => {
    const button = $('exportGlb');
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Exporting…';
    try {
      const blob = await exportGLB(viewer);
      download(blob, `${modelName}-edited.glb`);
      toasts.info('Exported GLB', 'Material edits and orientation are baked in.');
    } catch (error) {
      console.error('[3DMViewer] GLB export failed', error);
      toasts.error('GLB export failed', String(error.message));
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });

  // --- lifecycle -----------------------------------------------------------

  return {
    /** Call after every model load. */
    refresh(name = 'model') {
      modelName = name.replace(/\.[^.]+$/, '') || 'model';
      selectedKey = null;
      renderList();
      colorways.attach(modelName);
    },

    colorways,
    exportPNGs,
    get selectedKey() {
      return selectedKey;
    },
  };
}
