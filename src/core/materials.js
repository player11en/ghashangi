// Per-material editing.
//
// The point of this module is recolouring a product model: a sneaker with a
// body, a trim, a sole and laces should be recolourable per part, not tinted
// as one lump.
//
// The key fact that makes it work on *textured* models: three multiplies
// `material.color` into the base colour texture rather than replacing it —
// `map_fragment.glsl.js` is literally `diffuseColor *= sampledDiffuseColor`.
// That is also exactly what glTF's `baseColorFactor` means. So setting a colour
// on a textured material tints it, preserving every bit of shading, wear and
// detail in the map. A `blend` amount between the authored colour and the
// chosen one gives a continuous dial from "as authored" to "fully tinted",
// which is the behaviour Unity's material colour field has.
//
// Authored values are snapshotted before the first edit so any change is
// reversible. Precedent for this in the codebase: `setSideMode()` in viewer.js
// stashes `userData.authoredSide` the same way.

import { Color } from 'three';

/** Channels we offer, and how to read/write each one. */
const CHANNELS = ['metalness', 'roughness', 'emissiveIntensity', 'opacity'];

/** Extra channels that only exist on MeshPhysicalMaterial. */
const PHYSICAL_CHANNELS = ['clearcoat', 'clearcoatRoughness', 'iridescence', 'sheen', 'transmission'];

/**
 * Stable identity for a material across reloads of the same file.
 *
 * Deliberately not `uuid`: three regenerates uuids on every parse, so a
 * uuid-keyed colourway could never be re-applied after a reload. Name plus
 * ordinal survives, and the ordinal disambiguates the very common case of
 * several materials sharing a name (or having none at all).
 */
export function materialKey(material, index) {
  return `${material.name || 'material'}#${index}`;
}

/** Take a snapshot of everything we can edit, once. */
function snapshot(material) {
  if (material.userData.originalValues) return material.userData.originalValues;

  const original = {
    color: material.color ? material.color.clone() : null,
    emissive: material.emissive ? material.emissive.clone() : null,
    transparent: material.transparent,
  };

  for (const channel of [...CHANNELS, ...PHYSICAL_CHANNELS]) {
    if (channel in material) original[channel] = material[channel];
  }

  material.userData.originalValues = original;
  return original;
}

/**
 * Find every unique material on a model.
 *
 * Deduplicates by material instance: a material shared by twelve meshes is one
 * entry that edits all twelve, which is what someone recolouring "the sole"
 * expects.
 *
 * @param {import('three').Object3D|null} root
 * @returns {Array<{
 *   key: string, name: string, material: import('three').Material,
 *   meshCount: number, hasMap: boolean, channels: string[]
 * }>}
 */
export function collectMaterials(root) {
  if (!root) return [];

  const byMaterial = new Map();

  root.traverse((node) => {
    const material = node.material;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) {
      if (!m) continue;
      const found = byMaterial.get(m);
      if (found) found.meshCount++;
      else byMaterial.set(m, { material: m, meshCount: 1 });
    }
  });

  return [...byMaterial.values()].map(({ material, meshCount }, index) => {
    snapshot(material);
    return {
      key: materialKey(material, index),
      // Unnamed materials are common in exports; give them something clickable.
      name: material.name || `Material ${index + 1}`,
      material,
      meshCount,
      hasMap: Boolean(material.map),
      // Only offer channels the material actually has, so the panel matches the
      // asset instead of showing dead sliders.
      channels: [...CHANNELS, ...PHYSICAL_CHANNELS].filter((c) => c in material),
    };
  });
}

/** Current editable state of a material, for the UI and for saving a colourway. */
export function readMaterial(material) {
  const original = snapshot(material);
  const state = {
    color: material.color ? `#${material.color.getHexString()}` : null,
    emissive: material.emissive ? `#${material.emissive.getHexString()}` : null,
    blend: material.userData.colorBlend ?? 1,
    targetColor:
      material.userData.targetColor ??
      (material.color ? `#${material.color.getHexString()}` : null),
  };
  for (const channel of [...CHANNELS, ...PHYSICAL_CHANNELS]) {
    if (channel in material) state[channel] = material[channel];
  }
  state.original = original;
  return state;
}

const _target = new Color();

/**
 * Set a material's base colour, mixed against its authored colour.
 *
 * @param {import('three').Material} material
 * @param {string|number} color  The colour to move towards.
 * @param {number} [blend=1]     0 = authored colour, 1 = fully the new colour.
 */
export function setBaseColor(material, color, blend = 1) {
  if (!material.color) return;
  const original = snapshot(material);

  // Remember the intent, not just the result: reading back a 40%-blended colour
  // and re-blending it would drift towards the original on every edit.
  material.userData.targetColor = typeof color === 'string' ? color : `#${new Color(color).getHexString()}`;
  material.userData.colorBlend = blend;

  _target.set(color);
  material.color.copy(original.color ?? _target).lerp(_target, blend);
  material.needsUpdate = true;
}

/**
 * Set a numeric channel (metalness, roughness, opacity, …).
 *
 * @returns {boolean} false if the material has no such channel.
 */
export function setChannel(material, channel, value) {
  if (!(channel in material)) return false;
  material[channel] = value;

  // Opacity below 1 does nothing unless the material is in the transparent
  // queue. Only force it on when needed, and hand it back when the user
  // returns to fully opaque — blanket `transparent = true` on everything is the
  // bug this codebase already removed once (see viewer.js header).
  if (channel === 'opacity') {
    const original = snapshot(material);
    material.transparent = value < 1 ? true : original.transparent;
  }

  material.needsUpdate = true;
  return true;
}

/** Set the emissive colour. */
export function setEmissive(material, color) {
  if (!material.emissive) return;
  snapshot(material);
  material.emissive.set(color);
  material.needsUpdate = true;
}

/** Restore one material to the values it was authored with. */
export function resetMaterial(material) {
  const original = material.userData.originalValues;
  if (!original) return;

  if (original.color && material.color) material.color.copy(original.color);
  if (original.emissive && material.emissive) material.emissive.copy(original.emissive);
  material.transparent = original.transparent;

  for (const channel of [...CHANNELS, ...PHYSICAL_CHANNELS]) {
    if (channel in original && channel in material) material[channel] = original[channel];
  }

  delete material.userData.targetColor;
  delete material.userData.colorBlend;
  material.needsUpdate = true;
}

/** Restore every material on a model. */
export function resetAll(entries) {
  for (const { material } of entries) resetMaterial(material);
}

/**
 * Capture every material's current editable state, keyed for replay.
 * This is what a colourway stores.
 */
export function captureState(entries) {
  const out = {};
  for (const { key, material } of entries) {
    const state = {};
    if (material.color) {
      state.targetColor = material.userData.targetColor ?? `#${material.color.getHexString()}`;
      state.blend = material.userData.colorBlend ?? 1;
    }
    if (material.emissive) state.emissive = `#${material.emissive.getHexString()}`;
    for (const channel of [...CHANNELS, ...PHYSICAL_CHANNELS]) {
      if (channel in material) state[channel] = material[channel];
    }
    out[key] = state;
  }
  return out;
}

/**
 * Re-apply a captured state.
 *
 * Entries missing from the state are left alone rather than reset, so a
 * colourway saved against an earlier version of a model still applies what it
 * can instead of failing outright.
 *
 * @returns {{applied: number, missing: string[]}}
 */
export function applyState(entries, state) {
  let applied = 0;
  const missing = [];

  for (const { key, material } of entries) {
    const entry = state?.[key];
    if (!entry) {
      missing.push(key);
      continue;
    }

    if (entry.targetColor && material.color) {
      setBaseColor(material, entry.targetColor, entry.blend ?? 1);
    }
    if (entry.emissive && material.emissive) setEmissive(material, entry.emissive);
    for (const channel of [...CHANNELS, ...PHYSICAL_CHANNELS]) {
      if (entry[channel] !== undefined) setChannel(material, channel, entry[channel]);
    }
    applied++;
  }

  return { applied, missing };
}
