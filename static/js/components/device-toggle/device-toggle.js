// static/js/components/device-toggle/device-toggle.js
//
// "Play on this device" toggle. Lives in the cover/volume corner of the full
// player, beside the (shared) volume knob — it's an output-routing control, not
// a second volume. All audio/transport logic lives in window.deviceAudio; this
// component only renders state and forwards the user's tap.
//
// The tap handler calls deviceAudio.playHere() SYNCHRONOUSLY so the AudioContext
// is created inside the gesture (iOS Safari requirement). Do not await before it.

import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';
import deviceAudio                from '../../playback/device-audio/DeviceAudioController.js';

const CSS_URL = '/static/js/components/device-toggle/device-toggle.css';

const TITLES = {
  idle:            'Play on this device',
  connecting:      'Handing off…',
  prebuffering:    'Handing off…',
  playing:         'Playing on this device — tap to stop',
  stopping:        'Stopping…',
  paused:          'Disconnected — tap to resume here',
  'another-device':'Playing on another device — tap to take over',
  busy:            'Another device is active — tap to take over',
};

class RolfsoundDeviceToggle extends RolfsoundControl {
  constructor() {
    super();
    this._state = deviceAudio.state;
    this._onDeviceChange = (e) => this._apply(e.detail.state, e.detail.reason);
  }

  render() {
    this.shadowRoot.innerHTML = `
      <button class="hover-target" type="button" aria-pressed="false">
        <!-- device + soundwave glyph -->
        <svg class="ic-cast" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="13" rx="2"/>
          <path class="wave wave-1" d="M8.5 9.5a4 4 0 0 1 7 0"/>
          <path class="wave wave-2" d="M11 12a1.5 1.5 0 0 1 2 0"/>
          <line x1="9" y1="21" x2="15" y2="21"/>
        </svg>
        <span class="spinner" aria-hidden="true"></span>
      </button>
    `;
    this._btn = this.shadowRoot.querySelector('button');
    this._btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      this._onTap();
    });

    loadCss(CSS_URL).then(sheet => { this.shadowRoot.adoptedStyleSheets = [sheet]; });
    this._apply(this._state);
  }

  subscribe() {
    deviceAudio.addEventListener('change', this._onDeviceChange);
    // Reflect existing routing on mount (e.g. another device already streaming).
    this._syncFromCore();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    deviceAudio.removeEventListener('change', this._onDeviceChange);
  }

  async _syncFromCore() {
    if (deviceAudio.state !== 'idle') return; // we're already mid-session
    const status = await deviceAudio.getOutputStatus();
    if (!status || deviceAudio.state !== 'idle') return;
    if (status.sink === 'client' && status.client_connected) {
      this._apply('another-device');
    }
  }

  // ── Tap routing by state ──────────────────────────────────────────────────
  _onTap() {
    switch (this._state) {
      case 'stopping':
        return; // mid-teardown — ignore taps
      case 'playing':
      case 'prebuffering':
      case 'connecting':
        deviceAudio.stopHere();
        break;
      case 'busy':
      case 'another-device':
        deviceAudio.takeOver();
        break;
      default: // idle, paused, error
        deviceAudio.playHere();
    }
  }

  // ── Visual state ──────────────────────────────────────────────────────────
  _apply(state, reason) {
    this._state = state;
    if (!this._btn) return;

    const busy   = state === 'connecting' || state === 'prebuffering' || state === 'stopping';
    const active = state === 'playing';

    this._btn.classList.toggle('busy', busy);
    this._btn.classList.toggle('active', active);
    this._btn.classList.toggle('paused', state === 'paused');
    this._btn.classList.toggle('elsewhere', state === 'another-device' || state === 'busy');
    this._btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    this._btn.setAttribute('title', TITLES[state] || TITLES.idle);
    this._btn.setAttribute('aria-label', TITLES[state] || TITLES.idle);

    // Surface the take-over prompt through the existing island notification.
    if (state === 'busy' && reason === 'session_busy') {
      window.island?.showNotification?.({
        text: 'Playing on another device — tap again to take over',
        duration: 3200,
      });
    }
  }
}

customElements.define('rolfsound-device-toggle', RolfsoundDeviceToggle);
export default RolfsoundDeviceToggle;
