// Collapsible panel sections.
//
// Each `<h2 class="group-title">` is wrapped by a real `<button>` (native
// keyboard/click support for free — no reinvented role="button" + keydown
// handling needed) controlling a sibling `<div class="group-body">`.
//
// This file used to own a 13-button jump rail as well. That moved to tabs.js
// when the section count outgrew a single scrolling column: deciding which
// *set* of sections is on screen is a different job from remembering which
// ones the user left open, and they are now separate files.
//
// Two independent hidden mechanisms coexist on purpose. A section's own
// `hidden` attribute (e.g. `#animationGroup` hides itself entirely when the
// loaded model has no clips) is orthogonal to the accordion's `.group-body`
// `hidden` (does the *user* currently want this section open). Both are
// consulted separately; tabs.js's syncVisibility() is what keeps a tab from
// offering sections that have all hidden themselves.

/**
 * @param {HTMLElement} panelRoot  Contains the `.group` sections.
 * @returns {{
 *   setSectionOpen: (id: string, open: boolean) => void,
 *   isSectionOpen: (id: string) => boolean,
 *   sectionIds: () => string[],
 * }}
 */
export function createAccordion(panelRoot) {
  function setOpen(section, body, button, open) {
    body.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }

  // Keyed by section id (`${id}Body` is the body element's real id) — one
  // lookup shared by click handling and settings.js's persisted-state restore,
  // so there is exactly one place that resolves "section id" to its elements.
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

  return {
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
