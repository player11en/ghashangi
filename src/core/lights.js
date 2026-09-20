// The light rig behind the six sliders.
//
// Two bugs lived here.
//
// B3: the rig uses two RectAreaLights ("Left Light" / "Right Light"), but
// RectAreaLight is the one three light type that needs a lookup table uploaded
// before it shades correctly, via RectAreaLightUniformsLib.init(). That call was
// missing, so both of those sliders moved a number that never reached the image.
// Two of the six lighting controls were simply dead.
//
// B4: the shadow-catcher plane was added with `model.add(plane)` from *inside*
// `model.traverse()`, so it was added once per descendant node, and it parented
// to the model — meaning the scale and height sliders dragged the ground plane
// around with the subject. It belongs to the scene, once.
//
// Light *positions* are also now derived from the subject's bounds. The old rig
// hardcoded y=5..6 and a radius of 6, which was tuned for one particular model
// at its authored scale; with models normalised to a consistent size, the rig
// has to scale with them or the lights end up inside the geometry.
//
// Bug found in review (2026-09-21): every setter here mutated a light and
// returned, with no way to tell the render loop a redraw was needed. Under
// on-demand rendering (0fps at rest by design) that meant a light slider only
// "took" once something else invalidated the loop — in practice, orbiting the
// camera. requestShadowUpdate() looked like it covered setSun/setAngle, but it
// only sets shadow.needsUpdate, a flag for the *next* render, not a request for
// one to happen. createLightRig now takes an `invalidate` callback, the same
// pattern environment.js and post.js already use, and every setter calls it.

import {
  AmbientLight,
  DirectionalLight,
  RectAreaLight,
  Mesh,
  PlaneGeometry,
  ShadowMaterial,
  MathUtils,
  Object3D,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { fitShadowCamera, TARGET_SIZE } from './frame.js';

// Defaults carried over from the original HTML slider values, so the rig looks
// like the app people already know.
export const LIGHT_DEFAULTS = {
  ambient: 0.3,
  sun: 1.8,
  left: 4.5,
  right: 2.1,
  exposure: 0.6,
  angle: 53, // degrees, drives the sun's position around the subject
};

// RectAreaLightUniformsLib.init() uploads a shared BRDF lookup table. Doing it
// more than once is wasteful, and doing it not at all is B3.
let uniformsLibReady = false;
function ensureRectAreaLightUniforms() {
  if (uniformsLibReady) return;
  RectAreaLightUniformsLib.init();
  uniformsLibReady = true;
}

/**
 * Build the light rig and add it to the scene.
 *
 * @param {import('three').Scene} scene
 * @param {object} [options]
 * @param {(frames?: number) => void} [options.invalidate]  Ask the render loop
 *   for a redraw. Every setter calls this itself now; nothing external needs to.
 * @param {object} [options]
 * @param {(frames?: number) => void} [options.invalidate]
 * @param {number} [options.shadowMapSize=2048]  Starting resolution — 2048
 *   rather than the old 1024, since the shadow camera is now fitted to the
 *   subject instead of a fixed +/-10 box, so the extra resolution is actually
 *   spent on the model. Track 1.5's capability tier picks a smaller starting
 *   value on constrained devices; `setShadowMapSize()` below changes it later.
 * @returns {object} handles and setters.
 */
export function createLightRig(scene, { invalidate = () => {}, shadowMapSize = 2048 } = {}) {
  ensureRectAreaLightUniforms();

  // Nominal radius the rig is designed at. fitTo() rescales from here.
  let rigRadius = TARGET_SIZE * 0.75;

  const ambient = new AmbientLight(0xffffff, LIGHT_DEFAULTS.ambient);
  scene.add(ambient);

  const sun = new DirectionalLight(0xffffff, LIGHT_DEFAULTS.sun);
  sun.castShadow = true;
  sun.shadow.mapSize.width = shadowMapSize;
  sun.shadow.mapSize.height = shadowMapSize;
  // normalBias is the right tool for shadow acne on curved surfaces; the old
  // code used only a constant bias of -0.001, which trades acne for peter-
  // panning. A small constant bias on top handles flat coplanar cases.
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  // Static scene: the shadow map is re-rendered only when something asks for
  // it (see requestShadowUpdate), not on every frame.
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  scene.add(sun);

  // DirectionalLight aims at its .target, which must be in the scene graph for
  // its world matrix to update.
  const sunTarget = new Object3D();
  scene.add(sunTarget);
  sun.target = sunTarget;

  const left = new RectAreaLight(0xb2b2ff, LIGHT_DEFAULTS.left, 5, 5);
  scene.add(left);

  const right = new RectAreaLight(0xff9898, LIGHT_DEFAULTS.right, 6, 6);
  scene.add(right);

  // Ground plane that catches shadows without being visible itself. Hidden by
  // default because Stage.glb normally plays that role; AR turns it on, since
  // there is no stage in a passthrough scene.
  const shadowCatcher = new Mesh(
    new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new ShadowMaterial({ opacity: 0.5 }),
  );
  shadowCatcher.receiveShadow = true;
  shadowCatcher.visible = false;
  // It never moves relative to the scene, so it does not need a per-frame
  // matrix recompute.
  shadowCatcher.matrixAutoUpdate = false;
  scene.add(shadowCatcher);

  let angle = LIGHT_DEFAULTS.angle;

  /** Place the sun on a circle around the subject at `angle` degrees. */
  function applySunPosition() {
    const rad = MathUtils.degToRad(angle);
    sun.position.set(
      rigRadius * Math.cos(rad),
      rigRadius * 0.85,
      rigRadius * Math.sin(rad),
    );
  }

  /** Place the two fill lights relative to the rig radius. */
  function applyFillPositions() {
    left.position.set(-rigRadius * 0.5, rigRadius, rigRadius * 0.17);
    left.width = rigRadius * 0.85;
    left.height = rigRadius * 0.85;
    left.lookAt(0, rigRadius * 0.25, 0);

    right.position.set(rigRadius * 0.67, rigRadius, rigRadius * 0.33);
    right.width = rigRadius;
    right.height = rigRadius;
    right.lookAt(0, rigRadius * 0.25, 0);
  }

  applySunPosition();
  applyFillPositions();

  /**
   * Rescale and re-aim the rig for a newly loaded subject, and fit the shadow
   * camera and ground plane to it.
   *
   * @param {import('three').Object3D} object
   * @param {{radius:number, center:import('three').Vector3}} bounds
   */
  function fitTo(object, bounds) {
    rigRadius = Math.max(bounds.radius * 1.5, 0.5);
    applySunPosition();
    applyFillPositions();

    // Ground plane just larger than the subject's footprint.
    const span = Math.max(bounds.radius * 6, 1);
    shadowCatcher.scale.set(span, 1, span);
    shadowCatcher.position.set(bounds.center.x, 0, bounds.center.z);
    shadowCatcher.updateMatrix();

    fitShadowCamera(sun, object);
  }

  /** Re-render the shadow map on the next frame. */
  function requestShadowUpdate() {
    sun.shadow.needsUpdate = true;
  }

  /**
   * Change the shadow map's resolution, e.g. when the Quality control changes.
   *
   * `LightShadow.dispose()` frees the GPU render target but deliberately does
   * not null out `.map` itself (checked in three's own source) — that null is
   * what tells `WebGLShadowMap` to allocate a fresh one at the new
   * `mapSize` on the next shadow pass, so it has to be done here explicitly.
   */
  function setShadowMapSize(size) {
    if (sun.shadow.mapSize.width === size) return;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.dispose();
    sun.shadow.map = null;
    requestShadowUpdate();
    invalidate(2);
  }

  return {
    ambient,
    sun,
    left,
    right,
    shadowCatcher,
    fitTo,
    requestShadowUpdate,
    setShadowMapSize,

    setAmbient(v) {
      ambient.intensity = v;
      invalidate();
    },
    setSun(v) {
      sun.intensity = v;
      requestShadowUpdate();
      invalidate(2);
    },
    setLeft(v) {
      left.intensity = v;
      invalidate();
    },
    setRight(v) {
      right.intensity = v;
      invalidate();
    },
    setAngle(degrees) {
      angle = degrees;
      applySunPosition();
      requestShadowUpdate();
      invalidate(2);
    },
    getAngle() {
      return angle;
    },
    setShadowCatcherVisible(visible) {
      shadowCatcher.visible = visible;
      invalidate();
    },
  };
}
