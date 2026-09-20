// Device capability tier: low / medium / high.
//
// A discrete tier rather than a numeric score, matching how the rest of the
// app already exposes choices — the tone-mapping dropdown, the up-axis
// presets — as a small set of named options rather than a continuous
// unlabelled slider where a preset would do just as well and be easier to
// reason about.
//
// Nothing here is exact science. It exists to pick a sane starting point
// (Track 1.5.2 wires it into `resolutionScale`, AO/AA defaults, and shadow map
// size), not to gatekeep — every one of those remains a normal, user-facing
// control afterward. Getting the tier slightly wrong costs a frame or two of
// resolution, never a missing feature.

/**
 * @param {import('three').WebGLRenderer} renderer  Needed for
 *   `capabilities.maxTextureSize`, which is only known once WebGL context
 *   creation has actually queried the GPU.
 * @returns {{ tier: 'low'|'medium'|'high', signals: object }}
 */
export function detectCapabilityTier(renderer) {
  const cores = navigator.hardwareConcurrency || 4;

  // Safari does not implement navigator.deviceMemory at all (a privacy-
  // fingerprinting concern on their end, not a bug here) — 4 is a deliberately
  // unpenalising default rather than treating every Safari visitor as low-end.
  const memory = navigator.deviceMemory ?? 4;

  const maxTextureSize = renderer.capabilities.maxTextureSize;

  // Standard touch/mobile heuristic: a real pointing device reports
  // `maxTouchPoints === 0`, and `(pointer: coarse)` is true for a finger,
  // false for a mouse or trackpad — together they catch touch laptops too,
  // which `maxTouchPoints` alone would miss.
  const isMobile =
    navigator.maxTouchPoints > 0 || (window.matchMedia?.('(pointer: coarse)').matches ?? false);

  const signals = { cores, memory, maxTextureSize, isMobile };

  // Low: a touch device that is also light on cores/memory, or a GPU with a
  // genuinely small texture budget (regardless of device class — a low-end
  // desktop GPU deserves the same treatment as a low-end phone).
  if ((isMobile && (cores <= 4 || memory <= 4)) || maxTextureSize < 8192) {
    return { tier: 'low', signals };
  }

  // High: comfortably specced and not a touch device — mobile GPUs thermal-
  // throttle in ways core/memory counts alone don't capture, so mobile is
  // capped at 'medium' even when the numbers look generous.
  if (!isMobile && cores >= 8 && memory >= 8 && maxTextureSize >= 16384) {
    return { tier: 'high', signals };
  }

  return { tier: 'medium', signals };
}
