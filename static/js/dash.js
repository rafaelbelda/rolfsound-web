/* ============================================================
   ROLFSOUND V2 — Dashboard static visuals
   Paints the registration mesh and the dot-matrix visualizers
   (the hero motif) into every frame. O campo de pontos desenha
   o espectro REAL quando o motion passa `bands` (FFT do core em
   /api/levels?bands=N, via levels-feed.js); sem core, cai no
   envelope sintético com seed. O espectrograma do Capturar
   segue sintético — é mockup junto com a tela (TO-DO item 4).
   ============================================================ */
(function () {
  'use strict';

  function accentOf(el) {
    return getComputedStyle(el).getPropertyValue('--accent').trim() || '#c8693c';
  }

  /* ---- faint registration mesh behind each frame ---- */
  function paintMesh(cv) {
    const dash = cv.closest('.dash, .appshell') || cv.parentElement;
    const w = dash.clientWidth, h = dash.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const gap = 30;
    for (let y = gap; y < h; y += gap) {
      for (let x = gap; x < w; x += gap) {
        const key = (x / gap) % 5 === 0 && (y / gap) % 5 === 0;
        ctx.beginPath();
        ctx.arc(x, y, key ? 1.3 : 0.8, 0, Math.PI * 2);
        ctx.fillStyle = key ? 'rgba(232,233,238,0.14)' : 'rgba(232,233,238,0.05)';
        ctx.fill();
      }
    }
  }

  /* ---- dot-matrix visualizer: a grid of dots, lit toward an
         envelope curve, brightest in the accent colour. Reactive:
         the second arg may be a number (phase, legacy) or a state
         object { t, beat, level, bands } so the field pulses on
         each beat and swells with the track level. Com `bands`
         (espectro real do core, graves → agudos), a curva vira a
         FFT de verdade; sem elas, o envelope sintético de sempre. ---- */
  function paintMatrix(cv, state) {
    let phase, beat = 0, level = 1, bands = null;
    if (typeof state === 'object' && state) {
      phase = state.t || 0;
      beat = state.beat || 0;
      level = (state.level == null) ? 1 : state.level;
      if (state.bands && state.bands.length) bands = state.bands;
    } else {
      phase = state || 0;
    }
    const accent = accentOf(cv);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ctx = cv.getContext('2d');
    if (cv.width !== Math.round(w * dpr)) { cv.width = w * dpr; cv.height = h * dpr; }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const gap = parseFloat(cv.dataset.gap || 12);
    const r = parseFloat(cv.dataset.r || 1.5);
    const cols = Math.floor(w / gap);
    const rows = Math.floor(h / gap);
    const ox = (w - (cols - 1) * gap) / 2;
    const oy = (h - (rows - 1) * gap) / 2;

    // spectrum curve: real FFT bands when the core provides them, else the
    // seeded traveling-wave pseudo-spectrum — both scaled by level + beat.
    const seed = (cv.dataset.seed ? +cv.dataset.seed : 7);
    function env(i) {
      const t = i / cols;
      const floor = 0.06 + 0.04 * level;
      if (bands) {
        // graves à esquerda, agudos à direita, interpolação linear entre
        // bandas; γ<1 levanta os agudos (peso perceptual) e o beat dá punch
        const pos = (i / Math.max(1, cols - 1)) * (bands.length - 1);
        const k = Math.floor(pos);
        const v = bands[k] + (bands[Math.min(bands.length - 1, k + 1)] - bands[k]) * (pos - k);
        const spec = Math.pow(Math.min(1, v * 1.3), 0.55);
        return Math.max(floor, Math.min(1, spec + beat * 0.18 * spec));
      }
      const arch = Math.sin(t * Math.PI);                              // arch across width
      const b = 0.5 + 0.5 * Math.sin(t * 22 + seed + phase * 4.0);     // fast ripples
      const c = 0.5 + 0.5 * Math.sin(t * 7.3 + seed * 1.7 + phase * 1.7);
      const spec = arch * (0.45 + 0.4 * b * c);
      // level swells the whole field; beat adds a transient bounce (stronger at the crest)
      const reactive = spec * level + beat * level * 0.42 * arch;
      return Math.max(floor, Math.min(1, reactive));
    }

    const [ar, ag, ab] = hexRgb(accent);
    for (let c = 0; c < cols; c++) {
      const e = env(c);
      const lit = e * rows;                 // how many dots from bottom are "on"
      for (let rI = 0; rI < rows; rI++) {
        const x = ox + c * gap;
        const y = oy + rI * gap;
        const fromBottom = rows - 1 - rI;
        if (fromBottom < lit) {
          const k = 1 - fromBottom / Math.max(1, lit);       // brighter near crest
          const alpha = 0.25 + 0.6 * k;
          ctx.fillStyle = `rgba(${ar},${ag},${ab},${alpha})`;
          ctx.beginPath();
          ctx.arc(x, y, r + k * 0.7 + beat * 0.6, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = 'rgba(232,233,238,0.07)';
          ctx.beginPath();
          ctx.arc(x, y, r * 0.62, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  function hexRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)] : [200,105,60];
  }

  /* ---- rotate remix knob indicators to their value ---- */
  function placeKnobs() {
    document.querySelectorAll('.knob[data-frac]').forEach((k) => {
      const frac = parseFloat(k.dataset.frac);     // 0..1
      const deg = -135 + frac * 270;
      const ind = k.querySelector('.knob-ind');
      if (ind) ind.style.transform = `rotate(${deg}deg)`;
    });
  }

  /* ---- waveform + beatgrid for the Remixer ---- */
  /* ---- forma de onda real: busca os picos calculados no import (ver
         api/services/audio_analysis/waveform.py) e repinta quando chegam.
         Enquanto não analisada (ou fetch falhou), paintWave cai no
         envelope sintético de sempre — nunca fica em branco. ---- */
  const waveCache = new Map();   // trackId -> number[] | null (sem dado)

  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % 1000;
  }

  function fetchWavePeaks(trackId) {
    if (!trackId || waveCache.has(trackId)) return;
    waveCache.set(trackId, null);   // guarda de "em voo" — mock enquanto isso
    fetch(`/api/library/${encodeURIComponent(trackId)}/waveform`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const peaks = data && Array.isArray(data.peaks) && data.peaks.length ? data.peaks : null;
        if (!peaks) return;
        waveCache.set(trackId, peaks);
        document.querySelectorAll('canvas.wave-canvas').forEach(paintWave);
      })
      .catch(() => {});
  }

  document.addEventListener('rolf:track', (e) => {
    const id = e.detail && e.detail.id;
    if (!id) return;
    document.querySelectorAll('canvas.wave-canvas').forEach((cv) => {
      cv.dataset.trackId = id;
      cv.dataset.seed = hashSeed(id);
    });
    fetchWavePeaks(id);
  });

  function paintWave(cv) {
    const accent = accentOf(cv);
    const w = cv.clientWidth, h = cv.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);

    const played = parseFloat(cv.dataset.played || 0.32);
    const seed = parseFloat(cv.dataset.seed || 11);
    const barW = parseFloat(cv.dataset.bar || 3);
    const gap = parseFloat(cv.dataset.gap || 2);
    const step = barW + gap;
    const n = Math.floor(w / step);
    const mid = h / 2;
    const [ar, ag, ab] = hexRgb(accent);

    // picos reais da faixa (buscados no listener 'rolf:track' acima), quando
    // já analisados; senão cai no envelope sintético de sempre.
    const real = waveCache.get(cv.dataset.trackId);

    function amp(i) {
      if (real && real.length) {
        return real[Math.min(real.length - 1, Math.floor((i / n) * real.length))] || 0.02;
      }
      // stable pseudo-waveform envelope (placeholder até a análise terminar)
      const t = i / n;
      const macro = 0.35 + 0.45 * Math.abs(Math.sin(t * Math.PI * 2.3 + seed));
      const micro = 0.55 + 0.45 * Math.sin(i * 0.7 + seed * 2.1);
      const detail = 0.6 + 0.4 * Math.sin(i * 1.9 + seed);
      const env = 0.25 + 0.75 * Math.sin(Math.min(Math.PI, t * Math.PI * 1.05)); // fade in/out
      return Math.max(0.05, Math.min(1, macro * micro * detail * env));
    }

    for (let i = 0; i < n; i++) {
      const a = amp(i);
      const bh = a * (h * 0.92);
      const x = i * step;
      const isPlayed = i / n < played;
      if (isPlayed) {
        ctx.fillStyle = `rgba(${ar},${ag},${ab},0.92)`;
      } else {
        ctx.fillStyle = 'rgba(232,233,238,0.20)';
      }
      const r = Math.min(barW / 2, 1.4);
      roundRect(ctx, x, mid - bh / 2, barW, bh, r);
      ctx.fill();
    }

    // beatgrid: faint vertical lines every `beat` bars
    const beats = parseInt(cv.dataset.beats || 16, 10);
    ctx.strokeStyle = 'rgba(232,233,238,0.07)';
    ctx.lineWidth = 1;
    for (let b = 0; b <= beats; b++) {
      const x = Math.round((b / beats) * w) + 0.5;
      const major = b % 4 === 0;
      ctx.globalAlpha = major ? 1 : 0.5;
      ctx.beginPath();
      ctx.moveTo(x, major ? 0 : h * 0.16);
      ctx.lineTo(x, major ? h : h * 0.84);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---- dot-matrix spectrogram for Capturar/Rip (hero) ---- */
  function paintSpectro(cv, phase) {
    phase = phase || 0;
    const accent = accentOf(cv);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ctx = cv.getContext('2d');
    if (cv.width !== Math.round(w * dpr)) { cv.width = w * dpr; cv.height = h * dpr; }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const gap = parseFloat(cv.dataset.gap || 9);
    const cols = Math.floor(w / gap);
    const rows = Math.floor(h / gap);
    const ox = (w - (cols - 1) * gap) / 2;
    const oy = (h - (rows - 1) * gap) / 2;
    const seed = parseFloat(cv.dataset.seed || 4);
    const [ar, ag, ab] = hexRgb(accent);

    function energy(t, f) {
      let e = Math.pow(1 - f, 1.3) * 0.42;
      const bands = [[0.16, 0.95, 2.1], [0.33, 0.72, 3.3], [0.54, 0.52, 1.7], [0.73, 0.38, 4.2]];
      for (const [c, amp, spd] of bands) {
        const center = c + 0.045 * Math.sin(t * spd * 6.28 + seed);
        e += amp * Math.exp(-Math.pow((f - center) / 0.06, 2));
      }
      const beat = Math.pow(0.5 + 0.5 * Math.sin(t * 6.28 * 7 + seed), 6);
      e += beat * Math.pow(1 - f, 2) * 0.7;
      e += Math.max(0, Math.sin(f * 38 + t * 26 + seed)) * 0.07 * f;
      e *= 0.62 + 0.38 * Math.sin(t * 6.28 * 1.25 + seed * 2);
      return Math.max(0, Math.min(1, e));
    }

    for (let c = 0; c < cols; c++) {
      const t = c / cols + phase;
      const headBoost = 0.6 + 0.4 * Math.min(1, (c / cols) * 1.6); // brighter toward the capture head (right)
      for (let r = 0; r < rows; r++) {
        const f = 1 - r / rows; // top = high freq
        const e = energy(t, f) * headBoost;
        const x = ox + c * gap;
        const y = oy + r * gap;
        if (e > 0.07) {
          const alpha = 0.16 + 0.82 * e;
          ctx.fillStyle = `rgba(${ar},${ag},${ab},${alpha})`;
          ctx.beginPath();
          ctx.arc(x, y, 0.7 + e * 1.7, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = 'rgba(232,233,238,0.05)';
          ctx.beginPath();
          ctx.arc(x, y, 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  function paintAll() {
    document.querySelectorAll('.mesh-bg').forEach(paintMesh);
    document.querySelectorAll('canvas.matrix').forEach(paintMatrix);
    document.querySelectorAll('canvas.wave').forEach(paintWave);
    document.querySelectorAll('canvas.spectro-cv').forEach(paintSpectro);
    placeKnobs();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paintAll);
  } else {
    paintAll();
  }
  // expose for screen-switch repaints (canvases sized 0 while hidden)
  window.RolfPaint = paintAll;
  // expose individual painters for the motion loop
  window.RolfDraw = { matrix: paintMatrix, spectro: paintSpectro, wave: paintWave };
  // fonts settling can shift sizes; repaint once after load
  window.addEventListener('load', () => setTimeout(paintAll, 60));
})();
