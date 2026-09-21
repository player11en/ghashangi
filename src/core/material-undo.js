// Material-edit undo/redo.
//
// Scoped deliberately narrow: undo for material state (base color, blend,
// channels, emissive, opacity - anything captureMaterialState()/
// applyMaterialState() already round-trip for colourways), not a general
// command stack for the whole app. Flagged as a real gap, not built until
// asked for - a material editor with colourways and texture edits genuinely
// needs a way back that isn't "reset to the authored look and start over."
//
// Snapshot-based, not diff-based: captureMaterialState()/applyMaterialState()
// already exist (colourways.js uses the exact same pair), so an undo step is
// just "the material state before this edit," pushed onto a stack.
//
// Granularity is the real design problem here, not the stack itself. A
// slider fires many rapid changes per drag; recording one undo step per
// change would make undo useless (fifty clicks to undo one drag). So edits
// are coalesced: the state captured is always "before the current burst of
// edits," and a burst commits to the undo stack after a short idle gap -
// the same debounce shape settings.js already uses for its own autosave,
// for the same reason (a slider's 'input' event fires on every pixel of
// movement).

const DEBOUNCE_MS = 500;

/**
 * @param {object} options
 * @param {object} options.viewer  Needs captureMaterialState()/applyMaterialState().
 */
export function createMaterialUndo({ viewer }) {
  const undoStack = [];
  const redoStack = [];

  // The state as of the end of the last committed burst (or the last
  // undo/redo) - what a *new* burst's undo step should roll back to, since
  // by the time recordChange() first fires for a new burst, the mutation it
  // is reporting has already happened.
  let lastKnownState = null;
  let pendingBefore = null;
  let debounceTimer = null;
  let restoring = false;
  let onChange = () => {};

  function commitPending() {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    if (pendingBefore === null) return;
    undoStack.push(pendingBefore);
    pendingBefore = null;
    redoStack.length = 0; // a new edit invalidates whatever redo branch existed
    lastKnownState = viewer.captureMaterialState();
    onChange();
  }

  /** Call after every material-affecting change (viewer.onMaterialChange()). */
  function recordChange() {
    if (restoring) return;
    if (pendingBefore === null) pendingBefore = lastKnownState;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(commitPending, DEBOUNCE_MS);
  }

  /** Call once a model's materials are ready (new load) - starts a fresh history. */
  function reset() {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    pendingBefore = null;
    undoStack.length = 0;
    redoStack.length = 0;
    lastKnownState = viewer.captureMaterialState();
    onChange();
  }

  function undo() {
    commitPending(); // flush any in-progress burst first, so it isn't lost
    const previous = undoStack.pop();
    if (!previous) return false;
    redoStack.push(viewer.captureMaterialState());
    restoring = true;
    viewer.applyMaterialState(previous);
    restoring = false;
    lastKnownState = viewer.captureMaterialState();
    onChange();
    return true;
  }

  function redo() {
    const next = redoStack.pop();
    if (!next) return false;
    undoStack.push(viewer.captureMaterialState());
    restoring = true;
    viewer.applyMaterialState(next);
    restoring = false;
    lastKnownState = viewer.captureMaterialState();
    onChange();
    return true;
  }

  return {
    recordChange,
    reset,
    undo,
    redo,
    get canUndo() {
      return undoStack.length > 0 || pendingBefore !== null;
    },
    get canRedo() {
      return redoStack.length > 0;
    },
    /** Called whenever canUndo/canRedo might have changed, for button state. */
    onChange(callback) {
      onChange = callback ?? (() => {});
    },
  };
}
