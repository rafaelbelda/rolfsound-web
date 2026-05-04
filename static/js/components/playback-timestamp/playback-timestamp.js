// static/js/components/playback-timestamp/playback-timestamp.js
import RolfsoundControl from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/playback-timestamp/playback-timestamp.css?v=player-knob-fix-20260501';

class RolfsoundPlaybackTimestamp extends RolfsoundControl {
  constructor() {
    super();
    this._pos = 0;
    this._duration = 0;
    this._anchorMs = 0;
    this._playing = false;
    this._rafId = null;
    this._lastCurrent = '';
    this._lastTotal = '';
  }

  render() {
    this.shadowRoot.innerHTML = `
      <span class="time-current">0:00</span>
      <span class="time-total">/ 0:00</span>
    `;

    this._elCurrent = this.shadowRoot.querySelector('.time-current');
    this._elTotal = this.shadowRoot.querySelector('.time-total');

    loadCss(CSS_URL).then(sheet => {
      this.shadowRoot.adoptedStyleSheets = [sheet];
    });

    this._renderTime(this._pos, this._duration);
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
    this._pos = s.position ?? 0;
    this._duration = s.duration ?? 0;
    this._playing = s.state === 'playing';
    this._anchorMs = this._playing ? (s.position_updated_at ?? Date.now()) : 0;
    this._renderTime(this._pos, this._duration);
    this._playing ? this._startRaf() : this._stopRaf();
  }

  _applyProgress(p) {
    this._pos = p.position ?? this._pos;
    this._duration = p.duration ?? this._duration;
    this._anchorMs = p.position_updated_at ?? Date.now();
    if (!this._playing) this._renderTime(this._pos, this._duration);
  }

  _deadReckoned() {
    if (!this._anchorMs || !this._duration) return this._pos;
    const diff = (Date.now() - this._anchorMs) / 1000;
    return Math.min(this._pos + diff, this._duration);
  }

  _startRaf() {
    if (this._rafId) return;
    const tick = () => {
      this._renderTime(this._deadReckoned(), this._duration);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopRaf() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  _renderTime(pos, duration) {
    const current = this._fmt(pos);
    const total = `/ ${this._fmt(duration)}`;

    if (current !== this._lastCurrent) {
      this._elCurrent.textContent = current;
      this._lastCurrent = current;
    }
    if (total !== this._lastTotal) {
      this._elTotal.textContent = total;
      this._lastTotal = total;
    }
  }

  _fmt(seconds) {
    const total = Math.floor(seconds || 0);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
}

customElements.define('rolfsound-playback-timestamp', RolfsoundPlaybackTimestamp);
export default RolfsoundPlaybackTimestamp;
