// static/js/components/remix-button/remix-button.js
//
// Phase 0 stub. Opens the <rolfsound-remix-panel> panel. Visual polish and
// active-state indicator (lit up when remix ≠ identity) will arrive when the
// DSP backend lands and there's something meaningful to indicate.
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/remix-button/remix-button.css';

class RolfsoundRemixButton extends RolfsoundControl {
  constructor() {
    super();
    this._active = false;   // true when pitch ≠ 0 or tempo ≠ 1
  }

  render() {
    this.shadowRoot.innerHTML = `
      <button class="remix-btn" title="Remix" aria-label="Remix — pitch & tempo">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 6h16M4 12h10M4 18h16"/>
          <circle cx="18" cy="12" r="2" fill="currentColor"/>
        </svg>
      </button>
    `;
    this._btn = this.shadowRoot.querySelector('button');
    this._btn.addEventListener('click', () => this._toggle());
    loadCss(CSS_URL).then(sheet => { this.shadowRoot.adoptedStyleSheets = [sheet]; });
  }

  subscribe() {
    this.on('state.remix', s => {
      const active = (s.pitch_semitones !== 0) || (s.tempo_ratio !== 1);
      if (active !== this._active) {
        this._active = active;
        this.classList.toggle('active', active);
      }
    });
  }

  _toggle() {
    // Document-level panel anchored to the player. Panel component manages its
    // own open/close state via a custom event — decoupled from the button.
    window.dispatchEvent(new CustomEvent('rolfsound:remix-panel:toggle'));
  }
}

customElements.define('rolfsound-remix-button', RolfsoundRemixButton);
export default RolfsoundRemixButton;
