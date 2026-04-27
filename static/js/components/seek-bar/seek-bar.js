// static/js/components/seek-bar/seek-bar.js
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';
// Caminho corrigido para subir dois níveis e entrar em channel
import channel                    from '../../channel/RolfsoundChannel.js'; 

const CSS_URL = '/static/js/components/seek-bar/seek-bar.css';

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

class RolfsoundSeekBar extends RolfsoundControl {
  constructor() {
    super();
    this._pos          = 0;
    this._duration     = 0;
    this._anchorMs     = 0;
    this._guardUntilMs = 0;
    this._playing      = false;
    this._rafId        = null;
    this._dragging     = false;

    // Scrubbing real-time: 80ms é o equilíbrio perfeito para o Raspberry Pi
    this._sendThrottledSeek = throttle((pos) => {
      this.send('intent.seek', { position: pos });
    }, 80);
  }

  render() {
    this.shadowRoot.innerHTML = `
      <div class="time-row">
        <span class="time-current">0:00</span>
        <span class="time-sep">/</span>
        <span class="time-total">0:00</span>
      </div>
      <div class="bar" data-cursor="range" role="slider" aria-label="Seek">
        <div class="track-outer">
          <div class="track">
            <div class="fill"></div>
          </div>
          <div class="thumb"></div>
        </div>
      </div>
    `;

    this._elCurrent = this.shadowRoot.querySelector('.time-current');
    this._elTotal   = this.shadowRoot.querySelector('.time-total');
    this._elFill    = this.shadowRoot.querySelector('.fill');
    this._elThumb   = this.shadowRoot.querySelector('.thumb');
    this._elBar     = this.shadowRoot.querySelector('.bar');

    this._elBar.addEventListener('pointerdown', e => this._onPointerDown(e));

    loadCss(CSS_URL).then(sheet => {
      this.shadowRoot.adoptedStyleSheets = [sheet];
    });
  }

  subscribe() {
    this.on('state.playback', s => this._applySnapshot(s));
    this.on('event.progress', p => this._applyProgress(p));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopRaf();
  }

  _applySnapshot(s) {
    if (Date.now() < this._guardUntilMs) return;
    this._pos      = s.position     ?? 0;
    this._duration = s.duration     ?? 0;
    this._playing  = s.state === 'playing';
    this._anchorMs = this._playing ? (s.position_updated_at ?? Date.now()) : 0;
    this._renderProgress(this._pos, this._duration);
    this._playing ? this._startRaf() : this._stopRaf();
  }

  _applyProgress(p) {
    if (Date.now() < this._guardUntilMs) return;
    this._pos      = p.position ?? this._pos;
    this._duration = p.duration ?? this._duration;
    this._anchorMs = p.position_updated_at ?? Date.now();
  }

  _deadReckoned() {
    if (!this._anchorMs || !this._duration) return this._pos;
    const diff = (Date.now() - this._anchorMs) / 1000;
    return Math.min(this._pos + diff, this._duration);
  }

  _startRaf() {
    if (this._rafId) return;
    const tick = () => {
      if (!this._dragging) this._renderProgress(this._deadReckoned(), this._duration);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopRaf() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  _renderProgress(pos, duration) {
    const pct = duration > 0 ? Math.max(0, Math.min(pos / duration, 1)) : 0;
    const pctStr = `${(pct * 100).toFixed(2)}%`;
    
    if (this._elFill)  this._elFill.style.width = pctStr;
    if (this._elThumb) this._elThumb.style.left = pctStr;
    if (this._elCurrent) this._elCurrent.textContent = this._fmt(pos);
    if (this._elTotal)   this._elTotal.textContent   = this._fmt(duration);
  }

  _fmt(s) {
    const t = Math.floor(s || 0);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }

  _onPointerDown(e) {
    if (!this._duration) return;
    e.preventDefault();
    this._dragging = true;
    this._elBar.classList.add('dragging');
    this._elBar.setPointerCapture(e.pointerId);

    if (this._elFill) this._elFill.style.transition = 'none';
    if (this._elThumb) this._elThumb.style.transition = 'none';

    this._applyDrag(e);

    const onMove = (ev) => { if (this._dragging) this._applyDrag(ev); };
    const onUp = (ev) => {
      this._dragging = false;
      this._elBar.classList.remove('dragging');
      this._elBar.removeEventListener('pointermove', onMove);
      this._elBar.removeEventListener('pointerup',   onUp);

      const position = this._pctFromEvent(ev) * this._duration;
      this._seekTo(position, false); // Envio final exato

      requestAnimationFrame(() => {
        if (this._elFill) this._elFill.style.transition = '';
        if (this._elThumb) this._elThumb.style.transition = '';
      });
    };

    this._elBar.addEventListener('pointermove', onMove);
    this._elBar.addEventListener('pointerup',   onUp);
  }

  _applyDrag(e) {
    const pct = this._pctFromEvent(e);
    const pos = pct * this._duration;
    this._renderProgress(pos, this._duration);
  }

  _pctFromEvent(e) {
    const rect = this._elBar.getBoundingClientRect();
    return Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
  }

  _seekTo(position, isThrottled) {
    this._pos          = position;
    this._anchorMs     = this._playing ? Date.now() : 0;
    this._guardUntilMs = Date.now() + 1000; 
    
    if (isThrottled) this._sendThrottledSeek(position);
    else this.send('intent.seek', { position });
  }
}

customElements.define('rolfsound-seek-bar', RolfsoundSeekBar);
export default RolfsoundSeekBar;