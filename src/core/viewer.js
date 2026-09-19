// Renderer, scene, camera, controls, and the model slot.
//
// Fixes gathered here:
//
// B1  The shadow-catcher plane was a `const` local to init(), but render() and
//     the XR sessionend handler both referenced a bare `plane` identifier that
//     was never declared anywhere. Entering AR threw a ReferenceError and took
//     the render loop with it. It is now a named object with an owner.
// B2  Handled by render-loop.js: one animation loop, registered once.
// B9  Models are disposed on replacement (dispose.js), not just unparented.
// B10 setPixelRatio(window.devicePixelRatio) was uncapped. On a DPR-3 phone
//     that is nine times the fragments of DPR-1, with soft shadows on top.
// B12 `document.getElementById('canvas')` returned null — no such element ever
//     existed in index.html. The viewer now owns its canvas, and resizes from a
//     ResizeObserver on its container rather than a window resize listener.
//
// Also deliberately *not* carried over from the original:
//
//   material.transparent = true was set on every mesh of every loaded GLB. That
//   forces opaque geometry into the transparent queue, disables depth writes and
//   produces sorting artefacts on anything non-convex. It was masking a
//   different problem and is simply wrong.
//
//   material.side = FrontSide was forced on every mesh. GLTFLoader already sets
//   side from the asset's doubleSided flag, so overriding it broke every
//   correctly authored single-sided-geometry model (foliage, cloth, decals).
//   Authored values are now respected, with an explicit override available.

import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  Group,
  SRGBColorSpace,
  PCFShadowMap,
  DoubleSide,
  FrontSide,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createRenderLoop } from './render-loop.js';
import { createLightRig } from './lights.js';
import { createEnvironment } from './environment.js';
import { disposeObject } from './dispose.js';
import { measure, normalizeObject, frameCamera } from './frame.js';
import { createOrientation } from './orientation.js';
import { createAnimation } from './animation.js';
import {
  collectMaterials,
  setBaseColor,
  setChannel,
  setEmissive,
  resetMaterial,
  resetAll,
  captureState,
  applyState,
} from './materials.js';

/** Upper bound on device pixel ratio. Above 2 the cost is real and the gain is not. */
const MAX_PIXEL_RATIO = 2;

/**
 * @param {object} options
 * @param {HTMLElement} options.container  Element the canvas fills.
 */
export function createViewer({ container }) {
  // --- renderer ------------------------------------------------------------

  const canvas = document.createElement('canvas');
  canvas.className = 'viewer-canvas';
  container.appendChild(canvas);

  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    // Screenshots render and read back inside a single synchronous task, so the
    // drawing buffer does not need preserving across frames — which would cost
    // a full-frame copy every frame.
    preserveDrawingBuffer: false,
    alpha: true,
    powerPreference: 'high-performance',
  });

  renderer.outputColorSpace = SRGBColorSpace;
  // PCF rather than the old VSMShadowMap with blurSamples: 8. VSM is expensive
  // and light-bleeds, and at the 1024 map the original used it was the reason
  // shadows looked soft and blocky at the same time.
  //
  // Note PCFShadowMap, not PCFSoftShadowMap: r186 removed the latter's
  // implementation. The constant still exists, but WebGLShadowMap warns and
  // silently downgrades to PCFShadowMap, so asking for it is misleading.
  // Softness now comes from the fitted shadow camera plus the 2048 map set in
  // lights.js, which is where the resolution actually goes to work.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  let resolutionScale = 1;

  function applySize() {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO) * resolutionScale;

    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    loop.invalidate();
  }

  // --- scene ---------------------------------------------------------------

  const scene = new Scene();

  const camera = new PerspectiveCamera(50, 1, 0.05, 2000);
  camera.position.set(0, 5, 50);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.rotateSpeed = 0.5;
  controls.zoomSpeed = 2;
  controls.target.set(0, 0.5, 0);

  // Three nested transforms, each owned by exactly one thing, so none of them
  // can overwrite another:
  //
  //   modelRoot    user scale + height, and the auto-rotate spin
  //     orientRoot user X/Y/Z orientation, re-grounded after each change
  //       object   the normalisation scale baked in by frame.js
  //
  // The original collapsed all of this onto the loaded object, which is why the
  // scale slider wrote straight over the (unused) computed fit. Auto-rotate
  // still spins modelRoot.rotation.y, so orientation needs its own group or the
  // spin would overwrite it every frame.
  const modelRoot = new Group();
  modelRoot.name = 'modelRoot';
  scene.add(modelRoot);

  const orientRoot = new Group();
  orientRoot.name = 'orientRoot';
  modelRoot.add(orientRoot);

  const stageRoot = new Group();
  stageRoot.name = 'stageRoot';
  scene.add(stageRoot);

  const lights = createLightRig(scene);

  // --- render loop ---------------------------------------------------------

  let animation = null;
  let autoRotate = false;
  let autoRotateSpeed = 0.3; // radians/second

  // Notified whenever the clip list changes, so the UI can rebuild.
  let onAnimationChange = () => {};
  // Notified each frame while playing, so a scrubber can follow the playhead.
  let animationTick = () => {};

  const loop = createRenderLoop({
    renderer,
    update(delta) {
      // update() returns true when it actually moved the camera, which is what
      // lets damping settle without pinning the loop to 60fps forever.
      if (controls.update(delta)) loop.invalidate();

      // animation.update() advances only while playing, and marks the shadow
      // map dirty itself — an animated model's shadow is stale the moment it
      // moves.
      animation?.update(delta);

      if (autoRotate) {
        modelRoot.rotation.y += autoRotateSpeed * delta;
        lights.requestShadowUpdate();
      }
    },
    render() {
      renderer.render(scene, camera);
    },
  });

  const environment = createEnvironment({
    scene,
    renderer,
    invalidate: () => loop.invalidate(),
  });

  // Lit on the very first frame, before any HDR has been fetched.
  environment.useRoomEnvironment();
  environment.setExposure(0.6);
  environment.setToneMapping('agx');

  controls.addEventListener('change', () => loop.invalidate());

  // A ResizeObserver catches container changes a window resize listener misses:
  // a side panel opening, the mobile browser's URL bar collapsing, CSS layout
  // settling after fonts load.
  const resizeObserver = new ResizeObserver(() => applySize());
  resizeObserver.observe(container);
  applySize();

  // --- model slot ----------------------------------------------------------

  let current = null; // the loaded object currently inside modelRoot
  let currentBounds = null;
  let userScale = 1;
  let userHeight = 0;

  // collectMaterials walks the whole graph, and the UI reads the list on every
  // selection change, so cache it and drop the cache when the model changes.
  let materialCache = null;
  let statsCache = null;

  /**
   * Count what the model actually contains.
   *
   * Deliberately not `renderer.info.render.triangles`: that reports what the
   * last frame drew, which under frustum culling and on-demand rendering is not
   * the model's size. Reading it as "triangles" overstated Duck.glb as 28,962
   * against a real 4,212 — it was also counting the stage and shadow passes.
   *
   * renderer.info is still right for draw calls, which genuinely are a
   * per-frame property.
   */
  function computeModelStats() {
    const stats = { triangles: 0, vertices: 0, meshes: 0, materials: 0 };
    if (!current) return stats;

    const geometries = new Set();
    const materials = new Set();

    current.traverse((node) => {
      if (!node.isMesh && !node.isPoints && !node.isLine) return;
      stats.meshes++;

      for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
        if (m) materials.add(m);
      }

      const geometry = node.geometry;
      // Count shared geometry once for vertices, but every instance's triangles,
      // since an instance really is that much on screen.
      const position = geometry?.attributes?.position;
      if (!position) return;

      if (!geometries.has(geometry)) {
        geometries.add(geometry);
        stats.vertices += position.count;
      }
      if (node.isMesh) {
        stats.triangles += (geometry.index ? geometry.index.count : position.count) / 3;
      }
    });

    stats.triangles = Math.round(stats.triangles);
    stats.materials = materials.size;
    return stats;
  }

  /**
   * After any material edit: redraw, and re-render the shadow map.
   *
   * Opacity and emissive both change what a mesh contributes to the shadow
   * map, and shadows here are rendered on demand (shadow.autoUpdate = false),
   * so without this a material change would leave a stale shadow behind.
   */
  function afterMaterialChange() {
    lights.requestShadowUpdate();
    loop.invalidate(2);
  }

  /** Apply the scale and height sliders on top of the baked normalisation. */
  function applyUserTransform() {
    modelRoot.scale.setScalar(userScale);
    modelRoot.position.y = userHeight;
    lights.requestShadowUpdate();
    loop.invalidate();
  }

  /**
   * Re-measure the subject and refit everything that is sized against it.
   *
   * Called on load and after any orientation change: rotating a model changes
   * its footprint, so the shadow camera and the backdrop both need resizing or
   * the shadow clips and the stage no longer fits.
   */
  function refreshBounds() {
    const m = measure(modelRoot);
    currentBounds = { radius: m.sphere.radius, center: m.sphere.center, size: m.size };
    lights.fitTo(modelRoot, currentBounds);
    fitStage();
    return currentBounds;
  }

  // Orientation lives on its own group so the auto-rotate spin on
  // modelRoot.rotation.y can never overwrite it.
  const orientation = createOrientation({
    target: orientRoot,
    onChange() {
      refreshBounds();
      lights.requestShadowUpdate();
      loop.invalidate(2);
    },
  });

  /**
   * Install a freshly loaded object as the subject.
   *
   * @param {import('three').Object3D} object
   * @param {object} [options]
   * @param {Array<import('three').AnimationClip>} [options.animations]
   * @param {boolean} [options.frame=true]  Reframe the camera onto it.
   * @returns {{bounds: object, normalized: object, clips: Array}}
   */
  function setModel(object, { animations = [], frame = true } = {}) {
    clearModel();

    const normalized = normalizeObject(object);

    object.traverse((node) => {
      if (!node.isMesh) return;
      node.castShadow = true;
      node.receiveShadow = true;
    });

    modelRoot.rotation.set(0, 0, 0);
    // Orientation belongs to the file, not the session: a new model starts in
    // the pose it was authored in rather than inheriting the last one's fix.
    orientation.resetSilently();
    orientRoot.position.set(0, 0, 0);
    orientRoot.add(object);
    current = object;
    materialCache = null;
    statsCache = null;

    refreshBounds();
    applyUserTransform();

    if (frame) frameCamera(camera, controls, modelRoot, { keepDirection: false });

    const clips = animations.length ? animations : (object.animations ?? []);
    if (clips.length > 0) {
      animation = createAnimation({
        root: object,
        clips,
        loop,
        onShadowDirty: () => lights.requestShadowUpdate(),
        onTick: (time, total) => animationTick(time, total),
      });
      // Select the first clip but leave it paused, so a model opens on a
      // readable pose instead of immediately animating. Autoplay is the UI's
      // decision, not this layer's.
      animation.select(0);
    }
    onAnimationChange();

    // A couple of frames so textures finishing their decode land on screen.
    loop.invalidate(3);
    return { bounds: currentBounds, normalized, clips };
  }

  /** Remove and fully dispose the current subject. */
  function clearModel() {
    if (animation) {
      animation.dispose();
      animation = null;
    }
    if (current) {
      // The environment texture is assigned to materials as envMap by three; it
      // belongs to environment.js and must outlive the model.
      disposeObject(current, { protect: [environment.environmentTexture] });
      current = null;
      currentBounds = null;
      materialCache = null;
      statsCache = null;
    }
    loop.invalidate();
  }

  /** Install the decorative stage, scaled to the current subject. */
  function setStage(object) {
    disposeObject(stageRoot.children[0] ?? null, {
      protect: [environment.environmentTexture],
    });
    object.traverse((node) => {
      if (node.isMesh) node.receiveShadow = true;
    });
    stageRoot.add(object);
    fitStage();
    loop.invalidate();
  }

  // Stage.glb is a cyclorama — a curved studio backdrop — not a plinth. It has
  // to *enclose* the subject and the camera, not sit next to them: sized to
  // roughly the subject's own footprint it swallows the model and puts the
  // camera outside looking at its back, which is a featureless white wall.
  //
  // frameCamera() parks the camera at about 3x the subject radius, so the
  // backdrop needs to be comfortably wider than that.
  const STAGE_FOOTPRINT_RATIO = 10;

  function fitStage() {
    const stage = stageRoot.children[0];
    if (!stage || !currentBounds) return;

    // Measure at identity so the ratio is against the authored size, not
    // against whatever scale a previous fit left behind.
    stageRoot.scale.setScalar(1);
    stageRoot.position.set(0, 0, 0);
    const natural = measure(stage);

    const largest = Math.max(natural.size.x, natural.size.z) || 1;
    const target = Math.max(currentBounds.radius * STAGE_FOOTPRINT_RATIO, 1);
    const scale = target / largest;
    stageRoot.scale.setScalar(scale);

    // Rest the backdrop's floor on y = 0, where normalizeObject() puts the
    // subject's base, and centre it under the subject.
    const scaled = measure(stage);
    stageRoot.position.set(
      currentBounds.center.x - scaled.center.x,
      -scaled.box.min.y,
      currentBounds.center.z - scaled.center.z,
    );
  }

  // --- screenshots ---------------------------------------------------------

  /**
   * Capture the current view.
   *
   * Renders and copies in one synchronous task, which is what makes this work
   * without preserveDrawingBuffer: the drawing buffer is still intact until the
   * task yields. The original relied on the same trick but raced against its own
   * second render loop.
   *
   * @param {{scale?: number, transparent?: boolean}} [options]
   * @returns {Promise<Blob>}
   */
  function captureScreenshot({ scale = 1, transparent = false } = {}) {
    const width = container.clientWidth;
    const height = container.clientHeight;

    const previousBackground = scene.background;
    const previousRatio = renderer.getPixelRatio();

    if (transparent) scene.background = null;
    if (scale !== 1) {
      renderer.setPixelRatio(Math.min(previousRatio * scale, 8));
    }

    renderer.render(scene, camera);

    // Copy out of the WebGL canvas immediately, before restoring anything.
    const out = document.createElement('canvas');
    out.width = renderer.domElement.width;
    out.height = renderer.domElement.height;
    out.getContext('2d').drawImage(renderer.domElement, 0, 0);

    if (transparent) scene.background = previousBackground;
    if (scale !== 1) renderer.setPixelRatio(previousRatio);
    renderer.setSize(width, height, false);
    loop.invalidate();

    return new Promise((resolve, reject) => {
      out.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas produced no image data.'));
      }, 'image/png');
    });
  }

  // --- material overrides --------------------------------------------------

  /**
   * Force single- or double-sided rendering, or restore authored values.
   * @param {'authored'|'front'|'double'} mode
   */
  function setSideMode(mode) {
    if (!current) return;
    current.traverse((node) => {
      const material = node.material;
      if (!material) return;
      for (const m of Array.isArray(material) ? material : [material]) {
        if (m.userData.authoredSide === undefined) m.userData.authoredSide = m.side;
        if (mode === 'front') m.side = FrontSide;
        else if (mode === 'double') m.side = DoubleSide;
        else m.side = m.userData.authoredSide;
        m.needsUpdate = true;
      }
    });
    loop.invalidate();
  }

  function setWireframe(enabled) {
    if (!current) return;
    current.traverse((node) => {
      const material = node.material;
      if (!material) return;
      for (const m of Array.isArray(material) ? material : [material]) {
        if ('wireframe' in m) m.wireframe = enabled;
      }
    });
    loop.invalidate();
  }

  function setShadowsEnabled(enabled) {
    renderer.shadowMap.enabled = enabled;
    // Toggling shadowMap.enabled changes every material's compiled program.
    scene.traverse((node) => {
      const material = node.material;
      if (!material) return;
      for (const m of Array.isArray(material) ? material : [material]) {
        m.needsUpdate = true;
      }
    });
    lights.requestShadowUpdate();
    loop.invalidate();
  }

  // --- public surface ------------------------------------------------------

  return {
    renderer,
    scene,
    camera,
    controls,
    canvas,
    modelRoot,
    orientRoot,
    stageRoot,
    lights,
    environment,
    loop,
    orientation,

    get model() {
      return current;
    },
    get bounds() {
      return currentBounds;
    },
    /** Playback controller for the current model, or null if it has no clips. */
    get animation() {
      return animation;
    },

    /** Called when the clip list changes — i.e. on every model load. */
    onAnimationChange(callback) {
      onAnimationChange = callback ?? (() => {});
    },

    /** Called each frame while a clip is playing, so a scrubber can follow. */
    onAnimationTick(callback) {
      animationTick = callback ?? (() => {});
    },

    /** World-space bounds of any object in the scene. Used by tests and the HUD. */
    measure,

    // --- materials ---------------------------------------------------------
    // Cached per load, because collectMaterials walks the whole graph and the
    // UI asks for the list on every selection change.

    /** Unique materials on the current model. */
    get materials() {
      if (!materialCache) materialCache = collectMaterials(current);
      return materialCache;
    },

    /**
     * What the model contains: triangles, vertices, meshes, materials.
     * Derived from geometry, not from the last frame drawn.
     */
    get modelStats() {
      if (!statsCache) statsCache = computeModelStats();
      return statsCache;
    },

    /** Look one up by the stable key from materialKey(). */
    materialByKey(key) {
      return this.materials.find((entry) => entry.key === key) ?? null;
    },

    setMaterialColor(key, color, blend = 1) {
      const entry = this.materialByKey(key);
      if (!entry) return false;
      setBaseColor(entry.material, color, blend);
      afterMaterialChange();
      return true;
    },

    setMaterialChannel(key, channel, value) {
      const entry = this.materialByKey(key);
      if (!entry) return false;
      const ok = setChannel(entry.material, channel, value);
      if (ok) afterMaterialChange();
      return ok;
    },

    setMaterialEmissive(key, color) {
      const entry = this.materialByKey(key);
      if (!entry) return false;
      setEmissive(entry.material, color);
      afterMaterialChange();
      return true;
    },

    resetMaterial(key) {
      const entry = this.materialByKey(key);
      if (!entry) return false;
      resetMaterial(entry.material);
      afterMaterialChange();
      return true;
    },

    resetAllMaterials() {
      resetAll(this.materials);
      afterMaterialChange();
    },

    /** Snapshot every material's state — what a colourway stores. */
    captureMaterialState() {
      return captureState(this.materials);
    },

    /** Re-apply a snapshot. */
    applyMaterialState(state) {
      const result = applyState(this.materials, state);
      afterMaterialChange();
      return result;
    },

    setModel,
    clearModel,
    setStage,
    captureScreenshot,
    setSideMode,
    setWireframe,
    setShadowsEnabled,

    setScale(value) {
      userScale = value;
      applyUserTransform();
    },
    setHeight(value) {
      userHeight = value;
      applyUserTransform();
    },
    setAutoRotate(enabled) {
      autoRotate = enabled;
      if (enabled) loop.hold('autoRotate');
      else loop.release('autoRotate');
    },
    isAutoRotating() {
      return autoRotate;
    },
    setResolutionScale(value) {
      resolutionScale = value;
      applySize();
    },
    setStageVisible(visible) {
      stageRoot.visible = visible;
      loop.invalidate();
    },
    isStageVisible() {
      return stageRoot.visible;
    },

    /** Re-fit the camera to the current subject. */
    frame() {
      if (current) frameCamera(camera, controls, modelRoot, { keepDirection: true });
      loop.invalidate();
    },

    /** Return to the default three-quarter view. */
    resetCamera() {
      if (current) {
        frameCamera(camera, controls, modelRoot, { keepDirection: false });
      } else {
        camera.position.set(0, 5, 50);
        controls.target.set(0, 0.5, 0);
        controls.update();
      }
      loop.invalidate();
    },

    start() {
      loop.start();
    },

    dispose() {
      loop.dispose();
      resizeObserver.disconnect();
      clearModel();
      disposeObject(stageRoot.children[0] ?? null);
      environment.dispose();
      controls.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}

export { MAX_PIXEL_RATIO };
