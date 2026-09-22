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
import { createRepeatShader, setRepeatMode } from './passes/repeat-pass.js';
import { createColorGradeShader, setColorGradeStyle } from './passes/color-grade-pass.js';
import { createToneShader, setToneMode } from './passes/tone-pass.js';
import { createDisplaceShader, setDisplaceMode } from './passes/displace-pass.js';
import { createAsciiShader, setAsciiRamp } from './passes/ascii-pass.js';
import { createPixelateShader } from './passes/pixelate-pass.js';
import { createHalftoneShader, setHalftoneMode } from './passes/halftone-pass.js';
import { createFilmShader, applyFilmPreset } from './passes/film-pass.js';

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
    { AfterimagePass },
    { BokehPass },
  ] = await Promise.all([
    import('three/addons/postprocessing/EffectComposer.js'),
    import('three/addons/postprocessing/RenderPass.js'),
    import('three/addons/postprocessing/GTAOPass.js'),
    import('three/addons/postprocessing/SMAAPass.js'),
    import('three/addons/postprocessing/OutputPass.js'),
    import('three/addons/postprocessing/ShaderPass.js'),
    import('three/addons/postprocessing/UnrealBloomPass.js'),
    import('three/addons/postprocessing/GlitchPass.js'),
    import('three/addons/postprocessing/AfterimagePass.js'),
    import('three/addons/postprocessing/BokehPass.js'),
  ]);
  modules = {
    EffectComposer, RenderPass, GTAOPass, SMAAPass, OutputPass, ShaderPass, UnrealBloomPass, GlitchPass,
    AfterimagePass, BokehPass,
  };
  return modules;
}

// Every Style-tier effect (i.e. everything except AO/AA, which are fidelity,
// not stylization, and stay outside the reorderable band - see Track 4's own
// "Style vs Environment" split). Order here is only the *default* order a
// fresh composer builds passes in; reorderStyle() below permutes it later.
// Bloom/CRT/Glitch kept their original relative slots as the default; the
// five Track 5.3 additions land between Bloom and CRT, per the plan.
const STYLE_KEYS = [
  'bloom', 'colorGrade', 'tone', 'pixelate', 'palette', 'halftone', 'repeat', 'displace',
  'afterimage', 'ascii', 'crt', 'film', 'glitch',
];

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

  // Every Style pass, keyed the same as STYLE_KEYS - one map rather than one
  // variable each, since reorderStyle() needs to address them generically.
  const passes = {};
  const styleEnabled = {
    bloom: false, colorGrade: false, tone: false, pixelate: false, palette: false,
    halftone: false, repeat: false, displace: false, afterimage: false, ascii: false,
    crt: false, film: false, glitch: false,
  };
  let styleOrder = [...STYLE_KEYS];

  let aoEnabled = false;
  let aaEnabled = false;
  let dofEnabled = false;
  let dofPass = null;

  // Focus is a world-space distance along the camera's look direction, so a
  // sane default depends entirely on how far the camera sits from the
  // subject - which normalizeObject() makes predictable. Seeded from the
  // subject's own bounds in setSubject(), the same way the AO radius is,
  // rather than starting at three's default 1.0 and making every first use
  // begin with a slider hunt through an entirely blurred image.
  let dofFocus = 18;
  let dofAperture = 0.002;
  let dofMaxBlur = 0.01;
  // Once someone sets focus by hand, stop overwriting it on the next model
  // load - the same "an explicit choice stands" rule the quality tier and
  // every Style default already follow.
  let dofTouched = false;

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
  let afterimageTrail = 0.9; // 0..1 UI value; mapped to damp in applyAfterimage()
  let asciiRampName = 'classic';
  let asciiCustomRamp = '';
  let filmPreset = 'super8';

  // renderer.getSize() calls target.set(), so it needs a real Vector2 — a plain
  // {x, y} throws.
  const _size = new Vector2();

  function currentSize() {
    renderer.getSize(_size);
    return _size;
  }

  /** True when any effect wants the composer. */
  function active() {
    return aoEnabled || aaEnabled || dofEnabled || Object.values(styleEnabled).some(Boolean);
  }

  /** How many Style (non-fidelity) effects are currently on - see setSize's caller in Track 5.1. */
  function styleEffectCount() {
    return Object.values(styleEnabled).filter(Boolean).length;
  }

  async function build(width, height) {
    const {
      EffectComposer, RenderPass, GTAOPass, SMAAPass, OutputPass, ShaderPass, UnrealBloomPass, GlitchPass,
      AfterimagePass, BokehPass,
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

    // Depth of field sits in the fixed fidelity prefix, NOT the reorderable
    // Style band - and that is a correctness constraint, not a preference.
    // BokehPass renders its own depth pass of the real scene (which is why
    // it takes scene/camera at all, like GTAOPass): it blurs by distance.
    // Downstream of any Style pass there is no depth relationship left to
    // blur against - a CRT-scanlined or ASCII-glyphed frame has thrown that
    // information away - so it would be blurring an image that no longer
    // corresponds to the geometry it is sampling depth from.
    dofPass = new BokehPass(scene, camera, {
      focus: dofFocus,
      aperture: dofAperture,
      maxblur: dofMaxBlur,
    });
    dofPass.enabled = dofEnabled;
    composer.addPass(dofPass);

    // Default composite order below (STYLE_KEYS) is a starting point, not a
    // hard rule - reorderStyle() permutes it later. The reasoning that
    // motivated this particular default is still worth recording:
    //
    // Bloom before Palette: bloom-after-palette would let glow bleed between
    // fixed-palette colors before the final quantize, which reads as "a
    // filter over a retro image" rather than "a GBA screenshot" - bloom-
    // first still gets every pixel snapped to the palette on its way out.
    //
    // Glitch after CRT: reads as the CRT signal itself breaking up (a
    // struggling TV) rather than a corrupted source feed underneath a
    // working CRT - the more common real-world reference.
    passes.bloom = new UnrealBloomPass(new Vector2(width, height), bloomStrength, bloomRadius, bloomThreshold);
    passes.colorGrade = new ShaderPass(createColorGradeShader());
    passes.tone = new ShaderPass(createToneShader());
    passes.pixelate = new ShaderPass(createPixelateShader());
    passes.palette = new ShaderPass(createPaletteShader());
    passes.halftone = new ShaderPass(createHalftoneShader());
    passes.repeat = new ShaderPass(createRepeatShader());
    passes.displace = new ShaderPass(createDisplaceShader());
    passes.afterimage = new AfterimagePass(); // real damp set by applyAfterimage() below
    passes.ascii = new ShaderPass(createAsciiShader());
    passes.crt = new ShaderPass(createCrtShader());
    passes.film = new ShaderPass(createFilmShader());
    passes.glitch = new GlitchPass();

    for (const key of STYLE_KEYS) {
      passes[key].enabled = styleEnabled[key];
      composer.addPass(passes[key]);
    }

    // Must be last: it performs tone mapping and the sRGB conversion that the
    // renderer would otherwise do on its own. Reads renderer.toneMapping
    // itself, unmodified by anything above it — see the file header.
    const outputPass = new OutputPass();
    composer.addPass(outputPass);

    applyAO();
    applyCrtPreset(passes.crt, crtPreset);
    applyPalette(passes.palette, paletteName);
    passes.palette.uniforms.pixelSize.value = pixelSize;
    setAsciiRamp(passes.ascii, asciiRampName, asciiCustomRamp);
    applyFilmPreset(passes.film, filmPreset);
    applyAfterimage();
    composer.setSize(width, height);
    composer.setPixelRatio(renderer.getPixelRatio());
    applyResolutionUniforms(width, height);
  }

  /**
   * Permute the Style band's composite order (Track 5.2). Bloom/GTAO/SMAA's
   * fixed prefix and OutputPass's fixed suffix never move - only the Style
   * passes between them do, since EffectComposer.passes is a plain array and
   * every Style pass is already in it (added once, in build(), and simply
   * re-spliced here rather than removed/recreated).
   *
   * @param {string[]} order  A permutation of STYLE_KEYS. Missing/unknown
   *   keys are tolerated - appended at the end, or ignored, respectively -
   *   since this is fed from persisted settings that could predate a
   *   newly-added effect.
   */
  function reorderStyle(order) {
    const filtered = order.filter((k) => STYLE_KEYS.includes(k));
    for (const k of STYLE_KEYS) if (!filtered.includes(k)) filtered.push(k);
    styleOrder = filtered;

    if (!composer) return;
    const styleInstances = new Set(STYLE_KEYS.map((k) => passes[k]));
    // Anchor to the LAST fidelity pass, not to SMAA specifically: DOF was
    // added to that prefix after this function, and anchoring to SMAA would
    // silently re-splice the whole Style band in front of it, inverting the
    // fidelity-then-style order every pass here depends on.
    const lastFixed = dofPass ?? smaaPass;
    const insertAt = composer.passes.indexOf(lastFixed) + 1;
    composer.passes = composer.passes.filter((p) => !styleInstances.has(p));
    composer.passes.splice(insertAt, 0, ...styleOrder.map((k) => passes[k]));
    invalidate(2);
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

  /** CRT, Palette, Tone, and ASCII all need the real pixel resolution for their grids. */
  function applyResolutionUniforms(width, height) {
    const ratio = renderer.getPixelRatio();
    const pixelWidth = width * ratio;
    const pixelHeight = height * ratio;
    if (passes.crt) passes.crt.uniforms.uResolution.value = [pixelWidth, pixelHeight];
    if (passes.palette) passes.palette.uniforms.uResolution.value = [pixelWidth, pixelHeight];
    if (passes.pixelate) passes.pixelate.uniforms.uResolution.value = [pixelWidth, pixelHeight];
    if (passes.tone) passes.tone.uniforms.uResolution.value = [pixelWidth, pixelHeight];
    if (passes.ascii) passes.ascii.uniforms.uResolution.value = [pixelWidth, pixelHeight];
    if (passes.halftone) passes.halftone.uniforms.uResolution.value = [pixelWidth, pixelHeight];
    if (passes.film) passes.film.uniforms.uResolution.value = [pixelWidth, pixelHeight];
  }

  function applyAfterimage() {
    if (!passes.afterimage) return;
    // UI works in an intuitive 0..1 "trail length"; damp itself is a narrow
    // band close to 1 (0 or 1 either do nothing or accumulate forever).
    passes.afterimage.uniforms.damp.value = 0.8 + afterimageTrail * 0.18;
  }

  /** Generic enable/build path every Style effect setter below shares. */
  async function setStyleEnabled(key, enabled) {
    styleEnabled[key] = enabled;
    if (enabled && !composer) {
      const size = currentSize();
      await build(size.x, size.y);
    }
    if (passes[key]) passes[key].enabled = enabled;
    invalidate(2);
  }

  return {
    /** Whether the composer is currently in the output path. */
    get active() {
      return active();
    },

    /** Count of currently-enabled Style effects - see Track 5.1's device-cost nudge. */
    get styleEffectCount() {
      return styleEffectCount();
    },

    /** Current Style composite order, for persisting/restoring (Track 5.2). */
    get styleOrder() {
      return [...styleOrder];
    },

    /** Permute the Style composite order. See reorderStyle()'s own doc comment. */
    setStyleOrder(order) {
      reorderStyle(order);
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
      // Seed DOF's focus distance from the subject too, for the same reason
      // the AO radius is scoped here: both are world-space distances, and a
      // model normalised to ~10 units needs a different one than a model
      // left at 0.01. frameCamera() puts the camera at roughly 2.2x the
      // subject radius, so focusing there lands on the subject rather than
      // in front of or behind it.
      if (!dofTouched) {
        dofFocus = subjectRadius * 2.2;
        if (dofPass) dofPass.uniforms.focus.value = dofFocus;
      }
    },

    // --- depth of field (Track 6.1) ---------------------------------------
    // Fidelity, not stylization: it lives beside AO/AA in the Environment
    // group, and in the composer's fixed prefix. See build() for why.

    async setDof(enabled) {
      dofEnabled = enabled;
      if (enabled && !composer) {
        const size = currentSize();
        await build(size.x, size.y);
      }
      if (dofPass) dofPass.enabled = enabled;
      invalidate(2);
    },

    setDofFocus(value) {
      dofFocus = value;
      if (dofPass) dofPass.uniforms.focus.value = value;
      invalidate(2);
    },

    /**
     * Mark focus as deliberately chosen, so setSubject() stops re-seeding it
     * on the next model load.
     *
     * Deliberately NOT folded into setDofFocus(): main.js's bindSlider()
     * runs one initial apply() at wiring time to sync each control with its
     * markup default, which would otherwise mark focus "touched" with the
     * HTML default before any model had ever loaded - silently killing the
     * seeding for the whole session. (Found by running it: focus stayed at
     * 18 for a subject whose bounds wanted ~12.3.) Only a real 'input' event
     * from the slider, or settings.js restoring a saved value, calls this.
     */
    markDofFocusTouched() {
      dofTouched = true;
    },

    setDofAperture(value) {
      dofAperture = value;
      if (dofPass) dofPass.uniforms.aperture.value = value;
      invalidate(2);
    },

    setDofMaxBlur(value) {
      dofMaxBlur = value;
      if (dofPass) dofPass.uniforms.maxblur.value = value;
      invalidate(2);
    },

    /** Focus distance the subject seeding produced, so the UI can show it. */
    get dofFocus() {
      return dofFocus;
    },

    // --- Style effects (Track 4.3/4.4, extended in Track 5.3) ---------------
    // Same shape throughout: lazy-build the composer on first enable, keep
    // local state so a later build() (or a tier default) can re-apply it,
    // invalidate(2) so a shadow-adjacent redraw settles.

    setBloom(enabled) {
      return setStyleEnabled('bloom', enabled);
    },

    setBloomStrength(value) {
      bloomStrength = value;
      if (passes.bloom) passes.bloom.strength = value;
      invalidate(2);
    },

    setBloomRadius(value) {
      bloomRadius = value;
      if (passes.bloom) passes.bloom.radius = value;
      invalidate(2);
    },

    setBloomThreshold(value) {
      bloomThreshold = value;
      if (passes.bloom) passes.bloom.threshold = value;
      invalidate(2);
    },

    setGlitch(enabled) {
      return setStyleEnabled('glitch', enabled);
    },

    setGlitchWild(wild) {
      if (passes.glitch) passes.glitch.goWild = wild;
      invalidate(2);
    },

    setCrt(enabled) {
      return setStyleEnabled('crt', enabled);
    },

    setCrtPreset(name) {
      crtPreset = name;
      if (passes.crt) applyCrtPreset(passes.crt, name);
      invalidate(2);
    },

    setPalette(enabled) {
      return setStyleEnabled('palette', enabled);
    },

    setPaletteName(name) {
      paletteName = name;
      if (passes.palette) applyPalette(passes.palette, name);
      invalidate(2);
    },

    setPixelSize(value) {
      pixelSize = value;
      if (passes.palette) passes.palette.uniforms.pixelSize.value = value;
      invalidate(2);
    },

    // --- Track 5.3 additions -------------------------------------------

    setRepeat(enabled) {
      return setStyleEnabled('repeat', enabled);
    },

    setRepeatMode(name) {
      if (passes.repeat) setRepeatMode(passes.repeat, name);
      invalidate(2);
    },

    setRepeatAmount(value) {
      if (passes.repeat) passes.repeat.uniforms.amount.value = value;
      invalidate(2);
    },

    setRepeatAngle(degrees) {
      if (passes.repeat) passes.repeat.uniforms.angle.value = (degrees * Math.PI) / 180;
      invalidate(2);
    },

    setColorGrade(enabled) {
      return setStyleEnabled('colorGrade', enabled);
    },

    setColorGradeStyle(name) {
      if (passes.colorGrade) setColorGradeStyle(passes.colorGrade, name);
      invalidate(2);
    },

    setColorGradeParam(name, value) {
      if (passes.colorGrade?.uniforms[name]) passes.colorGrade.uniforms[name].value = value;
      invalidate(2);
    },

    setTone(enabled) {
      return setStyleEnabled('tone', enabled);
    },

    setToneMode(name) {
      if (passes.tone) setToneMode(passes.tone, name);
      invalidate(2);
    },

    setToneParam(name, value) {
      if (passes.tone?.uniforms[name]) passes.tone.uniforms[name].value = value;
      invalidate(2);
    },

    setDisplace(enabled) {
      return setStyleEnabled('displace', enabled);
    },

    setDisplaceMode(name) {
      if (passes.displace) setDisplaceMode(passes.displace, name);
      invalidate(2);
    },

    setDisplaceParam(name, value) {
      if (passes.displace?.uniforms[name]) passes.displace.uniforms[name].value = value;
      invalidate(2);
    },

    setAfterimage(enabled) {
      return setStyleEnabled('afterimage', enabled);
    },

    setAfterimageTrail(value) {
      afterimageTrail = value;
      applyAfterimage();
      invalidate(2);
    },

    // --- Track 4.5 (ASCII), built after being deferred through Tracks 4/5 --

    setAscii(enabled) {
      return setStyleEnabled('ascii', enabled);
    },

    setAsciiRamp(name, customRamp) {
      asciiRampName = name;
      if (customRamp !== undefined) asciiCustomRamp = customRamp;
      if (passes.ascii) setAsciiRamp(passes.ascii, name, asciiCustomRamp);
      invalidate(2);
    },

    setAsciiParam(name, value) {
      if (passes.ascii?.uniforms[name]) passes.ascii.uniforms[name].value = value;
      invalidate(2);
    },

    // --- print reproduction + film emulation -----------------------------

    // Standalone pixelation - the same block resample the retro palette does
    // internally, but usable without also quantizing to a console palette.
    setPixelate(enabled) {
      return setStyleEnabled('pixelate', enabled);
    },

    setPixelateParam(name, value) {
      if (passes.pixelate?.uniforms[name]) passes.pixelate.uniforms[name].value = value;
      invalidate(2);
    },

    setHalftone(enabled) {
      return setStyleEnabled('halftone', enabled);
    },

    setHalftoneMode(name) {
      if (passes.halftone) setHalftoneMode(passes.halftone, name);
      invalidate(2);
    },

    setHalftoneParam(name, value) {
      if (passes.halftone?.uniforms[name]) passes.halftone.uniforms[name].value = value;
      invalidate(2);
    },

    setFilm(enabled) {
      return setStyleEnabled('film', enabled);
    },

    setFilmPreset(name) {
      filmPreset = name;
      if (passes.film) applyFilmPreset(passes.film, name);
      invalidate(2);
    },

    setFilmParam(name, value) {
      if (passes.film?.uniforms[name]) passes.film.uniforms[name].value = value;
      invalidate(2);
    },

    setSize(width, height) {
      if (!composer) return;
      composer.setSize(width, height);
      composer.setPixelRatio(renderer.getPixelRatio());
      gtaoPass?.setSize(width, height);
      dofPass?.setSize(width, height);
      passes.bloom?.setSize(width, height);
      applyResolutionUniforms(width, height);
    },

    /**
     * The render call handed to the loop and to captureScreenshot().
     *
     * Deliberately does not touch renderer.toneMapping — see the file header
     * for why nothing here needs to. Time-based uniforms (CRT's grain/roll,
     * ColorGrade's hue-cycle animation, Displace's wave/wobble/jitter/shake)
     * are advanced here rather than from the render loop's own update(),
     * since they only matter for the one frame actually about to be drawn —
     * no reason to touch them when nothing is rendering.
     */
    render() {
      const t = performance.now() / 1000;
      if (passes.crt) passes.crt.uniforms.uTime.value = t;
      if (passes.colorGrade) passes.colorGrade.uniforms.uTime.value = t;
      if (passes.displace) passes.displace.uniforms.uTime.value = t;
      if (passes.film) passes.film.uniforms.uTime.value = t;
      if (active() && composer) composer.render();
      else renderer.render(scene, camera);
    },

    dispose() {
      composer?.dispose();
      gtaoPass?.dispose?.();
      smaaPass?.dispose?.();
      dofPass?.dispose?.();
      for (const key of STYLE_KEYS) {
        passes[key]?.dispose?.();
        passes[key] = null;
      }
      composer = null;
      gtaoPass = null;
      smaaPass = null;
      dofPass = null;
    },
  };
}
