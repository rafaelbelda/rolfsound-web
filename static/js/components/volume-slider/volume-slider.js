// static/js/components/volume-slider/volume-slider.js
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/volume-slider/volume-slider.css';

class RolfsoundVolumeSlider extends RolfsoundControl {
  constructor() {
    super();
    this._volume       = 1.0;
    this._dragging     = false;
    this._guardUntilMs = 0;
    this._open         = false;
  }

  render() {
    this.shadowRoot.innerHTML = `
      <div class="vol-wrap">
        <button class="hover-target" title="Volume" aria-label="Volume">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path class="vol-wave-2" d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
            <path class="vol-wave-3" d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
          </svg>
        </button>
        <div class="track-wrap" aria-hidden="true">
          <div class="vol-track">
            <div class="vol-fill"></div>
            <div class="vol-thumb"></div>
          </div>
        </div>
      </div>
    `;

    this._btn   = this.shadowRoot.querySelector('button');
    this._track = this.shadowRoot.querySelector('.vol-track');
    this._fill  = this.shadowRoot.querySelector('.vol-fill');
    this._thumb = this.shadowRoot.querySelector('.vol-thumb');

    this._btn.addEventListener('click', () => this._toggleOpen());
    this._track.addEventListener('pointerdown', (e) => this._onPointerDown(e));

    loadCss(CSS_URL).then(sheet => { this.shadowRoot.adoptedStyleSheets = [sheet]; });
  }

  subscribe() {
    this.on('state.playback', s => {
      if (Date.now() < this._guardUntilMs) return;
      if (typeof s.volume === 'number') {
        this._volume = Math.max(0, Math.min(1, s.volume));
        this._syncVisual();
      }
    });
  }

  _toggleOpen() {
    this._open = !this._open;
    this.classList.toggle('open', this._open);
  }

  _syncVisual() {
    const pct = this._volume * 100;
    if (this._fill)  this._fill.style.height  = `${pct}%`;
    if (this._thumb) this._thumb.style.bottom  = `${pct}%`;
    this._updateIcon();
  }

  _updateIcon() {
    const wave2 = this.shadowRoot.querySelector('.vol-wave-2');
    const wave3 = this.shadowRoot.querySelector('.vol-wave-3');
    if (!wave2 || !wave3) return;
    wave2.style.opacity = this._volume > 0.05 ? '1' : '0';
    wave3.style.opacity = this._volume > 0.4  ? '1' : '0';
  }

  _onPointerDown(e) {
    e.preventDefault();
    this._dragging = true;
    this._track.setPointerCapture(e.pointerId);
    this._applyPointer(e);

    const onMove = (ev) => { if (this._dragging) this._applyPointer(ev); };
    const onUp   = (ev) => {
      this._dragging = false;
      this._track.removeEventListener('pointermove', onMove);
      this._track.removeEventListener('pointerup',   onUp);
      this._applyPointer(ev);
      this._guardUntilMs = Date.now() + 800;
      this.send('intent.volume.set', { value: this._volume });
    };

    this._track.addEventListener('pointermove', onMove);
    this._track.addEventListener('pointerup',   onUp);
  }

  _applyPointer(e) {
    const rect   = this._track.getBoundingClientRect();
    const relY   = e.clientY - rect.top;
    const pct    = 1 - Math.max(0, Math.min(1, relY / rect.height));
    this._volume = Math.round(pct * 100) / 100;
    this._syncVisual();
  }
}

customElements.define('rolfsound-volume-slider', RolfsoundVolumeSlider);
export default RolfsoundVolumeSlider;
