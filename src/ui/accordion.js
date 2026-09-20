// Collapsible panel sections + a jump rail.
//
// The panel had grown to 11 sections, all permanently expanded, in one long
// scroll. Each `<h2 class="group-title">` is now wrapped by a real `<button>`
// (native keyboard/click support for free — no reinvented role="button" +
// keydown handling needed) controlling a sibling `<div class="group-body">`.
// A vertical rail alongside the panel jumps straight to a section instead of
// scrolling to find it.
//
// Two independent hidden mechanisms coexist on purpose. A section's own
// `hidden` attribute (e.g. `#animationGroup` hides itself entirely when the
// loaded model has no clips) is orthogonal to the accordion's `.group-body`
// `hidden` (does the *user* currently want this section open). Both are
// consulted separately; syncRailVisibility() is what keeps the rail from
// offering a jump to a section that has hidden itself.

/**
 * @param {HTMLElement} panelRoot  Contains the `.group` sections.
 * @param {HTMLElement} rail       Contains the `.rail-button`s.
 * @returns {{
 *   syncRailVisibility: () => void,
 *   setSectionOpen: (id: string, open: boolean) => void,
 *   isSectionOpen: (id: string) => boolean,
 *   sectionIds: () => string[],
 * }}
 */
export function createAccordion(panelRoot, rail) {
  function setOpen(section, body, button, open) {
    body.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }

  // Keyed by the same id a rail button's data-jump uses (`${id}Body` is the
  // body element's real id) — one lookup shared by click handling, the rail,
  // and settings.js's persisted-state restore, so there is exactly one place
  // that resolves "section id" to its three elements.
  const byId = new Map();
  for (const body of panelRoot.querySelectorAll('.group-body')) {
    const id = body.id.replace(/Body$/, '');
    const section = body.closest('.group');
    const button = section?.querySelector('.group-title');
    if (section && button) byId.set(id, { section, body, button });
  }

  for (const { section, body, button } of byId.values()) {
    button.addEventListener('click', () => {
      setOpen(section, body, button, body.hidden);
    });
  }

  // Rail buttons: open the target section (if collapsed) and scroll it into
  // view. Doesn't touch any other section's state — this is "jump to", not an
  // exclusive single-open accordion.
  for (const railButton of rail.querySelectorAll('.rail-button')) {
    railButton.addEventListener('click', () => {
      const entry = byId.get(railButton.dataset.jump);
      if (!entry) return;
      if (entry.body.hidden) setOpen(entry.section, entry.body, entry.button, true);
      entry.section.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  /**
   * Hide a rail button when its section has hidden itself (distinct from the
   * user having collapsed it — a collapsed-but-present section still gets a
   * working rail button, since clicking it is exactly how you'd reopen it).
   */
  function syncRailVisibility() {
    for (const railButton of rail.querySelectorAll('.rail-button')) {
      railButton.hidden = Boolean(byId.get(railButton.dataset.jump)?.section.hidden);
    }
  }

  syncRailVisibility();

  return {
    syncRailVisibility,

    /** Used by settings.js to restore last session's open/closed state. */
    setSectionOpen(id, open) {
      const entry = byId.get(id);
      if (entry) setOpen(entry.section, entry.body, entry.button, open);
    },

    isSectionOpen(id) {
      return !byId.get(id)?.body.hidden;
    },

    sectionIds() {
      return [...byId.keys()];
    },
  };
}
