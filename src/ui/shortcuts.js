// Keyboard shortcuts.
//
// Deliberately implemented as synthetic clicks on the existing buttons/
// checkboxes rather than calling viewer methods directly — every one of those
// controls already carries its own disabled-state handling, toast wiring, and
// (for wireframe) the paired <output>/state sync from Track 1.1. Reusing them
// means the shortcut can never drift out of sync with what the button does.
//
//   F      Frame the current model
//   R      Reset camera
//   Space  Play/pause the current animation clip (no-ops safely if none)
//   S      Screenshot
//   W      Toggle wireframe
//   Esc    Collapse the panel (never expands it — Esc closing something is a
//          one-way expectation; there is no modal in this app to close)

const $ = (id) => document.getElementById(id);

/** True while typing would be intercepted — an input, a select, anything editable. */
function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function createShortcuts() {
  const bindings = {
    f: () => $('frameButton').click(),
    r: () => $('resetButton').click(),
    s: () => $('screenshotButton').click(),
    w: () => $('wireframe').click(), // .click() on a checkbox toggles + fires 'change'
    ' ': () => $('playPause').click(),
  };

  function handleKeydown(event) {
    // Never hijack a browser/OS shortcut (Ctrl+S "save", Cmd+R "reload", ...).
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    // Typing into the URL field, a colourway name, or any numeric/hex value
    // field from Track 1.1 must never be interpreted as a shortcut — 's' typed
    // while naming a colourway "Summer" should not fire a screenshot.
    if (isEditableTarget(document.activeElement)) return;

    if (event.key === 'Escape') {
      const panel = $('panel');
      if (panel.dataset.collapsed !== 'true') $('panelToggle').click();
      return;
    }

    const action = bindings[event.key.toLowerCase()];
    if (!action) return;

    event.preventDefault(); // Space, in particular, would otherwise scroll the page.
    action();
  }

  window.addEventListener('keydown', handleKeydown);

  return {
    dispose() {
      window.removeEventListener('keydown', handleKeydown);
    },
  };
}
