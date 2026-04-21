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

const EMIT_COALESCE_MS = 16;
const GUARD_MS = 800;

class RolfsoundRemixPanel extends RolfsoundControl {
  constructor() {
    super();
    this._open          = false;
    this._pitch         = 0.0;
    this._tempo         = 1.0;
    this._baseBpm       = null; // Armazena o BPM original da música
    this._resetOnTrack  = true;
    
    this._guardUntilMs  = 0;
    this._lastEmitMs    = 0;
    this._emitTimer     = null;
    this._pending       = null;
    this._onWindowToggle = () => this._toggle();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <div class="panel" aria-hidden="true">
        <header>
          <span class="title">Remix</span>
          <button class="reset-btn" title="Restaurar originais">Reset</button>
        </header>

        <div class="control-group">
          <div class="label-row">
            <span class="label">Pitch</span>
            <span class="value pitch-val">0.0 st</span>
          </div>
          <div class="slider-row">
            <button class="step-btn pitch-down" title="-0.5 st">−</button>
            <input type="range" class="pitch" min="${PITCH_MIN}" max="${PITCH_MAX}" step="0.5" value="0" />
            <button class="step-btn pitch-up" title="+0.5 st">+</button>
          </div>
        </div>

        <div class="control-group">
          <div class="label-row">
            <span class="label">Tempo <span class="bpm-badge" style="display:none;">BPM</span></span>
            <span class="value tempo-val">1.00×</span>
          </div>
          <div class="slider-row">
            <button class="step-btn tempo-down" title="Reduzir precisão">−</button>
            <input type="range" class="tempo" min="${TEMPO_MIN}" max="${TEMPO_MAX}" step="0.01" value="1" />
            <button class="step-btn tempo-up" title="Aumentar precisão">+</button>
          </div>
        </div>

        <footer>
          <label class="toggle">
            <input type="checkbox" class="reset-flag" checked />
            <span class="toggle-track"></span>
            <span>Reset na próxima faixa</span>
          </label>
        </footer>
      </div>
    `;

    this._panel     = this.shadowRoot.querySelector('.panel');
    this._pitchEl   = this.shadowRoot.querySelector('.pitch');
    this._tempoEl   = this.shadowRoot.querySelector('.tempo');
    this._pitchVal  = this.shadowRoot.querySelector('.pitch-val');
    this._tempoVal  = this.shadowRoot.querySelector('.tempo-val');
    this._bpmBadge  = this.shadowRoot.querySelector('.bpm-badge');
    this._resetBtn  = this.shadowRoot.querySelector('.reset-btn');
    this._flagEl    = this.shadowRoot.querySelector('.reset-flag');

    // Bind de Eventos dos Sliders (Arrastar)
    this._pitchEl.addEventListener('input',   e => this._onPitchInput(e));
    this._pitchEl.addEventListener('change',  () => this._commit());
    this._tempoEl.addEventListener('input',   e => this._onTempoInput(e));
    this._tempoEl.addEventListener('change',  () => this._commit());

    // Bind de Eventos dos Botões de Precisão (Cliques)
    this.shadowRoot.querySelector('.pitch-down').addEventListener('click', () => this._stepPitch(-1));
    this.shadowRoot.querySelector('.pitch-up').addEventListener('click',   () => this._stepPitch(1));
    this.shadowRoot.querySelector('.tempo-down').addEventListener('click', () => this._stepTempo(-1));
    this.shadowRoot.querySelector('.tempo-up').addEventListener('click',   () => this._stepTempo(1));

    this._resetBtn.addEventListener('click',  () => this._onReset());
    this._flagEl.addEventListener('change',   () => this._onFlagChange());

    window.addEventListener('rolfsound:remix-panel:toggle', this._onWindowToggle);

    loadCss(CSS_URL).then(sheet => { this.shadowRoot.adoptedStyleSheets = [sheet]; });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('rolfsound:remix-panel:toggle', this._onWindowToggle);
    if (this._emitTimer) clearTimeout(this._emitTimer);
  }

  subscribe() {
    // Escuta mudanças nos rácios de Remix
    this.on('state.remix', s => {
      if (Date.now() < this._guardUntilMs) return;
      
      if (typeof s.pitch_semitones === 'number') {
        this._pitch = s.pitch_semitones;
        this._pitchEl.value = String(this._pitch);
      }
      if (typeof s.tempo_ratio === 'number') {
        this._tempo = s.tempo_ratio;
        this._tempoEl.value = String(this._tempo);
      }
      if (typeof s.reset_on_track_change === 'boolean') {
        this._resetOnTrack = s.reset_on_track_change;
        this._flagEl.checked = this._resetOnTrack;
      }
      this._updateVisuals();
    });

    this.on('state.playback', s => {
      // Procura primeiro na raiz (onde o nosso enricher acabou de o colocar)
      const track = s?.queue?.tracks?.[s.queue?.current_index];
      const bpm = s?.bpm || track?.bpm || track?.metadata?.bpm || null;
      
      if (this._baseBpm !== bpm) {
        this._baseBpm = bpm;
        this._updateVisuals();
      }
    });
  }

  _toggle() {
    this._open = !this._open;
    this._panel.setAttribute('aria-hidden', String(!this._open));
  }

  _onPitchInput(e) {
    this._pitch = parseFloat(e.target.value);
    this._updateVisuals();
    this._scheduleEmit({ pitch_semitones: this._pitch });
  }

  _onTempoInput(e) {
    this._tempo = parseFloat(e.target.value);
    this._updateVisuals();
    this._scheduleEmit({ tempo_ratio: this._tempo });
  }

  // --- Botões de Precisão Apple-like ---
  _stepPitch(direction) {
    // Altera exatamente 0.5 semitons
    let p = this._pitch + (direction * 0.5);
    p = Math.max(PITCH_MIN, Math.min(PITCH_MAX, p));
    this._pitch = p;
    this._pitchEl.value = String(p);
    this._updateVisuals();
    this._commit();
  }

  _stepTempo(direction) {
    // Se soubermos o BPM, alteramos exatamente 1 BPM. Senão, alteramos 0.01 do rácio.
    const stepAmount = this._baseBpm ? (1.0 / this._baseBpm) : 0.01;
    let t = this._tempo + (direction * stepAmount);
    t = Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, t));
    this._tempo = t;
    this._tempoEl.value = String(t);
    this._updateVisuals();
    this._commit();
  }

  _updateVisuals() {
    // Atualiza Texto do Pitch
    const sign = this._pitch > 0 ? '+' : '';
    this._pitchVal.textContent = `${sign}${this._pitch.toFixed(1).replace(/\.0$/, '.0')} st`;
    
    // Atualiza Texto do Tempo (BPM ou Ratio)
    if (this._baseBpm) {
      this._bpmBadge.style.display = 'inline-block';
      const currentBpm = Math.round(this._baseBpm * this._tempo);
      this._tempoVal.textContent = currentBpm;
    } else {
      this._bpmBadge.style.display = 'none';
      this._tempoVal.textContent = `${this._tempo.toFixed(2)}×`;
    }
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
    this._updateVisuals();
    this._guardUntilMs = Date.now() + GUARD_MS;
    this.send('intent.remix.reset', {});
  }

  _onFlagChange() {
    this._resetOnTrack = this._flagEl.checked;
    this.send('intent.remix.reset_flag.set', { enabled: this._resetOnTrack });
  }
}

customElements.define('rolfsound-remix-panel', RolfsoundRemixPanel);
export default RolfsoundRemixPanel;