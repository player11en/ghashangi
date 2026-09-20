// Post-processing: ambient occlusion and antialiasing.
//
// Ambient occlusion is the single biggest thing separating this app's output
// from a real-time studio renderer like Marmoset Toolbag. Without contact
// darkening in seams and crevices, a product reads as pasted onto the backdrop
// rather than sitting on it. Lighting and materials were never the gap.
//
// GTAO rather than SSAOPass or SAOPass: it is the ground-truth-based method and
// the best looking of the three in three.js, with far less haloing on curved
// surfaces — which is exactly the geometry a product viewer deals with.
//
// Everything here ships with three r186. No new dependency.
//
// ---------------------------------------------------------------------------
// Why this is lazy, and why there is a passthrough
//
// Introducing EffectComposer replaces `renderer.render(scene, camera)` as the
// output path, and three things depend on that call: the on-demand render loop,
// tone mapping, and transparent screenshots. So:
//
//   * With every effect off, render() calls renderer.render() directly. The
//     zero-effect path is byte-for-byte what the app did before this module
//     existed, which keeps the fallback honest and gives weak GPUs an out.
//
//   * The composer and its passes are only built on first use, so a visit that
//     never enables AO never pays for the passes or their render targets.
//
// ---------------------------------------------------------------------------
// Tone mapping: no special handling needed, and here is the proof
//
// The first version of this module assumed rendering the scene into
// EffectComposer's off-screen buffers (via RenderPass) would double up with
// OutputPass's own tone mapping, and "fixed" it by forcing
// renderer.toneMapping to NoToneMapping for the whole composer.render() call.
// That shipped broken — caught on test/render.mjs's first real run ("tone
// mapping still changes the image with AO on" failed outright), because it
// also blinded OutputPass, which reads that same property.
//
// The actual mechanism, found in three's own source
// (src/renderers/webgl/WebGLPrograms.js, getParameters()):
//
//   toneMapping = material.toneMapped && currentRenderTarget === null
//     ? renderer.toneMapping : NoToneMapping;
//
// A standard material only gets tone-mapped when it is rendered straight to
// the canvas (`currentRenderTarget === null`). RenderPass renders the scene
// into an off-screen WebGLRenderTarget — so every material in the scene is
// structurally guaranteed NoToneMapping there, regardless of what
// renderer.toneMapping is set to, with no help from this module needed.
// OutputPass is the one pass that writes to the real canvas, and separately,
// explicitly reads renderer.toneMapping itself to choose its curve. The two
// can never fight: leave renderer.toneMapping at whatever environment.js set,
// unmodified, for the whole call, and each pass does the right thing on its
// own by construction.

import { Vector2 } from 'three';

/** Passes are imported on first enable, not at module load. */
let modules = null;

async function loadModules() {
  if (modules) return modules;
  const [{ EffectComposer }, { RenderPass }, { GTAOPass }, { SMAAPass }, { OutputPass }] =
    await Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/GTAOPass.js'),
      import('three/addons/postprocessing/SMAAPass.js'),
      import('three/addons/postprocessing/OutputPass.js'),
    ]);
  modules = { EffectComposer, RenderPass, GTAOPass, SMAAPass, OutputPass };
  return modules;
}

/**
 * @param {object} options
 * @param {import('three').WebGLRenderer} options.renderer
 * @param {import('three').Scene} options.scene
 * @param {import('three').PerspectiveCamera} options.camera
 * @param {() => void} options.invalidate  Ask the render loop for a redraw.
 */
export function createPostProcessing({ renderer, scene, camera, invalidate }) {
  let composer = null;
  let gtaoPass = null;
  let smaaPass = null;

  let aoEnabled = false;
  let aaEnabled = false;
  let aoIntensity = 1;
  // Fraction of the subject's radius. A fixed world-space radius would be
  // wrong for the same reason the original's fixed ±10 shadow box was wrong:
  // models are normalised to a consistent size, but that size is arbitrary.
  let aoRadiusFactor = 0.25;
  let subjectRadius = 5;

  // renderer.getSize() calls target.set(), so it needs a real Vector2 — a plain
  // {x, y} throws.
  const _size = new Vector2();

  function currentSize() {
    renderer.getSize(_size);
    return _size;
  }

  /** True when any effect wants the composer. */
  function active() {
    return aoEnabled || aaEnabled;
  }

  async function build(width, height) {
    const { EffectComposer, RenderPass, GTAOPass, SMAAPass, OutputPass } = await loadModules();
    if (composer) return;

    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    gtaoPass = new GTAOPass(scene, camera, width, height);
    gtaoPass.enabled = aoEnabled;
    composer.addPass(gtaoPass);

    smaaPass = new SMAAPass();
    smaaPass.enabled = aaEnabled;
    composer.addPass(smaaPass);

    // Must be last: it performs tone mapping and the sRGB conversion that the
    // renderer would otherwise do on its own. Reads renderer.toneMapping
    // itself, unmodified by anything above it — see the file header.
    composer.addPass(new OutputPass());

    applyAO();
    composer.setSize(width, height);
    composer.setPixelRatio(renderer.getPixelRatio());
  }

  function applyAO() {
    if (!gtaoPass) return;
    gtaoPass.enabled = aoEnabled;
    gtaoPass.blendIntensity = aoIntensity;
    gtaoPass.updateGtaoMaterial({
      radius: Math.max(subjectRadius * aoRadiusFactor, 0.01),
      // Softer falloff reads better on product geometry than the default's
      // harder contact line.
      distanceExponent: 1,
      thickness: 1,
      scale: 1,
    });
  }

  return {
    /** Whether the composer is currently in the output path. */
    get active() {
      return active();
    },

    async setAO(enabled) {
      aoEnabled = enabled;
      if (enabled && !composer) {
        const size = currentSize();
        await build(size.x, size.y);
      }
      applyAO();
      invalidate(2);
    },

    async setAA(enabled) {
      aaEnabled = enabled;
      if (enabled && !composer) {
        const size = currentSize();
        await build(size.x, size.y);
      }
      if (smaaPass) smaaPass.enabled = enabled;
      invalidate(2);
    },

    setAOIntensity(value) {
      aoIntensity = value;
      applyAO();
      invalidate(2);
    },

    setAORadius(factor) {
      aoRadiusFactor = factor;
      applyAO();
      invalidate(2);
    },

    /**
     * Scope AO to the subject. Called from refreshBounds() in viewer.js, since
     * a model normalised to 10 units needs a different world-space AO radius
     * than one left at 0.01.
     */
    setSubject(bounds) {
      if (!bounds) return;
      subjectRadius = Math.max(bounds.radius, 0.01);
      applyAO();
    },

    setSize(width, height) {
      if (!composer) return;
      composer.setSize(width, height);
      composer.setPixelRatio(renderer.getPixelRatio());
      gtaoPass?.setSize(width, height);
    },

    /**
     * The render call handed to the loop and to captureScreenshot().
     *
     * Deliberately does not touch renderer.toneMapping — see the file header
     * for why nothing here needs to.
     */
    render() {
      if (active() && composer) composer.render();
      else renderer.render(scene, camera);
    },

    dispose() {
      composer?.dispose();
      gtaoPass?.dispose?.();
      smaaPass?.dispose?.();
      composer = null;
      gtaoPass = null;
      smaaPass = null;
    },
  };
}
