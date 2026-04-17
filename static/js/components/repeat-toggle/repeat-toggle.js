// static/js/components/repeat-toggle/repeat-toggle.js
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL   = '/static/js/components/repeat-toggle/repeat-toggle.css';
const CYCLE     = { off: 'all', all: 'one', one: 'off' };
const TITLES    = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one' };

class RolfsoundRepeatToggle extends RolfsoundControl {
  constructor() {
    super();
    this._mode         = 'off';
    this._guardUntilMs = 0;
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
    this._btn.addEventListener('click', () => this._onClick());
    loadCss(CSS_URL).then(sheet => { this.shadowRoot.adoptedStyleSheets = [sheet]; });
  }

  subscribe() {
    this.on('state.playback', s => {
      if (Date.now() < this._guardUntilMs) return;
      this._mode = s.repeat_mode ?? 'off';
      this._sync();
    });
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

  async _onClick() {
    this._mode         = CYCLE[this._mode] ?? 'off';
    this._guardUntilMs = Date.now() + 2000;
    this._sync();
    await this.send('intent.repeat.set', { mode: this._mode });
    setTimeout(() => { this._guardUntilMs = 0; }, 2500);
  }
}

customElements.define('rolfsound-repeat-toggle', RolfsoundRepeatToggle);
export default RolfsoundRepeatToggle;
