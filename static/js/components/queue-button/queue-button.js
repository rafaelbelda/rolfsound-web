// static/js/components/queue-button/queue-button.js
// Visual shell only — counter + active state.
// Click dispatches 'rolfsound-queue-click' (bubbles, composed) so
// PlaybackMitosisManager can run the panel animation it already owns.
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/queue-button/queue-button.css';

class RolfsoundQueueButton extends RolfsoundControl {
  render() {
    this.shadowRoot.innerHTML = `
      <button class="hover-target" title="Queue" aria-label="Queue">
        <span class="count"></span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 6h16"/>
          <path d="M4 12h11"/>
          <path d="M4 18h16"/>
        </svg>
      </button>
    `;
    this._btn   = this.shadowRoot.querySelector('button');
    this._count = this.shadowRoot.querySelector('.count');

    this._btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('rolfsound-queue-click', {
        bubbles: true, composed: true
      }));
    });

    loadCss(CSS_URL).then(sheet => { this.shadowRoot.adoptedStyleSheets = [sheet]; });
  }

  subscribe() {
    this.on('state.playback', s => this._applySnapshot(s));
  }

  _applySnapshot(s) {
    const count = (s.queue ?? []).length;
    const label = count === 1 ? '1 faixa' : `${count} faixas`;
    if (this._btn) {
      this._btn.title = label;
      this._btn.setAttribute('aria-label', label);
      this._btn.style.color = count
        ? 'var(--color-queue-active)'
        : 'var(--color-queue-inactive)';
    }
    if (this._count) {
      this._count.textContent = count > 99 ? '99+' : String(count);
      this._count.classList.toggle('visible', count > 0);
    }
  }

  // Called by PlaybackMitosisManager to sync open/closed styling
  setQueueOpen(open) {
    this.classList.toggle('queue-open', open);
  }
}

customElements.define('rolfsound-queue-button', RolfsoundQueueButton);
export default RolfsoundQueueButton;
