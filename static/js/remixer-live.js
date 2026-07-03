/* ============================================================
   ROLFSOUND V2 — REMIXER LIVE (superfície de controle do CORE)
   O antigo remixer-engine.js decodificava e TOCAVA áudio no
   navegador (Web Audio). Isso morreu: todo o áudio sai no
   rolfsound-core. Este módulo só traduz gestos em parâmetros:

     · Pitch / Tempo  → POST /api/remix (remix engine do core,
       pitch e tempo independentes sobre o áudio real)
     · Reset          → POST /api/remix/reset
     · clique/drag na waveform → seek no core (via RolfPlayback)
     · "Trocar faixa" → toca outra faixa do acervo no core
     · sincroniza os knobs quando outro cliente muda o remix
       (estado chega em 'rolf:status' → status.remix)

   Filtro/EQ/Loop/Saída ainda não existem no core — ficam como
   controles visuais até o core ganhar esses parâmetros.
   ============================================================ */
(function () {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const Player = window.RolfPlayer = window.RolfPlayer || {};
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // mesmo mapeamento de knob do prototype.js (fonte única do frac)
  const KNOB = {
    Pitch: { min: -12, max: 12 },
    Tempo: { min: 80, max: 160 },
  };
  const knobValue = (name, frac) => Math.round(KNOB[name].min + frac * (KNOB[name].max - KNOB[name].min));
  const fracForValue = (name, v) => Math.max(0, Math.min(1, (v - KNOB[name].min) / (KNOB[name].max - KNOB[name].min)));

  let pitchSemis = 0;
  let targetBpm = 0;              // 0 = segue o BPM original
  let lastLocalMs = 0;            // ignora sync do servidor logo após gesto local
  let remixTimer = null;

  /* ---------- helpers ---------- */
  function modByTitle(name) {
    return $$('.rmx-deck .mod').find((m) => (m.querySelector('.mod-title')?.textContent || '').trim() === name);
  }
  function reads() { return $$('.rmx-readouts .rmx-read .v'); }
  function origBpm() {
    const v = parseInt(reads()[0]?.textContent, 10);
    return (v > 0) ? v : 118;
  }
  function origKey() { return (reads()[2]?.textContent || 'A min').trim(); }

  function transposeKey(key, semis) {
    const m = /^([A-G]#?)\s*(min|maj|m|M)?/i.exec((key || '').trim());
    if (!m) return key;
    let idx = NOTES.indexOf(m[1].toUpperCase());
    if (idx < 0) return key;
    idx = (idx + Math.round(semis) % 12 + 120) % 12;
    const mode = (m[2] || '').toLowerCase().startsWith('ma') ? 'maj' : (m[2] ? 'min' : '');
    return NOTES[idx] + (mode ? ' ' + mode : '');
  }

  const fmtPct = (r) => { const p = (r - 1) * 100; return (p >= 0 ? '+' : '') + p.toFixed(1) + '%'; };

  function updateReadouts() {
    const rs = reads();
    const ob = origBpm();
    const tb = targetBpm || ob;
    if (rs[1]) rs[1].innerHTML = `${Math.round(tb)}<small> bpm</small>`;
    if (rs[3]) rs[3].textContent = transposeKey(origKey(), pitchSemis);

    const pitchMod = modByTitle('Pitch');
    if (pitchMod) { const b = pitchMod.querySelector('.mod-foot .mod-sub b'); if (b) b.textContent = transposeKey(origKey(), pitchSemis); }
    const tempoMod = modByTitle('Tempo');
    if (tempoMod) {
      const sub = tempoMod.querySelector('.mod-foot .mod-sub');
      if (sub) sub.innerHTML = `<b>${fmtPct(tb / ob)}</b> · de ${ob}`;
    }
  }

  // espelha o visual de um knob sem re-emitir 'rolfknob' (evita eco)
  function setKnobVisual(name, frac) {
    const knob = modByTitle(name)?.querySelector('.knob');
    if (!knob) return;
    frac = Math.max(0, Math.min(1, frac));
    knob.dataset.frac = frac.toFixed(4);
    knob.style.setProperty('--frac', frac.toFixed(4));
    const ind = knob.querySelector('.knob-ind');
    if (ind) ind.style.transform = `rotate(${-135 + frac * 270}deg)`;
    const valEl = knob.closest('.mod')?.querySelector('.knob-val');
    if (valEl) {
      const v = knobValue(name, frac);
      if (name === 'Pitch') valEl.innerHTML = `<span class="acc">${v > 0 ? '+' : ''}${v}</span><small>st</small>`;
      else valEl.innerHTML = `${v}<small>bpm</small>`;
    }
  }

  /* ---------- mandar remix ao core (debounced) ---------- */
  function pushRemix() {
    if (remixTimer) clearTimeout(remixTimer);
    remixTimer = setTimeout(() => {
      remixTimer = null;
      if (!window.RolfPlayback) return;
      window.RolfPlayback.remixSet({
        pitch_semitones: pitchSemis,
        tempo_ratio: (targetBpm || origBpm()) / origBpm(),
      });
    }, 150);
  }

  function wireKnob(name) {
    const knob = modByTitle(name)?.querySelector('.knob');
    if (!knob) return;
    // prototype.js é dono do drag e emite 'rolfknob'; aqui só traduzimos
    knob.addEventListener('rolfknob', (e) => {
      lastLocalMs = Date.now();
      const v = knobValue(name, e.detail.frac);
      if (name === 'Pitch') pitchSemis = v;
      else targetBpm = v;
      updateReadouts();
      pushRemix();
    });
  }

  /* ---------- sync de estado vindo do core ---------- */
  document.addEventListener('rolf:status', (e) => {
    const rmx = e.detail && e.detail.remix;
    if (!rmx || Date.now() - lastLocalMs < 2500) return;
    const semis = Math.round(rmx.pitch_semitones || 0);
    const ratio = rmx.tempo_ratio || 1;
    const bpm = Math.round(origBpm() * ratio);
    if (semis !== pitchSemis) {
      pitchSemis = semis;
      setKnobVisual('Pitch', fracForValue('Pitch', semis));
    }
    if (Math.abs(bpm - (targetBpm || origBpm())) >= 1) {
      targetBpm = bpm;
      setKnobVisual('Tempo', fracForValue('Tempo', bpm));
    }
    updateReadouts();
  });

  /* ---------- reset ---------- */
  function resetAll(sendToCore) {
    pitchSemis = 0;
    targetBpm = 0;
    setKnobVisual('Pitch', fracForValue('Pitch', 0));
    setKnobVisual('Tempo', fracForValue('Tempo', origBpm()));
    updateReadouts();
    if (sendToCore && window.RolfPlayback) window.RolfPlayback.remixReset();
  }

  /* ---------- seek na waveform (o playhead segue Player.pos) ---------- */
  function wireWave() {
    const frame = $('.wave-frame');
    if (!frame) return;
    let scrubbing = false;
    const fracOf = (e) => {
      const r = frame.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    };
    const seek = (e) => {
      const f = fracOf(e);
      Player.pos = f;                                    // feedback imediato
      const ph = $('.wave-playhead'); if (ph) ph.style.left = (f * 100).toFixed(2) + '%';
      if (window.RolfPlayback) window.RolfPlayback.seekFrac(f);
    };
    frame.addEventListener('pointerdown', (e) => {
      scrubbing = true;
      frame.setPointerCapture(e.pointerId);
      seek(e);
      e.preventDefault();
    });
    frame.addEventListener('pointermove', (e) => { if (scrubbing) seek(e); });
    const end = (e) => {
      if (!scrubbing) return;
      scrubbing = false;
      try { frame.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    frame.addEventListener('pointerup', end);
    frame.addEventListener('pointercancel', end);
  }

  /* ---------- controles visuais restantes (sem áudio local) ----------
     EQ e fader de saída ainda não existem no core; mantemos o gesto
     funcionando visualmente para a superfície não parecer quebrada. */
  function wireEqVisual() {
    const mod = modByTitle('EQ');
    if (!mod) return;
    $$('.eq-band', mod).forEach((band) => {
      const slider = band.querySelector('.eq-slider');
      const knob = band.querySelector('.eq-knob');
      const dbEl = band.querySelector('.eq-db');
      if (!slider || !knob) return;
      let fill = band.querySelector('.eq-fill');
      const apply = (frac) => {
        frac = Math.max(0, Math.min(1, frac));
        const db = (frac - 0.5) * 24;
        knob.style.bottom = (frac * 100).toFixed(1) + '%';
        knob.classList.toggle('acc', Math.abs(db) > 0.5);
        if (dbEl) dbEl.textContent = (db >= 0 ? '+' : '') + Math.round(db);
        if (!fill) { fill = document.createElement('span'); fill.className = 'eq-fill'; slider.prepend(fill); }
        if (db >= 0) { fill.style.bottom = '50%'; fill.style.top = (100 - frac * 100) + '%'; }
        else { fill.style.top = '50%'; fill.style.bottom = (frac * 100) + '%'; }
        fill.style.display = Math.abs(db) > 0.5 ? '' : 'none';
      };
      band._applyEq = apply;
      let drag = false;
      const fromEv = (e) => { const r = slider.getBoundingClientRect(); apply(1 - (e.clientY - r.top) / r.height); };
      slider.style.cursor = 'ns-resize';
      slider.addEventListener('pointerdown', (e) => { drag = true; slider.setPointerCapture(e.pointerId); fromEv(e); e.preventDefault(); });
      slider.addEventListener('pointermove', (e) => { if (drag) fromEv(e); });
      slider.addEventListener('pointerup', (e) => { drag = false; slider.releasePointerCapture(e.pointerId); });
    });
    const flat = mod.querySelector('.mod-toggle');
    if (flat) flat.addEventListener('click', () => {
      if (flat.classList.contains('on')) $$('.eq-band', mod).forEach((b) => b._applyEq && b._applyEq(0.5));
    });
  }

  function wireOutputVisual() {
    const mod = modByTitle('Saída');
    if (!mod) return;
    const meter = mod.querySelector('.meter');
    const valEl = mod.querySelector('.knob-val');
    if (!meter) return;
    meter.style.cursor = 'ns-resize';
    meter.title = 'Arraste para ajustar o volume';
    // o fader de saída controla o VOLUME REAL do core (0..1)
    const apply = (frac) => {
      frac = Math.max(0, Math.min(1, frac));
      if (valEl) valEl.innerHTML = Math.round(frac * 100) + '<small>%</small>';
      if (window.RolfSetVol) window.RolfSetVol(frac);
      if (window.RolfPlayback) window.RolfPlayback.setVolume(frac);
    };
    let drag = false;
    const fromEv = (e) => {
      const r = meter.getBoundingClientRect();
      apply(1 - (e.clientY - r.top) / r.height);
    };
    meter.addEventListener('pointerdown', (e) => { drag = true; meter.setPointerCapture(e.pointerId); fromEv(e); e.preventDefault(); });
    meter.addEventListener('pointermove', (e) => { if (drag) fromEv(e); });
    meter.addEventListener('pointerup', (e) => { drag = false; meter.releasePointerCapture(e.pointerId); });
  }

  /* ---------- picker "Trocar faixa" (toca no core) ---------- */
  function rowData(row) {
    return {
      id: row.dataset.id || '',
      bg: row.querySelector('.row-cover')?.style.background || '',
      title: row.querySelector('.row-title')?.textContent || 'Faixa',
      artist: row.querySelector('.row-artist')?.textContent || '',
      bpm: row.querySelector('.row-data')?.textContent || '',
      key: row.querySelector('.row-key')?.textContent || '',
    };
  }

  function buildPicker() {
    const strip = $('.rmx-track');
    if (!strip) return;
    const meta = strip.querySelector('.rmx-track-meta');
    if (!meta) return;
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
          `<span class="row-cover cover" style='background:${d.bg}'></span>` +
          `<span class="ri-main"><span class="ri-title">${d.title}</span><span class="ri-sub">${d.artist}</span></span>` +
          `<span class="ri-bpm">${d.bpm}</span><span class="ri-key">${d.key}</span>`;
        // tocar = mesmo caminho do acervo (loadTransport → core /api/play)
        it.addEventListener('click', () => { row.click(); closeMenu(); });
        menu.appendChild(it);
      });
    }
    function openMenu() { fill(); menu.hidden = false; btn.classList.add('open'); }
    function closeMenu() { menu.hidden = true; btn.classList.remove('open'); }
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden ? openMenu() : closeMenu(); });
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !e.target.closest('.rmx-loadmenu') && !e.target.closest('.rmx-loadbtn')) closeMenu();
    });
  }

  /* ---------- init ---------- */
  function init() {
    wireKnob('Pitch');
    wireKnob('Tempo');
    wireWave();
    wireEqVisual();
    wireOutputVisual();
    buildPicker();
    $$('.rmx .btn-ghost').forEach((b) => {
      if (/reset/i.test(b.textContent)) b.addEventListener('click', () => resetAll(true));
    });
    resetAll(false);   // posiciona knobs no estado neutro
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
