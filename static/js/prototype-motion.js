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

  // reactive-mesh envelope — nível/bandas REAIS do core via levels-feed.js
  // quando online; offline cai no sintético de sempre (ease + relógio de BPM)
  let level = 0;          // smoothed overall gain 0..1
  let beatIdx = -1, beatT = 0;
  let lvlAvg = 0;         // média móvel do nível (base do detector de beat)
  let lastFeedAt = 0;     // timestamp do último poll consumido
  let bandsSm = null;     // bandas suavizadas por frame (poll é ~8 Hz)

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

    // ---- reactive envelope: level swells while playing, beat punches on the grid.
    //      Com o core online (levels-feed.js) o nível é o pico L/R REAL da saída;
    //      offline, o ease sintético de sempre. ----
    const feed = window.RolfLevels;
    const live = play && feed && feed.online;
    const raw = live ? Math.min(1, Math.max(feed.l, feed.r) * 1.15)
                     : (play ? 0.85 : 0);
    // ataque rápido (acende no transiente), release lento (respira)
    level += (raw - level) * Math.min(1, dt * (raw > level ? 10 : 2.6));
    if (!play && level < 0.001) level = 0;
    // beat: online, detector de transiente (salto do nível sobre a média
    // móvel, avaliado uma vez por amostra do poll); offline, relógio de
    // parede no BPM da row ativa — como era.
    const activeRow = document.querySelector('.row.active');
    const bpm = activeRow ? (+activeRow.dataset.bpm || 118) : 118;
    if (live) {
      if (feed.at !== lastFeedAt) {
        lastFeedAt = feed.at;
        if (raw > 0.12 && raw > lvlAvg * 1.28 && now - beatT > 180) beatT = now;
        lvlAvg += (raw - lvlAvg) * 0.18;   // constante ~600 ms @ poll de 120 ms
      }
    } else if (play) {
      const beatLen = 60 / bpm;
      const idx = Math.floor((now / 1000) / beatLen);
      if (idx !== beatIdx) { beatIdx = idx; beatT = now; }
    }
    const sinceBeat = (now - beatT) / 1000;
    const beat = play ? Math.exp(-sinceBeat * 7) : 0;

    // bandas do espectro: suavizadas por frame pro campo fluir a 30 fps
    let bands = null;
    if (live && feed.bands && feed.bands.length) {
      if (!bandsSm || bandsSm.length !== feed.bands.length) bandsSm = feed.bands.slice();
      for (let i = 0; i < bandsSm.length; i++) {
        const t = feed.bands[i];
        bandsSm[i] += (t - bandsSm[i]) * Math.min(1, dt * (t > bandsSm[i] ? 12 : 3.2));
      }
      bands = bandsSm;
    } else {
      bandsSm = null;
    }
    const vizState = { t: now / 1000, beat: beat, level: level, bands: bands };

    // advance global playback while playing.
    // Com playback.js ativo (engineDriven), a posição vem do CORE por
    // dead-reckoning e o próprio bridge renderiza .tp-fill/.tp-time —
    // este bloco fake fica de fora por completo.
    if (play && !Player.engineDriven) {
      Player.pos += dt / Player.dur;
      if (Player.pos >= 1) {
        Player.pos = 0;
        document.dispatchEvent(new CustomEvent('rolf:ended'));
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

  // consumidor do poller de níveis: o transporte (mini-vis) está sempre
  // visível, então o predicado é só "tocando e com motion ligado";
  // 24 bandas servem o mini-vis e o viz fullscreen (mesmo pintor).
  if (window.RolfLevels) {
    window.RolfLevels.register('viz', () => playing() && !reduce(), { bands: 24 });
  }

  // initial transport progress reflects restored position
  document.querySelectorAll('.tp-fill').forEach((f) => { f.style.width = (Player.pos * 100).toFixed(2) + '%'; });
  const vf0 = document.querySelector('.tp-vol-fill');
  if (vf0) vf0.style.width = (Player.volume * 100).toFixed(0) + '%';

  requestAnimationFrame(frame);
})();
