// Loading progress readout.
//
// The original logged `loaded / total * 100 + '% loaded'` to the console and
// showed the user nothing, so a 4.4MB model on a slow connection was
// indistinguishable from a broken one.
//
// Indeterminate state matters more than it sounds: ProgressEvent.total is 0 for
// any response without a Content-Length (most gzip-encoded static servers), and
// the original divided by it, producing `Infinity% loaded`.

/**
 * @param {object} elements
 * @param {HTMLElement} elements.root
 * @param {HTMLElement} elements.fill
 * @param {HTMLElement} elements.label
 */
export function createProgress({ root, fill, label }) {
  let active = 0;

  function begin(text = 'Loading…') {
    active++;
    root.hidden = false;
    label.textContent = text;
    fill.style.width = '0%';
    fill.dataset.indeterminate = 'true';
  }

  /**
   * @param {number|null} fraction 0..1, or null when the total is unknown.
   * @param {string} [text]
   */
  function update(fraction, text) {
    if (text) label.textContent = text;
    if (fraction === null || !Number.isFinite(fraction)) {
      fill.dataset.indeterminate = 'true';
      return;
    }
    delete fill.dataset.indeterminate;
    const pct = Math.max(0, Math.min(1, fraction)) * 100;
    fill.style.width = `${pct.toFixed(1)}%`;
  }

  function end() {
    active = Math.max(0, active - 1);
    if (active > 0) return;
    fill.style.width = '100%';
    delete fill.dataset.indeterminate;
    // Let the filled bar register before it disappears.
    setTimeout(() => {
      if (active === 0) root.hidden = true;
    }, 220);
  }

  return { begin, update, end };
}

/** Human-readable byte count for progress labels. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
