// Tab groups for the control panel.
//
// The panel reached thirteen accordion sections in one scrolling column, with a
// thirteen-button jump rail beside it to make that navigable. Both patterns
// were past their useful range at once: every section competed with every other
// for the same column, and the rail had become a second list to learn rather
// than a shortcut into the first.
//
// Sections are unchanged - they are still the same `.group` accordions, with
// the same open/closed state and the same persistence. This only decides which
// *set* of them is on screen, so the accordion keeps doing exactly one job and
// this keeps the other. The tab bar replaces the rail outright.
//
// Deliberately not a mode switch: every tab drives the same scene, the same
// engine and the same export path. Grouping controls is a layout decision, and
// nothing here gates a feature behind a "mode" the way a second app shell
// would.

/**
 * @param {HTMLElement} tabBar   Contains the `.tab` buttons.
 * @param {HTMLElement} root     Contains the `.tab-panel` elements.
 * @returns {{
 *   activate: (key: string) => void,
 *   active: () => string,
 *   keys: () => string[],
 *   syncVisibility: () => void,
 * }}
 */
export function createTabs(tabBar, root) {
  const buttons = [...tabBar.querySelectorAll('.tab')];
  const byKey = new Map();

  for (const button of buttons) {
    const panel = root.querySelector(`#${button.getAttribute('aria-controls')}`);
    if (panel) byKey.set(button.dataset.tab, { button, panel });
  }

  let activeKey = buttons.find((b) => b.getAttribute('aria-selected') === 'true')?.dataset.tab
    ?? buttons[0]?.dataset.tab;

  function activate(key) {
    if (!byKey.has(key)) return;
    activeKey = key;
    for (const [k, { button, panel }] of byKey) {
      const on = k === key;
      panel.hidden = !on;
      button.setAttribute('aria-selected', String(on));
    }
    // A tab switch is a jump to a different set of controls, so the previous
    // tab's scroll position is not meaningful in the new one.
    root.scrollTop = 0;
  }

  for (const [key, { button }] of byKey) {
    button.addEventListener('click', () => activate(key));
  }

  // Left/right arrows move between tabs, which is what a role="tablist" tells
  // a screen-reader user to expect. Without this the role would be a lie.
  tabBar.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const visible = buttons.filter((b) => !b.hidden);
    const index = visible.findIndex((b) => b.dataset.tab === activeKey);
    const next = visible[(index + step + visible.length) % visible.length];
    if (next) {
      activate(next.dataset.tab);
      next.focus();
    }
  });

  /**
   * Hide a tab whose every section has hidden *itself* - distinct from a
   * section the user merely collapsed, which still belongs on its tab.
   *
   * In practice only `#animationGroup` does this (a model with no clips), and
   * it shares the Model tab with three other sections, so no tab empties
   * today. It is here so that stops being a thing to remember: any future
   * self-hiding section gets the correct behaviour without a second fix.
   */
  function syncVisibility() {
    for (const [key, { button, panel }] of byKey) {
      const sections = [...panel.querySelectorAll('.group')];
      const allHidden = sections.length > 0 && sections.every((s) => s.hidden);
      button.hidden = allHidden;
      if (allHidden && key === activeKey) {
        const fallback = buttons.find((b) => !b.hidden)?.dataset.tab;
        if (fallback) activate(fallback);
      }
    }
  }

  activate(activeKey);
  syncVisibility();

  return {
    activate,
    active: () => activeKey,
    keys: () => [...byKey.keys()],
    syncVisibility,
  };
}
