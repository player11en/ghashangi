// A virtual filesystem for multi-file drops.
//
// B11: the original tried to handle multi-file OBJ by reading every dropped file
// to base64, stuffing the results into three loose variables (`obj`, `mtl`,
// `texture`) and then loading only if *all three* were present:
//
//     if (objData && mtlData && texData) { loadOBJModel([obj, mtl, tex]); }
//
// So obj+mtl with no texture loaded nothing at all, obj alone loaded nothing,
// and a model with four textures loaded whichever one happened to land last.
// The dispatch was worse: loadOBJModel branched on `arg.length <= 3`, where
// `arg` was an Array on one path and a base64 data-URL *string* on the other —
// a string whose length is in the thousands, so single-OBJ fell through to the
// else branch by accident of its length rather than by design.
//
// The right mechanism already exists in three: LoadingManager.setURLModifier.
// Map every dropped file to a blob URL keyed by name, and let the loader resolve
// its own references — `mtllib chair.mtl`, `map_Kd wood.jpg`, a .gltf's
// "buffers": [{"uri": "scene.bin"}] — through that map. Any subset works,
// nothing needs to be enumerated in advance, and .gltf + .bin + textures loads
// for the first time.

import { LoadingManager } from 'three';

/** Strip directories and any query/fragment so lookups are by bare filename. */
function basename(path) {
  return path.split(/[\\/]/).pop().split(/[?#]/)[0];
}

/**
 * Build a LoadingManager that resolves relative references against a set of
 * local files.
 *
 * @param {File[]} files
 * @returns {{
 *   manager: LoadingManager,
 *   urlFor: (name: string) => string|undefined,
 *   names: string[],
 *   dispose: () => void
 * }}
 */
export function createFileSystem(files) {
  const manager = new LoadingManager();

  // Keyed both by bare filename and by the path as dropped, because a folder
  // drop gives webkitRelativePath-style names while the references inside the
  // asset are usually relative to the asset itself.
  const urls = new Map();
  const created = [];

  for (const file of files) {
    const url = URL.createObjectURL(file);
    created.push(url);

    const full = file.webkitRelativePath || file.name;
    urls.set(full, url);
    urls.set(basename(full), url);
    // Case-insensitive fallback: exporters routinely write `Wood.JPG` into the
    // .mtl while the file on disk is `wood.jpg`, and vice versa.
    urls.set(basename(full).toLowerCase(), url);
  }

  manager.setURLModifier((url) => {
    // Already a blob/data URL the loader got from us, or an absolute remote
    // reference the asset genuinely wants fetched. Leave both alone.
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;

    const name = basename(url);
    const hit = urls.get(url) ?? urls.get(name) ?? urls.get(name.toLowerCase());
    if (hit) return hit;

    // Unresolved: hand the original back so the loader reports a real 404
    // against a recognisable name instead of failing opaquely.
    return url;
  });

  return {
    manager,

    urlFor(name) {
      return urls.get(name) ?? urls.get(basename(name)) ?? urls.get(basename(name).toLowerCase());
    },

    names: files.map((f) => f.webkitRelativePath || f.name),

    dispose() {
      for (const url of created) URL.revokeObjectURL(url);
      urls.clear();
      created.length = 0;
    },
  };
}

/** Extensions that can be the root of a scene, as opposed to a dependency. */
const PRIMARY_EXTENSIONS = new Set([
  'glb', 'gltf', 'fbx', 'obj', 'stl', 'usdz', 'usda', 'usdc', 'usd', 'ply', '3mf',
]);

/** File extension, lowercased, without the dot. */
export function extensionOf(file) {
  const name = file.webkitRelativePath || file.name || String(file);
  const parts = basename(name).split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

/**
 * Pick the file to hand the loader out of a multi-file drop.
 *
 * Everything else in the set stays reachable through the LoadingManager, so this
 * only has to identify the entry point.
 *
 * @param {File[]} files
 * @returns {{primary: File, extension: string}|null}
 */
export function pickPrimary(files) {
  const candidates = files
    .map((file) => ({ file, extension: extensionOf(file) }))
    .filter(({ extension }) => PRIMARY_EXTENSIONS.has(extension));

  if (candidates.length === 0) return null;

  // Prefer a self-contained container over a set that needs siblings, so a drop
  // containing both a .glb and a loose .obj opens the .glb.
  const priority = ['glb', 'usdz', 'gltf', 'fbx', 'obj', 'stl', 'usdc', 'usda', 'usd', 'ply', '3mf'];
  candidates.sort(
    (a, b) => priority.indexOf(a.extension) - priority.indexOf(b.extension),
  );

  return { primary: candidates[0].file, extension: candidates[0].extension };
}

export { basename };
