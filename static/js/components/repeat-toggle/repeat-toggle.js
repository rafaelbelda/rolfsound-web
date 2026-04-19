// static/js/components/repeat-toggle/repeat-toggle.js
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL      = '/static/js/components/repeat-toggle/repeat-toggle.css';
const CYCLE        = { off: 'all', all: 'one', one: 'off' };
const TITLES       = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one' };
const MAX_GUARD_MS = 3000;

class RolfsoundRepeatToggle extends RolfsoundControl {
  constructor() {
    super();
    this._mode          = 'off';
    this._guardUntilMs  = 0;
    this._expectedMode  = null; // mode string we expect server to confirm
  }

  render() {
    this.shadowRoot.innerHTML = `
      <button class="hover-target" title="Repeat">
        <span class="dot"></span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <polyline points="17 1 21 5 17 9"/>
          <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
          <polyline points="7 23 3 19 7 15"/>
          <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
        </svg>
      </button>
    `;
    this._btn = this.shadowRoot.querySelector('button');
    this._dot = this.shadowRoot.querySelector('.dot');
    this._btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      this._onClick();
    });
    loadCss(CSS_URL).then(sheet => { this.shadowRoot.adoptedStyleSheets = [sheet]; });
  }

  subscribe() {
    this.on('state.playback', s => this._applySnapshot(s));
  }

  _applySnapshot(s) {
    if (Date.now() < this._guardUntilMs) {
      const serverMode = s.repeat_mode ?? 'off';
      if (this._expectedMode !== null && serverMode === this._expectedMode) {
        this._guardUntilMs = 0;
        this._expectedMode = null;
        // Fall through to apply confirmed state.
      } else {
        return;
      }
    }
    this._expectedMode = null;
    this._mode = s.repeat_mode ?? 'off';
    this._sync();
  }

  _sync() {
    const on = this._mode !== 'off';
    this._btn?.classList.toggle('active', on);
    this._btn?.setAttribute('title', TITLES[this._mode] ?? 'Repeat');
    if (!this._dot) return;
    this._dot.classList.toggle('visible', on);
    this._dot.classList.toggle('one', this._mode === 'one');
    this._dot.textContent = this._mode === 'one' ? '1' : '';
  }

  _onClick() {
    this._mode         = CYCLE[this._mode] ?? 'off';
    this._expectedMode = this._mode;
    this._guardUntilMs = Date.now() + MAX_GUARD_MS;
    this._sync();
    this.send('intent.repeat.set', { mode: this._mode });
  }
}

customElements.define('rolfsound-repeat-toggle', RolfsoundRepeatToggle);
export default RolfsoundRepeatToggle;
