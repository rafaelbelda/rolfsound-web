// static/js/components/shuffle-toggle/shuffle-toggle.js
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL      = '/static/js/components/shuffle-toggle/shuffle-toggle.css';
const MAX_GUARD_MS = 3000;

class RolfsoundShuffleToggle extends RolfsoundControl {
  constructor() {
    super();
    this._enabled       = false;
    this._guardUntilMs  = 0;
    this._expectedValue = null; // Boolean we expect server to confirm
  }

  render() {
    this.shadowRoot.innerHTML = `
      <button class="hover-target" title="Shuffle">
        <span class="dot"></span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <polyline points="16 3 21 3 21 8"/>
          <line x1="4" y1="20" x2="21" y2="3"/>
          <polyline points="21 16 21 21 16 21"/>
          <line x1="15" y1="15" x2="21" y2="21"/>
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
      const serverVal = s.shuffle ?? false;
      if (this._expectedValue !== null && serverVal === this._expectedValue) {
        this._guardUntilMs  = 0;
        this._expectedValue = null;
        // Fall through to apply confirmed state.
      } else {
        return;
      }
    }
    this._expectedValue = null;
    this._enabled = s.shuffle ?? false;
    this._sync();
  }

  _sync() {
    this._btn?.classList.toggle('active', this._enabled);
    this._dot?.classList.toggle('visible', this._enabled);
  }

  _onClick() {
    this._enabled       = !this._enabled;
    this._expectedValue = this._enabled;
    this._guardUntilMs  = Date.now() + MAX_GUARD_MS;
    this._sync();
    this.send('intent.shuffle.set', { enabled: this._enabled });
  }
}

customElements.define('rolfsound-shuffle-toggle', RolfsoundShuffleToggle);
export default RolfsoundShuffleToggle;
