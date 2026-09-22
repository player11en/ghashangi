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
  Vector3,
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
import { createPostProcessing } from './post.js';
import { detectCapabilityTier } from './capability.js';
import { simplifyToTriangleBudget, DEFAULT_TRIANGLE_BUDGET } from './simplify.js';
import { markMaterialsTouched } from './telemetry.js';
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

  // Needs the renderer to exist (maxTextureSize is only known once WebGL
  // context creation has actually queried the GPU), and needs to happen before
  // createLightRig() below, since the tier picks the starting shadow map size.
  const capability = detectCapabilityTier(renderer);

  // Start at the tier's own default rather than always 1 -> applyQualityTier():
  // avoids a low-end device briefly constructing at full resolution and a
  // 2048 shadow map before main.js's startup call downscales it.
  //
  // 'medium' getting a mild reduction (not just 'low') was added after a
  // real device exposed the gap: a touchscreen laptop with a genuine but
  // modest discrete GPU (an NVIDIA Max-Q part, not an integrated chip -
  // confirmed via chrome://gpu, ruling out the usual "browser picked the
  // wrong GPU" cause) lands in 'medium' under the touch heuristic, and at
  // a 2x-scaled display MAX_PIXEL_RATIO's cap of 2 still means every Style
  // pass runs at native 2x pixel density with zero default headroom.
  // 'medium' previously got exactly the same resolutionScale as 'high' -
  // this is the actual, previously-missing distinction between them.
  let resolutionScale = capability.tier === 'low' ? 0.75 : capability.tier === 'medium' ? 0.85 : 1;

  function applySize() {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO) * resolutionScale;

    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    // The composer keeps its own render targets, which have to track the
    // canvas or the image stretches.
    post?.setSize(width, height);

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

  // Closure over `loop`, declared just below — safe because this is only
  // called from a setter in response to user interaction, by which point
  // `loop` is assigned. Same pattern `post` uses for the same reason.
  const lights = createLightRig(scene, {
    invalidate: (f) => loop.invalidate(f),
    shadowMapSize: capability.tier === 'low' ? 1024 : 2048,
  });

  // --- render loop ---------------------------------------------------------

  // Owns the EffectComposer once any effect is switched on. Declared here
  // because the render loop's callback references it and it needs the loop's
  // invalidate — see the assignment immediately after createRenderLoop.
  let post = null;

  // A single per-frame hook, run at the end of update(). One slot rather than
  // a listener list: it exists for exclusive takeovers like turntable
  // recording, and two of those at once would fight over the same rotation.
  let beforeRender = null;

  let animation = null;
  let autoRotate = false;
  let autoRotateSpeed = 0.3; // radians/second

  // Notified whenever the clip list changes, so the UI can rebuild.
  let onAnimationChange = () => {};
  // Notified each frame while playing, so a scrubber can follow the playhead.
  let animationTick = () => {};
  // Notified after every material-affecting change, for material-undo.js to
  // record - see afterMaterialChange() below, the single chokepoint every
  // material edit/reset/colourway-apply already goes through.
  let onMaterialChange = () => {};

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

      // Last, so a hook can override anything above it. Used by turntable
      // recording to drive rotation from elapsed time: the rotation the
      // recorder captures is then always the rotation that was drawn.
      beforeRender?.(delta);
    },
    render() {
      // post is assigned just below; it needs the loop's invalidate, and the
      // loop needs its render. With no effects enabled post.render() falls
      // straight through to renderer.render(), so this is not an extra layer
      // in the common case.
      if (post) post.render();
      else renderer.render(scene, camera);
    },
  });

  post = createPostProcessing({
    renderer,
    scene,
    camera,
    invalidate: (frames) => loop.invalidate(frames),
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

  // Dense-model triangle budget (Track 1.5.3). Enabled by default - a model
  // already under budget is left completely untouched by simplifyToTriangleBudget,
  // so this only ever does anything for the genuinely dense case it exists for.
  let simplificationEnabled = true;
  let simplificationBudget = DEFAULT_TRIANGLE_BUDGET;
  // Populated on every load; read by the stats HUD for the "original vs
  // simplified" readout. null before the first model finishes loading.
  let simplificationResult = null;

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
    // The single chokepoint every material-affecting call already goes
    // through (manual edits, resets, colourway apply) - one place to log
    // "materials were touched this session" rather than one call per control.
    markMaterialsTouched();
    onMaterialChange();
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
    // AO radius is a fraction of the subject, not a fixed world distance.
    post?.setSubject(currentBounds);
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
   * @param {() => void} [options.onSimplifyStart]  Forwarded to
   *   simplifyToTriangleBudget() - called only if the model actually exceeds
   *   the triangle budget, so a caller can surface the (main-thread-
   *   blocking) reduction work as "still working" rather than a freeze.
   * @returns {Promise<{bounds: object, normalized: object, clips: Array}>}
   */
  async function setModel(object, { animations = [], frame = true, onSimplifyStart } = {}) {
    clearModel();

    const normalized = normalizeObject(object);

    object.traverse((node) => {
      if (!node.isMesh) return;
      node.castShadow = true;
      node.receiveShadow = true;
    });

    // Before the object joins the scene graph: nothing has rendered it yet,
    // so replacing geometry here can't produce a visible pop from full detail
    // down to simplified. A model already under budget comes back untouched.
    simplificationResult = simplificationEnabled
      ? await simplifyToTriangleBudget(object, simplificationBudget, { onStart: onSimplifyStart })
      : null;

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

  // The stage's appearance is a user setting, not a property of Stage.glb, so
  // it is held here and re-applied on every install - otherwise loading a new
  // model would quietly reset the backdrop to the file's authored white while
  // the panel still showed the chosen colour.
  // These mirror Stage.glb's own authored material (#e7e7e7, roughness 0.5 -
  // read off the loaded asset, not guessed), and index.html carries the same
  // two values as its control defaults.
  //
  // That agreement is load-bearing rather than cosmetic. A "preserve whatever
  // the asset authored unless the user touches it" flag was tried first and
  // does not work here: settings.js restores a field by assigning its value and
  // dispatching a real 'input' event, which is indistinguishable from someone
  // moving the slider - so both load() and reset() counted as explicit intent
  // and permanently stamped this app's guesses over the authored material.
  // Caught by a reset test asserting the image returns to baseline exactly.
  //
  // Declaring one set of defaults that happens to equal the authored values
  // removes the divergence instead of trying to detect it: startup, reset and a
  // restored session all land on the same image.
  let stageColor = '#e7e7e7';
  let stageRoughness = 0.5;

  function applyStageAppearance() {
    const stage = stageRoot.children[0];
    if (!stage) return;
    stage.traverse((node) => {
      if (!node.isMesh) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (!material) continue;
        material.color?.set(stageColor);
        if (material.roughness !== undefined) material.roughness = stageRoughness;
      }
    });
    lights.requestShadowUpdate();
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
    applyStageAppearance();
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
   * The largest `scale` captureScreenshot() can actually honour on this
   * device, before either dimension of the requested render target would
   * exceed what the GPU can allocate.
   *
   * `renderer.capabilities.maxTextureSize` is a real number three already
   * queried from WebGL at startup (GL_MAX_TEXTURE_SIZE), not a guess — this
   * replaces what used to be a flat `Math.min(ratio, 8)`, which had no
   * relationship to the device it was running on: too generous on a phone GPU
   * with a 4096 limit, needlessly stingy on a desktop GPU that could do 16384.
   *
   * @returns {number}
   */
  function maxScreenshotScale() {
    const maxTextureSize = renderer.capabilities.maxTextureSize;
    const ratio = renderer.getPixelRatio();
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    return Math.max(1, Math.min(maxTextureSize / (width * ratio), maxTextureSize / (height * ratio)));
  }

  /**
   * Capture the current view.
   *
   * Renders and copies in one synchronous task, which is what makes this work
   * without preserveDrawingBuffer: the drawing buffer is still intact until the
   * task yields. The original relied on the same trick but raced against its own
   * second render loop.
   *
   * `scale` is silently clamped to `maxScreenshotScale()` if it would exceed
   * the device's real texture-size limit — silent here because this is the
   * defensive floor, not the user-facing decision; a caller that wants to warn
   * before hitting this should check `maxScreenshotScale()` itself first (see
   * the Screenshot button and colourway export in main.js).
   *
   * @param {{scale?: number, transparent?: boolean}} [options]
   * @returns {Promise<Blob>}
   */
  function captureScreenshot({ scale = 1, transparent = false } = {}) {
    const width = container.clientWidth;
    const height = container.clientHeight;

    const previousBackground = scene.background;
    const previousStageVisible = stageRoot.visible;
    const previousRatio = renderer.getPixelRatio();
    const clampedScale = Math.min(scale, maxScreenshotScale());

    if (transparent) {
      scene.background = null;
      // scene.background alone only clears the sky — Stage.glb is an opaque
      // cyclorama that fills essentially the whole frame behind the subject,
      // so with it visible (the default) a "transparent" capture measured 0%
      // transparent pixels: correct clearing of a background nothing was
      // covering. The shadow catcher is deliberately left alone — its
      // ShadowMaterial is already semi-transparent, so it contributes a soft
      // contact shadow into the alpha channel, which is the wanted look for a
      // product cutout, not a bug to route around.
      stageRoot.visible = false;
    }
    if (clampedScale !== 1) {
      renderer.setPixelRatio(previousRatio * clampedScale);
    }

    // Through the same path as the viewport, so a screenshot carries the same
    // ambient occlusion and antialiasing the user is looking at.
    if (post) post.render();
    else renderer.render(scene, camera);

    // Copy out of the WebGL canvas immediately, before restoring anything.
    const out = document.createElement('canvas');
    out.width = renderer.domElement.width;
    out.height = renderer.domElement.height;
    out.getContext('2d').drawImage(renderer.domElement, 0, 0);

    if (transparent) {
      scene.background = previousBackground;
      stageRoot.visible = previousStageVisible;
    }
    if (clampedScale !== 1) renderer.setPixelRatio(previousRatio);
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

    /** Ambient occlusion and antialiasing. See core/post.js. */
    get post() {
      return post;
    },

    /**
     * Recompute size from the container right now, synchronously - rather
     * than waiting for the ResizeObserver to notice. Found necessary for
     * Track 4.6's aspect-ratio lock: measured the ResizeObserver path taking
     * longer than 300ms to actually resize the canvas in roughly 2 of every
     * 3 runs under headless Chromium + SwiftShader, which would silently
     * record a clip's first frames at the wrong dimensions. A caller that
     * changes the container's size and needs the canvas to match before
     * doing anything else (starting a recording, capturing a screenshot)
     * should call this immediately after, instead of assuming the observer
     * has already fired.
     */
    resize() {
      applySize();
    },

    /**
     * Install a per-frame hook, or pass null to remove it. Runs last in the
     * loop's update, so it can override auto-rotate. Exclusive: setting one
     * replaces any previous hook.
     */
    onBeforeRender(callback) {
      beforeRender = callback ?? null;
    },

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

    /** Called after every material-affecting change. See material-undo.js. */
    onMaterialChange(callback) {
      onMaterialChange = callback ?? (() => {});
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

    /**
     * Result of the current model's load-time simplification pass, or null
     * before any model has loaded: `{ original, simplified, applied }`
     * triangle counts, `applied` false when the model was already under
     * budget (the common case) or simplification is turned off.
     */
    get simplification() {
      return simplificationResult;
    },
    /** Takes effect on the next model loaded, not retroactively - the
     * pre-simplification geometry of the current model is already disposed. */
    setSimplificationEnabled(enabled) {
      simplificationEnabled = enabled;
    },
    setSimplificationBudget(triangles) {
      simplificationBudget = triangles;
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
    maxScreenshotScale,
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

    /** The device tier detected at construction — 'low' | 'medium' | 'high'. */
    get detectedTier() {
      return capability.tier;
    },
    get tierSignals() {
      return capability.signals;
    },

    /**
     * Apply a quality tier: resolution scale and shadow map resolution always;
     * AO/AA are only ever forced *off* on 'low', as a performance ceiling —
     * switching to 'medium'/'high' never auto-enables them, since that's a
     * separate, already-independent choice (the AO/AA checkboxes). Matches how
     * every other control in this app works: an explicit user choice, once
     * made and persisted by settings.js, stands until the user changes it —
     * this just picks the starting default for someone who never has.
     *
     * @param {'low'|'medium'|'high'} tier
     */
    applyQualityTier(tier) {
      resolutionScale = tier === 'low' ? 0.75 : tier === 'medium' ? 0.85 : 1;
      applySize();
      lights.setShadowMapSize(tier === 'low' ? 1024 : 2048);
      if (tier === 'low') {
        post.setAO(false);
        post.setAA(false);
        post.setDof(false);
        // Same rule extended to Track 4's Style stack: four more full-screen
        // passes on top of GTAO+SMAA is real cost, and a device that just had
        // AO/AA forced off for performance shouldn't have Style effects
        // default on and undo that. Only ever forces off, same as above -
        // never auto-enables on medium/high, and a user's explicit choice via
        // settings.js still wins once made.
        post.setBloom(false);
        post.setGlitch(false);
        post.setCrt(false);
        post.setPixelate(false);
        post.setLut(false);
        post.setPalette(false);
        post.setColorGrade(false);
        post.setTone(false);
        post.setRepeat(false);
        post.setDisplace(false);
        post.setAfterimage(false);
        post.setAscii(false);
        post.setHalftone(false);
        post.setFilm(false);
      }
    },
    setStageVisible(visible) {
      stageRoot.visible = visible;
      loop.invalidate();
    },
    setStageColor(hex) {
      stageColor = hex;
      applyStageAppearance();
      loop.invalidate(2);
    },
    setStageRoughness(value) {
      stageRoughness = value;
      applyStageAppearance();
      loop.invalidate(2);
    },
    isStageVisible() {
      return stageRoot.visible;
    },

    /**
   * Jump to a named view of the subject, framed the same way frame() does.
   *
   * Top is (0, 1, 0.001) rather than straight up on purpose: a view direction
   * exactly parallel to the camera's up vector is degenerate - lookAt() has no
   * unique solution and the orientation snaps unpredictably. The fraction is
   * far too small to see and removes the ambiguity.
   */
    setView(name) {
      if (!current) return;
      const directions = {
        front: [0, 0, 1],
        threeQuarter: [0.6, 0.45, 1],
        side: [1, 0, 0],
        top: [0, 1, 0.001],
        back: [0, 0, -1],
      };
      const d = directions[name];
      if (!d) return;
      frameCamera(camera, controls, modelRoot, {
        keepDirection: false,
        direction: new Vector3(d[0], d[1], d[2]),
      });
      loop.invalidate(2);
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
      // Was missing: the composer owns a read/write render-target pair, and
      // every Style/fidelity pass owns more on top of that (Bloom's whole mip
      // chain, GTAO's, SMAA's, Afterimage's accumulation buffer). None of it
      // is reachable from renderer.dispose(), so tearing the viewer down
      // without this leaked all of it. Latent rather than active today -
      // nothing in this app disposes the viewer - but an incomplete teardown
      // path is exactly the kind of thing that only bites once something
      // (an embed, a test harness, HMR) finally does.
      post?.dispose();
      controls.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}

export { MAX_PIXEL_RATIO };
