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
    // o acento pode ser fixo do álbum (editor) — resolvemos o album_id pela row
    // da faixa, então todo caminho de play (clique, reconciliação do core, fila)
    // respeita a cor salva sem precisar carregá-la em cada objeto `d`.
    const albumId = d.albumId
      || $$('.screen[data-screen="acervo"] .row').find((r) => r.dataset.id === d.id)?.dataset.albumId
      || '';
    applyAccent(d.bg, albumId);
    lastTrack = d;
    if (tp.cover) tp.cover.style.background = d.bg;
    if (tp.title) tp.title.textContent = d.title;
    // BPM/tom saíram daqui — agora vivem na telinha de pontinhos da topbar (topbar-now.js)
    if (tp.sub) tp.sub.textContent = d.artist || '';
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

  function wireRow(row) {
    row.addEventListener('click', () => loadTransport(row));
    // double-click: play it and jump to the live Remixer
    row.addEventListener('dblclick', () => { loadTransport(row); showScreen('remixer'); });
  }
  $$('.row').forEach(wireRow);
  // rows inseridas AO VIVO (download do Discovery concluído → acervo.js) não
  // passaram por este load; liga o clique/duplo-clique nelas quando chegam.
  document.addEventListener('rolf:row-added', (e) => {
    const row = e.detail && e.detail.row;
    if (row) wireRow(row);
  });

  /* ---------------- reactive accent + fullscreen visualizer ---------------- */
  let lastTrack = null;

  function hexToRgb(hex) {
    const m = /#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [200, 105, 60];
  }
  function toHex(r, g, b) {
    return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
  }

  // ---- colour-space helpers for adaptive accent derivation ----
  // The accent is used as text/glow over dark panels, so we can't hand the UI
  // whatever raw tone a cover averages to. We keep the cover's *hue* but let
  // the design system own chroma + lightness so the accent stays vivid and
  // legible. The work happens in OKLab/OKLCH (Björn Ottosson) rather than HSL:
  // lightness is perceptually uniform and hue holds steady as we lift lightness
  // for contrast — HSL would drift a blue toward purple while brightening it.
  // Used by dominantAccent()/normalizeAccent() below.
  function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function linearToSrgb(c) {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  }
  function rgbToOklch(r, g, b) {
    const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
    const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
    const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
    const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
    let h = Math.atan2(bb, a) * 180 / Math.PI; if (h < 0) h += 360;
    return [L, Math.hypot(a, bb), h];
  }
  function oklchToLinearRgb(L, C, h) {
    const hr = h * Math.PI / 180, a = C * Math.cos(hr), b = C * Math.sin(hr);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
  }
  // whether an OKLCH point survives the round-trip into displayable sRGB
  function inGamut([r, g, b]) { const e = 1e-3; return r >= -e && r <= 1 + e && g >= -e && g <= 1 + e && b >= -e && b <= 1 + e; }
  function oklchToRgb(L, C, h) { const t = oklchToLinearRgb(L, C, h); return [linearToSrgb(t[0]), linearToSrgb(t[1]), linearToSrgb(t[2])]; }
  // WCAG relative luminance + contrast ratio — used to hold the accent above a
  // legibility floor against the panel it sits on.
  function relLuminance(r, g, b) {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrast(l1, l2) { const a = Math.max(l1, l2), b = Math.min(l1, l2); return (a + 0.05) / (b + 0.05); }
  const PANEL_L = relLuminance(0x11, 0x11, 0x14);   // --panel #111114
  const DEFAULT_ACCENT = '#c8693c';                 // brand accent, used when a cover has no usable hue

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

  // Find the cover's *characteristic* hue with a chroma-weighted circular
  // histogram in OKLCH — a flat RGB average of a colourful image collapses to
  // grey mud, so instead each coloured pixel votes for its hue bin and the peak
  // wins. Returns [hue°, chroma] or null when the cover is essentially greyscale.
  function dominantAccent(data) {
    const BINS = 36;   // 10° per bin
    const hist = new Float32Array(BINS), chromaSum = new Float32Array(BINS);
    let coloredCount = 0, total = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 16) continue;   // skip near-transparent pixels
      total++;
      const [L, C, h] = rgbToOklch(data[i], data[i + 1], data[i + 2]);
      if (L < 0.20 || L > 0.95 || C < 0.04) continue;   // black/white/grey carry no hue
      coloredCount++;
      const w = C * Math.max(0, 1 - Math.abs(L - 0.6) * 1.5);   // favour chromatic, mid-light pixels
      if (w <= 0) continue;
      const bin = Math.min(BINS - 1, Math.floor(h / (360 / BINS)));
      hist[bin] += w; chromaSum[bin] += C * w;
    }
    if (!total || coloredCount < total * 0.02) return null;   // greyscale cover → no trustworthy hue
    let peak = 0;
    for (let i = 1; i < BINS; i++) if (hist[i] > hist[peak]) peak = i;
    let hx = 0, hy = 0, cAcc = 0, wsum = 0;               // refine across the peak's neighbours
    for (let d = -1; d <= 1; d++) {
      const b = (peak + d + BINS) % BINS, ang = (b + 0.5) * (360 / BINS) * Math.PI / 180;
      hx += Math.cos(ang) * hist[b]; hy += Math.sin(ang) * hist[b];
      cAcc += chromaSum[b]; wsum += hist[b];
    }
    let hue = Math.atan2(hy, hx) * 180 / Math.PI; if (hue < 0) hue += 360;
    return [hue, wsum ? cAcc / wsum : 0.13];
  }

  // Keep the cover's hue but pin chroma + lightness to a band the dark UI can
  // always show: vivid (never washed/neon) and above a contrast floor vs the
  // panel, raising perceptual lightness only as far as legibility needs. At
  // each lightness we pull chroma back into sRGB gamut before rendering.
  function normalizeAccent(hue, chroma) {
    const Cwant = Math.min(0.16, Math.max(0.09, chroma));
    let L = 0.64, best = oklchToRgb(L, Cwant, hue);
    while (L <= 0.86) {
      let C = Cwant;
      while (C > 0.02 && !inGamut(oklchToLinearRgb(L, C, hue))) C -= 0.005;
      best = oklchToRgb(L, C, hue);
      if (contrast(relLuminance(...best), PANEL_L) >= 4.0) break;
      L += 0.02;
    }
    return toHex(...best);
  }

  // Cor escolhida à mão no editor: respeitamos EXATAMENTE o tom pego (WYSIWYG)
  // quando ele já lê bem sobre os painéis escuros; só quando o pixel é escuro/
  // apagado demais (falha o piso de contraste) subimos a luz mantendo o mesmo
  // matiz, via a mesma máquina do acento automático. Assim o usuário vê o que
  // pegou, mas a UI nunca fica ilegível.
  function legibleAccent(hex) {
    const [r, g, b] = hexToRgb(hex);   // sempre um trio (cai no acento-marca se inválido)
    if (contrast(relLuminance(r, g, b), PANEL_L) >= 4.0) return toHex(r, g, b);
    const [, C, h] = rgbToOklch(r, g, b);
    return normalizeAccent(h, C);
  }

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
        const dom = dominantAccent(data);
        const hex = dom ? normalizeAccent(dom[0], dom[1]) : DEFAULT_ACCENT;
        accentCache.set(url, hex);
        onReady(hex);
      } catch (_) {
        // cross-origin cover without CORS headers taints the canvas — leave the accent as-is
      }
    };
    img.src = url;
  }

  // flood the whole UI with the accent pulled from the now-playing cover art —
  // a menos que o álbum da faixa tenha uma cor fixada no editor: aí ela manda
  // (passada pelo piso de legibilidade), sem amostrar a capa.
  function applyAccent(bg, albumId) {
    const saved = albumId && window.RolfAlbums && window.RolfAlbums[albumId]
      && window.RolfAlbums[albumId].accent;
    if (saved) {
      const [r, g, b] = hexToRgb(legibleAccent(saved));
      setAccentFromRgb(r, g, b);
      return;
    }
    const url = urlFromBg(bg);
    if (url) {
      sampleCoverColor(url, (hex) => {
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

  // Editor fixou/limpou a cor de um álbum: guarda no catálogo em memória e, se a
  // faixa tocando agora é desse álbum, troca o acento ao vivo (hex vazio = volta
  // a derivar da capa).
  function applyAlbumAccent(albumId, hex) {
    if (!albumId) return;
    if (window.RolfAlbums && window.RolfAlbums[albumId]) {
      window.RolfAlbums[albumId].accent = hex || '';
    }
    const active = $('.screen[data-screen="acervo"] .row.active');
    if (active && (active.dataset.albumId || '') === albumId) {
      applyAccent(active.querySelector('.row-cover')?.style.background || '', albumId);
    }
  }

  // superfície mínima p/ o editor (track-panels.js): prever a cor REAL que vai
  // renderizar (legible) e refletir a escolha ao vivo (applyAlbum).
  window.RolfAccent = { legible: legibleAccent, applyAlbum: applyAlbumAccent, DEFAULT: DEFAULT_ACCENT };

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

  // arrastar para reordenar → POST /api/queue/move (mutação otimista no
  // DOM; o poll re-renderiza do estado verdadeiro do core)
  if (queueList) {
    let dragEl = null;
    let dragFromAbs = -1;
    queueList.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.tpq-row');
      if (!row) return;
      dragEl = row;
      dragFromAbs = queueAbsIndex(row);
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    queueList.addEventListener('dragover', (e) => {
      if (!dragEl) return;
      e.preventDefault();
      const row = e.target.closest('.tpq-row');
      if (!row || row === dragEl) return;
      const r = row.getBoundingClientRect();
      const after = (e.clientY - r.top) / r.height > 0.5;
      queueList.insertBefore(dragEl, after ? row.nextSibling : row);
    });
    queueList.addEventListener('dragend', () => {
      if (!dragEl) return;
      const vis = $$('.tpq-row', queueList).indexOf(dragEl);
      const cur = window.RolfPlayback ? window.RolfPlayback.state.currentQueueIdx : -1;
      const toAbs = cur + 1 + Math.max(0, vis);
      dragEl.classList.remove('dragging');
      dragEl = null;
      renumberQueue();
      if (toAbs !== dragFromAbs && dragFromAbs >= 0 && window.RolfPlayback) {
        window.RolfPlayback.queueMove(dragFromAbs, toAbs);
        // qindex gravado ficou obsoleto até o próximo poll — o fallback
        // visual de queueAbsIndex() dá a posição certa nesse intervalo
        $$('.tpq-row', queueList).forEach((r) => { delete r.dataset.qindex; });
      }
      dragFromAbs = -1;
    });
  }

  const queueClear = $('[data-queue-clear]');
  if (queueClear) queueClear.addEventListener('click', () => {
    $$('.tpq-row', queueList).forEach((r, i) => { setTimeout(() => { r.style.opacity = '0'; setTimeout(() => r.remove(), 130); }, i * 30); });
    setTimeout(() => { renumberQueue(); toast('Fila esvaziada', 'Limpar'); }, 200);
    if (window.RolfPlayback) window.RolfPlayback.queueClear();
  });
  // salvar a fila atual como playlist (persistida no banco pelo servidor);
  // playlists.js escuta 'rolf:playlist-created' e insere no rail
  const queueSave = $('[data-queue-save]');
  if (queueSave) queueSave.addEventListener('click', async () => {
    const rows = $$('.tpq-row', queueList);
    if (!rows.length) { toast('Fila vazia', 'Salvar'); return; }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `Fila ${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    try {
      const res = await fetch('/api/queue/save-as-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const p = await res.json();
      document.dispatchEvent(new CustomEvent('rolf:playlist-created', {
        detail: { id: 'p' + p.id, name: p.name },
      }));
      toast(p.name, 'Playlist salva');
    } catch (err) {
      console.error('save queue as playlist failed:', err);
      toast('Servidor indisponível', 'Salvar');
    }
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
    row.draggable = true;
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
    // otimista: já reflete na row, persiste em paralelo
    const id = row.dataset.id;
    if (id) {
      fetch(`api/library/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fav: on }),
      }).catch((e) => console.error('save fav failed:', e));
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
      case 'export':  break;  // handled by export-dialog.js
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
  // .pad-grid fica de fora: os pads de sample têm dono (remixer-live.js)
  $$('.loop-grid:not(.pad-grid)').forEach((g) => g.addEventListener('click', (e) => {
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
    // Filtro em escala LOG (20 Hz–20 kHz): v é log2(Hz) — o knob percorre
    // oitavas, não Hz lineares (o miolo musical fica utilizável). O fmt
    // converte de volta. remixer-live.js usa o MESMO mapeamento no POST /fx.
    Filtro: {
      min: Math.log2(20), max: Math.log2(20000), step: 0.01,
      fmt: (v) => {
        const hz = Math.pow(2, v);
        return hz >= 1000 ? `${(hz / 1000).toFixed(1)}<small>kHz</small>` : `${Math.round(hz)}<small>Hz</small>`;
      },
    },
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

  /* ---------------- configurações / conta ----------------
     Aparência: os APLICADORES vivem aqui e ficam expostos em
     window.RolfAppearance — o config.js os chama no boot para
     reaplicar a escolha salva em /api/settings. A cor de acento não
     tem aplicador: é SEMPRE derivada da capa tocando (applyAccent). */
  function applyVizDensity(token) {
    const gap = { dense: 18, medium: 24, wide: 32 }[token] || 24;
    const vd = $('.viz-dots'); if (vd) vd.dataset.gap = gap;
  }
  function applyReduceMotion(on) {
    document.body.classList.toggle('reduce-motion', !!on);
  }
  window.RolfAppearance = {
    density: applyVizDensity,
    reduceMotion: applyReduceMotion,
  };

  // switches (persistência: config.js, via data-cfg-key)
  $$('.cfg [data-sw]').forEach((sw) => sw.addEventListener('click', () => {
    sw.classList.toggle('on');
    if (sw.dataset.cfgKey === 'ui_reduce_motion') applyReduceMotion(sw.classList.contains('on'));
  }));
  // segmented single-select
  $$('.cfg [data-cfg-seg]').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('button', g).forEach((x) => x.classList.remove('active')); b.classList.add('active');
    if (g.dataset.cfgKey === 'ui_viz_density') applyVizDensity(b.dataset.val);
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
