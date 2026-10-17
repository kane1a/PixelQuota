const DEFAULT_INPUTS = '#watermarkOpacity,#watermarkSize,#watermarkImageOpacity,#watermarkImageSize,#redactStrength';

function numberWithinBounds(input, value) {
  const min = input.min === '' ? -Infinity : Number(input.min);
  const max = input.max === '' ? Infinity : Number(input.max);
  return Math.max(min, Math.min(max, value));
}

function fire(input, type) {
  input.dispatchEvent(new Event(type, { bubbles: true }));
}

export function createNumericControls({ root = document, onDragStart = () => {}, onDragEnd = () => {} } = {}) {
  const inputs = [...root.querySelectorAll(DEFAULT_INPUTS)];
  const refreshLabels = () => {
    for (const input of inputs) {
      const control = input.closest('.numeric-control');
      if (!control) continue;
      const label = input.closest('.setting-control')?.querySelector('.control-label')?.textContent.trim() || input.getAttribute('aria-label') || input.id;
      const minus = control.querySelector('[data-numeric-step="-1"]');
      const plus = control.querySelector('[data-numeric-step="1"]');
      if (minus) minus.setAttribute('aria-label', `${label} −`);
      if (plus) plus.setAttribute('aria-label', `${label} +`);
    }
  };

  for (const input of inputs) {
    input.type = 'number';
    if (!input.step || input.step === 'any') input.step = '1';
    input.inputMode = 'numeric';
    input.classList.add('numeric-value');

    const wrapper = document.createElement('div');
    wrapper.className = 'numeric-control';
    wrapper.dataset.numericControl = input.id;
    const shell = document.createElement('div');
    shell.className = 'numeric-input-shell';
    const unit = document.createElement('span');
    unit.className = 'numeric-unit';
    unit.setAttribute('aria-hidden', 'true');
    unit.textContent = '%';

    const makeButton = (step, text) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'numeric-step-button';
      button.dataset.numericStep = String(step);
      button.textContent = text;
      return button;
    };
    const decrement = makeButton(-1, '−');
    const increment = makeButton(1, '+');
    input.before(wrapper);
    wrapper.append(decrement, shell, increment);
    shell.append(input, unit);

    const stepSize = () => {
      const step = Number(input.step);
      return Number.isFinite(step) && step > 0 ? step : 1;
    };
    const parsedValue = value => String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
    const legalDefault = () => {
      const initial = parsedValue(input.defaultValue);
      if (initial !== null) return numberWithinBounds(input, initial);
      const min = input.min === '' ? NaN : Number(input.min);
      if (Number.isFinite(min)) return numberWithinBounds(input, min);
      const max = input.max === '' ? NaN : Number(input.max);
      return Number.isFinite(max) ? numberWithinBounds(input, Math.min(0, max)) : 0;
    };
    let committedValue = parsedValue(input.value);
    if (committedValue === null) committedValue = legalDefault();
    else committedValue = numberWithinBounds(input, committedValue);
    let hasPendingInput = false;
    let committing = false;
    input.addEventListener('input', () => { if (!committing) hasPendingInput = true; });
    const commit = event => {
      if (committing) return;
      const previous = committedValue;
      const wasPending = hasPendingInput;
      const parsed = parsedValue(input.value);
      const next = numberWithinBounds(input, parsed === null ? committedValue : parsed);
      const changed = input.value !== String(next);
      committedValue = next;
      if (!changed) {
        if (event?.type === 'change') hasPendingInput = false;
        if (event?.type === 'keydown' && event.key === 'Enter' && wasPending && next === previous) {
          committing = true;
          try { fire(input, 'change'); } finally { committing = false; }
          hasPendingInput = false;
        }
        return;
      }
      input.value = String(next);
      committing = true;
      try {
        fire(input, 'input');
        if (event?.type !== 'change' && next === previous) fire(input, 'change');
      } finally { committing = false; }
      if (event?.type === 'change' || event?.type === 'blur' || event?.key === 'Enter') hasPendingInput = false;
    };
    input.addEventListener('change', event => commit(event));
    input.addEventListener('blur', event => commit(event));
    const current = () => Number.isFinite(Number(input.value)) ? Number(input.value) : Number(input.min || 0);
    const update = (delta, commit = false) => {
      const next = numberWithinBounds(input, current() + delta);
      if (next === current()) return;
      input.value = String(next);
      fire(input, 'input');
      if (commit) fire(input, 'change');
    };
    decrement.addEventListener('click', () => update(-stepSize(), true));
    increment.addEventListener('click', () => update(stepSize(), true));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        commit(event);
        return;
      }
      const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -1 : 0;
      if (!direction) return;
      event.preventDefault();
      update(direction * stepSize() * (event.shiftKey ? 10 : 1));
    });
    input.addEventListener('keyup', event => {
      if (event.key.startsWith('Arrow')) fire(input, 'change');
    });

    const label = input.closest('.setting-control')?.querySelector('.control-label');
    if (label) {
      let drag = null;
      let pending = null;
      let frame = 0;
      const flush = () => {
        frame = 0;
        if (pending === null) return;
        const next = pending;
        pending = null;
        if (next !== current()) {
          input.value = String(next);
          fire(input, 'input');
        }
      };
      label.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('button,input')) return;
        drag = { pointerId: event.pointerId, x: event.clientX, value: current(), changed: false };
        label.setPointerCapture?.(event.pointerId);
      });
      label.addEventListener('pointermove', event => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const distance = event.clientX - drag.x;
        if (!drag.changed && Math.abs(distance) < 4) return;
        if (!drag.changed) {
          drag.changed = true;
          onDragStart(input);
        }
        event.preventDefault();
        pending = numberWithinBounds(input, drag.value + Math.round(distance / 6) * stepSize());
        if (!frame) frame = requestAnimationFrame(flush);
      });
      const finish = event => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (frame) cancelAnimationFrame(frame);
        flush();
        const didChange = drag.changed;
        drag = null;
        if (didChange) {
          fire(input, 'change');
          onDragEnd(input);
        }
        if (label.hasPointerCapture?.(event.pointerId)) label.releasePointerCapture(event.pointerId);
      };
      label.addEventListener('pointerup', finish);
      label.addEventListener('pointercancel', finish);
    }
  }
  refreshLabels();
  return { inputs, refreshLabels };
}
