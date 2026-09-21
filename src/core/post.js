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
import { createCrtShader, applyCrtPreset } from './passes/crt-pass.js';
import { createPaletteShader, applyPalette } from './passes/palette-pass.js';

/** Passes are imported on first enable, not at module load. */
let modules = null;

async function loadModules() {
  if (modules) return modules;
  const [
    { EffectComposer },
    { RenderPass },
    { GTAOPass },
    { SMAAPass },
    { OutputPass },
    { ShaderPass },
    { UnrealBloomPass },
    { GlitchPass },
  ] = await Promise.all([
    import('three/addons/postprocessing/EffectComposer.js'),
    import('three/addons/postprocessing/RenderPass.js'),
    import('three/addons/postprocessing/GTAOPass.js'),
    import('three/addons/postprocessing/SMAAPass.js'),
    import('three/addons/postprocessing/OutputPass.js'),
    import('three/addons/postprocessing/ShaderPass.js'),
    import('three/addons/postprocessing/UnrealBloomPass.js'),
    import('three/addons/postprocessing/GlitchPass.js'),
  ]);
  modules = { EffectComposer, RenderPass, GTAOPass, SMAAPass, OutputPass, ShaderPass, UnrealBloomPass, GlitchPass };
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
  let bloomPass = null;
  let glitchPass = null;
  let crtPass = null;
  let palettePass = null;

  let aoEnabled = false;
  let aaEnabled = false;
  let bloomEnabled = false;
  let glitchEnabled = false;
  let crtEnabled = false;
  let paletteEnabled = false;

  let aoIntensity = 1;
  // Fraction of the subject's radius. A fixed world-space radius would be
  // wrong for the same reason the original's fixed ±10 shadow box was wrong:
  // models are normalised to a consistent size, but that size is arbitrary.
  let aoRadiusFactor = 0.25;
  let subjectRadius = 5;

  let bloomStrength = 0.6;
  let bloomRadius = 0.4;
  let bloomThreshold = 0.7;
  let crtPreset = 'arcade';
  let paletteName = 'gba';
  let pixelSize = 4;

  // renderer.getSize() calls target.set(), so it needs a real Vector2 — a plain
  // {x, y} throws.
  const _size = new Vector2();

  function currentSize() {
    renderer.getSize(_size);
    return _size;
  }

  /** True when any effect wants the composer. */
  function active() {
    return aoEnabled || aaEnabled || bloomEnabled || glitchEnabled || crtEnabled || paletteEnabled;
  }

  async function build(width, height) {
    const {
      EffectComposer, RenderPass, GTAOPass, SMAAPass, OutputPass, ShaderPass, UnrealBloomPass, GlitchPass,
    } = await loadModules();
    if (composer) return;

    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    gtaoPass = new GTAOPass(scene, camera, width, height);
    gtaoPass.enabled = aoEnabled;
    composer.addPass(gtaoPass);

    smaaPass = new SMAAPass();
    smaaPass.enabled = aaEnabled;
    composer.addPass(smaaPass);

    // Composite order below is pinned deliberately, not incidental:
    //
    //   Bloom -> Palette (pixelate+dither+quantize) -> CRT -> Glitch
    //
    // Bloom before palette, not after: bloom-after-palette would let glow
    // bleed between fixed-palette colors before the final quantize, which
    // reads as "a modern filter over a retro image." Bloom-before still gets
    // every bloomed pixel snapped to the palette on its way out - the
    // fixed-palette guarantee holds either way, but only bloom-first gives
    // the "GBA screenshot" look this is for.
    //
    // Glitch after CRT, not before: reads as the CRT signal itself breaking
    // up (a struggling TV) rather than a corrupted source feed underneath a
    // working CRT - the more common real-world reference.
    bloomPass = new UnrealBloomPass(new Vector2(width, height), bloomStrength, bloomRadius, bloomThreshold);
    bloomPass.enabled = bloomEnabled;
    composer.addPass(bloomPass);

    palettePass = new ShaderPass(createPaletteShader());
    palettePass.enabled = paletteEnabled;
    composer.addPass(palettePass);

    crtPass = new ShaderPass(createCrtShader());
    crtPass.enabled = crtEnabled;
    composer.addPass(crtPass);

    glitchPass = new GlitchPass();
    glitchPass.enabled = glitchEnabled;
    composer.addPass(glitchPass);

    // Must be last: it performs tone mapping and the sRGB conversion that the
    // renderer would otherwise do on its own. Reads renderer.toneMapping
    // itself, unmodified by anything above it — see the file header.
    composer.addPass(new OutputPass());

    applyAO();
    applyCrtPreset(crtPass, crtPreset);
    applyPalette(palettePass, paletteName);
    palettePass.uniforms.pixelSize.value = pixelSize;
    composer.setSize(width, height);
    composer.setPixelRatio(renderer.getPixelRatio());
    applyResolutionUniforms(width, height);
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

  /** CRT and palette both need the real pixel resolution for their grids. */
  function applyResolutionUniforms(width, height) {
    const ratio = renderer.getPixelRatio();
    const pixelWidth = width * ratio;
    const pixelHeight = height * ratio;
    if (crtPass) crtPass.uniforms.uResolution.value = [pixelWidth, pixelHeight];
    if (palettePass) palettePass.uniforms.uResolution.value = [pixelWidth, pixelHeight];
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

    // --- Style effects (Track 4.3/4.4) --------------------------------------
    // Same shape as setAO/setAA above throughout: lazy-build the composer on
    // first enable, keep local state so a later build() (or a tier default)
    // can re-apply it, invalidate(2) so a shadow-adjacent redraw settles.

    async setBloom(enabled) {
      bloomEnabled = enabled;
      if (enabled && !composer) {
        const size = currentSize();
        await build(size.x, size.y);
      }
      if (bloomPass) bloomPass.enabled = enabled;
      invalidate(2);
    },

    setBloomStrength(value) {
      bloomStrength = value;
      if (bloomPass) bloomPass.strength = value;
      invalidate(2);
    },

    setBloomRadius(value) {
      bloomRadius = value;
      if (bloomPass) bloomPass.radius = value;
      invalidate(2);
    },

    setBloomThreshold(value) {
      bloomThreshold = value;
      if (bloomPass) bloomPass.threshold = value;
      invalidate(2);
    },

    async setGlitch(enabled) {
      glitchEnabled = enabled;
      if (enabled && !composer) {
        const size = currentSize();
        await build(size.x, size.y);
      }
      if (glitchPass) glitchPass.enabled = enabled;
      invalidate(2);
    },

    setGlitchWild(wild) {
      if (glitchPass) glitchPass.goWild = wild;
      invalidate(2);
    },

    async setCrt(enabled) {
      crtEnabled = enabled;
      if (enabled && !composer) {
        const size = currentSize();
        await build(size.x, size.y);
      }
      if (crtPass) crtPass.enabled = enabled;
      invalidate(2);
    },

    setCrtPreset(name) {
      crtPreset = name;
      if (crtPass) applyCrtPreset(crtPass, name);
      invalidate(2);
    },

    async setPalette(enabled) {
      paletteEnabled = enabled;
      if (enabled && !composer) {
        const size = currentSize();
        await build(size.x, size.y);
      }
      if (palettePass) palettePass.enabled = enabled;
      invalidate(2);
    },

    setPaletteName(name) {
      paletteName = name;
      if (palettePass) applyPalette(palettePass, name);
      invalidate(2);
    },

    setPixelSize(value) {
      pixelSize = value;
      if (palettePass) palettePass.uniforms.pixelSize.value = value;
      invalidate(2);
    },

    setSize(width, height) {
      if (!composer) return;
      composer.setSize(width, height);
      composer.setPixelRatio(renderer.getPixelRatio());
      gtaoPass?.setSize(width, height);
      bloomPass?.setSize(width, height);
      applyResolutionUniforms(width, height);
    },

    /**
     * The render call handed to the loop and to captureScreenshot().
     *
     * Deliberately does not touch renderer.toneMapping — see the file header
     * for why nothing here needs to. CRT's uTime is advanced here rather than
     * from the render loop's own update(), since it only matters for the one
     * frame actually about to be drawn — no reason to touch it when nothing
     * is rendering.
     */
    render() {
      if (crtPass) crtPass.uniforms.uTime.value = performance.now() / 1000;
      if (active() && composer) composer.render();
      else renderer.render(scene, camera);
    },

    dispose() {
      composer?.dispose();
      gtaoPass?.dispose?.();
      smaaPass?.dispose?.();
      bloomPass?.dispose?.();
      glitchPass?.dispose?.();
      crtPass?.dispose?.();
      palettePass?.dispose?.();
      composer = null;
      gtaoPass = null;
      smaaPass = null;
      bloomPass = null;
      glitchPass = null;
      crtPass = null;
      palettePass = null;
    },
  };
}
