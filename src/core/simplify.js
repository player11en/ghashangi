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
//
// Skinned meshes are deliberately excluded from reduction. Checked directly
// against the installed SimplifyModifier's source: it does copy every
// attribute a geometry has - including skinIndex/skinWeight - onto the
// simplified result, so nothing is silently dropped. But the edge-collapse
// error metric it uses only scores position/normal/uv, with no awareness of
// skin-weight boundaries, so it can merge vertices across a joint boundary a
// skeleton-aware simplifier would leave alone - the usual symptom is visible
// pinching or tearing at joints on an animated character. Skeleton-aware
// simplification is a separate, much bigger piece of work; leaving skinned
// meshes untouched is the correct conservative default until that exists.
//
// The reduction itself is also a synchronous WASM call under the hood -
// `modify()` is only `async` for the one-time `MeshoptSimplifier.ready`
// wait, not because the simplification work itself yields. A multi-million-
// triangle mesh can genuinely block the main thread for a couple of seconds;
// `onStart` below exists so a caller can at least surface that as "working",
// not a silent freeze, via the existing loading-progress UI. Moving this to
// a worker is the real fix if that turns out not to be enough - not done
// here, since nothing so far has needed it.

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
 * Simplify every non-skinned mesh in `object` proportionally so the model's
 * total triangle count lands at or under `budget`, if it currently exceeds
 * it. Skinned meshes are counted but never reduced (see file header) - if
 * skinned geometry alone already exceeds the budget, this becomes a
 * best-effort reduction of everything else rather than a guaranteed cap.
 *
 * Applied once at load time, not live: simplifying an already-simplified
 * geometry repeatedly would just keep eroding it further on every re-run.
 * A model that already fits the budget is returned completely untouched -
 * no clone, no wasted work.
 *
 * @param {import('three').Object3D} object
 * @param {number} [budget]
 * @param {object} [options]
 * @param {() => void} [options.onStart]  Called once, only if simplification
 *   is actually about to run - lets a caller flip loading UI into an
 *   indeterminate "working" state right before the blocking part starts.
 * @returns {Promise<{original: number, simplified: number, applied: boolean, skinnedExcluded: boolean}>}
 */
export async function simplifyToTriangleBudget(object, budget = DEFAULT_TRIANGLE_BUDGET, { onStart } = {}) {
  const reducibleMeshes = [];
  let skinnedTris = 0;
  let reducibleTris = 0;

  object.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    const tris = meshTriangleCount(node.geometry);
    if (node.isSkinnedMesh) {
      skinnedTris += tris;
    } else {
      reducibleMeshes.push(node);
      reducibleTris += tris;
    }
  });

  const original = skinnedTris + reducibleTris;

  if (original <= budget) {
    const rounded = Math.round(original);
    return { original: rounded, simplified: rounded, applied: false, skinnedExcluded: false };
  }

  onStart?.();

  // One ratio, applied to every reducible mesh's own vertex count - a model
  // with one dense hero mesh and several simple trim pieces gets reduced
  // proportionally, rather than the trim pieces taking the same hit as the
  // hero mesh they're attached to. Floored at 5% of the reducible total so a
  // model dominated by skinned geometry still gets *some* reduction on its
  // non-skinned parts, rather than none, when skinned tris alone blow the
  // budget.
  const targetReducible = Math.max(budget - skinnedTris, reducibleTris * 0.05);
  const ratio = reducibleTris > 0 ? Math.min(1, targetReducible / reducibleTris) : 1;

  let reducedTris = 0;

  for (const node of reducibleMeshes) {
    const geometry = node.geometry;
    const position = geometry.attributes.position;
    const targetVertexCount = Math.max(3, Math.floor(position.count * ratio));
    const removeVertices = position.count - targetVertexCount;

    if (removeVertices <= 0) {
      reducedTris += meshTriangleCount(geometry);
      continue;
    }

    try {
      const result = await modifier.modify(geometry, removeVertices);
      geometry.dispose();
      node.geometry = result;
      reducedTris += meshTriangleCount(result);
    } catch (error) {
      // A degenerate or already-minimal mesh the simplifier can't reduce
      // further - keep it as it is rather than losing the mesh entirely.
      console.warn('[3DMViewer] simplification skipped for one mesh', error);
      reducedTris += meshTriangleCount(geometry);
    }
  }

  return {
    original: Math.round(original),
    simplified: Math.round(skinnedTris + reducedTris),
    applied: true,
    skinnedExcluded: skinnedTris > 0,
  };
}
