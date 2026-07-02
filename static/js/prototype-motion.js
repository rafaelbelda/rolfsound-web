/* ============================================================
   ROLFSOUND V2 — Motion
   Brings the prototype to life: the transport visualizer pulses
   while playing, the capture spectrogram scrolls toward the
   head, L/R meters react, and the Remixer playhead creeps.
   Only the ACTIVE screen's heavy canvas animates (throttled),
   and everything yields to prefers-reduced-motion.
   ============================================================ */
(function () {
  'use strict';

  const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const body = document.body;
  const reduce = () => reduceMQ || body.classList.contains('reduce-motion');

  // shared player state (created here or by prototype.js, whichever runs first)
  const Player = window.RolfPlayer = window.RolfPlayer || {};
  if (typeof Player.dur !== 'number') Player.dur = 228;          // 3:48 track length
  if (typeof Player.pos !== 'number') {
    const p = parseFloat(localStorage.getItem('rolf_pos') || '0');
    Player.pos = (p >= 0 && p < 1) ? p : 0;
  }
  if (typeof Player.volume !== 'number') Player.volume = 0.62;

  let last = performance.now();
  let tMatrix = 0, tSpectro = 0, tWave = 0, tSave = 0, tViz = 0;

  // reactive-mesh envelope (ported from the iPhone grid.js)
  let level = 0;          // smoothed overall gain 0..1
  let beatIdx = -1, beatT = 0;

  const $ = (s) => document.querySelector(s);

  function activeScreen() {
    const s = $('.screen.active');
    return s ? s.dataset.screen : '';
  }
  function playing() { return !body.classList.contains('paused'); }
  function fmt(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function meters(now) {
    const fills = document.querySelectorAll('.cap-meter-fill');
    const peaks = document.querySelectorAll('.cap-meter-peak');
    fills.forEach((f, i) => {
      const v = 0.58 + 0.2 * Math.sin(now / 230 + i * 1.7)
                     + 0.12 * Math.sin(now / 70 + i * 3.1)
                     + 0.06 * Math.sin(now / 31 + i);
      const c = Math.max(0.12, Math.min(0.97, v));
      f.style.height = (c * 100).toFixed(1) + '%';
      const pk = peaks[i];
      if (pk) {
        const cur = parseFloat(pk.style.bottom) || 80;
        const target = c * 100 + 6;
        pk.style.bottom = (target > cur ? target : cur - 0.4).toFixed(1) + '%';
      }
    });
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const scr = activeScreen();
    const play = playing();
    const draw = window.RolfDraw;

    // ---- reactive envelope: level swells while playing, beat punches on the grid ----
    const target = play ? 0.85 : 0;
    level += (target - level) * Math.min(1, dt * 3.2);
    if (!play && level < 0.001) level = 0;
    // BPM comes from the now-playing row; drives the beat clock
    const activeRow = document.querySelector('.row.active');
    const bpm = activeRow ? (+activeRow.dataset.bpm || 118) : 118;
    if (play) {
      const beatLen = 60 / bpm;
      const idx = Math.floor((now / 1000) / beatLen);
      if (idx !== beatIdx) { beatIdx = idx; beatT = now; }
    }
    const sinceBeat = (now - beatT) / 1000;
    const beat = play ? Math.exp(-sinceBeat * 7) : 0;
    const vizState = { t: now / 1000, beat: beat, level: level };

    // advance global playback while playing
    if (play) {
      if (!Player.engineDriven) {
        Player.pos += dt / Player.dur;
        if (Player.pos >= 1) {
          Player.pos = 0;
          document.dispatchEvent(new CustomEvent('rolf:ended'));
        }
      }
      document.querySelectorAll('.tp-fill').forEach((f) => { f.style.width = (Player.pos * 100).toFixed(2) + '%'; });
      const times = document.querySelectorAll('.transport .tp-time');
      if (times[0]) times[0].textContent = fmt(Player.pos * Player.dur);
      const ve = document.querySelector('[data-viz-elapsed]');
      if (ve) ve.textContent = fmt(Player.pos * Player.dur);
      if (now - tSave > 600) { tSave = now; localStorage.setItem('rolf_pos', Player.pos.toFixed(4)); }
    }

    if (!reduce() && draw) {
      // fullscreen visualizer — full-bleed reactive dot field
      const vizEl = document.querySelector('[data-viz]:not([hidden])');
      if (vizEl && now - tViz > 33) {
        tViz = now;
        const cv = vizEl.querySelector('.viz-dots');
        if (cv) draw.matrix(cv, vizState);
      }

      // transport mini visualizer — reacts to the beat (keeps a faint idle shimmer)
      if (now - tMatrix > 33) {
        tMatrix = now;
        const cv = $('.transport canvas.tp-mini-vis');
        if (cv) draw.matrix(cv, vizState);
      }

      // capturar: scrolling spectrogram + reacting meters
      if (scr === 'capturar') {
        const recording = $('.cap .rec-btn.recording');
        if (recording) {
          if (now - tSpectro > 45) {
            tSpectro = now;
            const cv = $('.spectro-cv');
            if (cv) draw.spectro(cv, now / 1000 * 0.22);
          }
          meters(now);
        }
      }

      // remixer: playhead creeps, coloured waveform follows
      if (scr === 'remixer') {
        const ph = $('.wave-playhead');
        if (ph) ph.style.left = (Player.pos * 100).toFixed(2) + '%';
        if (now - tWave > 110) {
          tWave = now;
          const cv = $('.wave-canvas');
          if (cv) { cv.dataset.played = Player.pos.toFixed(3); draw.wave(cv); }
        }
      }
    }

    requestAnimationFrame(frame);
  }

  // initial transport progress reflects restored position
  document.querySelectorAll('.tp-fill').forEach((f) => { f.style.width = (Player.pos * 100).toFixed(2) + '%'; });
  const vf0 = document.querySelector('.tp-vol-fill');
  if (vf0) vf0.style.width = (Player.volume * 100).toFixed(0) + '%';

  requestAnimationFrame(frame);
})();
