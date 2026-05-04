// static/js/components/remix-panel/remix-panel.js
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';
import '../knob/knob.js?v=player-knob-fix-20260501';

const CSS_URL = '/static/js/components/remix-panel/remix-panel.css';

const KNOBS = Object.freeze({
  pitch: {
    min: -12,
    max: 12,
    step: 0.5,
    neutral: 0,
    valueKey: '_pitch',
  },
  tempo: {
    min: 0.5,
    max: 2.0,
    step: 0.01,
    neutral: 1,
    valueKey: '_tempo',
  },
});

const INPUT_COMMIT_DEBOUNCE_MS = 140;
const GUARD_MS = 1600;
const TEMPLATE = `
  <aside class="panel" aria-hidden="true" aria-label="Remix controls">
    <header class="meta-top">
      <div class="meta-copy">
        <span class="meta-label">Tempo</span>
        <strong class="bpm-value">-- BPM</strong>
      </div>
      <button class="panel-close-btn" type="button" title="Close remix" aria-label="Close remix">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <path d="M18 6 6 18M6 6l12 12"/>
        </svg>
      </button>
    </header>

    <section class="knob-stack">
      <article class="knob-unit" data-kind="tempo">
        <rolfsound-knob class="knob-control" min="0.5" max="2" step="0.01" value="1" neutral="1"
          px-per-step="4" sweep="270" start="-135" data-cursor="range" aria-label="BPM"></rolfsound-knob>
        <div class="knob-copy">
          <span class="knob-label">BPM</span>
          <strong class="tempo-value">1.00x</strong>
        </div>
      </article>

      <article class="knob-unit" data-kind="pitch">
        <rolfsound-knob class="knob-control" min="-12" max="12" step="0.5" value="0" neutral="0"
          px-per-step="7" sweep="270" start="-135" data-cursor="range" aria-label="Pitch"></rolfsound-knob>
        <div class="knob-copy">
          <span class="knob-label">Pitch</span>
          <strong class="pitch-value">0.0 st</strong>
        </div>
      </article>
    </section>

    <footer class="meta-bottom">
      <span class="key-value">--</span>
      <span class="camelot-value">--</span>
      <button class="reset-btn" type="button" title="Reset remix">Reset</button>
    </footer>
  </aside>
`;

class RolfsoundRemixPanel extends RolfsoundControl {
  constructor() {
    super();
    this._open = false;
    this._pitch = 0;
    this._tempo = 1;
    this._baseBpm = null;
    this._musicalKey = null;
    this._camelotKey = null;
    this._currentTrackId = null;

    this._raf = 0;
    this._pending = null;
    this._emitTimer = null;
    this._dirty = false;
    this._guardUntilMs = 0;
    this._activeKnob = null;
    this._motion = null;
    this._onWindowToggle = event => this._toggle(event?.detail?.sourceRect);
  }

  render() {
    this.shadowRoot.innerHTML = TEMPLATE;
    this._cacheDom();
    this._bindKnob('pitch');
    this._bindKnob('tempo');
    this._resetBtn.addEventListener('click', () => this._reset());
    this._closeBtn.addEventListener('click', () => this._setOpen(false));
    loadCss(CSS_URL).then(sheet => { this.shadowRoot.adoptedStyleSheets = [sheet]; });
    this._schedulePaint();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('rolfsound:remix-panel:toggle', this._onWindowToggle);
    if (this._emitTimer) clearTimeout(this._emitTimer);
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._motion) this._motion.cancel();
  }

  subscribe() {
    window.addEventListener('rolfsound:remix-panel:toggle', this._onWindowToggle);
    this.on('state.remix', s => {
      if (this._activeKnob || Date.now() < this._guardUntilMs) return;
      if (typeof s.pitch_semitones === 'number') this._pitch = this._clamp('pitch', s.pitch_semitones);
      if (typeof s.tempo_ratio === 'number') this._tempo = this._clamp('tempo', s.tempo_ratio);
      this._schedulePaint();
    });

    this.on('state.playback', s => {
      const queueTracks = Array.isArray(s?.queue) ? s.queue : (s?.queue?.tracks || []);
      const currentIndex = s?.queue_current_index ?? s?.queue?.current_index ?? -1;
      const track = queueTracks[currentIndex] || null;
      this._currentTrackId = s?.track_id || track?.track_id || track?.id || null;
      this._applyMetadata({
        ...(track || {}),
        bpm: s?.bpm ?? track?.bpm,
        musical_key: s?.musical_key ?? track?.musical_key,
        camelot_key: s?.camelot_key ?? track?.camelot_key,
      });
    });

    this.on('event.track_updated', frame => {
      const track = frame?.payload ?? frame;
      const trackId = track?.id || track?.track_id;
      if (this._currentTrackId && trackId && trackId !== this._currentTrackId) return;
      this._applyMetadata(track);
    });
  }

  _cacheDom() {
    this._panel    = this.shadowRoot.querySelector('.panel');
    this._resetBtn = this.shadowRoot.querySelector('.reset-btn');
    this._closeBtn = this.shadowRoot.querySelector('.panel-close-btn');
    this._els = {
      bpm: this.shadowRoot.querySelector('.bpm-value'),
      key: this.shadowRoot.querySelector('.key-value'),
      camelot: this.shadowRoot.querySelector('.camelot-value'),
      pitchValue: this.shadowRoot.querySelector('.pitch-value'),
      tempoValue: this.shadowRoot.querySelector('.tempo-value'),
      pitchKnob: this.shadowRoot.querySelector('[data-kind="pitch"] rolfsound-knob'),
      tempoKnob: this.shadowRoot.querySelector('[data-kind="tempo"] rolfsound-knob'),
    };
  }

  _bindKnob(kind) {
    const knob = this._els[`${kind}Knob`];
    knob.addEventListener('rs-knob-input', e => this._onRemixInput(kind, e.detail.value));
    knob.addEventListener('rs-knob-change', e => this._onRemixCommit(kind, e.detail.value));
  }

  _toggle(sourceRect = null) {
    this._setOpen(!this._open, sourceRect);
  }

  _setOpen(open, sourceRect = null) {
    if (open === this._open) return;
    this._open = open;
    this.classList.toggle('open', open);
    this._playPanelMorph(open, sourceRect);
    window.dispatchEvent(new CustomEvent('rolfsound:remix-panel:state', {
      detail: { open },
    }));
  }

  _playPanelMorph(open, sourceRect = null) {
    const fromRect = sourceRect || this._buttonRect({ expanded: !open });
    const targetRect = this.getBoundingClientRect();
    const morph = this._morphTransform(fromRect, targetRect);

    if (this._motion) {
      this._motion.cancel();
      this._motion = null;
    }

    this._panel.classList.add('morphing');
    this._panel.style.pointerEvents = 'none';

    if (open) {
      this._panel.setAttribute('aria-hidden', 'false');
    }

    const frames = open
      ? [
          { opacity: '0.92', transform: morph, borderRadius: 'var(--radius-dynamic-island)' },
          { opacity: '1', transform: 'none', borderRadius: 'var(--radius-dynamic-island-expanded)' },
        ]
      : [
          { opacity: '1', transform: 'none', borderRadius: 'var(--radius-dynamic-island-expanded)' },
          { opacity: '0', transform: morph, borderRadius: 'var(--radius-dynamic-island)' },
        ];

    const motion = this._panel.animate(frames, {
      duration: open ? 520 : 420,
      easing: open ? 'cubic-bezier(0.2, 0, 0, 1)' : 'cubic-bezier(0.3, 0, 1, 1)',
    });

    this._motion = motion;
    motion.onfinish = () => {
      if (this._motion !== motion) return;
      this._motion = null;
      this._panel.classList.remove('morphing');
      this._panel.style.pointerEvents = '';
      this._panel.style.borderRadius = '';
      if (!this._open) this._panel.setAttribute('aria-hidden', 'true');
    };
    motion.oncancel = () => {
      if (this._motion === motion) this._motion = null;
      this._panel.classList.remove('morphing');
      this._panel.style.pointerEvents = '';
      this._panel.style.borderRadius = '';
    };
  }

  _buttonRect({ expanded = false } = {}) {
    const btn = this.parentElement?.querySelector('#btn-remix');
    const shellRect = this.parentElement?.getBoundingClientRect?.();
    if (expanded && shellRect?.width && shellRect?.height) {
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

    const rect = btn?.getBoundingClientRect?.();
    if (rect && rect.width && rect.height) return this._plainRect(rect);
    const target = this.getBoundingClientRect();
    return {
      left: target.right - 56,
      top: target.bottom - 56,
      width: 56,
      height: 56,
      right: target.right,
      bottom: target.bottom,
    };
  }

  _plainRect(rect) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }

  _morphTransform(sourceRect, targetRect) {
    if (!sourceRect || !targetRect?.width || !targetRect?.height) {
      return 'translateX(18px) scale(0.96)';
    }

    const sourceCenterX = sourceRect.left + sourceRect.width / 2;
    const sourceCenterY = sourceRect.top + sourceRect.height / 2;
    const targetCenterX = targetRect.left + targetRect.width / 2;
    const targetCenterY = targetRect.top + targetRect.height / 2;
    const dx = sourceCenterX - targetCenterX;
    const dy = sourceCenterY - targetCenterY;
    const scaleX = sourceRect.width / targetRect.width;
    const scaleY = sourceRect.height / targetRect.height;

    return `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`;
  }

  _onRemixInput(kind, value) {
    this._activeKnob = kind;
    if (this._applyKnobValue(kind, value)) this._scheduleIntent();
  }

  _onRemixCommit(kind, value) {
    this._applyKnobValue(kind, value);
    this._commit();
    if (this._activeKnob === kind) this._activeKnob = null;
  }

  _applyKnobValue(kind, value) {
    const cfg = KNOBS[kind];
    const nextValue = this._clamp(kind, value);
    if (this[cfg.valueKey] === nextValue) return false;
    this[cfg.valueKey] = nextValue;
    this._dirty = true;
    this._schedulePaint();
    return true;
  }

  _clamp(kind, value) {
    const cfg = KNOBS[kind];
    const number = Number(value);
    const safe = Number.isFinite(number) ? number : cfg.neutral;
    return Math.max(cfg.min, Math.min(cfg.max, safe));
  }

  _schedulePaint() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._paintKnobs();
      this._paintMetadata();
    });
  }

  _paintKnobs() {
    const sign = this._pitch > 0 ? '+' : '';
    this._els.pitchValue.textContent = `${sign}${this._pitch.toFixed(1)} st`;
    this._els.pitchKnob.setValue(this._pitch);
    this._els.pitchKnob.setAttribute('aria-valuetext', `${sign}${this._pitch.toFixed(1)} semitones`);

    const tempoText = this._baseBpm
      ? `${Math.round(this._baseBpm * this._tempo)} BPM`
      : `${this._tempo.toFixed(2)}x`;
    this._els.tempoValue.textContent = tempoText;
    this._els.tempoKnob.setValue(this._tempo);
    this._els.tempoKnob.setAttribute('aria-valuetext', tempoText);
  }

  _paintMetadata() {
    this._els.bpm.textContent = this._baseBpm ? `${Math.round(this._baseBpm)} BPM` : '-- BPM';
    this._els.key.textContent = this._formatMusicalKey(this._musicalKey);
    this._els.camelot.textContent = this._camelotKey || '--';
  }

  _formatMusicalKey(value) {
    const text = String(value || '').trim();
    if (!text) return '--';

    const normalized = text
      .replace(/\s+/g, ' ')
      .replace(/♯/g, '#')
      .replace(/♭/g, 'b');

    const match = normalized.match(/^([A-Ga-g])([#b]?)(?:\s+|-)?(major|minor|maj|min|m)?$/i);
    if (!match) return normalized;

    const note = `${match[1].toUpperCase()}${match[2] || ''}`;
    const mode = String(match[3] || '').toLowerCase();
    return mode === 'minor' || mode === 'min' || mode === 'm'
      ? `${note}m`
      : note;
  }

  _applyMetadata(data) {
    if (!data) return;
    const bpm = data.bpm ?? data.metadata?.bpm ?? null;
    const musicalKey = data.musical_key ?? data.metadata?.musical_key ?? null;
    const camelotKey = data.camelot_key ?? data.metadata?.camelot_key ?? null;
    const changed = (
      this._baseBpm !== bpm ||
      this._musicalKey !== musicalKey ||
      this._camelotKey !== camelotKey
    );
    if (!changed) return;
    this._baseBpm = bpm;
    this._musicalKey = musicalKey;
    this._camelotKey = camelotKey;
    this._schedulePaint();
  }

  _scheduleIntent() {
    this._pending = true;
    if (this._emitTimer) clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this._commit();
    }, INPUT_COMMIT_DEBOUNCE_MS);
  }

  _commit() {
    if (this._emitTimer) {
      clearTimeout(this._emitTimer);
      this._emitTimer = null;
    }
    if (!this._pending && !this._dirty) return;
    this._pending = null;
    this._dirty = false;
    this._guardUntilMs = Date.now() + GUARD_MS;
    this.send('intent.remix.set', this._remixPayload());
  }

  _remixPayload() {
    return {
      pitch_semitones: this._pitch,
      tempo_ratio: this._tempo,
    };
  }

  _reset() {
    this._pitch = KNOBS.pitch.neutral;
    this._tempo = KNOBS.tempo.neutral;
    this._pending = null;
    this._dirty = false;
    if (this._emitTimer) {
      clearTimeout(this._emitTimer);
      this._emitTimer = null;
    }
    this._schedulePaint();
    this._guardUntilMs = Date.now() + GUARD_MS;
    this.send('intent.remix.reset', {});
  }
}

customElements.define('rolfsound-remix-panel', RolfsoundRemixPanel);
export default RolfsoundRemixPanel;
