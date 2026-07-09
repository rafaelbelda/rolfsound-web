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
     · Filtro (LP/HP + cutoff log) e EQ (3 bandas) → POST /api/fx
       (fx_engine do core — estágio pós-remix do pump, ~150 ms)
     · Mute → POST /api/mute (flag no core; o fader mantém a posição)
     · medidor de Saída anima com os picos L/R reais do callback,
       via levels-feed.js (poller único de /api/levels), só com a
       tela Remixer visível
     · sincroniza knobs/faders quando outro cliente muda remix/fx
       (estado chega em 'rolf:status' → status.remix / status.fx)

   O módulo Loop vira o pad de samples na parte B do FX-PADS.md.
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

  // ---------- FX (filtro/EQ) — params reais no core ----------
  // Mesmo mapeamento log do knob Filtro no prototype.js: frac ↔ log2(Hz).
  const FLT_MIN_LOG = Math.log2(20), FLT_MAX_LOG = Math.log2(20000);
  const cutoffFromFrac = (f) => Math.pow(2, FLT_MIN_LOG + Math.max(0, Math.min(1, f)) * (FLT_MAX_LOG - FLT_MIN_LOG));
  const fracFromCutoff = (hz) => Math.max(0, Math.min(1, (Math.log2(Math.max(20, Math.min(20000, hz))) - FLT_MIN_LOG) / (FLT_MAX_LOG - FLT_MIN_LOG)));

  const EQ_KEYS = ['eq_low_db', 'eq_mid_db', 'eq_high_db'];   // ordem das .eq-band (Lo/Mid/Hi)
  const eqFracFromDb = (db) => Math.max(0, Math.min(1, db / 24 + 0.5));

  const fx = { filter_mode: 'lp', filter_cutoff_hz: 20000, eq_low_db: 0, eq_mid_db: 0, eq_high_db: 0 };
  let fxTimer = null;
  let lastFxLocalMs = 0;
  let muted = false;
  let lastMuteLocalMs = 0;

  function pushFx(partial) {
    Object.assign(fx, partial);
    lastFxLocalMs = Date.now();
    if (fxTimer) clearTimeout(fxTimer);
    fxTimer = setTimeout(() => {
      fxTimer = null;
      if (window.RolfPlayback) window.RolfPlayback.fxSet({ ...fx });
    }, 60); /* mesmo debounce curto do remix (ring pós-DSP responde em ~150 ms) */
  }

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

    // avisa a telinha da topbar (topbar-now.js) — BPM/tom efetivos ao vivo;
    // roda tanto no gesto local do knob quanto no sync vindo do core
    document.dispatchEvent(new CustomEvent('rolf:remix', {
      detail: { ratio: tb / ob, semis: pitchSemis },
    }));
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
    }, 60); /* o core agora responde em ~150 ms (ring pós-DSP) — debounce curto */
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

  // sync de FX e mute (mesma janela pós-gesto do remix)
  document.addEventListener('rolf:status', (e) => {
    const st = e.detail || {};
    const sfx = st.fx;
    if (sfx && !fxTimer && Date.now() - lastFxLocalMs > 2500) {
      const mode = sfx.filter_mode === 'hp' ? 'hp' : 'lp';
      const hz = +sfx.filter_cutoff_hz || 20000;
      if (mode !== fx.filter_mode || Math.abs(hz - fx.filter_cutoff_hz) > 1) {
        fx.filter_mode = mode;
        fx.filter_cutoff_hz = hz;
        setFilterVisual(mode, hz);
      }
      const eqMod = modByTitle('EQ');
      EQ_KEYS.forEach((k, i) => {
        const v = +sfx[k] || 0;
        if (Math.abs(v - fx[k]) < 0.05) return;
        fx[k] = v;
        const band = eqMod ? $$('.eq-band', eqMod)[i] : null;
        if (band && band._applyEq) band._applyEq(eqFracFromDb(v));
      });
      if (eqMod) syncEqFlat(eqMod);
    }
    if (typeof st.muted !== 'undefined' && Date.now() - lastMuteLocalMs > 2000) {
      if (!!st.muted !== muted) setMuteVisual(!!st.muted);
    }
  });

  /* ---------- reset ---------- */
  function resetAll(sendToCore) {
    pitchSemis = 0;
    targetBpm = 0;
    setKnobVisual('Pitch', fracForValue('Pitch', 0));
    setKnobVisual('Tempo', fracForValue('Tempo', origBpm()));
    updateReadouts();
    // FX volta ao neutro junto — o Reset do deck é da mesa inteira
    // (mute fica: é do módulo Saída, não do deck)
    fx.filter_mode = 'lp';
    fx.filter_cutoff_hz = 20000;
    fx.eq_low_db = fx.eq_mid_db = fx.eq_high_db = 0;
    setFilterVisual('lp', 20000);
    const eqMod = modByTitle('EQ');
    if (eqMod) {
      $$('.eq-band', eqMod).forEach((b) => b._applyEq && b._applyEq(0.5));
      syncEqFlat(eqMod);
    }
    if (sendToCore && window.RolfPlayback) {
      lastFxLocalMs = Date.now();
      window.RolfPlayback.remixReset();
      window.RolfPlayback.fxReset();
    }
  }

  /* ---------- Pads de sample (módulo Pads, ex-Loop) ----------
     6 slots por faixa. Pad vazio → arma e a próxima arrastada na
     waveform vira o trecho (snap por compasso via BPM). Pad gravado →
     toggle: o core troca a faixa pelo loop do trecho (slip — a
     timeline segue; desligar volta onde a música estaria). Botão
     direito limpa. Persistência em track_pads via /api/pads/set. */
  const PAD_BARS = [0.25, 0.5, 1, 2, 4, 8];
  const Pads = {
    slices: [null, null, null, null, null, null],
    active: -1,
    armed: -1,          // pad esperando a seleção (estado só local)
    lastTouched: -1,    // alvo dos botões In/Out
    localMs: 0,         // guard: ignora o status logo após ação local
  };

  const padCells = () => $$('.pad-grid .pad');
  const padTrackId = () => (window.RolfPlayback ? window.RolfPlayback.state.currentId : '') || '';
  const padTrackDur = () => (window.RolfPlayback ? window.RolfPlayback.state.duration : 0) || 0;

  async function padApi(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status);
    return res.json().catch(() => ({}));
  }

  function paintPads() {
    padCells().forEach((cell, i) => {
      const sl = Pads.slices[i];
      cell.classList.toggle('filled', !!sl);
      cell.classList.toggle('armed', Pads.armed === i);
      cell.classList.toggle('playing', Pads.active === i);
      cell.title = sl
        ? `Pad ${i + 1} · ${sl.start_s.toFixed(1)}s–${sl.end_s.toFixed(1)}s (clique: toca/para · direito: limpa)`
        : `Pad ${i + 1} vazio · clique e arraste na forma de onda`;
    });
    const tog = modByTitle('Pads')?.querySelector('.mod-toggle');
    if (tog) tog.classList.toggle('on', Pads.active >= 0);
    paintPadOverlay();
  }

  // overlay .wave-loop: seleção em curso (frações) ou o trecho do pad
  // ativo/último tocado. O display é inline (o HTML nasce display:none).
  function paintPadOverlay(selFrac) {
    const overlay = $('.wave-loop');
    if (!overlay) return;
    let reg = selFrac || null;
    if (!reg) {
      const idx = Pads.active >= 0 ? Pads.active : Pads.lastTouched;
      const sl = idx >= 0 ? Pads.slices[idx] : null;
      const dur = padTrackDur();
      if (sl && dur > 0) reg = { a: sl.start_s / dur, b: sl.end_s / dur };
    }
    overlay.classList.toggle('selecting', !!selFrac);
    overlay.classList.toggle('rmx-loop-off', !selFrac && Pads.active < 0);
    if (!reg) { overlay.style.display = 'none'; return; }
    const left = Math.min(reg.a, reg.b);
    const width = Math.max(0.002, Math.abs(reg.b - reg.a));
    overlay.style.left = (left * 100).toFixed(2) + '%';
    overlay.style.width = (width * 100).toFixed(2) + '%';
    overlay.style.display = 'block';
  }

  // snap musical: início no beat mais próximo, comprimento no tamanho
  // ¼–8 compassos mais próximo do arrastado (usa o BPM dos readouts)
  function snapRegion(aSec, bSec) {
    let start = Math.min(aSec, bSec);
    const rawLen = Math.max(Math.abs(bSec - aSec), 0.02);
    const dur = padTrackDur();
    const beat = 60 / origBpm();
    const bar = beat * 4;
    let bars = PAD_BARS[0];
    for (const b of PAD_BARS) {
      if (Math.abs(b * bar - rawLen) < Math.abs(bars * bar - rawLen)) bars = b;
    }
    start = Math.max(0, Math.round(start / beat) * beat);
    let end = start + bars * bar;
    if (dur > 0 && end > dur) { end = dur; start = Math.max(0, end - bars * bar); }
    return {
      start_s: Math.round(start * 1000) / 1000,
      end_s: Math.round(end * 1000) / 1000,
    };
  }

  function savePad(index, region) {
    const id = padTrackId();
    if (!id || region.end_s - region.start_s < 0.05) { paintPads(); return; }
    Pads.slices[index] = region;             // otimista
    Pads.lastTouched = index;
    Pads.localMs = Date.now();
    paintPads();
    padApi('/api/pads/set', { track_id: id, index, start_s: region.start_s, end_s: region.end_s })
      .catch((e) => console.error('pad set failed:', e));
  }

  function wirePads() {
    const mod = modByTitle('Pads');
    if (!mod) return;
    padCells().forEach((cell, i) => {
      cell.addEventListener('click', () => {
        Pads.localMs = Date.now();
        if (Pads.armed === i) { Pads.armed = -1; paintPads(); return; }
        if (!Pads.slices[i]) {
          if (!padTrackId() || !(padTrackDur() > 0)) return;   // sem faixa carregada
          Pads.armed = i;
          paintPads();
          document.dispatchEvent(new CustomEvent('rolf:toast', {
            detail: { text: 'Arraste na forma de onda para escolher o trecho', kicker: `Pad ${i + 1}` },
          }));
          return;
        }
        Pads.lastTouched = i;
        if (Pads.active === i) {
          Pads.active = -1;
          paintPads();
          padApi('/api/pads/off').catch((e) => console.error('pad off failed:', e));
        } else {
          Pads.active = i;
          paintPads();
          padApi('/api/pads/on', { index: i }).catch((e) => console.error('pad on failed:', e));
        }
      });
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!Pads.slices[i]) return;
        Pads.localMs = Date.now();
        if (Pads.active === i) Pads.active = -1;
        if (Pads.armed === i) Pads.armed = -1;
        if (Pads.lastTouched === i) Pads.lastTouched = -1;
        Pads.slices[i] = null;
        paintPads();
        padApi('/api/pads/clear', { track_id: padTrackId(), index: i })
          .catch((e) => console.error('pad clear failed:', e));
      });
    });
    // "Ativo" desliga o pad que estiver tocando (e espelha o estado)
    const tog = mod.querySelector('.mod-toggle');
    if (tog) tog.addEventListener('click', () => {
      Pads.localMs = Date.now();
      if (Pads.active >= 0) {
        Pads.active = -1;
        padApi('/api/pads/off').catch((e) => console.error('pad off failed:', e));
      }
      paintPads();   // reimpõe a classe (o prototype alterna 'on' antes)
    });
    // In/Out refinam as bordas do pad ativo (ou do último tocado) no playhead
    const io = $$('.loop-io .wave-tool', mod);
    const ioTarget = () => (Pads.active >= 0 ? Pads.active : Pads.lastTouched);
    if (io[0]) io[0].addEventListener('click', () => {
      const t = ioTarget();
      const sl = t >= 0 ? Pads.slices[t] : null;
      if (!sl || !window.RolfPlayback) return;
      const pos = window.RolfPlayback.position();
      if (pos < sl.end_s - 0.05) savePad(t, { start_s: Math.round(pos * 1000) / 1000, end_s: sl.end_s });
    });
    if (io[1]) io[1].addEventListener('click', () => {
      const t = ioTarget();
      const sl = t >= 0 ? Pads.slices[t] : null;
      if (!sl || !window.RolfPlayback) return;
      const pos = window.RolfPlayback.position();
      if (pos > sl.start_s + 0.05) savePad(t, { start_s: sl.start_s, end_s: Math.round(pos * 1000) / 1000 });
    });
  }

  // pads do servidor (status.pads) — o core limpa na troca de faixa e a
  // web reempurra os salvos, então o status é a fonte da verdade
  document.addEventListener('rolf:status', (e) => {
    const sp = e.detail && e.detail.pads;
    if (!sp || !Array.isArray(sp.slices)) return;
    if (Date.now() - Pads.localMs < 2500) return;
    const next = sp.slices.map((s) => (s ? { start_s: +s.start_s, end_s: +s.end_s } : null));
    const nextActive = (typeof sp.active === 'number') ? sp.active : -1;
    const changed = nextActive !== Pads.active ||
      JSON.stringify(next) !== JSON.stringify(Pads.slices);
    if (!changed) return;
    Pads.slices = next;
    Pads.active = nextActive;
    paintPads();
  });

  /* ---------- seek na waveform (o playhead segue Player.pos) ----------
     Com um pad ARMADO o arraste vira seleção de trecho, não seek. */
  function wireWave() {
    const frame = $('.wave-frame');
    if (!frame) return;
    let scrubbing = false;
    let selecting = false;
    let selA = 0;
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
      if (Pads.armed >= 0 && padTrackDur() > 0) {
        selecting = true;
        selA = fracOf(e);
        frame.setPointerCapture(e.pointerId);
        paintPadOverlay({ a: selA, b: selA });
        e.preventDefault();
        return;
      }
      scrubbing = true;
      frame.setPointerCapture(e.pointerId);
      seek(e);
      e.preventDefault();
    });
    frame.addEventListener('pointermove', (e) => {
      if (selecting) { paintPadOverlay({ a: selA, b: fracOf(e) }); return; }
      if (scrubbing) seek(e);
    });
    const end = (e) => {
      if (selecting) {
        selecting = false;
        try { frame.releasePointerCapture(e.pointerId); } catch (_) {}
        const idx = Pads.armed;
        Pads.armed = -1;
        const dur = padTrackDur();
        const b = fracOf(e);
        if (idx >= 0 && dur > 0 && Math.abs(b - selA) * dur > 0.02) {
          savePad(idx, snapRegion(selA * dur, b * dur));
        } else {
          paintPads();     // arraste vazio = cancela
        }
        return;
      }
      if (!scrubbing) return;
      scrubbing = false;
      try { frame.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    frame.addEventListener('pointerup', end);
    frame.addEventListener('pointercancel', end);
  }

  /* ---------- Filtro (LP/HP + cutoff) → /api/fx ---------- */
  function filterValHtml(hz) {
    return hz >= 1000 ? `${(hz / 1000).toFixed(1)}<small>kHz</small>` : `${Math.round(hz)}<small>Hz</small>`;
  }

  // espelha o filtro sem re-emitir 'rolfknob' (sync do servidor / reset)
  function setFilterVisual(mode, hz) {
    const mod = modByTitle('Filtro');
    if (!mod) return;
    const knob = mod.querySelector('.knob');
    if (knob) {
      const frac = fracFromCutoff(hz);
      knob.dataset.frac = frac.toFixed(4);
      knob.style.setProperty('--frac', frac.toFixed(4));
      const ind = knob.querySelector('.knob-ind');
      if (ind) ind.style.transform = `rotate(${-135 + frac * 270}deg)`;
    }
    const valEl = mod.querySelector('.knob-val');
    if (valEl) valEl.innerHTML = filterValHtml(hz);
    const tog = mod.querySelector('.mod-toggle');
    if (tog) { tog.textContent = mode.toUpperCase(); tog.classList.add('on'); }
  }

  function wireFilter() {
    const mod = modByTitle('Filtro');
    if (!mod) return;
    const knob = mod.querySelector('.knob');
    // prototype.js é dono do drag e do readout (mesma escala log)
    if (knob) knob.addEventListener('rolfknob', (e) => {
      pushFx({ filter_cutoff_hz: Math.round(cutoffFromFrac(e.detail.frac)) });
    });
    const tog = mod.querySelector('.mod-toggle');
    if (tog) tog.addEventListener('click', () => {
      const mode = fx.filter_mode === 'lp' ? 'hp' : 'lp';
      tog.textContent = mode.toUpperCase();
      tog.classList.add('on');   // prototype alterna a classe; o modo é sempre ativo
      pushFx({ filter_mode: mode });
    });
  }

  /* ---------- EQ 3 bandas (Lo/Mid/Hi, ±12 dB) → /api/fx ---------- */
  function syncEqFlat(mod) {
    const flat = mod.querySelector('.mod-toggle');
    if (flat) flat.classList.toggle('on', EQ_KEYS.every((k) => Math.abs(fx[k]) < 0.05));
  }

  function wireEq() {
    const mod = modByTitle('EQ');
    if (!mod) return;
    $$('.eq-band', mod).forEach((band, i) => {
      const slider = band.querySelector('.eq-slider');
      const knob = band.querySelector('.eq-knob');
      const dbEl = band.querySelector('.eq-db');
      if (!slider || !knob) return;
      let fill = band.querySelector('.eq-fill');
      const apply = (frac) => {   // só visual — reusado pelo sync do servidor
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
      const fromEv = (e) => {
        const r = slider.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
        apply(frac);
        pushFx({ [EQ_KEYS[i]]: Math.round((frac - 0.5) * 240) / 10 });
        syncEqFlat(mod);
      };
      slider.style.cursor = 'ns-resize';
      slider.addEventListener('pointerdown', (e) => { drag = true; slider.setPointerCapture(e.pointerId); fromEv(e); e.preventDefault(); });
      slider.addEventListener('pointermove', (e) => { if (drag) fromEv(e); });
      slider.addEventListener('pointerup', (e) => { drag = false; slider.releasePointerCapture(e.pointerId); });
    });
    const flat = mod.querySelector('.mod-toggle');
    if (flat) flat.addEventListener('click', () => {
      $$('.eq-band', mod).forEach((b) => b._applyEq && b._applyEq(0.5));
      pushFx({ eq_low_db: 0, eq_mid_db: 0, eq_high_db: 0 });
      flat.classList.add('on');
    });
  }

  /* ---------- Saída: volume (fader) + Mute real + medidor ---------- */
  function setMuteVisual(m) {
    muted = m;
    const tog = modByTitle('Saída')?.querySelector('.mod-toggle');
    if (tog) tog.classList.toggle('on', m);
  }

  function wireOutput() {
    const mod = modByTitle('Saída');
    if (!mod) return;
    const meter = mod.querySelector('.meter');
    const valEl = mod.querySelector('.knob-val');
    if (meter) {
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
    // Mute real — flag no core; o fader não perde a posição
    const tog = mod.querySelector('.mod-toggle');
    if (tog) tog.addEventListener('click', () => {
      muted = !muted;
      lastMuteLocalMs = Date.now();
      tog.classList.toggle('on', muted);
      if (window.RolfPlayback) window.RolfPlayback.setMute(muted);
    });
  }

  /* ---------- medidor: picos L/R reais via levels-feed.js ----------
     A fonte é o poller ÚNICO de /api/levels (compartilhado com os
     visualizadores); aqui só registramos o predicado de visibilidade
     e pintamos com decay por frame — fora da tela nada roda. */
  function wireMeter() {
    const mod = modByTitle('Saída');
    const cols = mod ? $$('.meter-col', mod) : [];
    if (cols.length < 2) return;
    const shown = { l: 0, r: 0 };   // com decay (suaviza entre polls)
    let rafOn = false;

    const remixerVisible = () =>
      !document.hidden && !!$('.screen[data-screen="remixer"].active');

    if (window.RolfLevels) window.RolfLevels.register('remixer-meter', remixerVisible);

    function paint() {
      if (!remixerVisible()) { rafOn = false; return; }
      const feed = window.RolfLevels || { l: 0, r: 0 };
      shown.l = Math.max(feed.l, shown.l * 0.86);
      shown.r = Math.max(feed.r, shown.r * 0.86);
      [shown.l, shown.r].forEach((x, c) => {
        // colunas em column-reverse: children[0] é o segmento de BAIXO
        // (.peak, sempre aceso por CSS); animamos os 7 seguintes.
        const segs = cols[c].children;
        const db = x > 0.0001 ? 20 * Math.log10(x) : -60;
        const n = Math.max(0, Math.min(7, Math.round((db + 42) / 42 * 7)));
        for (let i = 1; i < segs.length; i++) segs[i].classList.toggle('lit', i <= n);
      });
      requestAnimationFrame(paint);
    }

    function ensure() {
      if (!remixerVisible()) return;
      if (!rafOn) { rafOn = true; requestAnimationFrame(paint); }
    }
    setInterval(ensure, 800);      // barato: religa quando a tela volta
    document.addEventListener('visibilitychange', ensure);
    ensure();
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
    wireFilter();
    wireEq();
    wireOutput();
    wireMeter();
    wirePads();
    buildPicker();
    $$('.rmx .btn-ghost').forEach((b) => {
      if (/reset/i.test(b.textContent)) b.addEventListener('click', () => resetAll(true));
    });
    resetAll(false);   // posiciona knobs no estado neutro
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
