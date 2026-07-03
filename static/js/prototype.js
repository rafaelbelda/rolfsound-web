/* ============================================================
   ROLFSOUND V2 — Unified prototype interactions
   - Island navigates between screens (no page reload)
   - Track rows: click selects + loads transport; double-click
     or context "Abrir no Remixer" loads into the Remixer
   - Transport play/pause + scrub
   - Remixer knobs: drag to change value, arc + readout update
   - Toggles, loop cells, A/B, segmented controls, EQ
   ============================================================ */
(function () {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // shared player state (created here or by motion, whichever runs first)
  const Player = window.RolfPlayer = window.RolfPlayer || {};
  if (typeof Player.dur !== 'number') Player.dur = 228;
  if (typeof Player.pos !== 'number') {
    const p0 = parseFloat(localStorage.getItem('rolf_pos') || '0');
    Player.pos = (p0 >= 0 && p0 < 1) ? p0 : 0;
  }
  if (typeof Player.volume !== 'number') Player.volume = 0.62;
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  function mmss(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return m + ':' + (s < 10 ? '0' : '') + s; }

  /* ---------------- screen navigation ---------------- */
  const STUB_COPY = {
    playlists: ['Playlists', 'Coleções · em breve'],
    busca:     ['Busca avançada', 'BPM · tom · formato'],
    capturar:  ['Capturar / Rip', 'Vinil · CD · linha · em breve'],
  };

  function showScreen(name) {
    const target = $(`.screen[data-screen="${name}"]`);
    if (!target) { toast(STUB_COPY[name] ? STUB_COPY[name][0] : name, 'Em breve'); return; }
    $$('.screen').forEach((s) => s.classList.toggle('active', s === target));
    $$('.island .isl-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
    // repaint canvases that were hidden (clientWidth 0 → no draw).
    // double-rAF + a short fallback so the paint lands AFTER the screen's
    // entrance transition has given the canvases real layout dimensions.
    const repaint = () => { window.RolfPaint && window.RolfPaint(); };
    requestAnimationFrame(() => requestAnimationFrame(repaint));
    setTimeout(repaint, 220);
  }

  $$('.island .isl-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const nav = b.dataset.nav;
      showScreen(nav);
      if (nav === 'busca') {
        const f = $('[data-bsc-input]');
        if (f) setTimeout(() => f.focus(), 80);
      }
    });
  });

  /* device-status chip → Conta / Configurações */
  const statusChip = $('.tb-status[data-nav="config"]');
  if (statusChip) {
    statusChip.addEventListener('click', () => showScreen('config'));
    statusChip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showScreen('config'); }
    });
  }

  /* ---------------- track selection + transport ---------------- */
  const tp = {
    cover: $('.transport .tp-cover'),
    title: $('.transport .tp-title-text'),
    sub: $('.transport .tp-artist'),
  };

  function trackData(row) {
    return {
      bg:     row.querySelector('.row-cover')?.style.background || '',
      title:  row.querySelector('.row-title')?.textContent || 'Faixa',
      artist: row.querySelector('.row-artist')?.textContent || '',
      id:     row.dataset.id || '',
      bpm:    row.querySelector('.row-data')?.textContent || '',
      key:    row.querySelector('.row-key')?.textContent || '',
      dur:    +row.dataset.dur || 0,
    };
  }

  // keep the shared duration + total-time readouts in sync with the loaded track
  function setDuration(sec) {
    if (sec > 0) Player.dur = sec;
    const tr = document.querySelector('.transport .tp-time-r');
    if (tr) tr.textContent = mmss(Player.dur);
    const vt = $('[data-viz-total]');
    if (vt) vt.textContent = mmss(Player.dur);
  }

  // showTrack: aplica APENAS os visuais da faixa (transporte, marcador
  // ativo, viz, remixer). Nunca fala com o servidor — é chamado tanto
  // pelos cliques (otimista) quanto pelo playback.js ao reconciliar
  // o estado real vindo do core.
  function showTrack(d) {
    setDuration(+d.dur || 0);
    applyAccent(d.bg);
    lastTrack = d;
    if (tp.cover) tp.cover.style.background = d.bg;
    if (tp.title) tp.title.textContent = d.title;
    if (tp.sub) tp.sub.innerHTML = d.artist
      ? `${d.artist}${d.bpm ? ` <span style="width:3px;height:3px;border-radius:50%;background:var(--ink-faint)"></span> ${d.bpm} BPM` : ''}${d.key ? ` <span class="tag" style="margin-left:2px">${d.key}</span>` : ''}`
      : '';
    // move the active marker + eq into the matching acervo row
    $$('.row').forEach((r) => {
      r.classList.remove('active');
      const c = r.querySelector('.row-coord');
      const eq = c && c.querySelector('.eq');
      if (eq) eq.remove();
    });
    const match = $$('.screen[data-screen="acervo"] .row').find((r) => r.dataset.id === d.id);
    if (match) {
      match.classList.add('active');
      const coordEl = match.querySelector('.row-coord');
      if (coordEl && !coordEl.querySelector('.eq')) {
        const eq = document.createElement('span');
        eq.className = 'eq';
        eq.innerHTML = '<i></i><i></i><i></i>';
        coordEl.prepend(eq);
      }
    }
    syncViz(d);
    syncRemixer(d);
    // módulos fora deste arquivo (ex.: stems.js) reagem à troca de faixa
    document.dispatchEvent(new CustomEvent('rolf:track', { detail: d }));
  }

  // loadTransport: visuais otimistas + manda o core tocar a faixa.
  // O áudio sai no core — o navegador nunca reproduz nada.
  function loadTransport(row) {
    const d = trackData(row);
    showTrack(d);
    setPlaying(true);
    Player.pos = 0;
    if (window.RolfPlayback) window.RolfPlayback.playTrack(d.id, +d.dur || 0);
  }

  // Remixer is a LIVE performance surface over the now-playing track —
  // it always mirrors whatever the transport is playing, never a separate edit.
  function syncRemixer(d) {
    const cover = $('.rmx-track-cover');
    if (cover) cover.style.background = d.bg;
    const title = $('.rmx-track-title');
    if (title) title.textContent = d.title;
    const sub = $('.rmx-track-sub');
    if (sub) sub.innerHTML =
      `<span class="rmx-live"><span class="rmx-live-dot"></span>Ao vivo</span> <span class="d"></span> ${d.artist} <span class="d"></span> <span class="tag">${d.key}</span>`;
    // seed the orig readouts from the track
    const reads = $$('.rmx-read .v');
    if (reads[0]) reads[0].textContent = d.bpm;
    if (reads[2]) reads[2].textContent = d.key;
  }

  $$('.row').forEach((row) => {
    row.addEventListener('click', () => loadTransport(row));
    // double-click: play it and jump to the live Remixer
    row.addEventListener('dblclick', () => { loadTransport(row); showScreen('remixer'); });
  });

  /* ---------------- reactive accent + fullscreen visualizer ---------------- */
  let lastTrack = null;
  let accentMode = 'album';   // 'album' = react to cover art; or a pinned hex

  function hexToRgb(hex) {
    const m = /#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [200, 105, 60];
  }
  function toHex(r, g, b) {
    return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
  }
  function setAccentFromRgb(r, g, b) {
    const root = document.documentElement.style;
    root.setProperty('--accent', toHex(r, g, b));
    root.setProperty('--accent-soft', `rgba(${r},${g},${b},0.16)`);
  }

  // pulls the raw image URL out of a `background` CSS shorthand — works
  // whether url() is single- or double-quoted (reading .style.background
  // back from the DOM always re-serializes it with double quotes).
  function urlFromBg(bg) {
    const m = /url\((['"]?)(.*?)\1\)/i.exec(bg || '');
    return m ? m[2] : '';
  }

  // Real photographic cover art carries no usable colour in its CSS string
  // (only the neutral #141416 letterbox fallback) — the actual tone has to
  // come from the pixels themselves. Sampled client-side on a hidden canvas
  // and cached per URL so replaying a track doesn't re-decode it.
  const accentCache = new Map();
  let accentToken = 0;
  const sampleCv = document.createElement('canvas');
  sampleCv.width = 32; sampleCv.height = 32;
  const sampleCx = sampleCv.getContext('2d', { willReadFrequently: true });
  function sampleCoverColor(url, onReady) {
    if (accentCache.has(url)) { onReady(accentCache.get(url)); return; }
    const myToken = ++accentToken;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (myToken !== accentToken) return;   // a newer track loaded meanwhile
      try {
        sampleCx.clearRect(0, 0, 32, 32);
        sampleCx.drawImage(img, 0, 0, 32, 32);
        const data = sampleCx.getImageData(0, 0, 32, 32).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 16) continue;   // skip near-transparent pixels
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
        if (!n) return;
        const hex = toHex(Math.round(r / n), Math.round(g / n), Math.round(b / n));
        accentCache.set(url, hex);
        onReady(hex);
      } catch (_) {
        // cross-origin cover without CORS headers taints the canvas — leave the accent as-is
      }
    };
    img.src = url;
  }

  // flood the whole UI with the accent pulled from the now-playing cover art.
  function applyAccent(bg) {
    if (accentMode !== 'album') return;   // a fixed accent is pinned
    const url = urlFromBg(bg);
    if (url) {
      sampleCoverColor(url, (hex) => {
        if (accentMode !== 'album') return;   // may have been pinned while the image loaded
        const [r, g, b] = hexToRgb(hex);
        setAccentFromRgb(r, g, b);
      });
      return;
    }
    // legacy placeholder covers (fake CSS gradients) carry a usable colour directly
    let r, g, b;
    const hx = /#([0-9a-f]{6})/i.exec(bg || '');
    if (hx) { [r, g, b] = hexToRgb('#' + hx[1]); }
    else {
      const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(bg || '');
      if (!m) return;
      r = +m[1]; g = +m[2]; b = +m[3];
    }
    setAccentFromRgb(r, g, b);
  }

  function setAccentColor(hex) {
    const [r, g, b] = hexToRgb(hex);
    const root = document.documentElement.style;
    root.setProperty('--accent', hex);
    root.setProperty('--accent-soft', `rgba(${r},${g},${b},0.16)`);
  }

  const viz = $('[data-viz]');
  let vizActive = false;
  function syncViz(d) {
    if (!viz) return;
    d = d || lastTrack || {
      bg: tp.cover ? tp.cover.style.background : '',
      title: tp.title ? tp.title.textContent : '',
      artist: '', bpm: '', id: '',
    };
    const cover = $('[data-viz-cover]'); if (cover && d.bg) cover.style.background = d.bg;
    const title = $('[data-viz-title]'); if (title) title.textContent = d.title;
    const coord = $('[data-viz-coord]'); if (coord) coord.textContent = d.key || '';
    const sub = $('[data-viz-sub]');
    if (sub) sub.innerHTML = d.artist
      ? `${d.artist} <span style="width:3px;height:3px;border-radius:50%;background:var(--ink-faint)"></span> ${d.bpm} BPM`
      : '';
  }

  function openViz() {
    if (!viz) return;
    syncViz();
    viz.hidden = false;           // overlay always shows — fullscreen is a bonus
    vizActive = true;
    try {
      if (viz.requestFullscreen) { const p = viz.requestFullscreen(); if (p && p.catch) p.catch(() => {}); }
    } catch (_) {}
    requestAnimationFrame(() => { window.RolfPaint && window.RolfPaint(); });
  }
  function closeViz() {
    if (!viz || !vizActive) return;
    vizActive = false;
    viz.hidden = true;
    try {
      if (document.fullscreenElement && document.exitFullscreen) { const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => {}); }
    } catch (_) {}
  }
  const vizOpenBtn = $('[data-viz-open]');
  const vizCloseBtn = $('[data-viz-close]');
  if (vizOpenBtn) vizOpenBtn.addEventListener('click', openViz);
  if (vizCloseBtn) vizCloseBtn.addEventListener('click', closeViz);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && vizActive) closeViz();
  });

  /* ---------------- play queue (morphs up out of the dock) ---------------- */
  const dock = $('[data-dock]');
  const queueBtn = $('[data-queue-open]');
  const queueList = $('[data-queue-list]');
  let queueOpen = false;

  function renumberQueue() {
    const rows = $$('.tpq-row', queueList);
    rows.forEach((r, i) => { const idx = r.querySelector('.tpq-idx'); if (idx) idx.textContent = i + 1; });
    const count = $('[data-queue-count]');
    if (count) count.textContent = rows.length;
  }
  function setQueue(open) {
    queueOpen = open;
    if (dock) dock.classList.toggle('queue-open', open);
    if (queueBtn) queueBtn.classList.toggle('is-on', open);
    const q = $('[data-queue]');
    if (q) q.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  if (queueBtn) queueBtn.addEventListener('click', () => setQueue(!queueOpen));
  const queueClose = $('[data-queue-close]');
  if (queueClose) queueClose.addEventListener('click', () => setQueue(false));
  // click outside the expanded dock minimizes the queue
  document.addEventListener('pointerdown', (e) => {
    if (!queueOpen) return;
    if (e.target.closest('.tp-dock') || e.target.closest('.ctx') || e.target.closest('.viz')) return;
    setQueue(false);
  });

  // A fila REAL vive no core. Os handlers abaixo fazem a mutação otimista
  // no DOM e mandam a ação ao servidor; o poll do playback.js re-renderiza
  // a lista a partir do estado verdadeiro (via RolfQueueRowHtml).
  function queueAbsIndex(row) {
    // posição absoluta na fila do core: gravada pelo render (data-qindex);
    // fallback: posição visual após o índice atual
    if (row.dataset.qindex != null && row.dataset.qindex !== '') return +row.dataset.qindex;
    const rows = $$('.tpq-row', queueList);
    const vis = rows.indexOf(row);
    const cur = window.RolfPlayback ? window.RolfPlayback.state.currentQueueIdx : -1;
    return cur + 1 + Math.max(0, vis);
  }

  // play a queued track → core toca por índice; remove otimista da lista
  if (queueList) queueList.addEventListener('click', (e) => {
    const x = e.target.closest('.tpq-x');
    const row = e.target.closest('.tpq-row');
    if (!row) return;
    const abs = queueAbsIndex(row);
    if (x) {                       // remove from queue
      row.style.opacity = '0';
      setTimeout(() => { row.remove(); renumberQueue(); }, 140);
      if (window.RolfPlayback) window.RolfPlayback.queueRemove(abs);
      return;
    }
    const title = row.dataset.title;
    if (window.RolfPlayback) window.RolfPlayback.playQueueIndex(abs);
    row.remove();
    renumberQueue();
    toast(title, 'Tocando');
  });

  const queueClear = $('[data-queue-clear]');
  if (queueClear) queueClear.addEventListener('click', () => {
    $$('.tpq-row', queueList).forEach((r, i) => { setTimeout(() => { r.style.opacity = '0'; setTimeout(() => r.remove(), 130); }, i * 30); });
    setTimeout(() => { renumberQueue(); toast('Fila esvaziada', 'Limpar'); }, 200);
    if (window.RolfPlayback) window.RolfPlayback.queueClear();
  });
  // shuffle é um MODO do core (não um embaralhamento local da lista)
  const queueShuffle = $('[data-queue-shuffle]');
  if (queueShuffle) queueShuffle.addEventListener('click', () => {
    if (window.RolfPlayback) {
      window.RolfPlayback.toggleShuffle();
      toast(window.RolfPlayback.state.shuffle ? 'Shuffle ligado' : 'Shuffle desligado', 'Fila');
    }
  });

  // "Adicionar à fila" from the row context menu — otimista + servidor
  function addToQueue(d) {
    if (!queueList) return;
    const dur = d.dur > 0 ? mmss(d.dur) : '—';
    const row = document.createElement('div');
    row.className = 'tpq-row';
    row.dataset.bg = d.bg; row.dataset.title = d.title; row.dataset.artist = d.artist;
    row.dataset.bpm = d.bpm; row.dataset.id = d.id; row.dataset.key = d.key;
    row.dataset.dur = d.dur || 0;
    row.innerHTML =
      '<span class="tpq-grip"><i></i><i></i><i></i></span>' +
      '<span class="tpq-idx"></span>' +
      `<span class="row-cover cover" style='background:${d.bg}'></span>` +
      `<div class="tpq-main"><div class="tpq-name">${d.title}</div><div class="tpq-artist">${d.artist}</div></div>` +
      `<span class="tpq-data">${d.bpm}</span><span class="tpq-key">${d.key}</span>` +
      `<span class="tpq-dur">${dur}</span>` +
      '<button class="tpq-x" aria-label="Remover"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    queueList.appendChild(row);
    renumberQueue();
    if (window.RolfPlayback) window.RolfPlayback.queueAdd(d.id);
  }

  /* favoritar · renomear · remover — real row mutations */
  function toggleFav(row) {
    const on = row.dataset.fav !== '1';
    row.dataset.fav = on ? '1' : '0';
    const tags = row.querySelector('.row-tags');
    if (tags) {
      let star = tags.querySelector('.fav-star');
      if (on && !star) { star = document.createElement('span'); star.className = 'tag fav-star'; star.textContent = '★'; tags.prepend(star); }
      if (!on && star) star.remove();
    }
    return on;
  }
  function startRename(row) {
    const el = row.querySelector('.row-title');
    if (!el) return;
    el.setAttribute('contenteditable', 'true');
    el.classList.add('editing');
    const range = document.createRange(); range.selectNodeContents(el);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    el.focus();
    const finish = () => {
      el.removeAttribute('contenteditable'); el.classList.remove('editing');
      const name = el.textContent.trim() || 'Faixa';
      el.textContent = name; row.dataset.title = name;
      el.removeEventListener('blur', finish); el.removeEventListener('keydown', onKey);
      toast(name, 'Renomeada');
    };
    const onKey = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); }
      if (ev.key === 'Escape') { ev.preventDefault(); el.blur(); }
    };
    el.addEventListener('blur', finish);
    el.addEventListener('keydown', onKey);
  }
  function removeRow(row) {
    const wasActive = row.classList.contains('active');
    const title = trackData(row).title;
    row.style.transition = 'opacity 0.15s, transform 0.15s';
    row.style.opacity = '0'; row.style.transform = 'translateX(-8px)';
    setTimeout(() => { row.remove(); if (wasActive && window.RolfPlayback) window.RolfPlayback.next(); }, 160);
    toast(title, 'Removida do cofre');
  }

  /* context-menu actions */
  document.addEventListener('rolf:ctx', (e) => {
    const { action, row, label } = e.detail;
    switch (action) {
      case 'play':    if (row) loadTransport(row); toast(row ? trackData(row).title : 'Tocando', 'Play'); break;
      case 'remix':   if (row) { loadTransport(row); showScreen('remixer'); } break;
      case 'capturar': showScreen('capturar'); break;
      case 'queue':   if (row) addToQueue(trackData(row)); toast(row ? trackData(row).title : '', 'Na fila'); break;
      case 'fav':     if (row) { const on = toggleFav(row); toast(trackData(row).title, on ? 'Favoritada' : 'Removida dos favoritos'); } break;
      case 'rename':  if (row) startRename(row); break;
      case 'remove':  if (row) removeRow(row); break;
      case 'edit': case 'album': case 'artist': break;  // handled by track-panels.js
      case 'import': case 'dossier': break;  // handled by importer.js
      case 'playlist': break;  // handled by playlists.js
      case 'versions': break;  // handled by versions.js
      case 'stems': break;  // handled by stems.js
      default:        toast(label || 'Ação', '·');
    }
  });

  /* ---------------- play / pause ---------------- */
  let playing = true;
  const PLAY_ICON  = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4 18.6 12 8 18.6z"/></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5.5" width="3.4" height="13" rx="1"/><rect x="13.6" y="5.5" width="3.4" height="13" rx="1"/></svg>';

  function setPlaying(v) {
    playing = v;
    document.body.classList.toggle('paused', !v);
    $$('.tp-play, .st-play, .rl-play').forEach((b) => { b.innerHTML = v ? PAUSE_ICON : PLAY_ICON; });
  }
  // Os cliques de play/pause/prev/next são de responsabilidade do
  // playback.js (que os liga aos endpoints do core). Aqui só mantemos
  // o renderizador visual — exposto adiante como RolfSetPlaying.

  /* scrub bars — visual imediato + seek real no core (via bridge) */
  function seekTo(frac) {
    Player.pos = clamp01(frac);
    document.querySelectorAll('.tp-fill').forEach((f) => { f.style.width = (Player.pos * 100).toFixed(2) + '%'; });
    document.querySelectorAll('.transport .tp-time')[0] && (document.querySelectorAll('.transport .tp-time')[0].textContent = mmss(Player.pos * Player.dur));
    const ve = $('[data-viz-elapsed]'); if (ve) ve.textContent = mmss(Player.pos * Player.dur);
    if (window.RolfPlayback) window.RolfPlayback.seekFrac(Player.pos);
    // NOTE: remixer .wave-playhead is positioned via Player.pos (prototype-motion)
  }
  $$('.tp-bar').forEach((bar) => {
    bar.addEventListener('click', (e) => {
      const r = bar.getBoundingClientRect();
      seekTo((e.clientX - r.left) / r.width);
    });
  });
  // remixer waveform interaction is owned by remixer-live.js (seek no core)

  /* volume — draggable; o volume REAL é do core (POST /api/volume) */
  const volBar = $('.tp-vol-bar');
  const volFill = $('.tp-vol-fill');
  function setVol(frac) {                  // visual apenas (usado pelo poll)
    Player.volume = clamp01(frac);
    if (volFill) volFill.style.width = (Player.volume * 100).toFixed(0) + '%';
  }
  if (volBar) {
    let vdrag = false;
    const fromEv = (e) => {
      const r = volBar.getBoundingClientRect();
      setVol((e.clientX - r.left) / r.width);
      if (window.RolfPlayback) window.RolfPlayback.setVolume(Player.volume);
    };
    volBar.style.cursor = 'pointer';
    volBar.addEventListener('pointerdown', (e) => { vdrag = true; volBar.setPointerCapture(e.pointerId); fromEv(e); });
    volBar.addEventListener('pointermove', (e) => { if (vdrag) fromEv(e); });
    volBar.addEventListener('pointerup', (e) => { vdrag = false; volBar.releasePointerCapture(e.pointerId); });
  }
  setVol(Player.volume);

  /* ---------------- generic toggles ---------------- */
  // single-active groups
  $$('.rmx-ab').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('button', g).forEach((x) => x.classList.remove('active')); b.classList.add('active');
  }));
  $$('.loop-grid').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('.loop-cell'); if (!b) return;
    $$('.loop-cell', g).forEach((x) => x.classList.remove('on')); b.classList.add('on');
  }));
  $$('.seg').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('button', g).forEach((x) => x.classList.remove('active')); b.classList.add('active');
  }));
  // independent toggles (Shuffle/Repeat do transporte são modos do CORE —
  // ligados pelo playback.js aos endpoints /api/queue/shuffle e /repeat)
  $$('.mod-toggle, .tp-btn[aria-label="Loop"]').forEach((b) => {
    b.addEventListener('click', () => b.classList.toggle('on'));
  });

  /* ---------------- knob drag ---------------- */
  // value formatters per module title
  const KNOB = {
    Pitch:  { min: -12, max: 12, step: 1, fmt: (v) => `<span class="acc">${v > 0 ? '+' : ''}${v}</span><small>st</small>` },
    Tempo:  { min: 80, max: 160, step: 1, fmt: (v) => `${v}<small>bpm</small>` },
    Filtro: { min: 0.1, max: 18, step: 0.1, fmt: (v) => `${v.toFixed(1)}<small>kHz</small>` },
  };

  function moduleOf(knob) {
    const mod = knob.closest('.mod');
    return mod ? mod.querySelector('.mod-title')?.textContent.trim() : null;
  }

  function setKnob(knob, frac) {
    frac = Math.max(0, Math.min(1, frac));
    knob.dataset.frac = frac.toFixed(4);
    knob.style.setProperty('--frac', frac.toFixed(4));
    const ind = knob.querySelector('.knob-ind');
    if (ind) ind.style.transform = `rotate(${-135 + frac * 270}deg)`;
    const cfg = KNOB[moduleOf(knob)];
    const valEl = knob.closest('.mod')?.querySelector('.knob-val');
    if (cfg && valEl) {
      let v = cfg.min + frac * (cfg.max - cfg.min);
      v = cfg.step >= 1 ? Math.round(v) : Math.round(v / cfg.step) * cfg.step;
      valEl.innerHTML = cfg.fmt(v);
    }
    // notify the audio engine (single source of truth for frac)
    knob.dispatchEvent(new CustomEvent('rolfknob', { detail: { frac } }));
  }

  $$('.knob').forEach((knob) => {
    let dragging = false;
    const setFromY = (clientY) => {
      const r = knob.getBoundingClientRect();
      setKnob(knob, 1 - (clientY - r.top) / r.height);   // bottom = 0, top = 1
    };
    knob.addEventListener('pointerdown', (e) => {
      dragging = true; knob.setPointerCapture(e.pointerId);
      setFromY(e.clientY); e.preventDefault();
    });
    knob.addEventListener('pointermove', (e) => { if (dragging) setFromY(e.clientY); });
    knob.addEventListener('pointerup', (e) => { dragging = false; knob.releasePointerCapture(e.pointerId); });
    // double-click to reset to center
    knob.addEventListener('dblclick', () => setKnob(knob, 0.5));
  });

  /* fine steppers */
  $$('.stepper').forEach((st) => {
    const mod = st.closest('.mod');
    const knob = mod?.querySelector('.knob');
    const btns = $$('.step-btn', st);
    if (!knob) return;
    btns[0] && btns[0].addEventListener('click', () => setKnob(knob, parseFloat(knob.dataset.frac || 0.5) - 0.04));
    btns[1] && btns[1].addEventListener('click', () => setKnob(knob, parseFloat(knob.dataset.frac || 0.5) + 0.04));
  });

  /* reset button in remixer */
  $$('.btn-ghost').forEach((b) => {
    if (/reset/i.test(b.textContent)) b.addEventListener('click', () => {
      $$('.rmx .knob').forEach((k) => setKnob(k, 0.5));
      toast('Remixer', 'Reset');
    });
    if (/salvar/i.test(b.textContent)) b.addEventListener('click', () => toast('Versão salva no cofre', '✓'));
  });

  /* playlists handled by playlists.js */

  /* ---------------- busca avançada ----------------
     Real search lives in search-engine.js. Expose the transport
     loader + track parser so it can play results. */
  window.RolfLoadTransport = loadTransport;
  window.RolfTrackData = trackData;

  /* ---------------- contratos p/ playback.js (bridge → core) ----------
     Renderizadores visuais puros — o bridge chama estes hooks quando o
     estado REAL do core chega pelo poll de /api/status. */
  window.RolfShowTrack = showTrack;
  window.RolfSetPlaying = setPlaying;
  window.RolfSetVol = setVol;
  window.RolfSetDuration = setDuration;

  /* ---------------- capturar / rip ---------------- */
  // source segmented
  $$('.src-seg').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('button', g).forEach((x) => x.classList.remove('active')); b.classList.add('active');
    toast(b.textContent.trim(), 'Fonte');
  }));
  // record toggle
  const recBtn = $('[data-rec]');
  if (recBtn) recBtn.addEventListener('click', () => {
    const on = recBtn.classList.toggle('recording');
    recBtn.lastChild.textContent = on ? 'Gravando' : 'Iniciar captura';
    toast(on ? 'Captura iniciada' : 'Captura pausada', on ? 'REC' : '·');
  });
  // auto-split toggle
  const splitBtn = $('[data-autosplit]');
  if (splitBtn) splitBtn.addEventListener('click', () => splitBtn.classList.toggle('on'));
  // save to vault
  const capSave = $('.cap-save');
  if (capSave) capSave.addEventListener('click', () => toast('3 faixas salvas no cofre', 'Cofre'));
  // detected track selection
  $$('.cap-trk').forEach((t) => t.addEventListener('click', () => {
    $$('.cap-trk').forEach((x) => x.classList.remove('live')); t.classList.add('live');
  }));

  /* ---------------- configurações / conta ---------------- */
  // switches
  $$('.cfg [data-sw]').forEach((sw) => sw.addEventListener('click', () => {
    sw.classList.toggle('on');
    // "movimento reduzido" mirrors the label
    const label = sw.closest('.cfg-row')?.querySelector('.cfg-row-label')?.textContent || '';
    if (/movimento reduzido/i.test(label)) {
      document.body.classList.toggle('reduce-motion', sw.classList.contains('on'));
    }
  }));
  // segmented single-select
  $$('.cfg [data-cfg-seg]').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('button', g).forEach((x) => x.classList.remove('active')); b.classList.add('active');
    // density seg → respace the fullscreen dot field
    const label = g.closest('.cfg-row')?.querySelector('.cfg-row-label')?.textContent || '';
    if (/densidade/i.test(label)) {
      const gap = { 'Denso': 18, 'Médio': 24, 'Amplo': 32 }[b.textContent.trim()] || 24;
      const vd = $('.viz-dots'); if (vd) vd.dataset.gap = gap;
    }
  }));
  // accent mode swatches
  $$('[data-cfg-accent] .cfg-swatch').forEach((sw) => sw.addEventListener('click', () => {
    $$('[data-cfg-accent] .cfg-swatch').forEach((x) => x.classList.remove('on'));
    sw.classList.add('on');
    const val = sw.dataset.accent;
    if (val === 'album') {
      accentMode = 'album';
      if (lastTrack) applyAccent(lastTrack.bg);   // re-derive from now-playing
      else { const c = tp.cover && tp.cover.style.background; if (c) { accentMode = 'album'; applyAccent(c); } }
      toast('Acento reativo à capa', 'Álbum');
    } else {
      accentMode = val;
      setAccentColor(val);
      toast('Acento fixo', val.toUpperCase());
    }
  }));
  // account links
  $$('.cfg .cfg-link').forEach((b) => b.addEventListener('click', () => {
    toast(b.textContent.trim(), /sair/i.test(b.textContent) ? 'Conta' : '·');
  }));

  /* ---------------- toast ---------------- */
  let toastEl;
  function toast(text, kicker) {
    let wrap = $('.toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
    if (toastEl) toastEl.remove();
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.innerHTML =
      `<span class="ti"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/></svg></span>` +
      `<span>${text || ''}</span>` + (kicker ? `<span class="tk">${kicker}</span>` : '');
    wrap.appendChild(toastEl);
    requestAnimationFrame(() => toastEl.classList.add('show'));
    const el = toastEl;
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 240); }, 1900);
  }
  // allow other modules to raise a toast
  document.addEventListener('rolf:toast', (e) => toast(e.detail && e.detail.text, e.detail && e.detail.kicker));
})();
