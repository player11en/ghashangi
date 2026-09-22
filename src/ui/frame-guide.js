// Render-frame overlay: what Blender's camera passepartout does.
//
// The problem it solves is that this app had no way to see what a clip or
// screenshot would actually crop to *while composing the shot*. The aspect
// lock in aspect-lock.js physically resizes the viewport to the target ratio,
// which is right for the moment a recording runs and wrong for everything
// before it: it changes the canvas resolution, it fights an in-progress orbit,
// and it only exists while a preview or recording is active.
//
// So this is deliberately not that. Nothing here touches the renderer, the
// canvas, or the camera. It is two dimmed bars over the viewport marking the
// region outside the target ratio, `pointer-events: none` so orbiting and
// every other gesture pass straight through. Full resolution, full
// interactivity, guide only - the render is unchanged and the overlay is a
// statement about where the crop will land, not the crop itself.
//
// Kept as its own element rather than drawn into the canvas for the same
// reason: a guide baked into the render would end up in the exported image,
// which is the exact opposite of the point.

/**
 * Ratios as width / height. `null` means no guide.
 *
 * These are the shapes something actually gets exported for: 9:16 for Reels,
 * TikTok and Shorts, 1:1 for a feed post, 4:5 for the taller feed crop, 16:9
 * for video, 4:3 and 3:2 for print-ish stills, 21:9 for a wide hero image.
 */
export const FRAME_RATIOS = {
  free: null,
  '9:16': 9 / 16,
  '4:5': 4 / 5,
  '1:1': 1,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '16:9': 16 / 9,
  '21:9': 21 / 9,
};

/**
 * @param {HTMLElement} container  The viewport element the guide overlays.
 * @returns {{
 *   setRatio: (key: string) => void,
 *   setEnabled: (on: boolean) => void,
 *   refresh: () => void,
 *   dimensions: () => {width: number, height: number} | null,
 *   dispose: () => void,
 * }}
 */
export function createFrameGuide(container) {
  let ratioKey = 'free';
  let enabled = false;

  const root = document.createElement('div');
  root.className = 'frame-guide';
  root.hidden = true;
  // Announced nowhere and focusable by nothing: it is decoration over a canvas
  // whose real state lives in the controls that set it.
  root.setAttribute('aria-hidden', 'true');

  // Four bars rather than a single box with a huge border: letterboxing needs
  // top/bottom only and pillarboxing needs left/right only, and a bar that
  // collapses to zero height simply disappears.
  const bars = {
    top: document.createElement('div'),
    bottom: document.createElement('div'),
    left: document.createElement('div'),
    right: document.createElement('div'),
  };
  for (const [side, bar] of Object.entries(bars)) {
    bar.className = `frame-guide-bar frame-guide-${side}`;
    root.appendChild(bar);
  }

  // A 1px outline on the kept region, so the boundary is readable even when
  // the dimming is subtle or the scene is already dark at the edges.
  const outline = document.createElement('div');
  outline.className = 'frame-guide-outline';
  root.appendChild(outline);

  container.appendChild(root);

  /** The pixel box the guide is describing, or null when there is no guide. */
  function box() {
    const ratio = FRAME_RATIOS[ratioKey];
    if (!ratio) return null;

    const availableWidth = container.clientWidth;
    const availableHeight = container.clientHeight;
    if (!availableWidth || !availableHeight) return null;

    // Contain-fit, the same rule aspect-lock.js uses, so the guide marks
    // exactly the region a recording at this ratio will end up capturing.
    let width = availableWidth;
    let height = width / ratio;
    if (height > availableHeight) {
      height = availableHeight;
      width = height * ratio;
    }

    return {
      width: Math.round(width),
      height: Math.round(height),
      x: Math.round((availableWidth - width) / 2),
      y: Math.round((availableHeight - height) / 2),
    };
  }

  function refresh() {
    const b = box();
    const show = enabled && b !== null;
    root.hidden = !show;
    if (!show) return;

    bars.top.style.height = `${b.y}px`;
    bars.bottom.style.height = `${b.y}px`;
    bars.left.style.width = `${b.x}px`;
    bars.right.style.width = `${b.x}px`;
    // The side bars only span the kept region's height, so the corners are
    // covered once by the top/bottom bars instead of twice - double-dimmed
    // corners are visible and read as a rendering bug.
    bars.left.style.top = `${b.y}px`;
    bars.left.style.bottom = `${b.y}px`;
    bars.right.style.top = `${b.y}px`;
    bars.right.style.bottom = `${b.y}px`;

    outline.style.inset = `${b.y}px ${b.x}px`;
  }

  // The viewport resizes with the window and with the panel collapsing, and the
  // guide is expressed in pixels, so it has to be recomputed rather than
  // described once in CSS.
  const observer = new ResizeObserver(refresh);
  observer.observe(container);

  return {
    setRatio(key) {
      ratioKey = key in FRAME_RATIOS ? key : 'free';
      refresh();
    },

    setEnabled(on) {
      enabled = on;
      refresh();
    },

    refresh,

    /** Output size at the current ratio, for showing real pixel dimensions. */
    dimensions() {
      const b = box();
      return b ? { width: b.width, height: b.height } : null;
    },

    dispose() {
      observer.disconnect();
      root.remove();
    },
  };
}
