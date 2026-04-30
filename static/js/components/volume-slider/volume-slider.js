// static/js/components/volume-slider/volume-slider.js
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/volume-slider/volume-slider.css';

// Utilitário de limite de cadência (Throttle)
const throttle = (func, limit) => {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  }
};

class RolfsoundVolumeSlider extends RolfsoundControl {
  constructor() {
    super();
    this._volume       = 1.0;
    this._dragging     = false;
    this._guardUntilMs = 0;
    this._open         = false;
    this._trackHeight  = 100;
    this._dragRect     = null;
    this._lastVisualRatio = -1;

    // CRIAMOS O ENVIO SUAVE USANDO A SUA PRÓPRIA ABSTRAÇÃO (this.send)
    // 50ms é seguro para o hardware de áudio processar sem engarrafar.
    this._sendThrottledVol = throttle((vol) => {
      this.send('intent.volume.set', { value: vol });
    }, 50);
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
          <div class="vol-track" data-cursor="range" role="slider" aria-label="Volume">
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
    const ratio = Math.max(0, Math.min(1, this._volume));
    if (ratio !== this._lastVisualRatio) {
      if (this._fill) {
        this._fill.style.transform = `scale3d(1, ${ratio}, 1)`;
      }
      if (this._thumb) {
        const y = -this._trackHeight * ratio;
        this._thumb.style.transform = `translate3d(-50%, ${y}px, 0) translateY(50%)`;
      }
      this._lastVisualRatio = ratio;
    }
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
    this._dragRect = this._track.getBoundingClientRect();
    this._trackHeight = this._dragRect.height || this._trackHeight;
    this._applyPointer(e);

    const onMove = (ev) => { 
      if (this._dragging) {
        this._applyPointer(ev);
        this._guardUntilMs = Date.now() + 800;
      }
    };

    const onUp = (ev) => {
      this._dragging = false;
      this._track.removeEventListener('pointermove', onMove);
      this._track.removeEventListener('pointerup',   onUp);
      
      this._applyPointer(ev);
      this._dragRect = null;
      
      // O toque final envia SEM throttle para cravar o número exato onde o dedo parou
      this.send('intent.volume.set', { value: this._volume });
      this._guardUntilMs = Date.now() + 800;
    };

    this._track.addEventListener('pointermove', onMove);
    this._track.addEventListener('pointerup',   onUp);
  }

  _applyPointer(e) {
    const rect   = this._dragRect || this._track.getBoundingClientRect();
    const relY   = e.clientY - rect.top;
    const pct    = 1 - Math.max(0, Math.min(1, relY / rect.height));
    this._volume = Math.round(pct * 100) / 100;
    
    // 1. Optimistic UI: O ecrã atualiza na mesma hora (Latência 0 visual)
    this._syncVisual();

    // 2. Real-time Audio: Informa o servidor enquanto arrasta (com suavidade)
    if (this._dragging) {
      this._sendThrottledVol(this._volume);
    }
  }
}

customElements.define('rolfsound-volume-slider', RolfsoundVolumeSlider);
export default RolfsoundVolumeSlider;
