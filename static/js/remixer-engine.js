/* ============================================================
   ROLFSOUND V2 — REMIXER LIVE ENGINE
   Real audio for the Remixer tab. Decodes an uploaded track and
   plays it through a Web Audio graph with INDEPENDENT pitch and
   tempo (granular overlap-add time-stretch + resample), a filter,
   3-band EQ, loop, and output gain/mute. Every knob and button in
   the deck is wired to actually move the sound.

   Graph:  granular(ScriptProcessor) -> filter -> eqLo -> eqMid
           -> eqHi -> outGain -> analyser -> destination

   window.RolfRemixer.load(trackData) / play() / pause() / seek(f)
   ============================================================ */
(function () {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const AUDIO_URL = 'static/audio/reverie.mp3';

  const Player = window.RolfPlayer = window.RolfPlayer || {};
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /* ---------- engine state ---------- */
  let ctx = null, scriptNode = null;
  let filterNode = null, eqLo = null, eqMid = null, eqHi = null;
  let outGain = null, analyser = null, freqData = null, timeData = null;
  let buffer = null, chL = null, chR = null, srcLen = 0, rate = 44100;
  let peaks = null;                         // cached high-res waveform peaks

  let ready = false, playing = false, ended = false;

  // grain / OLA
  let G = 0, synthHop = 0, hann = null, RING = 1 << 15, MASK = RING - 1;
  let ringL = null, ringR = null;
  let inPos = 0, synthAbs = 0, readAbs = 0;

  // musical params (independent)
  let origBpm = 118, origKey = 'A min';
  let targetBpm = 118, pitchSemis = 0;
  let keyLock = true;
  let muted = false, gainDb = -3, volume = Math.pow(10, gainDb / 20);

  // filter
  let filterType = 'lowpass', filterHz = 8200;
  // loop
  let loopActive = false, loopStart = 0, loopEnd = 0;   // in source samples

  // ---- waveform view window (zoom + pan), fractions of full track 0..1 ----
  let viewA = 0, viewB = 1;
  // interaction mode: 'seek' | 'loop' | 'cue' | 'zoom'  (Beatgrid is a separate display toggle)
  let mode = 'seek';
  let showGrid = true;
  let follow = true;                 // auto-scroll the view to keep the playhead visible
  // cue points: array of { f: trackFrac, label, el }
  let cues = [];
  // A/B compare snapshots
  let abSlot = 'A';
  const abStore = { A: null, B: null };

  const viewSpan = () => Math.max(0.005, viewB - viewA);
  const fToX = (f) => (f - viewA) / viewSpan();   // track-frac -> 0..1 inside the frame
  const xToF = (x) => viewA + x * viewSpan();     // 0..1 inside frame -> track-frac
  function clampView() {
    const span = Math.min(1, viewB - viewA);
    if (viewA < 0) { viewA = 0; viewB = span; }
    if (viewB > 1) { viewB = 1; viewA = 1 - span; }
    if (viewA < 0) viewA = 0;
  }
  function setZoom(newSpan, centerF) {
    newSpan = Math.min(1, Math.max(0.012, newSpan));
    const x = (centerF - viewA) / viewSpan();     // keep centerF at same screen x
    viewA = centerF - x * newSpan;
    viewB = viewA + newSpan;
    clampView();
    layout();
  }
  function fitView() { viewA = 0; viewB = 1; layout(); }
  function snapBeat(f) {
    if (!showGrid || !Player.dur) return f;
    const beatSec = 60 / origBpm;
    const t = Math.round((f * Player.dur) / beatSec) * beatSec;
    return Math.max(0, Math.min(1, t / Player.dur));
  }

  function tempoRatio() { return targetBpm / origBpm; }
  function pitchRatio() {
    const semi = Math.pow(2, pitchSemis / 12);
    return keyLock ? semi : semi * tempoRatio();
  }

  /* ---------- key transpose ---------- */
  function transposeKey(key, semis) {
    const m = /^([A-G]#?)\s*(min|maj|m|M)?/i.exec((key || '').trim());
    if (!m) return key;
    let idx = NOTES.indexOf(m[1].toUpperCase());
    if (idx < 0) return key;
    idx = (idx + Math.round(semis) % 12 + 120) % 12;
    const mode = (m[2] || '').toLowerCase().startsWith('ma') ? 'maj' : (m[2] ? 'min' : '');
    return NOTES[idx] + (mode ? ' ' + mode : '');
  }
  function curKey() { return transposeKey(origKey, pitchSemis); }

  /* ============================================================
     BUILD GRAPH + DECODE
     ============================================================ */
  function ensureCtx() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    rate = ctx.sampleRate;

    G = Math.round(0.12 * rate);            // ~120ms grains
    synthHop = G >> 1;                      // 50% overlap (Hann sums to 1)
    hann = new Float32Array(G);
    for (let i = 0; i < G; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (G - 1));
    ringL = new Float32Array(RING);
    ringR = new Float32Array(RING);

    filterNode = ctx.createBiquadFilter();
    filterNode.type = filterType; filterNode.frequency.value = filterHz; filterNode.Q.value = 0.8;

    eqLo = ctx.createBiquadFilter();  eqLo.type = 'lowshelf';  eqLo.frequency.value = 160;  eqLo.gain.value = 0;
    eqMid = ctx.createBiquadFilter(); eqMid.type = 'peaking';  eqMid.frequency.value = 1000; eqMid.Q.value = 0.9; eqMid.gain.value = 0;
    eqHi = ctx.createBiquadFilter();  eqHi.type = 'highshelf'; eqHi.frequency.value = 6500;  eqHi.gain.value = 0;

    outGain = ctx.createGain(); outGain.gain.value = volume;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.8;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);

    scriptNode = ctx.createScriptProcessor(4096, 1, 2);
    scriptNode.onaudioprocess = process;

    scriptNode.connect(filterNode);
    filterNode.connect(eqLo); eqLo.connect(eqMid); eqMid.connect(eqHi);
    eqHi.connect(outGain); outGain.connect(analyser); analyser.connect(ctx.destination);
  }

  async function decode() {
    try {
      const res = await fetch(encodeURI(AUDIO_URL));
      const arr = await res.arrayBuffer();
      ensureCtx();
      buffer = await ctx.decodeAudioData(arr);
      srcLen = buffer.length;
      chL = buffer.getChannelData(0);
      chR = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : chL;
      computePeaks();
      ready = true;
      Player.dur = buffer.duration;
      installRealWave();
      // size & redraw transport time labels
      const totals = $$('.transport .tp-time');
      if (totals[1]) totals[1].textContent = mmss(Player.dur);
      const vt = $('[data-viz-total]'); if (vt) vt.textContent = mmss(Player.dur);
      layout();
    } catch (e) {
      console.warn('Remixer: decode failed', e);
    }
  }

  function computePeaks() {
    const N = 1024;
    peaks = new Float32Array(N);
    const block = Math.floor(srcLen / N) || 1;
    for (let i = 0; i < N; i++) {
      let mx = 0;
      const a = i * block, b = Math.min(srcLen, a + block);
      for (let j = a; j < b; j += 2) {
        const v = Math.abs(chL[j]);
        if (v > mx) mx = v;
      }
      peaks[i] = mx;
    }
    // normalize
    let pk = 0; for (let i = 0; i < N; i++) if (peaks[i] > pk) pk = peaks[i];
    if (pk > 0) for (let i = 0; i < N; i++) peaks[i] = Math.min(1, peaks[i] / pk);
  }

  /* ============================================================
     GRANULAR OLA — independent pitch (resample) + tempo (read rate)
     ============================================================ */
  function addGrain() {
    const pr = pitchRatio();
    for (let i = 0; i < G; i++) {
      const sp = inPos + i * pr;
      const i0 = sp | 0;
      let sL = 0, sR = 0;
      if (i0 >= 0 && i0 + 1 < srcLen) {
        const fr = sp - i0;
        sL = chL[i0] * (1 - fr) + chL[i0 + 1] * fr;
        sR = chR[i0] * (1 - fr) + chR[i0 + 1] * fr;
      }
      const w = hann[i];
      const idx = (synthAbs + i) & MASK;
      ringL[idx] += sL * w;
      ringR[idx] += sR * w;
    }
    synthAbs += synthHop;
    inPos += synthHop * tempoRatio();

    if (loopActive && loopEnd > loopStart && inPos >= loopEnd) {
      inPos -= (loopEnd - loopStart);
    } else if (inPos >= srcLen - 2) {
      inPos = 0; ended = true;             // natural end → restart, flag for advance
    }
  }

  function process(e) {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    const n = outL.length;
    if (!ready || !playing) {
      for (let i = 0; i < n; i++) { outL[i] = 0; outR[i] = 0; }
      return;
    }
    while (synthAbs < readAbs + n + G) addGrain();
    for (let i = 0; i < n; i++) {
      const idx = (readAbs + i) & MASK;
      outL[i] = ringL[idx]; ringL[idx] = 0;
      outR[i] = ringR[idx]; ringR[idx] = 0;
    }
    readAbs += n;
  }

  function clearRing() {
    if (ringL) { ringL.fill(0); ringR.fill(0); }
    synthAbs = 0; readAbs = 0;
  }

  // heard source position (account for generation lead)
  function heardSamp() {
    return Math.max(0, inPos - (synthAbs - readAbs) * tempoRatio());
  }
  function posFrac() { return srcLen ? Math.min(1, heardSamp() / srcLen) : 0; }

  /* ============================================================
     TRANSPORT
     ============================================================ */
  function play() {
    if (!ready) { decode().then(() => { if (ready) play(); }); return; }
    if (ctx.state === 'suspended') ctx.resume();
    playing = true; ended = false;
    document.body.classList.remove('paused');
    Player.engineDriven = true;
    syncPlayIcons();
    if (!rafOn) { rafOn = true; requestAnimationFrame(uiTick); }
  }
  function pause() {
    playing = false;
    document.body.classList.add('paused');
    syncPlayIcons();
  }
  function toggle() { playing ? pause() : play(); }

  function seek(frac) {
    frac = Math.max(0, Math.min(0.9999, frac));
    inPos = frac * srcLen;
    clearRing();
    Player.pos = frac;
    renderPos();
  }

  const PLAY_ICON  = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4 18.6 12 8 18.6z"/></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5.5" width="3.4" height="13" rx="1"/><rect x="13.6" y="5.5" width="3.4" height="13" rx="1"/></svg>';
  function syncPlayIcons() {
    $$('.tp-play, .st-play, .rl-play').forEach((b) => { b.innerHTML = playing ? PAUSE_ICON : PLAY_ICON; });
  }

  /* ============================================================
     UI TICK — position + meters
     ============================================================ */
  let rafOn = false;
  function mmss(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return m + ':' + (s < 10 ? '0' : '') + s; }

  function renderPos() {
    const f = Player.pos;
    $$('.tp-fill').forEach((el) => { el.style.width = (f * 100).toFixed(2) + '%'; });
    const t0 = $$('.transport .tp-time')[0]; if (t0) t0.textContent = mmss(f * Player.dur);
    const ve = $('[data-viz-elapsed]'); if (ve) ve.textContent = mmss(f * Player.dur);
    positionPlayhead();
    paintWaveNow();
  }

  function meters() {
    if (!analyser) return;
    analyser.getByteTimeDomainData(timeData);
    let rms = 0;
    for (let i = 0; i < timeData.length; i++) { const x = (timeData[i] - 128) / 128; rms += x * x; }
    rms = Math.sqrt(rms / timeData.length);
    const lvl = Math.min(1, rms * 3.0);
    const cols = $$('.rmx .meter .meter-col');
    cols.forEach((col, ci) => {
      const segs = $$('i', col);
      const v = lvl * (ci === 0 ? 1 : 0.92);
      const lit = Math.round(v * segs.length);
      segs.forEach((seg, si) => {
        const fromBottom = si;             // column-reverse → index 0 is bottom
        seg.classList.toggle('lit', fromBottom < lit && fromBottom < segs.length - 1);
        seg.classList.toggle('peak', fromBottom === lit - 1 && lit > 0);
      });
    });
  }

  function uiTick() {
    if (!playing) { rafOn = false; return; }
    const f = posFrac();
    Player.pos = f;
    // follow-scroll: keep the playhead visible when zoomed in
    if (follow && viewSpan() < 0.999) {
      const x = fToX(f);
      if (x > 0.92 || x < 0) {
        const span = viewSpan();
        viewA = f - span * 0.2; viewB = viewA + span; clampView();
        layout();
      }
    }
    const t0 = $$('.transport .tp-time')[0]; if (t0) t0.textContent = mmss(f * Player.dur);
    $$('.tp-fill').forEach((el) => { el.style.width = (f * 100).toFixed(2) + '%'; });
    const ve = $('[data-viz-elapsed]'); if (ve) ve.textContent = mmss(f * Player.dur);
    positionPlayhead();
    paintWaveNow();
    meters();
    if (ended) { ended = false; }          // looped to start, keep going
    requestAnimationFrame(uiTick);
  }

  /* ============================================================
     REAL WAVEFORM
     ============================================================ */
  function installRealWave() {
    if (!window.RolfDraw) return;
    const fake = window.RolfDraw.wave;
    window.RolfDraw.wave = function (cv) {
      if (!cv.classList.contains('wave-canvas') || !peaks) return fake(cv);
      paintReal(cv);
    };
  }
  function paintReal(cv) {
    const accent = getComputedStyle(cv).getPropertyValue('--accent').trim() || '#c8693c';
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = w * dpr; cv.height = h * dpr;
    const c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0); c.scale(dpr, dpr);
    c.clearRect(0, 0, w, h);
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(accent);
    const ar = m ? parseInt(m[1], 16) : 200, ag = m ? parseInt(m[2], 16) : 105, ab = m ? parseInt(m[3], 16) : 60;

    // beat / bar grid (drawn behind the bars), mapped through the view window
    if (showGrid && Player.dur) {
      const beatSec = 60 / origBpm, barSec = 4 * beatSec;
      const viewBeats = (Player.dur * viewSpan()) / beatSec;
      if (viewBeats < 160) {                              // zoomed enough: show beats faintly
        c.strokeStyle = 'rgba(232,233,238,0.045)'; c.lineWidth = 1;
        const beats = Player.dur / beatSec;
        for (let b = 0; b <= beats; b++) {
          if (b % 4 === 0) continue;
          const x = fToX((b * beatSec) / Player.dur);
          if (x < 0 || x > 1) continue;
          const px = Math.round(x * w) + 0.5;
          c.beginPath(); c.moveTo(px, h * 0.18); c.lineTo(px, h * 0.82); c.stroke();
        }
      }
      c.strokeStyle = 'rgba(232,233,238,0.11)'; c.lineWidth = 1;   // bar lines (stronger)
      const bars = Player.dur / barSec;
      for (let b = 0; b <= bars; b++) {
        const x = fToX((b * barSec) / Player.dur);
        if (x < 0 || x > 1) continue;
        const px = Math.round(x * w) + 0.5;
        c.beginPath(); c.moveTo(px, 0); c.lineTo(px, h); c.stroke();
      }
    }

    const barW = 3, gap = 2, step = barW + gap;
    const n = Math.floor(w / step);
    const mid = h / 2;
    const played = Player.pos || 0;
    const startP = viewA * peaks.length, endP = viewB * peaks.length;
    for (let i = 0; i < n; i++) {
      const pf = i / n;                                  // 0..1 across the frame
      const pIdx = Math.floor(startP + pf * (endP - startP));
      const p = peaks[Math.max(0, Math.min(peaks.length - 1, pIdx))] || 0;
      const bh = Math.max(2, Math.pow(p, 0.8) * h * 0.94);
      const x = i * step;
      const trackF = viewA + pf * viewSpan();
      c.fillStyle = (trackF < played) ? `rgba(${ar},${ag},${ab},0.95)` : 'rgba(232,233,238,0.20)';
      roundRect(c, x, mid - bh / 2, barW, bh, 1.3); c.fill();
    }
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
  function paintWaveNow() {
    const cv = $('.wave-canvas');
    if (!cv) return;
    if (peaks) paintReal(cv);
    else if (window.RolfDraw && window.RolfDraw.wave) window.RolfDraw.wave(cv);
  }

  /* ============================================================
     VIEW LAYOUT — repaint + reposition overlays + ruler
     ============================================================ */
  function layout() {
    paintWaveNow();
    rebuildRuler();
    positionPlayhead();
    positionLoop();
    positionCues();
    updateZoomReadout();
  }

  function positionPlayhead() {
    const ph = $('.wave-playhead'); if (!ph) return;
    const x = fToX(Player.pos || 0);
    if (x < -0.01 || x > 1.01) { ph.style.display = 'none'; }
    else { ph.style.display = ''; ph.style.left = (x * 100).toFixed(3) + '%'; }
  }

  function positionLoop() {
    const el = $('.wave-loop'); if (!el) return;
    if (!srcLen || loopEnd <= loopStart) { el.style.display = 'none'; return; }
    const x0 = fToX(loopStart / srcLen), x1 = fToX(loopEnd / srcLen);
    if (x1 < 0 || x0 > 1) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = (Math.max(0, x0) * 100).toFixed(3) + '%';
    el.style.right = ((1 - Math.min(1, x1)) * 100).toFixed(3) + '%';
    el.classList.toggle('rmx-loop-off', !loopActive);
  }

  function renderCues() {
    const frame = $('.wave-frame'); if (!frame) return;
    $$('.wave-cue', frame).forEach((e) => e.remove());
    cues.forEach((c) => {
      const el = document.createElement('div');
      el.className = 'wave-cue'; el.dataset.cue = c.label;
      c.el = el; frame.appendChild(el);
    });
    positionCues();
  }
  function positionCues() {
    cues.forEach((c) => {
      if (!c.el) return;
      const x = fToX(c.f);
      if (x < -0.01 || x > 1.01) { c.el.style.display = 'none'; }
      else { c.el.style.display = ''; c.el.style.left = (x * 100).toFixed(3) + '%'; }
    });
  }

  function rebuildRuler() {
    const ruler = $('.rmx .wave-ruler'); if (!ruler || !Player.dur) return;
    const barSec = 4 * 60 / origBpm;
    const totalBars = Player.dur / barSec;
    const viewBars = totalBars * viewSpan();
    let step = 1;
    while (viewBars / step > 12) step *= 2;
    ruler.innerHTML = '';
    const firstBar = Math.ceil((viewA * totalBars) / step) * step;
    const lastBar = viewA * totalBars + viewBars;
    for (let b = firstBar; b <= lastBar + 1e-6; b += step) {
      const x = fToX((b * barSec) / Player.dur);
      if (x < -0.001 || x > 1.001) continue;
      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.style.left = (x * 100).toFixed(3) + '%';
      tick.innerHTML = '<span>' + (b + 1) + '</span>';
      ruler.appendChild(tick);
    }
  }

  function updateZoomReadout() {
    const badge = $('.rmx-zoom-badge');
    const fit = $('.rmx-fit');
    const zoomed = viewSpan() < 0.999;
    if (badge) { badge.textContent = (1 / viewSpan()).toFixed(1) + '×'; badge.hidden = !zoomed; }
    if (fit) fit.hidden = !zoomed;
  }

  /* ============================================================
     READOUTS
     ============================================================ */
  function modByTitle(name) {
    return $$('.rmx-deck .mod').find((m) => (m.querySelector('.mod-title')?.textContent || '').trim() === name);
  }
  function fmtPct(r) { const p = (r - 1) * 100; return (p >= 0 ? '+' : '') + p.toFixed(1) + '%'; }

  function updateReadouts() {
    const reads = $$('.rmx-readouts .rmx-read .v');
    if (reads[0]) reads[0].textContent = origBpm;
    if (reads[1]) reads[1].innerHTML = `${Math.round(targetBpm)}<small> bpm</small>`;
    if (reads[2]) reads[2].textContent = origKey;
    if (reads[3]) reads[3].textContent = curKey();

    const pitchMod = modByTitle('Pitch');
    if (pitchMod) { const b = pitchMod.querySelector('.mod-foot .mod-sub b'); if (b) b.textContent = curKey(); }
    const tempoMod = modByTitle('Tempo');
    if (tempoMod) {
      const sub = tempoMod.querySelector('.mod-foot .mod-sub');
      if (sub) sub.innerHTML = `<b>${fmtPct(tempoRatio())}</b> · de ${origBpm}`;
    }
  }

  /* ============================================================
     KNOB MAPPING (matches prototype.js so visuals stay in sync)
     ============================================================ */
  const KNOB = {
    Pitch:  { min: -12, max: 12, step: 1 },
    Tempo:  { min: 80, max: 160, step: 1 },
    Filtro: { min: 0.1, max: 18, step: 0.1 },
  };
  function knobValue(name, frac) {
    const k = KNOB[name];
    let v = k.min + frac * (k.max - k.min);
    return k.step >= 1 ? Math.round(v) : Math.round(v / k.step) * k.step;
  }
  function fracForValue(name, val) {
    const k = KNOB[name];
    return Math.max(0, Math.min(1, (val - k.min) / (k.max - k.min)));
  }
  function setKnobVisual(knob, frac) {
    frac = Math.max(0, Math.min(1, frac));
    knob.dataset.frac = frac.toFixed(4);
    knob.style.setProperty('--frac', frac.toFixed(4));
    const ind = knob.querySelector('.knob-ind');
    if (ind) ind.style.transform = `rotate(${-135 + frac * 270}deg)`;
    const name = (knob.closest('.mod')?.querySelector('.mod-title')?.textContent || '').trim();
    const valEl = knob.closest('.mod')?.querySelector('.knob-val');
    if (valEl && KNOB[name]) {
      const v = knobValue(name, frac);
      if (name === 'Pitch') valEl.innerHTML = `<span class="acc">${v > 0 ? '+' : ''}${v}</span><small>st</small>`;
      else if (name === 'Tempo') valEl.innerHTML = `${v}<small>bpm</small>`;
      else if (name === 'Filtro') valEl.innerHTML = `${v.toFixed(1)}<small>kHz</small>`;
    }
  }

  function applyFromKnob(name, frac) {
    const knob = modByTitle(name)?.querySelector('.knob');
    if (knob) setKnobVisual(knob, frac);
    const v = knobValue(name, frac);
    if (name === 'Pitch') { pitchSemis = v; updateReadouts(); }
    else if (name === 'Tempo') { targetBpm = v; updateReadouts(); }
    else if (name === 'Filtro') { filterHz = Math.max(40, v * 1000); if (filterNode) filterNode.frequency.setTargetAtTime(filterHz, ctx.currentTime, 0.02); }
  }

  /* ============================================================
     WIRE CONTROLS
     ============================================================ */
  function wireKnob(name) {
    const mod = modByTitle(name); if (!mod) return;
    const knob = mod.querySelector('.knob'); if (!knob) return;
    // prototype.js owns frac (drag, dblclick, steppers) and emits 'rolfknob';
    // we just translate that into sound. No frac math here → no double-stepping.
    knob.addEventListener('rolfknob', (e) => applyFromKnob(name, e.detail.frac));
  }

  /* ---------- output volume (drag the meter as a fader) ---------- */
  function applyGain() {
    if (outGain) outGain.gain.setTargetAtTime(muted ? 0 : volume, ctx ? ctx.currentTime : 0, 0.02);
    const mod = modByTitle('Saída');
    const valEl = mod?.querySelector('.knob-val');
    if (valEl) valEl.innerHTML = (muted ? '−∞' : (gainDb > 0 ? '+' : (gainDb < 0 ? '−' : '')) + Math.abs(Math.round(gainDb))) + '<small>dB</small>';
  }
  function setGainDb(db) {
    gainDb = Math.max(-48, Math.min(6, db));
    volume = Math.pow(10, gainDb / 20);
    applyGain();
  }
  function wireOutput() {
    const mod = modByTitle('Saída'); if (!mod) return;
    const meter = mod.querySelector('.meter'); if (!meter) return;
    meter.style.cursor = 'ns-resize';
    meter.title = 'Arraste para ajustar o volume';
    // frac 0(bottom)→1(top) maps to -48..+6 dB
    const dbToFrac = (db) => (db + 48) / 54;
    const fracToDb = (f) => f * 54 - 48;
    let drag = false;
    const fromEv = (e) => {
      const r = meter.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
      setGainDb(fracToDb(f));
    };
    meter.addEventListener('pointerdown', (e) => { drag = true; meter.setPointerCapture(e.pointerId); fromEv(e); e.preventDefault(); });
    meter.addEventListener('pointermove', (e) => { if (drag) fromEv(e); });
    meter.addEventListener('pointerup', (e) => { drag = false; meter.releasePointerCapture(e.pointerId); });
    meter.addEventListener('wheel', (e) => { e.preventDefault(); setGainDb(gainDb - Math.sign(e.deltaY)); }, { passive: false });
  }

  function wireToggles() {
    $$('.rmx-deck .mod').forEach((mod) => {
      const title = (mod.querySelector('.mod-title')?.textContent || '').trim();
      const tog = mod.querySelector('.mod-toggle');
      if (!tog) return;
      tog.addEventListener('click', () => {
        const on = tog.classList.contains('on');   // prototype.js already toggled
        const label = tog.textContent.trim();
        if (title === 'Pitch') {          // Key lock
          keyLock = on; updateReadouts();
        } else if (title === 'Tempo') {   // Sync → snap to nearest whole-number ratio
          if (on) { targetBpm = origBpm; const k = mod.querySelector('.knob'); if (k) setKnobVisual(k, fracForValue('Tempo', targetBpm)); updateReadouts(); }
        } else if (title === 'Filtro') {  // LP / HP
          filterType = on ? 'lowpass' : 'highpass';
          tog.textContent = on ? 'LP' : 'HP';
          if (filterNode) filterNode.type = filterType;
        } else if (title === 'Loop') {    // Ativo / Off
          loopActive = on;
          tog.textContent = on ? 'Ativo' : 'Off';
          if (on && loopEnd <= loopStart) setLoopFromBeats(currentLoopBeats || 1);
          positionLoop();
        } else if (title === 'Saída') {   // Mute
          muted = on;
          applyGain();
        }
      });
    });
  }

  /* ---------- EQ drag ---------- */
  function wireEQ() {
    const mod = modByTitle('EQ'); if (!mod) return;
    const bands = $$('.eq-band', mod);
    const targets = [eqLo, eqMid, eqHi];
    bands.forEach((band, bi) => {
      const slider = band.querySelector('.eq-slider');
      const knob = band.querySelector('.eq-knob');
      const dbEl = band.querySelector('.eq-db');
      let fill = band.querySelector('.eq-fill');
      const apply = (frac) => {                 // frac 0..1 bottom→top
        frac = Math.max(0, Math.min(1, frac));
        const db = (frac - 0.5) * 24;           // -12..+12
        knob.style.bottom = (frac * 100).toFixed(1) + '%';
        knob.classList.toggle('acc', Math.abs(db) > 0.5);
        dbEl.textContent = (db >= 0 ? '+' : '') + Math.round(db);
        if (!fill) { fill = document.createElement('span'); fill.className = 'eq-fill'; slider.prepend(fill); }
        if (db >= 0) { fill.style.bottom = '50%'; fill.style.top = (100 - frac * 100) + '%'; }
        else { fill.style.top = '50%'; fill.style.bottom = (frac * 100) + '%'; }
        fill.style.display = Math.abs(db) > 0.5 ? '' : 'none';
        if (targets[bi]) targets[bi].gain.setTargetAtTime(db, ctx ? ctx.currentTime : 0, 0.02);
      };
      band._applyEq = apply;
      let drag = false;
      const fromEv = (e) => { const r = slider.getBoundingClientRect(); apply(1 - (e.clientY - r.top) / r.height); };
      slider.style.cursor = 'ns-resize';
      slider.addEventListener('pointerdown', (e) => { drag = true; slider.setPointerCapture(e.pointerId); fromEv(e); e.preventDefault(); });
      slider.addEventListener('pointermove', (e) => { if (drag) fromEv(e); });
      slider.addEventListener('pointerup', (e) => { drag = false; slider.releasePointerCapture(e.pointerId); });
    });
    // Flat toggle resets bands
    const flat = mod.querySelector('.mod-toggle');
    if (flat) flat.addEventListener('click', () => { if (flat.classList.contains('on')) bands.forEach((b) => b._applyEq && b._applyEq(0.5)); });
  }

  /* ---------- loop module ---------- */
  let currentLoopBeats = 1;
  function setLoopFromBeats(beats) {
    currentLoopBeats = beats;
    const beatSec = 60 / origBpm;
    loopStart = snapBeat(heardSamp() / srcLen) * srcLen;
    loopEnd = Math.min(srcLen - 2, loopStart + beats * beatSec * rate);
    positionLoop();
  }
  function updateLoopOverlay() { positionLoop(); }
  function setLoopToggle(on) {
    loopActive = on;
    const t = modByTitle('Loop')?.querySelector('.mod-toggle');
    if (t) { t.classList.toggle('on', on); t.textContent = on ? 'Ativo' : 'Off'; }
  }
  function wireLoop() {
    const mod = modByTitle('Loop'); if (!mod) return;
    const map = { '¼': 0.25, '½': 0.5, '1': 1, '2': 2, '4': 4, '8': 8 };
    $$('.loop-cell', mod).forEach((cell) => {
      cell.addEventListener('click', () => {
        const beats = map[cell.textContent.trim()] || 1;
        setLoopFromBeats(beats);
        setLoopToggle(true);
      });
    });
    const ioBtns = $$('.loop-io .wave-tool', mod);
    if (ioBtns[0]) ioBtns[0].addEventListener('click', () => { loopStart = heardSamp(); if (loopEnd <= loopStart) loopEnd = Math.min(srcLen - 2, loopStart + rate); setLoopToggle(true); positionLoop(); });
    if (ioBtns[1]) ioBtns[1].addEventListener('click', () => { loopEnd = heardSamp(); if (loopEnd <= loopStart) loopStart = Math.max(0, loopEnd - rate); setLoopToggle(true); positionLoop(); });
  }

  /* ---------- A/B compare (snapshot of every parameter) ---------- */
  function snapshot() {
    return {
      pitchSemis, targetBpm, keyLock, filterType, filterHz, muted, gainDb,
      eq: [eqLo, eqMid, eqHi].map((n) => (n ? n.gain.value : 0)),
      loopStart, loopEnd, loopActive,
    };
  }
  function restore(s) {
    if (!s) return;
    pitchSemis = s.pitchSemis; targetBpm = s.targetBpm; keyLock = s.keyLock;
    filterType = s.filterType; filterHz = s.filterHz; muted = s.muted;
    loopStart = s.loopStart; loopEnd = s.loopEnd; loopActive = s.loopActive;
    if (filterNode) { filterNode.type = filterType; filterNode.frequency.setTargetAtTime(filterHz, ctx.currentTime, 0.05); }
    [eqLo, eqMid, eqHi].forEach((n, i) => n && n.gain.setTargetAtTime(s.eq[i], ctx.currentTime, 0.05));
    setGainDb(s.gainDb);
    const pk = modByTitle('Pitch')?.querySelector('.knob'); if (pk) setKnobVisual(pk, fracForValue('Pitch', pitchSemis));
    const tk = modByTitle('Tempo')?.querySelector('.knob'); if (tk) setKnobVisual(tk, fracForValue('Tempo', targetBpm));
    const fk = modByTitle('Filtro')?.querySelector('.knob'); if (fk) setKnobVisual(fk, fracForValue('Filtro', filterHz / 1000));
    $$('.rmx .eq-band').forEach((b, i) => { if (b._applyEq) b._applyEq(s.eq[i] / 24 + 0.5); });
    const klock = modByTitle('Pitch')?.querySelector('.mod-toggle'); if (klock) klock.classList.toggle('on', keyLock);
    const lp = modByTitle('Filtro')?.querySelector('.mod-toggle'); if (lp) { lp.classList.toggle('on', filterType === 'lowpass'); lp.textContent = filterType === 'lowpass' ? 'LP' : 'HP'; }
    const muteT = modByTitle('Saída')?.querySelector('.mod-toggle'); if (muteT) muteT.classList.toggle('on', muted);
    setLoopToggle(loopActive);
    updateReadouts(); applyGain(); layout();
  }
  function wireAB() {
    const g = $('.rmx-ab'); if (!g) return;
    abStore.A = snapshot(); abStore.B = snapshot();
    $$('button', g).forEach((b) => {
      b.addEventListener('click', () => {
        const slot = b.textContent.trim();
        if (slot === abSlot) return;
        abStore[abSlot] = snapshot();   // bank current edits into the slot we're leaving
        abSlot = slot;
        restore(abStore[slot]);
      });
    });
  }

  /* ---------- cue init from markup ---------- */
  function initCues() {
    const existing = $$('.wave-frame .wave-cue');
    cues = existing.map((el) => ({ f: (parseFloat(el.style.left) || 0) / 100, label: el.dataset.cue || 'A' }));
    renderCues();
  }

  /* ---------- reset ---------- */
  function resetAll() {
    pitchSemis = 0; targetBpm = origBpm;
    keyLock = true; muted = false;
    filterType = 'lowpass'; filterHz = 8200;
    loopActive = false; currentLoopBeats = 1; loopStart = 0; loopEnd = 0;
    viewA = 0; viewB = 1; mode = 'seek'; showGrid = true;
    muted = false; setGainDb(-3);
    if (filterNode) { filterNode.type = 'lowpass'; filterNode.frequency.setTargetAtTime(filterHz, ctx.currentTime, 0.05); }
    [eqLo, eqMid, eqHi].forEach((e) => e && e.gain.setTargetAtTime(0, ctx.currentTime, 0.05));
    if (outGain) outGain.gain.setTargetAtTime(volume, ctx.currentTime, 0.05);
    // visuals
    const pk = modByTitle('Pitch')?.querySelector('.knob'); if (pk) setKnobVisual(pk, fracForValue('Pitch', 0));
    const tk = modByTitle('Tempo')?.querySelector('.knob'); if (tk) setKnobVisual(tk, fracForValue('Tempo', origBpm));
    const fk = modByTitle('Filtro')?.querySelector('.knob'); if (fk) setKnobVisual(fk, fracForValue('Filtro', 8.2));
    const klock = modByTitle('Pitch')?.querySelector('.mod-toggle'); if (klock) klock.classList.add('on');
    const lp = modByTitle('Filtro')?.querySelector('.mod-toggle'); if (lp) { lp.classList.add('on'); lp.textContent = 'LP'; }
    const loopT = modByTitle('Loop')?.querySelector('.mod-toggle'); if (loopT) { loopT.classList.remove('on'); loopT.textContent = 'Off'; }
    const muteT = modByTitle('Saída')?.querySelector('.mod-toggle'); if (muteT) muteT.classList.remove('on');
    $$('.rmx .eq-band').forEach((b) => b._applyEq && b._applyEq(0.5));
    const frame = $('.wave-frame'); if (frame) frame.dataset.mode = 'seek';
    $$('.rmx-wave-tools .wave-tool').forEach((b) => { if (b.dataset.tool === 'beatgrid') b.classList.add('on'); else if (['loop', 'cue', 'zoom'].includes(b.dataset.tool)) b.classList.remove('on'); });
    updateReadouts();
    layout();
  }

  /* ---------- wave interaction: seek / loop-select / cue / zoom ---------- */
  const HIT = 7;                       // px hit threshold for handles/cues
  function wireWave() {
    const frame = $('.wave-frame'); if (!frame) return;
    frame.dataset.mode = mode;
    let action = null, dragCue = null, downX = 0, moved = false, anchorF = 0;

    const rect = () => frame.getBoundingClientRect();
    const fx = (e) => { const r = rect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
    const fOf = (e) => xToF(fx(e));
    const cueHit = (px) => cues.find((c) => Math.abs(fToX(c.f) * rect().width - px) < HIT);

    frame.addEventListener('pointerdown', (e) => {
      if (!srcLen) return;
      frame.setPointerCapture(e.pointerId);
      downX = e.clientX; moved = false;
      const r = rect();
      const px = fx(e) * r.width, f = fOf(e);

      if (mode === 'zoom') { action = 'zoom'; anchorF = f; return; }

      if (mode === 'cue') {
        const hit = cueHit(px);
        if (hit) { dragCue = hit; }
        else { dragCue = { f, label: String.fromCharCode(65 + cues.length % 8) }; cues.push(dragCue); renderCues(); }
        action = 'cue-move'; positionCues(); return;
      }

      if (mode === 'loop') {
        const lx = fToX(loopStart / srcLen) * r.width, rx = fToX(loopEnd / srcLen) * r.width;
        const hasLoop = loopEnd > loopStart;
        if (hasLoop && Math.abs(px - lx) < HIT) action = 'loop-l';
        else if (hasLoop && Math.abs(px - rx) < HIT) action = 'loop-r';
        else if (hasLoop && px > lx && px < rx) { action = 'loop-move'; anchorF = f; }
        else { action = 'loop-new'; anchorF = f; loopStart = f * srcLen; loopEnd = f * srcLen; }
        positionLoop(); return;
      }

      // seek mode: a cue click jumps to it; otherwise scrub
      const hit = cueHit(px);
      if (hit) { action = 'cue-jump'; dragCue = hit; return; }
      action = 'seek'; seek(f);
    });

    frame.addEventListener('pointermove', (e) => {
      if (!action) return;
      if (Math.abs(e.clientX - downX) > 3) moved = true;
      const f = fOf(e);
      if (action === 'seek') seek(f);
      else if (action === 'cue-move') { dragCue.f = f; positionCues(); }
      else if (action === 'loop-new') {
        loopStart = snapBeat(Math.min(anchorF, f)) * srcLen;
        loopEnd = snapBeat(Math.max(anchorF, f)) * srcLen;
        positionLoop();
      } else if (action === 'loop-l') {
        loopStart = Math.min(snapBeat(f) * srcLen, loopEnd - rate * 0.05); positionLoop();
      } else if (action === 'loop-r') {
        loopEnd = Math.max(snapBeat(f) * srcLen, loopStart + rate * 0.05); positionLoop();
      } else if (action === 'loop-move') {
        let d = (f - anchorF) * srcLen, ns = loopStart + d, ne = loopEnd + d;
        if (ns < 0) { ne -= ns; ns = 0; }
        if (ne > srcLen) { ns -= (ne - srcLen); ne = srcLen; }
        loopStart = ns; loopEnd = ne; anchorF = f; positionLoop();
      }
    });

    frame.addEventListener('pointerup', (e) => {
      try { frame.releasePointerCapture(e.pointerId); } catch (_) {}
      const f = fOf(e);
      if (action === 'zoom') {
        const factor = (e.altKey || e.metaKey || e.shiftKey) ? 2 : 0.5;  // out vs in
        setZoom(viewSpan() * factor, anchorF);
      } else if (action === 'cue-jump' && !moved) {
        seek(dragCue.f);
      } else if (action === 'loop-new') {
        if (!moved) { loopStart = loopEnd = 0; setLoopToggle(false); seek(f); }
        else setLoopToggle(true);
        positionLoop();
      } else if (action && action.indexOf('loop-') === 0) {
        setLoopToggle(true);
      }
      action = null; dragCue = null;
    });

    // right-click a cue to remove it
    frame.addEventListener('contextmenu', (e) => {
      const px = fx(e) * rect().width;
      const hit = cueHit(px);
      if (hit) { e.preventDefault(); cues = cues.filter((c) => c !== hit); renderCues(); }
    });

    // wheel: zoom toward cursor (shift = pan)
    frame.addEventListener('wheel', (e) => {
      if (!srcLen) return;
      e.preventDefault();
      const f = fOf(e);
      if (e.shiftKey) {
        const d = Math.sign(e.deltaY) * viewSpan() * 0.12;
        viewA += d; viewB += d; clampView(); layout();
      } else {
        setZoom(viewSpan() * (e.deltaY > 0 ? 1.18 : 0.85), f);
      }
    }, { passive: false });
  }

  /* ---------- wave tools (Beatgrid display + Loop/Cue/Zoom modes) ---------- */
  function setMode(m) {
    mode = (mode === m) ? 'seek' : m;
    const frame = $('.wave-frame'); if (frame) frame.dataset.mode = mode;
    $$('.rmx-wave-tools .wave-tool').forEach((b) => {
      const l = b.dataset.tool;
      if (l === 'beatgrid' || l === 'fit') return;
      b.classList.toggle('on', mode !== 'seek' && l === mode);
    });
  }
  function wireTools() {
    const wrap = $('.rmx-wave-tools'); if (!wrap) return;
    // tag + de-dupe handlers by cloning (drops any prototype.js generic toggle)
    $$('.wave-tool', wrap).forEach((btn) => {
      const t = btn.textContent.trim().toLowerCase();
      btn.dataset.tool = t.indexOf('beatgrid') === 0 ? 'beatgrid'
        : t.indexOf('loop') === 0 ? 'loop'
        : t.indexOf('cue') === 0 ? 'cue'
        : t.indexOf('zoom') === 0 ? 'zoom' : 'other';
    });
    // add zoom badge + fit button
    if (!$('.rmx-zoom-badge', wrap)) {
      const badge = document.createElement('span');
      badge.className = 'rmx-zoom-badge'; badge.hidden = true;
      const fit = document.createElement('button');
      fit.className = 'wave-tool rmx-fit'; fit.dataset.tool = 'fit'; fit.hidden = true;
      fit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>Ajustar';
      wrap.prepend(badge);
      wrap.appendChild(fit);
    }
    $$('.wave-tool', wrap).forEach((btn) => {
      const clone = btn.cloneNode(true);
      btn.replaceWith(clone);
      const t = clone.dataset.tool;
      clone.addEventListener('click', () => {
        if (t === 'beatgrid') { showGrid = !showGrid; clone.classList.toggle('on', showGrid); layout(); }
        else if (t === 'fit') { fitView(); }
        else setMode(t);
      });
    });
    // initial tool states
    const grid = $('.wave-tool[data-tool="beatgrid"]', wrap); if (grid) grid.classList.toggle('on', showGrid);
    ['loop', 'cue', 'zoom'].forEach((m) => { const b = $(`.wave-tool[data-tool="${m}"]`, wrap); if (b) b.classList.remove('on'); });
  }

  /* ============================================================
     TRACK PICKER  (select a track to load into the remixer)
     ============================================================ */
  function buildPicker() {
    const strip = $('.rmx-track'); if (!strip) return;
    const meta = strip.querySelector('.rmx-track-meta');
    const btn = document.createElement('button');
    btn.className = 'rmx-loadbtn'; btn.type = 'button';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3.2l9.6 10H20"/><path d="M17 4l3 3-3 3"/></svg>Trocar faixa<svg class="cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>';
    const menu = document.createElement('div');
    menu.className = 'rmx-loadmenu'; menu.hidden = true;
    meta.after(btn);
    btn.after(menu);

    function fill() {
      menu.innerHTML = '';
      $$('.screen[data-screen="acervo"] .row').forEach((row) => {
        const d = rowData(row);
        const it = document.createElement('button');
        it.className = 'rmx-loaditem'; it.type = 'button';
        it.innerHTML =
          `<span class="row-cover cover" style="background:${d.bg}"></span>` +
          `<span class="ri-main"><span class="ri-title">${d.title}</span><span class="ri-sub">${d.artist}</span></span>` +
          `<span class="ri-bpm">${d.bpm}</span><span class="ri-key">${d.key}</span>`;
        it.addEventListener('click', () => { load(d); closeMenu(); });
        menu.appendChild(it);
      });
    }
    function openMenu() { fill(); menu.hidden = false; btn.classList.add('open'); }
    function closeMenu() { menu.hidden = true; btn.classList.remove('open'); }
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden ? openMenu() : closeMenu(); });
    document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('.rmx-loadmenu') && !e.target.closest('.rmx-loadbtn')) closeMenu(); });
  }

  function rowData(row) {
    return {
      bg: row.querySelector('.row-cover')?.style.background || '',
      title: row.querySelector('.row-title')?.textContent || 'Faixa',
      artist: row.querySelector('.row-artist')?.textContent || 'Rolf',
      bpm: row.querySelector('.row-data')?.textContent || '118',
      key: row.querySelector('.row-key')?.textContent || 'A min',
      coord: row.dataset.coord || '',
    };
  }

  /* ============================================================
     LOAD A TRACK INTO THE REMIXER
     ============================================================ */
  function load(d) {
    origBpm = parseInt(d.bpm, 10) || 118;
    origKey = d.key || 'A min';
    // strip visuals
    const cover = $('.rmx-track-cover'); if (cover && d.bg) cover.style.background = d.bg;
    const title = $('.rmx-track-title'); if (title) title.textContent = d.title;
    const sub = $('.rmx-track-sub');
    if (sub) sub.innerHTML = `<span class="rmx-live"><span class="rmx-live-dot"></span>Ao vivo</span> <span class="d"></span> ${d.artist} <span class="d"></span> <span class="tag">${origKey}</span>`;
    // transport
    const tpCover = $('.transport .tp-cover'); if (tpCover && d.bg) tpCover.style.background = d.bg;
    const tpTitle = $('.transport .tp-title-text'); if (tpTitle) tpTitle.textContent = d.title;
    const tpArtist = $('.transport .tp-artist'); if (tpArtist) tpArtist.textContent = d.artist;
    resetAll();
    cues = [{ f: 0, label: 'A' }];
    renderCues();
    seek(0);
    layout();
  }

  /* ============================================================
     PLAY BUTTON OWNERSHIP (clone to drop prototype.js handlers)
     ============================================================ */
  function ownPlayButtons() {
    $$('.tp-play, .rl-play').forEach((b) => {
      const clone = b.cloneNode(true);
      b.replaceWith(clone);
      clone.addEventListener('click', () => { ensureCtx(); toggle(); });
    });
    // viz play mirrors
    const vp = $('.viz-play');
    if (vp) { const c = vp.cloneNode(true); vp.replaceWith(c); c.addEventListener('click', () => { ensureCtx(); toggle(); }); }
  }

  /* ============================================================
     INIT
     ============================================================ */
  function init() {
    ensureCtx();
    decode();
    wireKnob('Pitch'); wireKnob('Tempo'); wireKnob('Filtro');
    wireToggles(); wireEQ(); wireLoop(); wireWave(); wireOutput();
    wireTools(); wireAB(); initCues();
    buildPicker();
    ownPlayButtons();
    // reset button (header)
    $$('.rmx .btn-ghost').forEach((b) => {
      if (/reset/i.test(b.textContent)) b.addEventListener('click', () => { resetAll(); });
    });
    // double-click an acervo row → also align engine to that track
    $$('.screen[data-screen="acervo"] .row').forEach((row) => {
      row.addEventListener('dblclick', () => { load(rowData(row)); play(); });
    });
    // start paused (needs gesture to sound)
    document.body.classList.add('paused');
    playing = false;
    syncPlayIcons();
    // seed readouts from the markup's default track
    const reads = $$('.rmx-readouts .rmx-read .v');
    origBpm = parseInt(reads[0]?.textContent, 10) || 118;
    origKey = (reads[2]?.textContent || 'A min').trim();
    targetBpm = origBpm;
    updateReadouts();
    applyGain();
    layout();
    // repaint/reposition on resize
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(layout, 120); });
    // relayout when the remixer screen becomes visible
    const rmx = $('.screen[data-screen="remixer"]');
    if (rmx && window.ResizeObserver) { new ResizeObserver(() => layout()).observe(rmx); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.RolfRemixer = { load, play, pause, toggle, seek, get playing() { return playing; } };
})();
