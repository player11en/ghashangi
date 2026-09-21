// Temporarily force the viewport container to a target aspect ratio, for
// exporting clips shaped for social platforms (9:16, 1:1) instead of
// whatever shape the browser window happens to be.
//
// Resizing the container alone isn't enough on its own: viewer.js resizes
// the renderer/canvas from a ResizeObserver on that container, and measured
// directly before trusting it, that observer took longer than 300ms to
// actually fire in roughly 2 of every 3 runs under headless Chromium +
// SwiftShader (real, reproducible - not a one-off flake). A recording that
// starts immediately after locking would capture its first frames at the
// wrong dimensions. So every lock/unlock here calls viewer.resize() - a
// synchronous "recompute size from the container right now" - rather than
// waiting on the observer to get around to it.
//
// Two entry points: `lockAspect`/`unlockAspect` as a pair for an open-ended
// state (live Preview, which the user stops whenever they like - not a
// single bounded async call), and `withAspectLock` wrapping that pair
// around a bounded operation (recording a fixed-duration clip).

const RATIOS = {
  free: null,
  '9:16': 9 / 16,
  '1:1': 1,
};

export const ASPECT_OPTIONS = Object.keys(RATIOS);

/**
 * Lock the container to `ratioKey`'s aspect ratio, contain-fit within its
 * current available space, and force the viewer to resize to match
 * immediately. Returns the previous inline style so the caller can restore
 * it later via `unlockAspect` - or does nothing and returns `null` for
 * 'free', so callers can unconditionally call `unlockAspect` with whatever
 * this returns without checking for 'free' themselves.
 *
 * @param {HTMLElement} container
 * @param {object} viewer
 * @param {'free'|'9:16'|'1:1'} ratioKey
 * @returns {object|null} a snapshot to pass to unlockAspect(), or null
 */
export function lockAspect(container, viewer, ratioKey) {
  const ratio = RATIOS[ratioKey];
  if (!ratio) return null;

  const availableWidth = container.clientWidth;
  const availableHeight = container.clientHeight;

  // Contain-fit: the largest box of the target ratio that fits inside the
  // space the container already has, so locking never grows past the
  // viewport the user is actually looking at.
  let width = availableWidth;
  let height = width / ratio;
  if (height > availableHeight) {
    height = availableHeight;
    width = height * ratio;
  }

  // #viewport is `position: fixed; inset: 0` - left/top/right/bottom all 0,
  // sized by stretching. An explicit width/height alone would be
  // over-constrained against that and anchor top-left, not centered; setting
  // left/top explicitly too (and letting right/bottom go auto) is what
  // actually centers the locked box within the space it already had.
  const previous = {
    left: container.style.left,
    top: container.style.top,
    right: container.style.right,
    bottom: container.style.bottom,
    width: container.style.width,
    height: container.style.height,
  };

  container.style.left = `${Math.round((availableWidth - width) / 2)}px`;
  container.style.top = `${Math.round((availableHeight - height) / 2)}px`;
  container.style.right = 'auto';
  container.style.bottom = 'auto';
  container.style.width = `${Math.round(width)}px`;
  container.style.height = `${Math.round(height)}px`;

  viewer.resize();

  return previous;
}

/** Restore whatever lockAspect() returned, and resize back immediately. */
export function unlockAspect(container, viewer, previous) {
  if (!previous) return;
  Object.assign(container.style, previous);
  viewer.resize();
}

/**
 * Run `fn` (sync or async) with the container locked to `ratioKey`'s aspect
 * ratio, then restore the container's own sizing afterward - even if `fn`
 * throws. For a single bounded operation (recording a fixed-duration clip);
 * see lockAspect/unlockAspect above for an open-ended state instead.
 *
 * @param {HTMLElement} container
 * @param {object} viewer
 * @param {'free'|'9:16'|'1:1'} ratioKey
 * @param {() => Promise<any>|any} fn
 */
export async function withAspectLock(container, viewer, ratioKey, fn) {
  const previous = lockAspect(container, viewer, ratioKey);
  try {
    return await fn();
  } finally {
    unlockAspect(container, viewer, previous);
  }
}
