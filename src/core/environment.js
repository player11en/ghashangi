// Environment lighting, background, and tone mapping.
//
// The original assigned the raw equirectangular HDR straight to both
// scene.environment and scene.background. That works, but it leaves three to
// build and cache the irradiance data implicitly, gives no way to release the
// source texture, and offers no lighting at all until a 1.5MB HDR has finished
// downloading — the model just sits there unlit.
//
// Here the HDR is converted once with PMREMGenerator, and a procedural
// RoomEnvironment is installed immediately as a synchronous fallback so the
// first frame is always lit. r186 also adds AgX and Neutral tone mapping, which
// did not exist in r154; both are better defaults for product-style renders
// than ACESFilmic, which crushes saturated colours.

import {
  PMREMGenerator,
  EquirectangularReflectionMapping,
  Color,
  NoToneMapping,
  LinearToneMapping,
  ReinhardToneMapping,
  CineonToneMapping,
  ACESFilmicToneMapping,
  AgXToneMapping,
  NeutralToneMapping,
} from 'three';
// HDRLoader, not RGBELoader: r186 deprecates RGBELoader in favour of HDRLoader.
// Same .hdr input, same output, new name.
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/** Selectable tone mapping curves, in rough order of contrast. */
export const TONE_MAPPINGS = {
  none: NoToneMapping,
  linear: LinearToneMapping,
  reinhard: ReinhardToneMapping,
  cineon: CineonToneMapping,
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
};

export const DEFAULT_HDR = 'Skybox/blouberg_sunrise_2_1k.hdr';

/**
 * @param {object} options
 * @param {import('three').Scene} options.scene
 * @param {import('three').WebGLRenderer} options.renderer
 * @param {() => void} options.invalidate  Ask the render loop for a redraw.
 */
export function createEnvironment({ scene, renderer, invalidate }) {
  const pmrem = new PMREMGenerator(renderer);

  // Resources we own and must dispose when replacing the environment. Kept
  // separately from the model's resources so unloading a model never disposes
  // the environment out from under it (see dispose.js `protect`).
  let envRenderTarget = null;
  let backgroundTexture = null;

  let showBackground = true;
  let blurriness = 0.35;
  let intensity = 1;

  const fallbackColor = new Color(0x141418);

  function currentEnvironmentTexture() {
    return envRenderTarget ? envRenderTarget.texture : null;
  }

  function releaseEnvironment() {
    if (envRenderTarget) {
      envRenderTarget.dispose();
      envRenderTarget = null;
    }
    if (backgroundTexture) {
      backgroundTexture.dispose();
      backgroundTexture = null;
    }
  }

  function applyBackground() {
    if (!showBackground) {
      scene.background = fallbackColor;
    } else {
      scene.background = backgroundTexture ?? currentEnvironmentTexture() ?? fallbackColor;
    }
    scene.backgroundBlurriness = blurriness;
    scene.backgroundIntensity = intensity;
    invalidate();
  }

  /**
   * Install a procedural studio environment. Synchronous, so the very first
   * frame is lit even before any HDR has been fetched, and useful in its own
   * right as a neutral lighting option.
   */
  function useRoomEnvironment() {
    releaseEnvironment();
    const room = new RoomEnvironment();
    envRenderTarget = pmrem.fromScene(room, 0.04);
    // RoomEnvironment is a throwaway Scene of plain boxes; once PMREM has read
    // it there is nothing to keep.
    room.traverse((node) => {
      node.geometry?.dispose();
      node.material?.dispose();
    });
    scene.environment = currentEnvironmentTexture();
    scene.environmentIntensity = intensity;
    applyBackground();
  }

  /**
   * Load an equirectangular HDR and use it for both lighting and background.
   *
   * @param {string} url
   * @param {(fraction:number) => void} [onProgress]
   * @returns {Promise<void>}
   */
  function loadHDR(url = DEFAULT_HDR, onProgress) {
    return new Promise((resolve, reject) => {
      new HDRLoader().load(
        url,
        (texture) => {
          texture.mapping = EquirectangularReflectionMapping;

          releaseEnvironment();
          envRenderTarget = pmrem.fromEquirectangular(texture);
          // Keep the equirect for the visible background: the PMREM output is a
          // low-resolution roughness pyramid and looks obviously soft if used
          // as the sky. It is disposed with the rest in releaseEnvironment().
          backgroundTexture = texture;

          scene.environment = currentEnvironmentTexture();
          scene.environmentIntensity = intensity;
          applyBackground();
          resolve();
        },
        (event) => {
          if (onProgress && event.total) onProgress(event.loaded / event.total);
        },
        (error) => reject(error),
      );
    });
  }

  return {
    useRoomEnvironment,
    loadHDR,

    /** The texture assigned to scene.environment, for dispose.js to protect. */
    get environmentTexture() {
      return currentEnvironmentTexture();
    },

    setBackgroundVisible(visible) {
      showBackground = visible;
      applyBackground();
    },

    setBlurriness(value) {
      blurriness = value;
      applyBackground();
    },

    /** Drives both the background and the lighting contribution. */
    setIntensity(value) {
      intensity = value;
      scene.environmentIntensity = value;
      applyBackground();
    },

    /** Rotate the environment. Cheap way to relight without moving lights. */
    setRotation(radians) {
      scene.environmentRotation.y = radians;
      scene.backgroundRotation.y = radians;
      invalidate();
    },

    setToneMapping(name) {
      const mapping = TONE_MAPPINGS[name];
      if (mapping === undefined) return false;

      // A plain, direct write, even with post-processing active. Three only
      // applies renderer.toneMapping to a material rendered straight to the
      // canvas (WebGLPrograms.js's getParameters(): NoToneMapping is forced
      // for anything rendered to an off-screen target). RenderPass renders the
      // scene into EffectComposer's off-screen buffers, so it structurally
      // cannot double up with OutputPass, which is the pass that writes to the
      // real canvas and separately, explicitly reads this same property to
      // choose its own curve. See post.js's file header for the full case.
      renderer.toneMapping = mapping;

      // Tone mapping is compiled into every material's shader.
      scene.traverse((node) => {
        const material = node.material;
        if (!material) return;
        for (const m of Array.isArray(material) ? material : [material]) {
          m.needsUpdate = true;
        }
      });
      invalidate();
      return true;
    },

    setExposure(value) {
      renderer.toneMappingExposure = value;
      invalidate();
    },

    dispose() {
      releaseEnvironment();
      pmrem.dispose();
    },
  };
}
