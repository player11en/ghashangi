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
  AnimationMixer,
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

  let mixer = null;
  let autoRotate = false;
  let autoRotateSpeed = 0.3; // radians/second

  const loop = createRenderLoop({
    renderer,
    update(delta) {
      // update() returns true when it actually moved the camera, which is what
      // lets damping settle without pinning the loop to 60fps forever.
      if (controls.update(delta)) loop.invalidate();

      if (mixer) {
        mixer.update(delta);
        // An animated model's shadow is stale the moment it moves.
        lights.requestShadowUpdate();
      }

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

    refreshBounds();
    applyUserTransform();

    if (frame) frameCamera(camera, controls, modelRoot, { keepDirection: false });

    const clips = animations.length ? animations : (object.animations ?? []);
    if (clips.length > 0) {
      mixer = new AnimationMixer(object);
      mixer.clipAction(clips[0]).play();
      loop.hold('animation');
    }

    // A couple of frames so textures finishing their decode land on screen.
    loop.invalidate(3);
    return { bounds: currentBounds, normalized, clips };
  }

  /** Remove and fully dispose the current subject. */
  function clearModel() {
    if (mixer) {
      mixer.stopAllAction();
      mixer.uncacheRoot(mixer.getRoot());
      mixer = null;
      loop.release('animation');
    }
    if (current) {
      // The environment texture is assigned to materials as envMap by three; it
      // belongs to environment.js and must outlive the model.
      disposeObject(current, { protect: [environment.environmentTexture] });
      current = null;
      currentBounds = null;
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
    get mixer() {
      return mixer;
    },

    /** World-space bounds of any object in the scene. Used by tests and the HUD. */
    measure,

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
