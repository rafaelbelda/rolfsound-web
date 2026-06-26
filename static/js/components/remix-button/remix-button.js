// static/js/components/remix-button/remix-button.js
// Visual shell only — active state + open styling.
// Click dispatches 'rolfsound-remix-click' (bubbles, composed) so PlayerShell
// runs the side-panel animation it owns — the exact pattern the queue button uses.
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/remix-button/remix-button.css';

class RolfsoundRemixButton extends RolfsoundControl {
  constructor() {
    super();
    this._active = false;
  }

  render() {
    this.shadowRoot.innerHTML = `
      <button class="remix-btn" title="Remix" aria-label="Remix - BPM & pitch" aria-expanded="false">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 6h16M4 12h10M4 18h16"/>
          <circle cx="18" cy="12" r="2" fill="currentColor"/>
        </svg>
      </button>
    `;
    this._btn = this.shadowRoot.querySelector('button');
    this._btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('rolfsound-remix-click', {
        bubbles: true, composed: true
      }));
    });
    loadCss(CSS_URL).then(sheet => { this.shadowRoot.adoptedStyleSheets = [sheet]; });
  }

  subscribe() {
    this.on('state.remix', s => {
      const pitch = Number(s?.pitch_semitones ?? 0);
      const tempo = Number(s?.tempo_ratio ?? 1);
      const active = Math.abs(pitch) > 0.001 || Math.abs(tempo - 1) > 0.001;
      if (active !== this._active) {
        this._active = active;
        this.classList.toggle('active', active);
      }
    });
  }

  // Called by PlayerShell to sync open/closed styling (mirrors queue button).
  setRemixOpen(open) {
    this.classList.toggle('remix-open', open);
    this._btn?.setAttribute('aria-expanded', String(open));
  }
}

customElements.define('rolfsound-remix-button', RolfsoundRemixButton);
export default RolfsoundRemixButton;
