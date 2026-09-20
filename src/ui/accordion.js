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

const $ = (id) => document.getElementById(id);

/**
 * @param {HTMLElement} panelRoot  Contains the `.group` sections.
 * @param {HTMLElement} rail       Contains the `.rail-button`s.
 * @returns {{ syncRailVisibility: () => void }}
 */
export function createAccordion(panelRoot, rail) {
  const sections = [...panelRoot.querySelectorAll('.group')];

  function setOpen(section, body, button, open) {
    body.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }

  for (const section of sections) {
    const button = section.querySelector('.group-title');
    const body = section.querySelector('.group-body');
    if (!button || !body) continue; // defensive: every section should have both

    button.addEventListener('click', () => {
      setOpen(section, body, button, body.hidden);
    });
  }

  // Rail buttons: open the target section (if collapsed) and scroll it into
  // view. Doesn't touch any other section's state — this is "jump to", not an
  // exclusive single-open accordion.
  for (const railButton of rail.querySelectorAll('.rail-button')) {
    railButton.addEventListener('click', () => {
      const id = railButton.dataset.jump;
      const body = $(`${id}Body`);
      const button = body?.closest('.group')?.querySelector('.group-title');
      const section = body?.closest('.group');
      if (!body || !button || !section) return;

      if (body.hidden) setOpen(section, body, button, true);
      section.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  /**
   * Hide a rail button when its section has hidden itself (distinct from the
   * user having collapsed it — a collapsed-but-present section still gets a
   * working rail button, since clicking it is exactly how you'd reopen it).
   */
  function syncRailVisibility() {
    for (const railButton of rail.querySelectorAll('.rail-button')) {
      const section = $(`${railButton.dataset.jump}Body`)?.closest('.group');
      railButton.hidden = Boolean(section?.hidden);
    }
  }

  syncRailVisibility();
  return { syncRailVisibility };
}
