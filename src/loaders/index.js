// Format dispatch.
//
// Every loader is dynamically imported, so opening a .glb never downloads the
// FBX parser and vice versa. Each returns the same shape — { object, animations }
// — so the viewer does not care which format it came from.
//
// Changes from the original beyond the bug fixes:
//
//   .usd / .usda / .usdc now load. r186 replaced the old USDZLoader with
//   USDLoader, which parses the binary "crate" format as well as ASCII. The
//   app's own modal used to warn "only usdz (using usda)"; that limitation is
//   gone, it just needed the upgrade.
//
//   STL meshes get MeshStandardMaterial instead of MeshPhongMaterial, so they
//   respond to the PMREM environment like every other format. Phong ignores
//   scene.environment almost entirely, which is why imported STLs used to look
//   flat and plastic next to a glTF.

import { Mesh, MeshStandardMaterial, Group } from 'three';
import { attachDecoders } from './registry.js';
import { extensionOf, basename } from './fs-map.js';

/** Extensions we can open, for the file picker and for error messages. */
export const SUPPORTED_EXTENSIONS = [
  'glb', 'gltf', 'fbx', 'obj', 'stl', 'usdz', 'usda', 'usdc', 'usd',
];

/** Normalise the many shapes of loader progress into a 0..1 fraction or null. */
function fractionOf(event) {
  if (!event || !event.total || !Number.isFinite(event.total)) return null;
  return event.loaded / event.total;
}

async function loadGLTF({ url, manager, renderer, onProgress }) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader(manager);
  await attachDecoders(loader, renderer);

  const gltf = await loader.loadAsync(url, (e) => onProgress(fractionOf(e)));
  return { object: gltf.scene, animations: gltf.animations ?? [] };
}

async function loadFBX({ url, manager, onProgress }) {
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
  const loader = new FBXLoader(manager);
  const object = await loader.loadAsync(url, (e) => onProgress(fractionOf(e)));
  return { object, animations: object.animations ?? [] };
}

async function loadOBJ({ url, manager, files, fs, onProgress }) {
  const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
  const loader = new OBJLoader(manager);

  // OBJLoader does not follow the `mtllib` directive itself — it has to be
  // handed a materials object. Find a .mtl in the drop if there is one; textures
  // it references resolve through the LoadingManager's URL modifier.
  const mtlFile = files?.find((f) => extensionOf(f) === 'mtl');
  if (mtlFile) {
    const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
    const mtlUrl = fs.urlFor(mtlFile.webkitRelativePath || mtlFile.name);
    const materials = await new MTLLoader(manager).loadAsync(mtlUrl);
    materials.preload();
    loader.setMaterials(materials);
  }

  const object = await loader.loadAsync(url, (e) => onProgress(fractionOf(e)));
  return { object, animations: [] };
}

async function loadSTL({ url, manager, onProgress }) {
  const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
  const geometry = await new STLLoader(manager).loadAsync(url, (e) => onProgress(fractionOf(e)));

  // STL carries no material information at all, so this is entirely our choice.
  // Standard rather than Phong: it picks up the environment map.
  const material = new MeshStandardMaterial({
    color: 0xb4b8be,
    metalness: 0.1,
    roughness: 0.55,
  });

  // Most STLs are unsmoothed triangle soup with no normals worth trusting.
  if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();

  const group = new Group();
  group.add(new Mesh(geometry, material));
  return { object: group, animations: [] };
}

async function loadUSD({ url, manager, onProgress }) {
  const { USDLoader } = await import('three/addons/loaders/USDLoader.js');
  const object = await new USDLoader(manager).loadAsync(url, (e) => onProgress(fractionOf(e)));
  return { object, animations: object.animations ?? [] };
}

const HANDLERS = {
  glb: loadGLTF,
  gltf: loadGLTF,
  fbx: loadFBX,
  obj: loadOBJ,
  stl: loadSTL,
  usdz: loadUSD,
  usda: loadUSD,
  usdc: loadUSD,
  usd: loadUSD,
};

/**
 * Load a model.
 *
 * @param {object} options
 * @param {string} options.url          blob: or http(s): URL of the entry file.
 * @param {string} options.extension    Lowercased, no dot.
 * @param {import('three').LoadingManager} [options.manager]
 * @param {import('three').WebGLRenderer} options.renderer
 * @param {File[]} [options.files]      The full drop, for multi-file formats.
 * @param {object} [options.fs]         createFileSystem() result.
 * @param {(fraction:number|null) => void} [options.onProgress]
 * @returns {Promise<{object: import('three').Object3D, animations: Array}>}
 */
export async function loadModel({
  url,
  extension,
  manager,
  renderer,
  files,
  fs,
  onProgress = () => {},
}) {
  const handler = HANDLERS[extension];
  if (!handler) {
    throw new UnsupportedFormatError(extension);
  }
  return handler({ url, manager, renderer, files, fs, onProgress });
}

export class UnsupportedFormatError extends Error {
  constructor(extension) {
    super(
      extension
        ? `.${extension} files are not supported.`
        : 'That file has no extension, so its format could not be determined.',
    );
    this.name = 'UnsupportedFormatError';
    this.extension = extension;
  }
}

export { extensionOf, basename };
