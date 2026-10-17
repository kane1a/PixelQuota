export function createOverlayManager(doc = document) {
  const entries = new Map();
  let activeId = null;
  let focusRestoreToken = 0;

  function register(id, { trigger, popover, open, close }) {
    entries.set(id, { trigger, popover, open, close });
    return () => {
      if (activeId === id) activeId = null;
      entries.delete(id);
      close?.();
    };
  }

  function close(id = activeId, { restoreFocus = false } = {}) {
    const entry = entries.get(id);
    if (!entry) return;
    focusRestoreToken++;
    entry.close?.();
    if (activeId === id) activeId = null;
    if (restoreFocus) entry.trigger?.focus();
  }

  function open(id) {
    const entry = entries.get(id);
    if (!entry) return;
    focusRestoreToken++;
    if (activeId && activeId !== id) close(activeId);
    entry.open?.();
    activeId = id;
  }

  function isOpen(id) {
    return activeId === id;
  }

  doc.addEventListener('pointerdown', event => {
    focusRestoreToken++;
    if (!activeId) return;
    const id = activeId;
    const entry = entries.get(id);
    if (!entry || entry.trigger?.contains(event.target) || entry.popover?.contains(event.target)) return;
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    const focusable = target?.closest?.('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"]),[contenteditable="true"],[role="button"],[role="link"]');
    close(id);
    if (focusable) return;
    const token = focusRestoreToken;
    const restore = () => {
      if (token !== focusRestoreToken || activeId !== null) return;
      const active = doc.activeElement;
      if (active && active !== doc.body && active !== doc.documentElement && !entry.popover?.contains(active)) return;
      if (!entry.trigger?.isConnected || entry.trigger.disabled) return;
      entry.trigger.focus();
    };
    doc.defaultView.requestAnimationFrame(() => doc.defaultView.requestAnimationFrame(restore));
  });

  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !activeId) return;
    event.preventDefault();
    close(activeId, { restoreFocus: true });
  });

  return { register, open, close, isOpen, get activeId() { return activeId; } };
}
