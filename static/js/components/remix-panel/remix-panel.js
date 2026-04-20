// static/js/components/remix-panel/remix-panel.js
//
// Phase 0 stub. Renders pitch + tempo sliders plus the global
// reset-on-track-change toggle. Visual design will be revisited with
// Claude Design; this implementation is structurally complete so the
// pipeline can be validated end-to-end (UI → WS → core → DSP slot).
//
// Latency strategy (mirrors volume-slider):
//   • Optimistic UI with guard window
//   • rAF-throttled intent emission (~30 Hz max during drag)
//   • Final commit on pointerup
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';

const CSS_URL = '/static/js/components/remix-panel/remix-panel.css';

const PITCH_MIN = -12;
const PITCH_MAX =  12;
const TEMPO_MIN =  0.5;
const TEMPO_MAX =  2.0;

// Emit intents at most once per frame (~60 Hz cap; core coalesces further).
const EMIT_COALESCE_MS = 16;
// Suppress incoming state.remix echoes for this window after a local commit
// so the user's in-flight drag isn't overwritten by a stale snapshot.
const GUARD_MS = 800;


class RolfsoundRemixPanel extends RolfsoundControl {
  constructor() {
    super();
    this._open          = false;
    this._pitch         = 0.0;
    this._tempo         = 1.0;
    this._resetOnTrack  = true;
    this._guardUntilMs  = 0;
    this._lastEmitMs    = 0;
    this._emitTimer     = null;
    this._pending       = null;   // { pitch?, tempo? }
    this._onWindowToggle = () => this._toggle();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <div class="panel" aria-hidden="true">
        <header>
          <span class="title">Remix</span>
          <button class="reset" title="Reset">Reset</button>
        </header>

        <div class="row" data-param="pitch">
          <label>Pitch <span class="value pitch-val">0 st</span></label>
          <input type="range" class="pitch" min="${PITCH_MIN}" max="${PITCH_MAX}" step="0.1" value="0" />
        </div>

        <div class="row" data-param="tempo">
          <label>Tempo <span class="value tempo-val">1.00×</span></label>
          <input type="range" class="tempo" min="${TEMPO_MIN}" max="${TEMPO_MAX}" step="0.01" value="1" />
        </div>

        <div class="stems-slot"><!-- Phase 3: stems injected here --></div>

        <footer>
          <label class="toggle">
            <input type="checkbox" class="reset-flag" checked />
            <span>Reset on track change</span>
          </label>
        </footer>
      </div>
    `;

    this._panel     = this.shadowRoot.querySelector('.panel');
    this._pitchEl   = this.shadowRoot.querySelector('.pitch');
    this._tempoEl   = this.shadowRoot.querySelector('.tempo');
    this._pitchVal  = this.shadowRoot.querySelector('.pitch-val');
    this._tempoVal  = this.shadowRoot.querySelector('.tempo-val');
    this._resetBtn  = this.shadowRoot.querySelector('.reset');
    this._flagEl    = this.shadowRoot.querySelector('.reset-flag');

    this._pitchEl.addEventListener('input',   e => this._onPitchInput(e));
    this._pitchEl.addEventListener('change',  () => this._commit());
    this._tempoEl.addEventListener('input',   e => this._onTempoInput(e));
    this._tempoEl.addEventListener('change',  () => this._commit());
    this._resetBtn.addEventListener('click',  () => this._onReset());
    this._flagEl.addEventListener('change',   () => this._onFlagChange());

    window.addEventListener('rolfsound:remix-panel:toggle', this._onWindowToggle);

    loadCss(CSS_URL).then(sheet => { this.shadowRoot.adoptedStyleSheets = [sheet]; });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('rolfsound:remix-panel:toggle', this._onWindowToggle);
    if (this._emitTimer) { clearTimeout(this._emitTimer); this._emitTimer = null; }
  }

  subscribe() {
    this.on('state.remix', s => {
      if (Date.now() < this._guardUntilMs) return;
      if (typeof s.pitch_semitones === 'number') {
        this._pitch = s.pitch_semitones;
        this._pitchEl.value = String(this._pitch);
        this._pitchVal.textContent = this._formatPitch(this._pitch);
      }
      if (typeof s.tempo_ratio === 'number') {
        this._tempo = s.tempo_ratio;
        this._tempoEl.value = String(this._tempo);
        this._tempoVal.textContent = this._formatTempo(this._tempo);
      }
      if (typeof s.reset_on_track_change === 'boolean') {
        this._resetOnTrack = s.reset_on_track_change;
        this._flagEl.checked = this._resetOnTrack;
      }
    });
  }

  _toggle() {
    this._open = !this._open;
    this._panel.setAttribute('aria-hidden', String(!this._open));
    this.classList.toggle('open', this._open);
  }

  _onPitchInput(e) {
    this._pitch = parseFloat(e.target.value);
    this._pitchVal.textContent = this._formatPitch(this._pitch);
    this._scheduleEmit({ pitch_semitones: this._pitch });
  }

  _onTempoInput(e) {
    this._tempo = parseFloat(e.target.value);
    this._tempoVal.textContent = this._formatTempo(this._tempo);
    this._scheduleEmit({ tempo_ratio: this._tempo });
  }

  _scheduleEmit(partial) {
    this._pending = { ...(this._pending || {}), ...partial };
    const now = Date.now();
    const wait = Math.max(0, EMIT_COALESCE_MS - (now - this._lastEmitMs));
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      const payload = this._pending; this._pending = null;
      if (!payload) return;
      this._lastEmitMs = Date.now();
      this._guardUntilMs = this._lastEmitMs + GUARD_MS;
      this.send('intent.remix.set', payload);
    }, wait);
  }

  _commit() {
    // Final commit on pointerup — guarantees state matches the released slider
    // value in case the coalesced emit raced the release.
    if (this._emitTimer) { clearTimeout(this._emitTimer); this._emitTimer = null; }
    this._pending = null;
    this._guardUntilMs = Date.now() + GUARD_MS;
    this.send('intent.remix.set', {
      pitch_semitones: this._pitch,
      tempo_ratio:     this._tempo,
    });
  }

  _onReset() {
    this._pitch = 0.0;
    this._tempo = 1.0;
    this._pitchEl.value = '0';
    this._tempoEl.value = '1';
    this._pitchVal.textContent = this._formatPitch(0);
    this._tempoVal.textContent = this._formatTempo(1);
    this._guardUntilMs = Date.now() + GUARD_MS;
    this.send('intent.remix.reset', {});
  }

  _onFlagChange() {
    this._resetOnTrack = this._flagEl.checked;
    this.send('intent.remix.reset_flag.set', { enabled: this._resetOnTrack });
  }

  _formatPitch(v) {
    const sign = v > 0 ? '+' : '';
    return `${sign}${v.toFixed(1).replace(/\.0$/, '')} st`;
  }

  _formatTempo(v) {
    return `${v.toFixed(2)}×`;
  }
}

customElements.define('rolfsound-remix-panel', RolfsoundRemixPanel);
export default RolfsoundRemixPanel;
