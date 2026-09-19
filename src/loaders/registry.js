// Compressed-glTF decoders, attached lazily.
//
// B18: the original registered no DRACO, KTX2 or Meshopt support at all. Since
// those three cover essentially every web-optimised glTF in circulation, the
// most common kind of file people would try to open was also the kind
// guaranteed to fail — with `console.log('An error happened')` as the only
// symptom.
//
// On decoder hosting: r186's DRACOLoader and KTX2Loader locate their own wasm
// with `new URL('../libs/…', import.meta.url)`, which Vite statically resolves
// and emits as a hashed asset. So the decoders are served from our own origin,
// content-hashed and immutably cacheable, with nothing to stage or configure —
// and calling setDecoderPath()/setTranscoderPath() with a directory would
// *replace* those correct URLs with worse hand-maintained ones. Neither is
// called. (This is a change since r154, where hosting the decoders yourself was
// the only option.)
//
// DRACO_GLTF_CONFIG is passed deliberately: it selects the glTF-only Draco build
// and, because it is an object rather than a path, sets the loader's `dep_js` to
// null — skipping a 719KB pure-JS decoder fallback that is only reachable on
// browsers without WebAssembly, which cannot run this app anyway.
//
// The decoders total ~900KB, so they are dynamically imported on first use. A
// visit that only opens uncompressed models never pays for them.

let dracoLoader = null;
let ktx2Loader = null;
let meshoptDecoder = null;

async function getDracoLoader() {
  if (dracoLoader) return dracoLoader;
  const { DRACOLoader, DRACO_GLTF_CONFIG } = await import('three/addons/loaders/DRACOLoader.js');
  dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(DRACO_GLTF_CONFIG);
  // No preload(): the wasm is fetched on the first actual Draco decode rather
  // than on every glTF load, compressed or not.
  return dracoLoader;
}

/**
 * @param {import('three').WebGLRenderer} renderer Needed for detectSupport(),
 *   which queries which GPU texture compression formats are available so the
 *   transcoder targets the right one (ASTC, BC7, ETC2, …).
 */
async function getKTX2Loader(renderer) {
  if (ktx2Loader) return ktx2Loader;
  const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
  ktx2Loader = new KTX2Loader();
  ktx2Loader.detectSupport(renderer);
  return ktx2Loader;
}

async function getMeshoptDecoder() {
  if (meshoptDecoder) return meshoptDecoder;
  const module = await import('three/addons/libs/meshopt_decoder.module.js');
  meshoptDecoder = module.MeshoptDecoder;
  await meshoptDecoder.ready;
  return meshoptDecoder;
}

/**
 * Attach all three decoders to a GLTFLoader.
 *
 * Attaching is cheap — three only instantiates a decoder when a file actually
 * declares the matching extension.
 *
 * @param {import('three/addons/loaders/GLTFLoader.js').GLTFLoader} loader
 * @param {import('three').WebGLRenderer} renderer
 */
export async function attachDecoders(loader, renderer) {
  const [draco, ktx2, meshopt] = await Promise.all([
    getDracoLoader(),
    getKTX2Loader(renderer),
    getMeshoptDecoder(),
  ]);

  loader.setDRACOLoader(draco);
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(meshopt);
  return loader;
}

/** Release decoder worker pools. */
export function disposeDecoders() {
  dracoLoader?.dispose();
  ktx2Loader?.dispose();
  dracoLoader = null;
  ktx2Loader = null;
  meshoptDecoder = null;
}
