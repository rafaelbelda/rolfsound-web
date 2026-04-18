// static/js/components/play-button/play-button.js
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/play-button/play-button.css';

class RolfsoundPlayButton extends RolfsoundControl {
  constructor() {
    super();
    this._playState    = 'idle'; // 'idle' | 'playing' | 'paused'
    this._hasQueue     = false;
    this._guardUntilMs = 0;
  }

  render() {
    this.shadowRoot.innerHTML = `
      <button class="hover-target" title="Play / Pause">
        <svg class="icon-play" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <polygon points="5,3 19,12 5,21"/>
        </svg>
        <svg class="icon-pause" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="display:none">
          <rect x="6" y="4" width="4" height="16"/>
          <rect x="14" y="4" width="4" height="16"/>
        </svg>
      </button>
    `;
    this._btn      = this.shadowRoot.querySelector('button');
    this._iconPlay  = this.shadowRoot.querySelector('.icon-play');
    this._iconPause = this.shadowRoot.querySelector('.icon-pause');

    this._btn.addEventListener('click', () => this._onClick());

    loadCss(CSS_URL).then(sheet => {
      this.shadowRoot.adoptedStyleSheets = [sheet];
    });
  }

  subscribe() {
    this.on('state.playback', s => this._applySnapshot(s));
  }

  _applySnapshot(s) {
    if (Date.now() < this._guardUntilMs) return;
    this._playState = s.state ?? 'idle';
    this._hasQueue  = (s.queue?.length ?? 0) > 0;
    this._syncIcon();
  }

  _syncIcon() {
    const playing = this._playState === 'playing';
    if (this._iconPlay)  this._iconPlay.style.display  = playing ? 'none'  : '';
    if (this._iconPause) this._iconPause.style.display = playing ? ''      : 'none';
  }

  async _onClick() {
    this._guardUntilMs = Date.now() + 2000;

    if (this._playState === 'playing') {
      this._playState = 'paused';
      this._syncIcon();
      await this.send('intent.pause', {});
    } else if (this._playState === 'paused') {
      this._playState = 'playing';
      this._syncIcon();
      await this.send('intent.play', {});
    } else {
      if (!this._hasQueue) return;
      this._playState = 'playing';
      this._syncIcon();
      await this.send('intent.play', {});
    }

    // Allow reconciliation after guard expires
    setTimeout(() => { this._guardUntilMs = 0; }, 2500);
  }
}

customElements.define('rolfsound-play-button', RolfsoundPlayButton);
export default RolfsoundPlayButton;
