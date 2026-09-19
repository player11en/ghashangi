// Recursive GPU-resource disposal.
//
// The previous version of this app dropped models with scene.remove(model) and
// nothing else, so every geometry, material and texture stayed resident for the
// lifetime of the tab. Loading a handful of models in a row leaked all of their
// VRAM. three does not do this for you: remove() only unparents.

/**
 * Whether a material property holds something that needs disposing.
 * Covers .map, .normalMap, .envMap, .aoMap, … without having to enumerate the
 * full and version-dependent list of texture slots by hand.
 */
function isDisposableTexture(value) {
  return Boolean(value && value.isTexture && typeof value.dispose === 'function');
}

/**
 * Dispose one material and every texture it references.
 *
 * @param {import('three').Material} material
 * @param {Set<object>} seen      Shared across the walk so a texture reused by
 *                                several materials is disposed exactly once.
 * @param {Set<object>} protected_ Resources owned by someone else (the
 *                                environment map, a shared UV-checker) that
 *                                must survive the model being unloaded.
 * @param {{materials:number, textures:number}} counts
 */
function disposeMaterial(material, seen, protected_, counts) {
  if (!material || seen.has(material) || protected_.has(material)) return;
  seen.add(material);

  for (const value of Object.values(material)) {
    if (!isDisposableTexture(value)) continue;
    if (seen.has(value) || protected_.has(value)) continue;
    seen.add(value);
    value.dispose();
    counts.textures++;
  }

  material.dispose();
  counts.materials++;
}

/**
 * Dispose everything under `root`, then unparent it.
 *
 * Safe to call with null, and safe to call twice on the same object.
 *
 * @param {import('three').Object3D|null} root
 * @param {{protect?: Iterable<object>}} [options]
 *   protect — resources the caller owns and wants to keep alive, typically the
 *   PMREM environment texture, which is assigned to material.envMap by three
 *   when scene.environment is set and would otherwise be disposed here.
 * @returns {{geometries:number, materials:number, textures:number}}
 */
export function disposeObject(root, { protect = [] } = {}) {
  const counts = { geometries: 0, materials: 0, textures: 0 };
  if (!root) return counts;

  const seen = new Set();
  const protected_ = new Set(protect);

  root.traverse((node) => {
    if (node.geometry && !seen.has(node.geometry)) {
      seen.add(node.geometry);
      node.geometry.dispose();
      counts.geometries++;
    }

    const { material } = node;
    if (Array.isArray(material)) {
      for (const m of material) disposeMaterial(m, seen, protected_, counts);
    } else if (material) {
      disposeMaterial(material, seen, protected_, counts);
    }

    // SkinnedMesh holds a Skeleton with its own bone texture.
    if (node.skeleton && typeof node.skeleton.dispose === 'function') {
      node.skeleton.dispose();
    }
  });

  root.removeFromParent();
  return counts;
}

/**
 * Object URLs created for dropped files and downloaded blobs. The old code
 * created one per load and never revoked any, so the underlying blobs were
 * pinned in memory for the life of the document.
 */
const liveObjectUrls = new Set();

/** Create a tracked object URL. */
export function trackObjectUrl(blobOrFile) {
  const url = URL.createObjectURL(blobOrFile);
  liveObjectUrls.add(url);
  return url;
}

/** Revoke one tracked object URL. */
export function revokeObjectUrl(url) {
  if (!url || !liveObjectUrls.has(url)) return;
  URL.revokeObjectURL(url);
  liveObjectUrls.delete(url);
}

/** Revoke every tracked object URL — called when swapping models. */
export function revokeAllObjectUrls() {
  for (const url of liveObjectUrls) URL.revokeObjectURL(url);
  liveObjectUrls.clear();
}
