// User-visible messages.
//
// B19: every loader in the original passed `function () { console.log('An error
// happened'); }` as its onError. A model that failed to parse looked identical
// to one still loading — the app just sat there. The only error that ever
// reached the user was an unsupported extension, via alert().

const AUTO_DISMISS_MS = { info: 4000, warn: 7000, error: 11000 };

/** @param {HTMLElement} container */
export function createToasts(container) {
  /**
   * @param {string} title
   * @param {{detail?: string, level?: 'info'|'warn'|'error', sticky?: boolean}} [options]
   * @returns {() => void} dismiss
   */
  function show(title, { detail, level = 'info', sticky = false } = {}) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.level = level;

    const titleEl = document.createElement('div');
    titleEl.className = 'toast-title';
    titleEl.textContent = title;
    el.appendChild(titleEl);

    if (detail) {
      const detailEl = document.createElement('p');
      detailEl.className = 'toast-detail';
      detailEl.textContent = detail;
      el.appendChild(detailEl);
    }

    container.appendChild(el);

    let timer = null;
    const dismiss = () => {
      if (timer) clearTimeout(timer);
      el.remove();
    };

    // Clicking anywhere on a toast dismisses it; errors stay until then.
    el.addEventListener('click', dismiss);
    if (!sticky) timer = setTimeout(dismiss, AUTO_DISMISS_MS[level]);

    return dismiss;
  }

  return {
    show,
    info: (title, detail) => show(title, { detail, level: 'info' }),
    warn: (title, detail) => show(title, { detail, level: 'warn' }),
    error: (title, detail) => show(title, { detail, level: 'error', sticky: true }),
  };
}
