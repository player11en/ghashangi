// Model orientation: up-axis correction and free rotation per axis.
//
// glTF, and three, are Y-up. Most of the rest of the 3D world is not: CAD
// packages, Blender and 3ds Max are Z-up, so their exports arrive lying on
// their back with no way to stand them up. That was simply unfixable in this
// app before — nothing anywhere touched model rotation.
//
// Two things make this less trivial than setting `rotation.x`.
//
// First, grounding. frame.js rests a model's base on y = 0 so it sits on the
// stage. Rotate it 90 degrees afterwards and half of it swings below the floor.
// Every orientation change therefore has to re-ground, which is why
// groundObject() was split out of normalizeObject().
//
// Second, auto-rotate already owns a rotation channel: viewer.js spins
// `modelRoot.rotation.y` every frame. A user Y-rotation written to the same
// object would be overwritten continuously, and the two would accumulate into
// each other. Orientation therefore lives on its own group between modelRoot
// and the model, so spin and orientation never touch the same Euler.

import { MathUtils } from 'three';
import { groundObject } from './frame.js';

/**
 * Up-axis presets, as the X rotation needed to bring that axis to Y.
 *
 * Z-up is far and away the common case — it is what Blender, 3ds Max, most CAD
 * kernels and most .stl files in the wild use.
 */
export const UP_AXIS_PRESETS = {
  y: { label: 'Y', euler: [0, 0, 0] },
  z: { label: 'Z', euler: [-90, 0, 0] },
  x: { label: 'X', euler: [0, 0, 90] },
};

/**
 * Drive the orientation of a single group.
 *
 * @param {object} options
 * @param {import('three').Object3D} options.target  The group to rotate.
 * @param {() => void} options.onChange  Called after every change, once the
 *   object has been re-grounded. Refit lights/stage and invalidate here.
 */
export function createOrientation({ target, onChange }) {
  // Degrees, because that is what the UI speaks and what a person reasoning
  // about "turn it a quarter turn" thinks in. Converted on apply.
  const angles = { x: 0, y: 0, z: 0 };
  let preset = 'y';

  function apply() {
    target.rotation.set(
      MathUtils.degToRad(angles.x),
      MathUtils.degToRad(angles.y),
      MathUtils.degToRad(angles.z),
    );
    // Settle it back onto the floor after the rotation moved it off.
    groundObject(target);
    onChange();
  }

  /** Normalise to (-180, 180] so the sliders and readout stay in range. */
  function wrap(degrees) {
    let value = degrees % 360;
    if (value > 180) value -= 360;
    if (value <= -180) value += 360;
    return value;
  }

  return {
    get angles() {
      return { ...angles };
    },

    get preset() {
      return preset;
    },

    /** Set one axis to an absolute angle in degrees. */
    setAxis(axis, degrees) {
      if (!(axis in angles)) return;
      angles[axis] = wrap(degrees);
      preset = 'custom';
      apply();
    },

    /** Turn one axis by a relative amount — the ±90° snap buttons. */
    nudge(axis, degrees) {
      if (!(axis in angles)) return;
      angles[axis] = wrap(angles[axis] + degrees);
      preset = 'custom';
      apply();
    },

    /**
     * Apply an up-axis preset. One click, and the overwhelmingly common
     * "it loaded on its side" case is fixed.
     */
    setUpAxis(name) {
      const found = UP_AXIS_PRESETS[name];
      if (!found) return false;
      const [x, y, z] = found.euler;
      angles.x = x;
      angles.y = y;
      angles.z = z;
      preset = name;
      apply();
      return true;
    },

    /** Back to the pose the file was authored in. */
    reset() {
      angles.x = 0;
      angles.y = 0;
      angles.z = 0;
      preset = 'y';
      apply();
    },

    /**
     * Re-apply the current angles to a newly loaded model without treating it
     * as a user change. Orientation is a property of the *file*, not of the
     * session, so loading a new model starts it fresh.
     */
    resetSilently() {
      angles.x = 0;
      angles.y = 0;
      angles.z = 0;
      preset = 'y';
      target.rotation.set(0, 0, 0);
    },
  };
}
