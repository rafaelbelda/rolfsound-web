// static/js/components/skip-buttons/skip-buttons.js
// Defines two custom elements in one file:
//   <rolfsound-skip-back>  — prev / restart
//   <rolfsound-skip-fwd>   — next
// Both are placed independently in the controls pill, flanking <rolfsound-play-button>.

import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/skip-buttons/skip-buttons.css';

// ── Skip Back ──────────────────────────────────────────────────────────────────
// If current position > 3s → restart track (intent.seek position=0).
// Otherwise → go to previous track (intent.skip direction=back).

class RolfsoundSkipBack extends RolfsoundControl {
  constructor() {
    super();
    this._pos      = 0;
    this._anchorMs = 0;
  }

  render() {
    this.shadowRoot.innerHTML = `
      <button class="hover-target" title="Anterior / Início">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <polygon points="19,20 9,12 19,4"/>
          <line x1="5" y1="19" x2="5" y2="5"/>
        </svg>
      </button>
    `;
    this.shadowRoot.querySelector('button')
        .addEventListener('pointerdown', (e) => {
          if (e.button !== 0 && e.pointerType === 'mouse') return;
          e.preventDefault();
          this._onClick();
        });

    loadCss(CSS_URL).then(sheet => {
      this.shadowRoot.adoptedStyleSheets = [sheet];
    });
  }

  subscribe() {
    this.on('state.playback', s => {
      this._pos      = s.position ?? 0;
      this._anchorMs = s.state === 'playing' ? Date.now() : 0;
    });
  }

  _livePos() {
    if (!this._anchorMs) return this._pos;
    return this._pos + (Date.now() - this._anchorMs) / 1000;
  }

  _onClick() {
    if (this._livePos() > 3) {
      this.send('intent.seek', { position: 0 });
    } else {
      this.send('intent.skip', { direction: 'back' });
    }
  }
}

// ── Skip Forward ───────────────────────────────────────────────────────────────

class RolfsoundSkipFwd extends RolfsoundControl {
  render() {
    this.shadowRoot.innerHTML = `
      <button class="hover-target" title="Próxima">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <polygon points="5,4 15,12 5,20"/>
          <line x1="19" y1="5" x2="19" y2="19"/>
        </svg>
      </button>
    `;
    this.shadowRoot.querySelector('button')
        .addEventListener('pointerdown', (e) => {
          if (e.button !== 0 && e.pointerType === 'mouse') return;
          e.preventDefault();
          this.send('intent.skip', { direction: 'fwd' });
        });

    loadCss(CSS_URL).then(sheet => {
      this.shadowRoot.adoptedStyleSheets = [sheet];
    });
  }

  subscribe() { /* no state needed */ }
}

customElements.define('rolfsound-skip-back', RolfsoundSkipBack);
customElements.define('rolfsound-skip-fwd',  RolfsoundSkipFwd);
