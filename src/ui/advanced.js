// Progressive disclosure: one panel, two depths.
//
// There are ~120 controls now and every phase adds more. The alternative
// considered and rejected was splitting the app into Open and Pro modes; the
// deciding argument against it was that a mode split hides state that is still
// running - a timeline built in Pro keeps driving the render after switching to
// Open, unreachable and invisible, with no way to discover why the image is
// moving. This project already reverted one feature for exactly that failure
// (the tier auto-downgrade silently unchecking a user's own toggles).
//
// So the rule here is the whole point, not a refinement:
//
//   A control that differs from its shipped default stays visible even with
//   Advanced off.
//
// Nothing that is actually affecting the render can ever be hidden. Turning
// Advanced off is therefore always safe - it can only ever hide controls that
// are doing nothing.
//
// Hiding is done with a class rather than the `hidden` attribute on purpose:
// rows already use `hidden` for their own conditional logic (a Style effect's
// parameter rows appear when the effect is switched on, see syncStyleRows in
// main.js). Two independent reasons to hide the same element cannot share one
// attribute without one of them clobbering the other, so they compose here
// instead - either can hide a row, and the row shows only when neither wants
// it hidden.

const HIDDEN_CLASS = 'advanced-hidden';

/**
 * @param {HTMLElement} root       Contains the `[data-advanced]` elements.
 * @param {object} options
 * @param {(id: string) => boolean} options.isAtDefault  From settings.js -
 *   whether a control still holds the value index.html shipped with.
 * @returns {{
 *   setEnabled: (on: boolean) => void,
 *   enabled: () => boolean,
 *   refresh: () => void,
 *   counts: () => {total: number, hidden: number},
 * }}
 */
export function createAdvanced(root, { isAtDefault }) {
  let enabled = false;

  // The rows and their controls are static markup, so this is resolved once
  // rather than re-queried per refresh. That mattered: refresh() runs on every
  // edit, and settings.load() dispatches an event for all ~100 tracked fields
  // at startup - re-querying 70-odd rows inside each of those took a page
  // reload past a 30 second timeout. Caught by the suite's tab-persistence
  // check, which reloads the page.
  const rows = [...root.querySelectorAll('[data-advanced]')].map((element) => ({
    element,
    controls: [...element.querySelectorAll('input[id], select[id], textarea[id]')]
      // The paired readout beside a slider mirrors that slider's own value and
      // is not a separate setting, so it would double-count every change.
      .filter((control) => !control.classList.contains('value-input'))
      .map((control) => control.id),
  }));

  function refresh() {
    for (const { element, controls } of rows) {
      const touched = controls.some((id) => !isAtDefault(id));
      element.classList.toggle(HIDDEN_CLASS, !enabled && !touched);
    }
  }

  // Coalesced to one run per frame. A slider drag fires an event per pixel and
  // a settings restore fires one per field; recomputing on each is wasted work
  // for a result that is only ever looked at once painted.
  let pending = false;
  function scheduleRefresh() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      refresh();
    });
  }

  // Any edit can change whether a row counts as touched, and a reset changes a
  // lot of them at once. Listening on the root covers both without every caller
  // remembering to poke this.
  root.addEventListener('input', scheduleRefresh);
  root.addEventListener('change', scheduleRefresh);

  refresh();

  return {
    setEnabled(on) {
      enabled = on;
      refresh();
    },

    enabled: () => enabled,

    refresh,

    /** For the hint under the switch: how much is currently tucked away. */
    counts() {
      let hidden = 0;
      for (const { element } of rows) if (element.classList.contains(HIDDEN_CLASS)) hidden++;
      return { total: rows.length, hidden };
    },
  };
}
