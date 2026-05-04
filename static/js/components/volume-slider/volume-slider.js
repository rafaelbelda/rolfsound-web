// static/js/components/volume-slider/volume-slider.js
import RolfsoundControl from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';
import '../knob/knob.js?v=player-knob-fix-20260501';

const CSS_URL = '/static/js/components/volume-slider/volume-slider.css?v=player-knob-fix-20260501';

const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

const throttle = (func, limit) => {
  let inThrottle = false;
  return function(...args) {
    if (inThrottle) return;
    func.apply(this, args);
    inThrottle = true;
    setTimeout(() => { inThrottle = false; }, limit);
  };
};

class RolfsoundVolumeSlider extends RolfsoundControl {
  constructor() {
    super();
    this._volume = 1;
    this._guardUntilMs = 0;

    this._sendThrottledVol = throttle((volume) => {
      this.send('intent.volume.set', { value: volume });
    }, 50);
  }

  render() {
    this.shadowRoot.innerHTML = `
      <rolfsound-knob class="vol-knob" min="0" max="1" step="0.01" value="1" neutral="0"
        px-per-step="2" sweep="270" start="-135" data-cursor="range" aria-label="Volume">
        <svg class="speaker-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
          <path class="vol-wave-2" d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          <path class="vol-wave-3" d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
        </svg>
      </rolfsound-knob>
    `;

    this._knob = this.shadowRoot.querySelector('rolfsound-knob');
    this._wave2 = this.shadowRoot.querySelector('.vol-wave-2');
    this._wave3 = this.shadowRoot.querySelector('.vol-wave-3');

    this._knob.addEventListener('rs-knob-input', e => this._onKnobInput(e.detail.value));
    this._knob.addEventListener('rs-knob-change', e => this._onKnobChange(e.detail.value));

    loadCss(CSS_URL).then(sheet => {
      this.shadowRoot.adoptedStyleSheets = [sheet];
    });

    this._syncVisual();
  }

  subscribe() {
    this.on('state.playback', s => {
      if (Date.now() < this._guardUntilMs) return;
      if (typeof s.volume !== 'number') return;
      this._volume = clamp01(s.volume);
      this._syncVisual();
    });
  }

  _onKnobInput(value) {
    this._volume = clamp01(value);
    this._guardUntilMs = Date.now() + 800;
    this._syncVisual();
    this._sendThrottledVol(this._volume);
  }

  _onKnobChange(value) {
    this._volume = clamp01(value);
    this._guardUntilMs = Date.now() + 800;
    this._syncVisual();
    this.send('intent.volume.set', { value: this._volume });
  }

  _syncVisual() {
    this._knob?.setValue(this._volume);
    this._knob?.setAttribute('aria-valuetext', `${Math.round(this._volume * 100)}%`);
    this._updateIcon();
  }

  _updateIcon() {
    if (!this._wave2 || !this._wave3) return;
    this._wave2.style.opacity = this._volume > 0.05 ? '1' : '0';
    this._wave3.style.opacity = this._volume > 0.4 ? '1' : '0';
  }
}

customElements.define('rolfsound-volume-slider', RolfsoundVolumeSlider);
export default RolfsoundVolumeSlider;
