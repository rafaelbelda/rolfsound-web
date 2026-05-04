// static/js/components/seek-bar/seek-bar.js
import RolfsoundControl from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/seek-bar/seek-bar.css?v=player-knob-fix-20260501';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const throttle = (func, limit) => {
  let inThrottle = false;
  return function(...args) {
    if (inThrottle) return;
    func.apply(this, args);
    inThrottle = true;
    setTimeout(() => { inThrottle = false; }, limit);
  };
};

class RolfsoundSeekBar extends RolfsoundControl {
  constructor() {
    super();
    this._pos = 0;
    this._duration = 0;
    this._anchorMs = 0;
    this._guardUntilMs = 0;
    this._playing = false;
    this._rafId = null;
    this._dragging = false;
    this._dragRect = null;
    this._lastRatio = -1;
    this._lastTooltipText = '';

    this._sendThrottledSeek = throttle((position) => {
      this.send('intent.seek', { position });
    }, 80);
  }

  render() {
    this.shadowRoot.innerHTML = `
      <div class="bar" data-cursor="range" role="slider" tabindex="0" aria-label="Seek"
        aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
        <div class="hairline"></div>
        <div class="fill"></div>
        <div class="magnify">
          <div class="magnify-track"></div>
          <div class="magnify-fill"></div>
        </div>
      </div>
      <div class="scrub-tooltip" role="tooltip" hidden>0:00</div>
    `;

    this._elBar = this.shadowRoot.querySelector('.bar');
    this._elFill = this.shadowRoot.querySelector('.fill');
    this._elMagnifyFill = this.shadowRoot.querySelector('.magnify-fill');
    this._tooltip = this.shadowRoot.querySelector('.scrub-tooltip');

    this._elBar.addEventListener('pointerenter', () => this._onPointerEnter());
    this._elBar.addEventListener('pointerleave', () => this._onPointerLeave());
    this._elBar.addEventListener('pointermove', e => this._onPointerMove(e));
    this._elBar.addEventListener('pointerdown', e => this._onPointerDown(e));
    this._elBar.addEventListener('keydown', e => this._onKeyDown(e));

    loadCss(CSS_URL).then(sheet => {
      this.shadowRoot.adoptedStyleSheets = [sheet];
    });

    this._renderProgress(this._pos, this._duration);
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
    this._pos = s.position ?? 0;
    this._duration = s.duration ?? 0;
    this._playing = s.state === 'playing';
    this._anchorMs = this._playing ? (s.position_updated_at ?? Date.now()) : 0;
    this._renderProgress(this._pos, this._duration);
    this._playing ? this._startRaf() : this._stopRaf();
  }

  _applyProgress(p) {
    if (Date.now() < this._guardUntilMs) return;
    this._pos = p.position ?? this._pos;
    this._duration = p.duration ?? this._duration;
    this._anchorMs = p.position_updated_at ?? Date.now();
    if (!this._playing && !this._dragging) this._renderProgress(this._pos, this._duration);
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
    const ratio = duration > 0 ? clamp(pos / duration, 0, 1) : 0;
    const stableRatio = Number(ratio.toFixed(5));
    if (stableRatio !== this._lastRatio) {
      this._elFill.style.transform = `scale3d(${stableRatio}, 1, 1)`;
      this._elMagnifyFill.style.transform = `scale3d(${stableRatio}, 1, 1)`;
      this._lastRatio = stableRatio;
    }

    this._elBar.setAttribute('aria-valuemax', String(Math.floor(duration || 0)));
    this._elBar.setAttribute('aria-valuenow', String(Math.floor(pos || 0)));
    this._elBar.setAttribute('aria-valuetext', `${this._fmt(pos)} of ${this._fmt(duration)}`);
  }

  _onPointerEnter() {
    this._elBar.classList.add('hover');
  }

  _onPointerLeave() {
    if (this._dragging) return;
    this._elBar.classList.remove('hover');
    this._hideTooltip();
  }

  _onPointerMove(e) {
    this._updateCursor(e);
  }

  _onPointerDown(e) {
    if (!this._duration) return;
    e.preventDefault();
    this._dragging = true;
    this._elBar.classList.add('dragging', 'hover');
    this._elBar.setPointerCapture(e.pointerId);
    this._dragRect = this._elBar.getBoundingClientRect();

    this._elFill.style.transition = 'none';
    this._elMagnifyFill.style.transition = 'none';

    this._applyDrag(e);

    const onMove = ev => {
      if (!this._dragging) return;
      this._applyDrag(ev);
    };
    const onRelease = ev => {
      if (!this._dragging) return;
      const rect = this._dragRect || this._elBar.getBoundingClientRect();
      this._dragging = false;
      this._elBar.classList.remove('dragging');
      this._elBar.removeEventListener('pointermove', onMove);
      this._elBar.removeEventListener('pointerup', onRelease);
      this._elBar.removeEventListener('pointercancel', onRelease);
      try { this._elBar.releasePointerCapture(ev.pointerId); } catch {}

      this._updateCursor(ev);
      const position = this._pctFromEvent(ev) * this._duration;
      this._seekTo(position, false);
      this._dragRect = null;

      const inside = (
        ev.clientX >= rect.left && ev.clientX <= rect.right &&
        ev.clientY >= rect.top && ev.clientY <= rect.bottom
      );
      if (!inside) {
        this._elBar.classList.remove('hover');
        this._hideTooltip();
      }

      requestAnimationFrame(() => {
        this._elFill.style.transition = '';
        this._elMagnifyFill.style.transition = '';
      });
    };

    this._elBar.addEventListener('pointermove', onMove);
    this._elBar.addEventListener('pointerup', onRelease);
    this._elBar.addEventListener('pointercancel', onRelease);
  }

  _onKeyDown(e) {
    if (!this._duration) return;
    let next = null;
    if (e.key === 'ArrowLeft') next = this._deadReckoned() - 5;
    if (e.key === 'ArrowRight') next = this._deadReckoned() + 5;
    if (e.key === 'PageDown') next = this._deadReckoned() - 30;
    if (e.key === 'PageUp') next = this._deadReckoned() + 30;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = this._duration;
    if (next == null) return;

    e.preventDefault();
    this._seekTo(clamp(next, 0, this._duration), false);
    this._renderProgress(this._pos, this._duration);
  }

  _applyDrag(e) {
    this._updateCursor(e);
    const pos = this._pctFromEvent(e) * this._duration;
    this._pos = pos;
    this._renderProgress(pos, this._duration);
    this._seekTo(pos, true);
  }

  _pctFromEvent(e) {
    const rect = this._dragRect || this._elBar.getBoundingClientRect();
    if (!rect.width) return 0;
    return clamp((e.clientX - rect.left) / rect.width, 0, 1);
  }

  _updateCursor(e) {
    const rect = this._dragRect || this._elBar.getBoundingClientRect();
    if (!rect.width) return;
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    const pct = x / rect.width;
    const tooltipX = clamp(x, 24, Math.max(24, rect.width - 24));

    this._elBar.style.setProperty('--cursor-x', `${x}px`);
    this._tooltip.style.setProperty('--tooltip-x', `${tooltipX}px`);

    if (this._duration > 0) {
      const text = this._fmt(pct * this._duration);
      if (text !== this._lastTooltipText) {
        this._tooltip.textContent = text;
        this._lastTooltipText = text;
      }
      this._tooltip.hidden = false;
    }
  }

  _hideTooltip() {
    this._tooltip.hidden = true;
    this._lastTooltipText = '';
  }

  _seekTo(position, isThrottled) {
    this._pos = clamp(position, 0, this._duration || 0);
    this._anchorMs = this._playing ? Date.now() : 0;
    this._guardUntilMs = Date.now() + 1000;

    if (isThrottled) this._sendThrottledSeek(this._pos);
    else this.send('intent.seek', { position: this._pos });
  }

  _fmt(seconds) {
    const total = Math.floor(seconds || 0);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
}

customElements.define('rolfsound-seek-bar', RolfsoundSeekBar);
export default RolfsoundSeekBar;
