// static/js/components/knob/knob.js
import RolfsoundControl from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/knob/knob.css?v=player-knob-fix-20260501';

const DEFAULTS = Object.freeze({
  min: 0,
  max: 1,
  step: 0.01,
  value: 0,
  neutral: 0,
  pxPerStep: 2,
  sweep: 270,
  start: -135,
});

class RolfsoundKnob extends RolfsoundControl {
  static get observedAttributes() {
    return ['min', 'max', 'step', 'value', 'neutral', 'px-per-step', 'sweep', 'start'];
  }

  constructor() {
    super();
    this._min = DEFAULTS.min;
    this._max = DEFAULTS.max;
    this._step = DEFAULTS.step;
    this._value = null;
    this._neutral = DEFAULTS.neutral;
    this._pxPerStep = DEFAULTS.pxPerStep;
    this._sweep = DEFAULTS.sweep;
    this._start = DEFAULTS.start;

    this._dragging = false;
    this._startY = 0;
    this._startValue = DEFAULTS.value;
  }

  render() {
    this.shadowRoot.innerHTML = `
      <button class="knob" part="knob" type="button" tabindex="-1" aria-hidden="true">
        <span class="knob-face">
          <span class="knob-notch"></span>
        </span>
        <span class="knob-content">
          <slot></slot>
        </span>
      </button>
    `;

    this._knob = this.shadowRoot.querySelector('.knob');
    this._notch = this.shadowRoot.querySelector('.knob-notch');

    this._readConfig();
    if (this._value == null) {
      this._value = this._normalise(this._numberAttr('value', this._neutral));
    }

    this._ensureA11y();
    this._bind();
    this._paint();

    loadCss(CSS_URL).then(sheet => {
      this.shadowRoot.adoptedStyleSheets = [sheet];
    });
  }

  subscribe() {}

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    this._readConfig();
    if (name === 'value') {
      this.setValue(newValue);
      return;
    }
    if (this._value != null) {
      this._value = this._normalise(this._value);
      this._paint();
    }
  }

  setValue(value) {
    const next = this._normalise(value);
    if (Object.is(this._value, next)) {
      this._syncAria();
      return;
    }
    this._value = next;
    this._paint();
  }

  get value() {
    return this._value ?? this._neutral;
  }

  _bind() {
    this._knob.addEventListener('pointerdown', e => this._onPointerDown(e));
    this._knob.addEventListener('pointermove', e => this._onPointerMove(e));
    this._knob.addEventListener('pointerup', e => this._onPointerRelease(e));
    this._knob.addEventListener('pointercancel', e => this._onPointerRelease(e));
    this._knob.addEventListener('lostpointercapture', () => this._finishDrag());

    this._knob.addEventListener('wheel', e => this._onWheel(e), { passive: false });
    this.addEventListener('keydown', e => this._onKeyDown(e));
  }

  _onPointerDown(e) {
    e.preventDefault();
    this._dragging = true;
    this._startY = e.clientY;
    this._startValue = this.value;
    this._knob.classList.add('dragging');
    this._knob.setPointerCapture(e.pointerId);
  }

  _onPointerMove(e) {
    if (!this._dragging) return;
    e.preventDefault();
    const delta = this._startY - e.clientY;
    const next = this._startValue + (delta / this._pxPerStep) * this._step;
    if (this._setFromInteraction(next)) this._emit('rs-knob-input');
  }

  _onPointerRelease(e) {
    if (!this._dragging) return;
    e.preventDefault();
    this._finishDrag();
    try { this._knob.releasePointerCapture(e.pointerId); } catch {}
    this._emit('rs-knob-change');
  }

  _finishDrag() {
    if (!this._dragging) return;
    this._dragging = false;
    this._knob?.classList.remove('dragging');
  }

  _onWheel(e) {
    e.preventDefault();
    const direction = e.deltaY < 0 ? 1 : -1;
    if (this._setFromInteraction(this.value + direction * this._step)) {
      this._emit('rs-knob-change');
    }
  }

  _onKeyDown(e) {
    let next = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = this.value + this._step;
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = this.value - this._step;
    if (e.key === 'PageUp') next = this.value + this._step * 10;
    if (e.key === 'PageDown') next = this.value - this._step * 10;
    if (e.key === 'Home') next = this._min;
    if (e.key === 'End') next = this._max;
    if (next == null) return;

    e.preventDefault();
    if (this._setFromInteraction(next)) this._emit('rs-knob-change');
  }

  _setFromInteraction(value) {
    const next = this._normalise(value);
    if (Object.is(this._value, next)) return false;
    this._value = next;
    this._paint();
    return true;
  }

  _emit(type) {
    this.dispatchEvent(new CustomEvent(type, {
      bubbles: true,
      composed: true,
      detail: { value: this.value },
    }));
  }

  _readConfig() {
    this._min = this._numberAttr('min', DEFAULTS.min);
    this._max = this._numberAttr('max', DEFAULTS.max);
    if (this._max < this._min) [this._min, this._max] = [this._max, this._min];

    this._step = Math.max(Number.EPSILON, this._numberAttr('step', DEFAULTS.step));
    this._neutral = this._numberAttr('neutral', DEFAULTS.neutral);
    this._pxPerStep = Math.max(0.1, this._numberAttr('px-per-step', DEFAULTS.pxPerStep));
    this._sweep = this._numberAttr('sweep', DEFAULTS.sweep);
    this._start = this._numberAttr('start', DEFAULTS.start);
  }

  _numberAttr(name, fallback) {
    const raw = this.getAttribute(name);
    if (raw == null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  _normalise(value) {
    const number = Number(value);
    const safe = Number.isFinite(number) ? number : this._neutral;
    const clamped = Math.max(this._min, Math.min(this._max, safe));
    const snapped = Math.round((clamped - this._min) / this._step) * this._step + this._min;
    const decimals = Math.min(8, this._stepDecimals() + 2);
    return Number(Math.max(this._min, Math.min(this._max, snapped)).toFixed(decimals));
  }

  _stepDecimals() {
    const text = String(this.getAttribute('step') ?? this._step);
    if (text.includes('e-')) return Number(text.split('e-')[1]) || 0;
    const dot = text.indexOf('.');
    return dot === -1 ? 0 : text.length - dot - 1;
  }

  _paint() {
    if (!this._notch) return;
    const span = this._max - this._min || 1;
    const ratio = (this.value - this._min) / span;
    const rotation = ratio * this._sweep + this._start;
    this._notch.style.transform = `rotate(${rotation}deg)`;
    this._syncAria();
  }

  _ensureA11y() {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'slider');
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
  }

  _syncAria() {
    this.setAttribute('aria-valuemin', String(this._min));
    this.setAttribute('aria-valuemax', String(this._max));
    this.setAttribute('aria-valuenow', String(this.value));
    this.setAttribute('aria-valuetext', String(this.value));
  }
}

if (!customElements.get('rolfsound-knob')) {
  customElements.define('rolfsound-knob', RolfsoundKnob);
}
export default RolfsoundKnob;
