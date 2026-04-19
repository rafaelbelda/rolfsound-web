// static/js/components/play-button/play-button.js
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/play-button/play-button.css';

// Guard strategy: optimistic update fires instantly on pointerdown.
// Guard stays active until the server echoes back the EXPECTED state,
// at which point it collapses immediately (Apple "confirm-then-release" pattern).
// If the server never confirms (error), guard expires after MAX_GUARD_MS and
// the next snapshot reverts the UI — which is correct (command failed).
const MAX_GUARD_MS = 3000;

class RolfsoundPlayButton extends RolfsoundControl {
  constructor() {
    super();
    this._playState    = 'idle'; // 'idle' | 'playing' | 'paused'
    this._hasQueue     = false;
    this._guardUntilMs = 0;
    this._expectedState = null; // what state we expect the server to confirm
    this._inflight      = false;
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
    this._btn       = this.shadowRoot.querySelector('button');
    this._iconPlay  = this.shadowRoot.querySelector('.icon-play');
    this._iconPause = this.shadowRoot.querySelector('.icon-pause');

    // pointerdown fires the moment the finger/cursor touches — no lift required.
    // preventDefault stops the browser from re-firing as a click event.
    this._btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      this._onClick();
    });

    loadCss(CSS_URL).then(sheet => {
      this.shadowRoot.adoptedStyleSheets = [sheet];
    });
  }

  subscribe() {
    this.on('state.playback', s => this._applySnapshot(s));
  }

  _applySnapshot(s) {
    if (Date.now() < this._guardUntilMs) {
      // Guard is active. Only release it when the server echoes back our
      // expected state — confirming the command was processed.
      if (this._expectedState && s.state === this._expectedState) {
        this._guardUntilMs  = 0;
        this._expectedState = null;
        this._inflight      = false;
        // Fall through to apply the confirmed state (it matches the optimistic
        // update anyway, so no visual change — just syncs _hasQueue etc.)
      } else {
        return; // server hasn't processed our command yet — ignore
      }
    }
    // Guard expired naturally or just cleared.
    this._expectedState = null;
    this._inflight      = false;
    this._playState     = s.state ?? 'idle';
    this._hasQueue      = (s.queue?.length ?? 0) > 0;
    this._syncIcon();
  }

  _syncIcon() {
    const playing = this._playState === 'playing';
    if (this._iconPlay)  this._iconPlay.style.display  = playing ? 'none' : '';
    if (this._iconPause) this._iconPause.style.display = playing ? ''     : 'none';
  }

  _onClick() {
    if (this._inflight) return;
    this._inflight = true;

    let intent, expectedState;
    if (this._playState === 'playing') {
      this._playState  = 'paused';
      intent           = 'intent.pause';
      expectedState    = 'paused';
    } else if (this._playState === 'paused') {
      this._playState  = 'playing';
      intent           = 'intent.play';
      expectedState    = 'playing';
    } else {
      if (!this._hasQueue) { this._inflight = false; return; }
      this._playState  = 'playing';
      intent           = 'intent.play';
      expectedState    = 'playing';
    }

    // Visual update is synchronous — user sees it in the same frame as the press.
    this._syncIcon();

    // Guard stays active until server confirms our expected state (or MAX_GUARD_MS).
    this._expectedState = expectedState;
    this._guardUntilMs  = Date.now() + MAX_GUARD_MS;

    // Fire-and-forget — guard is managed by _applySnapshot, not by send's completion.
    this.send(intent, {});
  }
}

customElements.define('rolfsound-play-button', RolfsoundPlayButton);
export default RolfsoundPlayButton;
