// static/js/components/remix-button/remix-button.js
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/remix-button/remix-button.css';

class RolfsoundRemixButton extends RolfsoundControl {
  constructor() {
    super();
    this._active = false;
    this._open = false;
    this._onPanelState = (event) => this.setPanelOpen(Boolean(event.detail?.open));
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
    this._btn.addEventListener('click', () => this._toggle());
    loadCss(CSS_URL).then(sheet => { this.shadowRoot.adoptedStyleSheets = [sheet]; });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('rolfsound:remix-panel:state', this._onPanelState);
  }

  subscribe() {
    window.addEventListener('rolfsound:remix-panel:state', this._onPanelState);
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

  _toggle() {
    const rect = this._fullButtonRect();
    window.dispatchEvent(new CustomEvent('rolfsound:remix-panel:toggle', {
      detail: {
        sourceRect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
      },
    }));
  }

  _fullButtonRect() {
    const shellRect = this.parentElement?.getBoundingClientRect?.();
    if (shellRect?.width && shellRect?.height) {
      const size = shellRect.height;
      const gap = 4;
      return {
        left: shellRect.left - size - gap,
        top: shellRect.top + shellRect.height / 2 - size / 2,
        right: shellRect.left - gap,
        bottom: shellRect.top + shellRect.height / 2 + size / 2,
        width: size,
        height: size,
      };
    }

    return this.getBoundingClientRect();
  }

  setPanelOpen(open) {
    if (open === this._open) return;
    this._open = open;
    this.classList.toggle('remix-open', open);
    this._btn?.setAttribute('aria-expanded', String(open));
  }
}

customElements.define('rolfsound-remix-button', RolfsoundRemixButton);
export default RolfsoundRemixButton;
