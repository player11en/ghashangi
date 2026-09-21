// Keyboard shortcuts.
//
// Deliberately implemented as synthetic clicks on the existing buttons/
// checkboxes rather than calling viewer methods directly — every one of those
// controls already carries its own disabled-state handling, toast wiring, and
// (for wireframe) the paired <output>/state sync from Track 1.1. Reusing them
// means the shortcut can never drift out of sync with what the button does.
//
//   F           Frame the current model
//   R           Reset camera
//   Space       Play/pause the current animation clip (no-ops safely if none)
//   S           Screenshot
//   W           Toggle wireframe
//   Ctrl+Z      Undo the last material edit
//   Ctrl+Shift+Z  Redo
//   Esc         Collapse the panel (never expands it — Esc closing something
//               is a one-way expectation; there is no modal in this app to close)

const $ = (id) => document.getElementById(id);

/** True while typing would be intercepted — an input, a select, anything editable. */
function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Narrower than isEditableTarget(), for Ctrl+Z specifically: a numeric/hex
 * `.value-input` field (Track 1.1) or a color/range picker commits one
 * structured value on change rather than accumulating freeform keystrokes,
 * so there's no meaningful per-keystroke native undo to preserve there the
 * way there is in a colourway name or the URL field - material-undo should
 * win in those fields, not back off from them.
 */
function blocksUndoShortcut(target) {
  if (!target) return false;
  if (target.tagName === 'TEXTAREA' || target.isContentEditable) return true;
  if (target.tagName === 'SELECT') return true;
  if (target.tagName === 'INPUT') {
    if (target.classList.contains('value-input')) return false;
    if (target.type === 'color' || target.type === 'range') return false;
    return true;
  }
  return false;
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
    // Ctrl/Cmd+Z is common and expected enough to special-case ahead of the
    // "never hijack a browser/OS shortcut" rule below - but still backs off
    // in a genuine freeform text field (colourway name, custom ASCII ramp,
    // the URL box), so editing one of those keeps the browser's own native
    // text-undo. A numeric/hex value field or a color/range picker doesn't
    // get that treatment - see blocksUndoShortcut()'s own doc comment.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      if (blocksUndoShortcut(document.activeElement)) return;
      event.preventDefault();
      if (event.shiftKey) $('materialRedo').click();
      else $('materialUndo').click();
      return;
    }

    // Never hijack any other browser/OS shortcut (Ctrl+S "save", Cmd+R "reload", ...).
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
