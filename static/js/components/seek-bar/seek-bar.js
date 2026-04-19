// static/js/components/seek-bar/seek-bar.js
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/seek-bar/seek-bar.css';

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
    this._dragMoveFn   = null;
    this._dragUpFn     = null;
  }

  // RolfsoundControl calls render() then subscribe() on connectedCallback.

  render() {
    this.shadowRoot.innerHTML = `
      <div class="time-row">
        <span class="time-current">0:00</span>
        <span class="time-sep">/</span>
        <span class="time-total">0:00</span>
      </div>
      <div class="bar">
        <div class="track">
          <div class="fill"></div>
        </div>
      </div>
    `;

    this._elCurrent = this.shadowRoot.querySelector('.time-current');
    this._elTotal   = this.shadowRoot.querySelector('.time-total');
    this._elFill    = this.shadowRoot.querySelector('.fill');
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
    this._unbindDrag();
  }

  // ── State application ──────────────────────────────────────────────────

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

  // ── Dead-reckoning ─────────────────────────────────────────────────────

  _deadReckoned() {
    if (!this._anchorMs || !this._duration) return this._pos;
    return Math.min(this._pos + (Date.now() - this._anchorMs) / 1000, this._duration);
  }

  // ── RAF ────────────────────────────────────────────────────────────────

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

  // ── Rendering ──────────────────────────────────────────────────────────

  _renderProgress(pos, duration) {
    const pct = duration > 0 ? Math.max(0, Math.min(pos / duration, 1)) : 0;
    if (this._elFill)    this._elFill.style.transform    = `scaleX(${pct})`;
    if (this._elCurrent) this._elCurrent.textContent     = this._fmt(pos);
    if (this._elTotal)   this._elTotal.textContent       = this._fmt(duration);
  }

  _fmt(s) {
    const t = Math.floor(s || 0);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }

  // ── Input handling ─────────────────────────────────────────────────────

  _onPointerDown(e) {
    if (!this._duration) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    this._dragging = true;

    // Kill CSS transition so fill is glued to the finger — zero lag during drag.
    if (this._elFill) this._elFill.style.transition = 'none';

    this._dragMoveFn = (mv) => {
      const pct = this._pctFromEvent(mv);
      const pos = pct * this._duration;
      if (this._elFill)    this._elFill.style.transform = `scaleX(${pct})`;
      if (this._elCurrent) this._elCurrent.textContent  = this._fmt(pos);
    };

    this._dragUpFn = (up) => {
      this._dragging = false;
      const position = this._pctFromEvent(up) * this._duration;
      this._unbindDrag();

      // Re-enable transition after two frames so the final snap doesn't animate.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (this._elFill) this._elFill.style.transition = '';
      }));

      this._seekTo(position);
    };

    document.addEventListener('mousemove', this._dragMoveFn);
    document.addEventListener('mouseup',   this._dragUpFn, { once: true });
  }

  _unbindDrag() {
    if (this._dragMoveFn) document.removeEventListener('mousemove', this._dragMoveFn);
    this._dragMoveFn = null;
    this._dragUpFn   = null;
  }

  _pctFromEvent(e) {
    const rect = this._elBar.getBoundingClientRect();
    return Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
  }

  _seekTo(position) {
    this._pos          = position;
    this._anchorMs     = this._playing ? Date.now() : 0;
    // Guard covers the window between sending the seek and the server's first
    // tick arriving with the new anchor. 800ms is enough for: core processes
    // seek + emits playback_tick (1Hz) + broadcaster forwards it.
    this._guardUntilMs = Date.now() + 800;
    this._renderProgress(position, this._duration);
    this.send('intent.seek', { position });
  }
}

customElements.define('rolfsound-seek-bar', RolfsoundSeekBar);
export default RolfsoundSeekBar;
