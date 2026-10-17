const POSITIONS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];

export function setupPositionPicker({ popover, id, overlayManager }) {
  const parent = popover.parentElement;
  const fieldLabel = parent?.querySelector(':scope > .control-label');
  const wrapper = document.createElement('div');
  wrapper.className = 'position-picker';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'position-picker-trigger';
  trigger.dataset.positionTrigger = id;
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', popover.id);
  trigger.setAttribute('aria-expanded', 'false');
  const icon = document.createElement('span');
  icon.className = 'position-trigger-icon';
  icon.setAttribute('aria-hidden', 'true');
  for (const position of POSITIONS) {
    const dot = document.createElement('i');
    dot.dataset.positionIndicator = position;
    icon.append(dot);
  }
  trigger.append(icon);
  popover.classList.add('position-popover');
  popover.hidden = true;
  popover.setAttribute('role', 'dialog');
  popover.tabIndex = -1;
  parent.insertBefore(wrapper, popover);
  wrapper.append(trigger, popover);
  const popupHost=popover.closest('.settings-sheet')||document.querySelector('#app')||document.body;
  if(popover.parentElement!==popupHost)popupHost.append(popover);

  const syncLabel = () => {
    const label = fieldLabel?.textContent.trim() || popover.getAttribute('aria-label') || 'Position';
    trigger.setAttribute('aria-label', label);
    trigger.title = label;
    popover.setAttribute('aria-label', label);
  };
  const syncSelected = () => {
    const active = popover.querySelector('[data-position].active')?.dataset.position || 'mc';
    trigger.dataset.position = active;
    icon.querySelectorAll('[data-position-indicator]').forEach(dot => dot.classList.toggle('active', dot.dataset.positionIndicator === active));
  };
  const place = () => {
    if (popover.hidden) return;
    const anchor = trigger.getBoundingClientRect();
    const bounds = popover.getBoundingClientRect();
    const margin = 8;
    let left = Math.max(margin, Math.min(window.innerWidth - bounds.width - margin, anchor.right - bounds.width));
    let top = anchor.top - bounds.height - 8;
    if (top < margin) top = anchor.bottom + 8;
    top = Math.max(margin, Math.min(window.innerHeight - bounds.height - margin, top));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  };
  const show = () => {
    syncLabel();
    syncSelected();
    popover.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    place();
  };
  const hide = () => {
    popover.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };

  overlayManager.register(id, { trigger, popover, open: show, close: hide });
  trigger.addEventListener('click', () => overlayManager.isOpen(id) ? overlayManager.close(id) : overlayManager.open(id));
  popover.addEventListener('click', event => {
    if (!event.target.closest('[data-position]')) return;
    requestAnimationFrame(syncSelected);
    overlayManager.close(id, { restoreFocus: true });
  });
  window.addEventListener('resize', place);
  document.addEventListener('scroll', place, true);
  if (fieldLabel) new MutationObserver(syncLabel).observe(fieldLabel, { childList: true, subtree: true, characterData: true });
  syncLabel();
  syncSelected();
  return { trigger, popover, syncSelected, open: () => overlayManager.open(id), close: options => overlayManager.close(id, options) };
}
