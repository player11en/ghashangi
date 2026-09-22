// Bounds-driven model normalisation and camera framing.
//
// The original code computed a fit factor (`15 / box.getSize().y` for GLB,
// `2 / …` for OBJ) and then never applied it, so every model arrived at raw
// authored scale. A 0.01-unit CAD part was a sub-pixel dot; a 5000-unit scan
// swallowed the camera. Camera near/far were fixed at 0.05/2000 regardless.
//
// The fix has two halves, deliberately kept separate:
//
//   normalizeObject() bakes a fit transform into the loaded object, so "scale
//   slider = 1" means "sensibly sized" for every model, whatever its units.
//   The user's scale and height sliders then drive the *parent* group, so they
//   multiply the fit instead of overwriting it (which is what used to happen).
//
//   frameCamera() positions the camera to contain the result, and derives
//   near/far from the actual bounds so depth precision matches the subject.

import { Box3, Sphere, MathUtils, Vector3 } from 'three';

// Reused across calls; these helpers run on every model load and on every
// frame-to-fit keypress, and there is no reason to allocate each time.
const _box = new Box3();
const _size = new Vector3();
const _center = new Vector3();
const _sphere = new Sphere();
const _dir = new Vector3();

/** The size, in world units, that a normalised model's largest axis becomes. */
export const TARGET_SIZE = 10;

/**
 * Measure an object's world-space bounds.
 *
 * Forces a matrix update first: a freshly loaded glTF has not been rendered
 * yet, so its world matrices are still identity and Box3.setFromObject would
 * measure the wrong thing.
 *
 * @param {import('three').Object3D} object
 * @returns {{box: Box3, size: Vector3, center: Vector3, sphere: Sphere, isEmpty: boolean}}
 */
export function measure(object) {
  object.updateWorldMatrix(true, true);
  _box.setFromObject(object);

  if (_box.isEmpty()) {
    return {
      box: _box.clone(),
      size: new Vector3(),
      center: new Vector3(),
      sphere: new Sphere(new Vector3(), 0),
      isEmpty: true,
    };
  }

  _box.getSize(_size);
  _box.getCenter(_center);
  _box.getBoundingSphere(_sphere);

  return {
    box: _box.clone(),
    size: _size.clone(),
    center: _center.clone(),
    sphere: _sphere.clone(),
    isEmpty: false,
  };
}

/**
 * Centre an object horizontally on the origin and rest its base on y = 0.
 *
 * Resting on the ground rather than centring on the origin is what makes the
 * stage model and the shadow catcher line up without per-model fiddling.
 *
 * Adjusts `object.position`, so whatever rotation or scale it carries is left
 * alone. That is what lets this be re-run: rotating a grounded object swings
 * part of it below the floor, and calling this again settles it back down
 * without disturbing the orientation that caused it.
 *
 * @param {import('three').Object3D} object
 * @returns {{size: Vector3, center: Vector3}|null} null if there is no geometry.
 */
export function groundObject(object) {
  const { center, box, size, isEmpty } = measure(object);
  if (isEmpty) return null;

  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= box.min.y;
  object.updateWorldMatrix(true, true);

  // Re-measure so callers get the settled bounds, not the pre-move ones.
  const settled = measure(object);
  return { size: settled.size, center: settled.center };
}

/**
 * Scale an object so its largest dimension is `targetSize`, then ground it.
 *
 * The transform is written onto `object` itself. Keep user-facing scale and
 * position on the parent group so the two never fight.
 *
 * @param {import('three').Object3D} object
 * @param {{targetSize?: number}} [options]
 * @returns {{scale: number, size: Vector3, originalSize: Vector3}}
 */
export function normalizeObject(object, { targetSize = TARGET_SIZE } = {}) {
  const { size, isEmpty } = measure(object);

  // A model with no renderable geometry (an empty scene graph, a file that
  // parsed but produced nothing) has no meaningful scale. Leave it alone
  // rather than dividing by zero.
  if (isEmpty) {
    return { scale: 1, size: new Vector3(), originalSize: new Vector3() };
  }

  const largest = Math.max(size.x, size.y, size.z);
  const scale = largest > 0 ? targetSize / largest : 1;

  object.scale.multiplyScalar(scale);

  // Ground after scaling rather than scaling the old numbers: the object may
  // have had a non-identity transform of its own before we touched it.
  const settled = groundObject(object);

  return { scale, size: settled?.size ?? size, originalSize: size };
}

/**
 * Move the camera so `object` fills the view, and point the controls at it.
 *
 * Fits the bounding *sphere*, not the box, so the framing does not change as
 * the model spins — a box fit visibly breathes during auto-rotate.
 *
 * @param {import('three').PerspectiveCamera} camera
 * @param {object|null} controls        OrbitControls, or null
 * @param {import('three').Object3D} object
 * @param {object} [options]
 * @param {number} [options.fitRatio=1.25]  >1 leaves margin around the subject.
 * @param {boolean} [options.keepDirection=true]  Preserve the current viewing
 *   angle and only change distance. False resets to a default three-quarter view.
 */
export function frameCamera(camera, controls, object, options = {}) {
  const { fitRatio = 1.25, keepDirection = true, direction = null } = options;
  const { sphere, isEmpty } = measure(object);
  if (isEmpty) return;

  const radius = Math.max(sphere.radius, 1e-4);

  // Fit against whichever axis is tighter. With a portrait phone viewport the
  // horizontal field of view is much narrower than the vertical one, and
  // fitting only the vertical fov clips the model off the sides.
  const vFov = MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const distance = (radius * fitRatio) / Math.sin(Math.min(vFov, hFov) / 2);

  if (direction) {
    // An explicit view direction (the saved-view buttons). Takes precedence
    // over keepDirection, which exists for "refit without moving the camera",
    // and reuses the distance, near/far and controls-limit maths below rather
    // than each caller working out its own camera position.
    _dir.copy(direction);
    if (_dir.lengthSq() < 1e-8) _dir.set(0.6, 0.45, 1);
    _dir.normalize();
  } else if (keepDirection) {
    _dir.subVectors(camera.position, sphere.center);
    // A camera sitting exactly on the target has no direction to preserve.
    if (_dir.lengthSq() < 1e-8) _dir.set(0.6, 0.45, 1);
    _dir.normalize();
  } else {
    _dir.set(0.6, 0.45, 1).normalize();
  }

  camera.position.copy(sphere.center).addScaledVector(_dir, distance);

  // Depth range tight enough to keep z-buffer precision useful, loose enough
  // that the user can zoom in and pull back without clipping. The old fixed
  // 0.05/2000 range wasted almost all of the depth buffer.
  camera.near = Math.max(distance - radius * 4, radius / 1000);
  camera.far = distance + radius * 20;
  camera.updateProjectionMatrix();

  if (controls) {
    controls.target.copy(sphere.center);
    // Let the user get close without entering the model, and stop them flying
    // so far out that it becomes a speck.
    controls.minDistance = radius * 0.2;
    controls.maxDistance = distance * 8;
    controls.update();
  }

  camera.lookAt(sphere.center);
}

/**
 * Fit a directional light's shadow camera to the subject.
 *
 * The old code hardcoded a ±10 orthographic box with near 0.1 / far 30. Any
 * model outside that box had its shadow silently clipped, and any model much
 * smaller than it wasted nearly all of the shadow map's resolution on empty
 * space — which is why the shadows looked soft and blocky at the same time.
 *
 * @param {import('three').DirectionalLight} light
 * @param {import('three').Object3D} object
 * @param {{margin?: number}} [options]
 */
export function fitShadowCamera(light, object, { margin = 1.2 } = {}) {
  const { sphere, isEmpty } = measure(object);
  if (isEmpty || !light.shadow) return;

  const radius = Math.max(sphere.radius, 1e-4) * margin;
  const cam = light.shadow.camera;

  cam.left = -radius;
  cam.right = radius;
  cam.top = radius;
  cam.bottom = -radius;

  const lightDistance = light.position.distanceTo(sphere.center);
  cam.near = Math.max(lightDistance - radius * 2, 0.01);
  cam.far = lightDistance + radius * 2;
  cam.updateProjectionMatrix();

  light.target.position.copy(sphere.center);
  light.target.updateMatrixWorld();

  // Static scene: render the shadow map on demand rather than every frame.
  light.shadow.needsUpdate = true;
}
