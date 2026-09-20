// Dense-model triangle budget.
//
// "Would DLSS help with big, dense models?" No real DLSS is reachable from a
// browser (see the plan's 1.5.3 for why), and it wouldn't help this case
// anyway - DLSS upscales pixels, never vertices. The actual fix for a dense
// model is fewer triangles. three r186's SimplifyModifier is built directly
// on meshoptimizer (the same WASM library registry.js already loads for
// Draco/Meshopt decoding, so this is not a new dependency) rather than the
// older manual edge-collapse implementation - async, geometry in, geometry
// out.

import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';

// Chosen as "large enough that a real product/character model never hits it,
// small enough that a raw photogrammetry/CAD dump reliably does" - a starting
// default, not a hard limit; the Model group's own control can change it.
export const DEFAULT_TRIANGLE_BUDGET = 500_000;

const modifier = new SimplifyModifier();

/** A mesh's own triangle count - not deduplicated by shared geometry, since
 * every instance really does cost that many triangles on screen. */
function meshTriangleCount(geometry) {
  const position = geometry.attributes.position;
  if (!position) return 0;
  const index = geometry.index;
  return (index ? index.count : position.count) / 3;
}

/**
 * Simplify every mesh in `object` proportionally so the model's total
 * triangle count lands at or under `budget`, if it currently exceeds it.
 *
 * Applied once at load time, not live: simplifying an already-simplified
 * geometry repeatedly would just keep eroding it further on every re-run.
 * A model that already fits the budget is returned completely untouched -
 * no clone, no wasted work.
 *
 * @param {import('three').Object3D} object
 * @param {number} [budget]
 * @returns {Promise<{original: number, simplified: number, applied: boolean}>}
 */
export async function simplifyToTriangleBudget(object, budget = DEFAULT_TRIANGLE_BUDGET) {
  const meshes = [];
  let original = 0;
  object.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    meshes.push(node);
    original += meshTriangleCount(node.geometry);
  });

  if (original <= budget) {
    const rounded = Math.round(original);
    return { original: rounded, simplified: rounded, applied: false };
  }

  // One ratio, applied to every mesh's own vertex count - a model with one
  // dense hero mesh and several simple trim pieces gets reduced
  // proportionally, rather than the trim pieces taking the same hit as the
  // hero mesh they're attached to.
  const ratio = budget / original;
  let simplified = 0;

  for (const node of meshes) {
    const geometry = node.geometry;
    const position = geometry.attributes.position;
    const targetVertexCount = Math.max(3, Math.floor(position.count * ratio));
    const removeVertices = position.count - targetVertexCount;

    if (removeVertices <= 0) {
      simplified += meshTriangleCount(geometry);
      continue;
    }

    try {
      const result = await modifier.modify(geometry, removeVertices);
      geometry.dispose();
      node.geometry = result;
      simplified += meshTriangleCount(result);
    } catch (error) {
      // A degenerate or already-minimal mesh the simplifier can't reduce
      // further - keep it as it is rather than losing the mesh entirely.
      console.warn('[3DMViewer] simplification skipped for one mesh', error);
      simplified += meshTriangleCount(geometry);
    }
  }

  return { original: Math.round(original), simplified: Math.round(simplified), applied: true };
}
