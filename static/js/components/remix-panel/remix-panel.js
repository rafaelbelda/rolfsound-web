// static/js/components/remix-panel/remix-panel.js
// Remix controls — twin vertical gauges (BPM + Pitch) with live key/Camelot.
//
// This is panel *content* only: PlayerShell mounts it inside the body-appended
// side-panel container and owns the open/close/morph animation (same machinery
// as the queue). The component owns the gauges, the real-data wiring (channel
// subscriptions + intents) and the green→accent→red limit tinting.
import RolfsoundControl           from '../../core/RolfsoundControl.js';
import { adoptStyles as loadCss } from '../../core/adoptStyles.js';
import { deriveBaseKey, shiftKey } from '../../utils/keyShift.js';

const CSS_URL = '/static/js/components/remix-panel/remix-panel.css';

// Engine limits — pitch in semitones, tempo as a playback-rate ratio.
const PITCH = Object.freeze({ min: -12, max: 12, step: 0.5, neutral: 0 });
const TEMPO = Object.freeze({ min: 0.5, max: 2.0, neutral: 1 });

const INPUT_COMMIT_DEBOUNCE_MS = 140;
const GUARD_MS = 1600;
const LIMIT_RGB = [255, 77, 79];   // colour values fade toward near min/max
const WHITE_VAL = [244, 246, 244];
const WHITE_PTR = [255, 255, 255];
const ZONE = 8;                    // ticks from each edge where the red tint ramps in

// Haptics — Android (Vibration API) + iOS 17.4+ (hidden system-switch click).
// The switch element is created lazily once and reused for every tick.
const haptic = (() => {
  let iosSwitch = null;
  return () => {
    try {
      if (navigator.vibrate) { navigator.vibrate(10); return; }
      if (!iosSwitch) {
        const label = document.createElement('label');
        iosSwitch = document.createElement('input');
        iosSwitch.type = 'checkbox';
        iosSwitch.setAttribute('switch', '');
        label.style.cssText = 'position:fixed;top:-100px;left:-100px;opacity:0;pointer-events:none;';
        label.appendChild(iosSwitch);
        document.body.appendChild(label);
      }
      iosSwitch.parentElement.click();
      iosSwitch.checked = false;
    } catch {}
  };
})();

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mix   = (a, b, t) => a.map((x, k) => Math.round(x + (b[k] - x) * t));
const rgb   = c => `rgb(${c[0]},${c[1]},${c[2]})`;
const rgba  = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const comma = (n, dp = 1) => n.toFixed(dp).replace('.', ',');

const TEMPLATE = `
  <div class="remix-root">
    <header class="head">
      <h1>Remix</h1>
      <button class="close-btn" type="button" title="Close remix" aria-label="Close remix">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <path d="M18 6 6 18M6 6l12 12"/>
        </svg>
      </button>
    </header>

    <div class="stage">
      <div class="col" data-col="bpm">
        <span class="name">BPM</span>
        <div class="value"><span data-val>--</span><span class="unit">bpm</span></div>
        <div class="delta" data-delta></div>
        <div class="ruler-wrap">
          <div class="center-line"></div>
          <div class="ruler" data-ruler tabindex="0" role="slider" aria-label="Tempo in beats per minute"></div>
        </div>
      </div>

      <div class="col" data-col="pitch">
        <span class="name">Pitch</span>
        <div class="value"><span data-val>0,0</span><span class="unit">st</span></div>
        <div class="delta" data-delta></div>
        <div class="ruler-wrap">
          <div class="center-line"></div>
          <div class="ruler" data-ruler tabindex="0" role="slider" aria-label="Pitch in semitones"></div>
        </div>
      </div>
    </div>

    <div class="keys">
      <div class="k"><span class="lab">Key</span><span class="val key-std">--</span></div>
      <div class="k cam"><span class="lab">Camelot</span><span class="val key-cam">--</span></div>
    </div>

    <div class="foot"><button class="reset-btn" type="button">Reset</button></div>
  </div>
`;

/* ───────────── one vertical ruler (min at top, max at bottom) ─────────────
   index 0 = max value (top); scrolling down selects lower values. Built once
   per config; rebuilt when the BPM span (base tempo) changes. onUser fires only
   for user-driven scrolls so programmatic syncs never echo back to the engine. */
function VRuler(root, cfg, hooks) {
  const ruler   = root.querySelector('[data-ruler]');
  const valEl   = root.querySelector('[data-val]');
  const deltaEl = root.querySelector('[data-delta]');

  const STEP_PX = 18;
  const steps   = Math.max(1, Math.round((cfg.max - cfg.min) / cfg.step));
  const valueOf = i => Math.round((cfg.max - i * cfg.step) * 1000) / 1000;
  const indexOf = v => clamp(Math.round((cfg.max - v) / cfg.step), 0, steps);
  const edgeT   = i => { const d = Math.min(i, steps - i); return d < ZONE ? (ZONE - d) / ZONE : 0; };

  let index     = indexOf(cfg.start);
  let lastIndex = -1;
  let userActive = false;
  let raf = null, idleTimer = null;

  const track = document.createElement('div');
  track.className = 'rl-track';
  const pad = () => { const s = document.createElement('div'); s.className = 'rl-spacer'; return s; };
  const lead = pad(), tail = pad();
  track.appendChild(lead);

  const ticks = [], bars = [], baseColors = [];
  for (let i = 0; i <= steps; i++) {
    const v = valueOf(i), isMajor = cfg.major(v), t = edgeT(i);
    const a0   = isMajor ? 0.42 : 0.22;
    const base = t > 0 ? rgba(mix(WHITE_PTR, LIMIT_RGB, t), Math.min(0.85, a0 + 0.45 * t)) : `rgba(255,255,255,${a0})`;
    const tick = document.createElement('div');
    tick.className = 'rl-tick' + (isMajor ? ' major' : '');
    tick.style.height = STEP_PX + 'px';
    const bar = document.createElement('span');
    bar.className = 'rl-bar';
    bar.style.background = base;
    tick.appendChild(bar);
    if (isMajor) {
      const lab = document.createElement('span');
      lab.className = 'rl-lab';
      lab.textContent = cfg.label(v);
      tick.appendChild(lab);
    }
    track.appendChild(tick);
    ticks.push(tick); bars.push(bar); baseColors.push(base);
  }
  track.appendChild(tail);
  ruler.appendChild(track);

  function sizeSpacers() {
    const half = Math.max(0, Math.round(ruler.clientHeight / 2 - STEP_PX / 2));
    lead.style.height = half + 'px';
    tail.style.height = (half + 2) + 'px';
  }
  function scrollToIndex(i, smooth) {
    ruler.scrollTo({ top: i * STEP_PX, behavior: smooth ? 'smooth' : 'auto' });
  }

  function paint(i) {
    const v = valueOf(i);
    valEl.textContent   = cfg.fmt(v);
    deltaEl.textContent = cfg.delta(v);
    if (i === lastIndex) return;
    if (bars[lastIndex]) { ticks[lastIndex].classList.remove('active'); bars[lastIndex].style.background = baseColors[lastIndex]; }
    const t = edgeT(i), accent = hooks.accent();
    if (bars[i]) { ticks[i].classList.add('active'); bars[i].style.background = rgb(mix(accent, LIMIT_RGB, t)); }
    root.style.setProperty('--ptr', rgb(mix(accent, LIMIT_RGB, t)));
    root.style.setProperty('--valcol', t > 0 ? rgb(mix(WHITE_VAL, LIMIT_RGB, t)) : 'var(--ink)');
    ruler.setAttribute('aria-valuenow', v);
    ruler.setAttribute('aria-valuetext', cfg.fmt(v) + ' ' + cfg.unit);
    lastIndex = i;
    hooks.haptic?.();
  }

  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const i = clamp(Math.round(ruler.scrollTop / STEP_PX), 0, steps);
      const changed = i !== index;
      index = i;
      paint(i);
      if (userActive && changed) cfg.onUser(valueOf(i));
    });
  }
  ruler.addEventListener('scroll', onScroll, { passive: true });

  const markActive = () => {
    userActive = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { userActive = false; }, 480);
  };
  ['pointerdown', 'wheel', 'touchstart', 'keydown'].forEach(ev =>
    ruler.addEventListener(ev, markActive, { passive: true }));

  // Pointer drag (touch + wheel are native for a vertical scroll container).
  let dragging = false, startY = 0, startTop = 0;
  ruler.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse') return;
    dragging = true; startY = e.clientY; startTop = ruler.scrollTop;
    ruler.setPointerCapture(e.pointerId);
  });
  ruler.addEventListener('pointermove', e => { if (dragging) ruler.scrollTop = startTop - (e.clientY - startY); });
  const endDrag = () => { if (dragging) { dragging = false; scrollToIndex(index, true); } };
  ruler.addEventListener('pointerup', endDrag);
  ruler.addEventListener('pointercancel', endDrag);

  ruler.addEventListener('keydown', e => {
    let d = 0;
    if (e.key === 'ArrowUp') d = -1;
    if (e.key === 'ArrowDown') d = 1;
    if (!d) return;
    e.preventDefault();
    index = clamp(index + d, 0, steps);
    scrollToIndex(index, true);
  });

  const onResize = () => { sizeSpacers(); scrollToIndex(index, false); };
  window.addEventListener('resize', onResize);

  requestAnimationFrame(() => { sizeSpacers(); scrollToIndex(index, false); paint(index); });

  return {
    /** Move to a value without firing onUser (engine/track-driven sync). */
    setValue(v) {
      index = indexOf(v);
      sizeSpacers();
      scrollToIndex(index, false);
      paint(index);
    },
    refresh() { sizeSpacers(); scrollToIndex(index, false); paint(index); },
    get value() { return valueOf(index); },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      if (idleTimer) clearTimeout(idleTimer);
      window.removeEventListener('resize', onResize);
      ruler.removeEventListener('scroll', onScroll);
      ruler.replaceChildren();
    },
  };
}

class RolfsoundRemixPanel extends RolfsoundControl {
  constructor() {
    super();
    this._pitch = 0;
    this._tempo = 1;
    this._baseBpm = null;
    this._baseKey = null;
    this._currentTrackId = null;

    this._bpmRuler = null;
    this._pitchRuler = null;

    this._pending = false;
    this._dirty = false;
    this._emitTimer = null;
    this._guardUntilMs = 0;
  }

  render() {
    this.shadowRoot.innerHTML = TEMPLATE;
    this._els = {
      keyStd:  this.shadowRoot.querySelector('.key-std'),
      keyCam:  this.shadowRoot.querySelector('.key-cam'),
      bpmCol:  this.shadowRoot.querySelector('[data-col="bpm"]'),
      pitchCol:this.shadowRoot.querySelector('[data-col="pitch"]'),
    };
    this.shadowRoot.querySelector('.reset-btn').addEventListener('click', () => this._reset());
    this.shadowRoot.querySelector('.close-btn').addEventListener('click', () => {
      // Same toggle path the button uses — PlayerShell owns the close animation.
      this.dispatchEvent(new CustomEvent('rolfsound-remix-click', { bubbles: true, composed: true }));
    });
    loadCss(CSS_URL).then(sheet => { this.shadowRoot.adoptedStyleSheets = [sheet]; });

    this._buildPitchRuler();
    this._buildBpmRuler();
    this._paintKey();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._emitTimer) clearTimeout(this._emitTimer);
    this._bpmRuler?.destroy();
    this._pitchRuler?.destroy();
    this._bpmRuler = this._pitchRuler = null;
  }

  subscribe() {
    this.on('state.remix', s => {
      if (Date.now() < this._guardUntilMs) return;
      if (typeof s.pitch_semitones === 'number') {
        this._pitch = clamp(s.pitch_semitones, PITCH.min, PITCH.max);
        this._pitchRuler?.setValue(this._pitch);
        this._paintKey();
      }
      if (typeof s.tempo_ratio === 'number') {
        this._tempo = clamp(s.tempo_ratio, TEMPO.min, TEMPO.max);
        if (this._baseBpm) this._bpmRuler?.setValue(Math.round(this._baseBpm * this._tempo));
      }
    });

    this.on('state.playback', s => {
      const queueTracks  = Array.isArray(s?.queue) ? s.queue : (s?.queue?.tracks || []);
      const currentIndex = s?.queue_current_index ?? s?.queue?.current_index ?? -1;
      const track = queueTracks[currentIndex] || null;
      this._currentTrackId = s?.track_id || track?.track_id || track?.id || null;
      this._applyMetadata({
        ...(track || {}),
        bpm:         s?.bpm         ?? track?.bpm,
        musical_key: s?.musical_key ?? track?.musical_key,
        camelot_key: s?.camelot_key ?? track?.camelot_key,
      });
    });

    this.on('event.track_updated', frame => {
      const track   = frame?.payload ?? frame;
      const trackId = track?.id || track?.track_id;
      if (this._currentTrackId && trackId && trackId !== this._currentTrackId) return;
      this._applyMetadata(track);
    });
  }

  /** Called by PlayerShell once the container is sized & visible. */
  activate() {
    // Two nested RAFs: first lets the browser finish layout after the container
    // becomes visible; second fires after the resulting geometry is painted so
    // sizeSpacers() reads the actual clientHeight (not 0).
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this._pitchRuler?.refresh();
      this._bpmRuler?.refresh();
    }));
    // The channel doesn't replay the last snapshot to new subscribers and this
    // panel only mounts on open, so pull the current track + remix state once so
    // the gauges open already showing real values (same source as the manager).
    this._seedFromStatus();
  }

  async _seedFromStatus() {
    try {
      const r = await fetch('/api/status');
      if (!r.ok) return;
      const s = await r.json();
      this._currentTrackId = s?.track_id || this._currentTrackId;
      this._applyMetadata({ bpm: s?.bpm, musical_key: s?.musical_key, camelot_key: s?.camelot_key });

      const remix = s?.remix;
      if (!remix || Date.now() < this._guardUntilMs) return;
      if (typeof remix.pitch_semitones === 'number') {
        this._pitch = clamp(remix.pitch_semitones, PITCH.min, PITCH.max);
        this._pitchRuler?.setValue(this._pitch);
        this._paintKey();
      }
      if (typeof remix.tempo_ratio === 'number') {
        this._tempo = clamp(remix.tempo_ratio, TEMPO.min, TEMPO.max);
        if (this._baseBpm) this._bpmRuler?.setValue(Math.round(this._baseBpm * this._tempo));
      }
    } catch {}
  }

  // ── ruler builders ──────────────────────────────────────────────

  _accent() {
    const raw = getComputedStyle(this).getPropertyValue('--rs-theme-accent-rgb').trim();
    const m = raw.match(/\d+/g);
    if (m && m.length >= 3) {
      const c = [+m[0], +m[1], +m[2]];
      if (c[0] + c[1] + c[2] > 90) return c;   // ignore the near-black neutral
    }
    return [33, 211, 101];
  }

  _buildPitchRuler() {
    this._pitchRuler?.destroy();
    this._pitchRuler = VRuler(this._els.pitchCol, {
      min: PITCH.min, max: PITCH.max, step: PITCH.step, start: this._pitch, unit: 'st',
      major: v => Number.isInteger(v),
      label: v => (v > 0 ? '+' : '') + v,
      fmt:   v => (v > 0 ? '+' : '') + comma(v, 1),
      delta: v => '(' + (v > 0 ? '+' : '') + comma((Math.pow(2, v / 12) - 1) * 100, 1) + '%)',
      onUser: v => this._onPitch(v),
    }, { accent: () => this._accent(), haptic });
  }

  _buildBpmRuler() {
    this._bpmRuler?.destroy();
    const valEl = this._els.bpmCol.querySelector('[data-val]');
    if (!this._baseBpm) { this._bpmRuler = null; if (valEl) valEl.textContent = '--'; return; }
    const base  = this._baseBpm;
    const min   = Math.round(base * TEMPO.min);
    const max   = Math.round(base * TEMPO.max);
    const start = clamp(Math.round(base * this._tempo), min, max);
    this._bpmRuler = VRuler(this._els.bpmCol, {
      min, max, step: 1, start, unit: 'bpm',
      major: v => v % 5 === 0,
      label: v => v,
      fmt:   v => String(v),
      delta: v => '(' + (v >= base ? '+' : '') + comma((v - base) / base * 100, 1) + '%)',
      onUser: v => this._onBpm(v),
    }, { accent: () => this._accent(), haptic });
  }

  // ── user input ──────────────────────────────────────────────────

  _onPitch(v) {
    this._pitch = clamp(v, PITCH.min, PITCH.max);
    this._paintKey();
    this._dirty = true;
    this._scheduleIntent();
  }

  _onBpm(v) {
    if (!this._baseBpm) return;
    this._tempo = clamp(v / this._baseBpm, TEMPO.min, TEMPO.max);
    this._dirty = true;
    this._scheduleIntent();
  }

  // ── derived key / camelot ──────────────────────────────────────

  _paintKey() {
    const shifted = shiftKey(this._baseKey, this._pitch);
    this._els.keyStd.textContent = shifted?.name    || '--';
    this._els.keyCam.textContent = shifted?.camelot || '--';
  }

  _applyMetadata(data) {
    if (!data) return;
    const bpm        = data.bpm ?? data.metadata?.bpm ?? null;
    const musicalKey = data.musical_key ?? data.metadata?.musical_key ?? null;
    const camelotKey = data.camelot_key ?? data.metadata?.camelot_key ?? null;
    const nextBase   = (bpm != null && Number.isFinite(Number(bpm))) ? Number(bpm) : null;
    const nextKey    = deriveBaseKey({ camelot_key: camelotKey, musical_key: musicalKey });

    if (nextBase !== this._baseBpm) {
      this._baseBpm = nextBase;
      this._buildBpmRuler();   // span depends on base tempo
    }
    const keyChanged = JSON.stringify(nextKey) !== JSON.stringify(this._baseKey);
    if (keyChanged) {
      this._baseKey = nextKey;
      this._paintKey();
    }
  }

  // ── engine intents (debounced, guarded against echo) ───────────

  _scheduleIntent() {
    this._pending = true;
    if (this._emitTimer) clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => { this._emitTimer = null; this._commit(); }, INPUT_COMMIT_DEBOUNCE_MS);
  }

  _commit() {
    if (this._emitTimer) { clearTimeout(this._emitTimer); this._emitTimer = null; }
    if (!this._pending && !this._dirty) return;
    this._pending = false;
    this._dirty = false;
    this._guardUntilMs = Date.now() + GUARD_MS;
    this.send('intent.remix.set', { pitch_semitones: this._pitch, tempo_ratio: this._tempo });
  }

  _reset() {
    this._pitch = PITCH.neutral;
    this._tempo = TEMPO.neutral;
    this._pending = false;
    this._dirty = false;
    if (this._emitTimer) { clearTimeout(this._emitTimer); this._emitTimer = null; }
    this._pitchRuler?.setValue(this._pitch);
    if (this._baseBpm) this._bpmRuler?.setValue(Math.round(this._baseBpm * this._tempo));
    this._paintKey();
    this._guardUntilMs = Date.now() + GUARD_MS;
    this.send('intent.remix.reset', {});
  }
}

customElements.define('rolfsound-remix-panel', RolfsoundRemixPanel);
export default RolfsoundRemixPanel;
