/* ============================================================
   ROLFSOUND V2 — Playlists (data-driven)
   Real playlist system: collections hold ordered track ids
   into the Acervo. Create, rename, reorder (drag), remove,
   play/shuffle, and add tracks from the context menu. Persists
   to localStorage so the library survives reloads.
   ============================================================ */
(function () {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const rail    = $('[data-pl-rail]');
  const detail  = $('[data-pl-detail]');
  const summary = $('[data-pl-summary]');
  if (!rail || !detail) return;

  /* ---------- track pool from the Acervo ---------- */
  function row(id) { return $(`.screen[data-screen="acervo"] .row[data-id="${id}"]`); }
  function meta(id) {
    const r = row(id);
    if (!r) return null;
    return {
      id,
      title:  r.dataset.title || r.querySelector('.row-title')?.textContent || 'Faixa',
      artist: r.dataset.artist || r.querySelector('.row-artist')?.textContent || '',
      bpm:    +(r.dataset.bpm || r.querySelector('.row-data')?.textContent || 0),
      key:    r.dataset.key || r.querySelector('.row-key')?.textContent || '',
      bg:     r.querySelector('.row-cover')?.style.background || '',
      durSec: +(r.dataset.dur || 0),
      dur:    r.querySelector('.row-dur')?.textContent || '',
    };
  }

  /* ---------- model (seeded from RolfsoundData, persisted em localStorage) ---------- */
  const DEFAULTS = (window.RolfsoundData && Array.isArray(window.RolfsoundData.playlists))
    ? window.RolfsoundData.playlists
    : [];
  const norm = (p) => ({ ...p, tracks: [...(p.tracks || [])] });
  let playlists, selectedId, seq = 100;
  try {
    const saved = JSON.parse(localStorage.getItem('rolf_playlists_v2') || 'null');
    playlists = (saved && Array.isArray(saved.lists)) ? saved.lists.map(norm) : DEFAULTS.map(norm);
    seq = saved && saved.seq ? saved.seq : 100;
  } catch (_) { playlists = DEFAULTS.map(norm); }
  selectedId = playlists[0] && playlists[0].id;

  function save() { try { localStorage.setItem('rolf_playlists_v2', JSON.stringify({ lists: playlists, seq })); } catch (_) {} }
  function byId(id) { return playlists.find((p) => p.id === id); }
  function tracksOf(p) { return p.tracks.map(meta).filter(Boolean); }

  function fmtTotal(sec) {
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  }
  function statLine(p) {
    const ts = tracksOf(p);
    const n = ts.length;
    const total = ts.reduce((a, t) => a + t.durSec, 0);
    return `${n} ${n === 1 ? 'faixa' : 'faixas'} · ${fmtTotal(total)}`;
  }

  /* ---------- collage from first covers ---------- */
  function collage(p, cls) {
    const ts = tracksOf(p);
    const cells = [];
    for (let i = 0; i < 4; i++) {
      const bg = ts[i] ? ts[i].bg : 'linear-gradient(150deg,#1a1a1e,#0c0c0f)';
      // single-quoted: .style.background re-serializes url() with double
      // quotes, which would otherwise close this attribute early.
      cells.push(`<span style='background:${bg}'></span>`);
    }
    return `<div class="collage${cls ? ' ' + cls : ''}">${cells.join('')}</div>`;
  }

  /* ---------- render rail ---------- */
  function renderRail() {
    const cards = playlists.map((p) => {
      const ts = tracksOf(p);
      return `<div class="pl-card${p.id === selectedId ? ' active' : ''}" data-id="${p.id}">
        ${collage(p)}
        <div class="pl-card-info"><div class="pl-card-name">${esc(p.name)}</div><div class="pl-card-meta">${statLine(p)}</div></div>
      </div>`;
    }).join('');
    rail.innerHTML = cards +
      `<button class="pl-card new" data-pl-new-card>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        <span>Nova playlist</span>
      </button>`;
    const totalTracks = playlists.reduce((a, p) => a + p.tracks.length, 0);
    if (summary) summary.textContent = `${playlists.length} ${playlists.length === 1 ? 'coleção' : 'coleções'} · ${totalTracks} faixas`;
    const crumb = $('.screen[data-screen="playlists"] .top-crumb');
    if (crumb) crumb.innerHTML = `Biblioteca <span class="c-dot"></span> Playlists <span class="c-dot"></span> ${playlists.length} ${playlists.length === 1 ? 'coleção' : 'coleções'}`;
    $$('.pl-card[data-id]', rail).forEach((c) => c.addEventListener('click', () => { selectedId = c.dataset.id; renderAll(); }));
    const nc = $('[data-pl-new-card]', rail);
    if (nc) nc.addEventListener('click', createPlaylist);
  }

  /* ---------- render detail ---------- */
  const esc = (s) => String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');

  function renderDetail() {
    const p = byId(selectedId);
    if (!p) { detail.innerHTML = ''; return; }
    const ts = tracksOf(p);
    const bpms = ts.map((t) => t.bpm).filter(Boolean);
    const keys = ts.map((t) => t.key).filter(Boolean);
    const bpmRange = bpms.length ? (Math.min(...bpms) === Math.max(...bpms) ? Math.min(...bpms) : Math.min(...bpms) + '–' + Math.max(...bpms)) + ' BPM' : '—';
    const keyRange = keys.length ? (keys[0] + (keys.length > 1 ? ' → ' + keys[keys.length - 1] : '')) : '—';
    const playingId = document.querySelector('.row.active')?.dataset.id || '';

    const rows = ts.length ? ts.map((t, i) =>
      `<div class="pl-row${t.id === playingId ? ' playing' : ''}" data-id="${esc(t.id)}" draggable="true">
        <span class="pl-drag" aria-label="Arrastar"><i></i><i></i><i></i></span>
        <span class="pl-idx">${String(i + 1).padStart(2, '0')}</span>
        <span class="row-cover cover" style='background:${t.bg}'></span>
        <div class="pl-main"><div class="pl-title">${esc(t.title)}</div><div class="pl-artist">${esc(t.artist)}</div></div>
        <span class="pl-data">${t.bpm || ''}</span>
        <span class="pl-key">${esc(t.key)}</span>
        <span class="pl-dur">${esc(t.dur)}</span>
        <button class="pl-x" aria-label="Remover da playlist"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>`).join('')
      : `<div class="pl-empty">
          <span class="pl-empty-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6M9 13h6M9 17h3"/></svg></span>
          <div class="pl-empty-title">Playlist vazia</div>
          <div class="pl-empty-sub">Botão direito numa faixa → Adicionar à playlist</div>
        </div>`;

    detail.innerHTML =
      `<div class="pl-hero">
        ${collage(p, 'pl-hero-collage')}
        <div class="pl-hero-info">
          <div class="pl-hero-eyebrow">Playlist · ${ts.length} ${ts.length === 1 ? 'faixa' : 'faixas'}</div>
          <div class="pl-hero-name" data-pl-name title="Clique para renomear">${esc(p.name)}</div>
          <div class="pl-hero-meta"><span>${statLine(p)}</span> <span class="d"></span> ${bpmRange} <span class="d"></span> ${esc(keyRange)}</div>
        </div>
        <div class="pl-hero-actions">
          <button class="pl-play" data-pl-play><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4 18.6 12 8 18.6z"/></svg>Tocar</button>
          <button class="pl-icon-btn" data-pl-shuffle aria-label="Embaralhar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3.2l9.6 10H20"/><path d="M17 4l3 3-3 3"/><path d="M4 17h3.2l2.6-2.7"/><path d="M14.2 9.7 16.8 7"/><path d="M17 14l3 3-3 3"/></svg></button>
          <button class="pl-icon-btn" data-pl-del aria-label="Excluir playlist"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/></svg></button>
        </div>
      </div>
      <div class="pl-tracks-head">
        <span></span><span>#</span><span></span><span>Faixa</span><span>BPM</span><span>Tom</span><span class="r">Dur</span><span></span>
      </div>
      <div class="pl-tracks scroll">${rows}</div>`;

    wireDetail(p);
  }

  function renderAll() { renderRail(); renderDetail(); save(); }

  /* ---------- detail wiring ---------- */
  function playById(id) { const r = row(id); if (r) r.click(); }

  function wireDetail(p) {
    // rename
    const nameEl = $('[data-pl-name]', detail);
    if (nameEl) nameEl.addEventListener('click', () => startRename(p, nameEl));
    // play / shuffle / delete
    const playBtn = $('[data-pl-play]', detail);
    if (playBtn) playBtn.addEventListener('click', () => { const t = tracksOf(p)[0]; if (t) playById(t.id); });
    const shBtn = $('[data-pl-shuffle]', detail);
    if (shBtn) shBtn.addEventListener('click', () => {
      for (let i = p.tracks.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p.tracks[i], p.tracks[j]] = [p.tracks[j], p.tracks[i]]; }
      renderAll();
      const t = tracksOf(p)[0]; if (t) playById(t.id);
      raise(p.name, 'Embaralhada');
    });
    const delBtn = $('[data-pl-del]', detail);
    if (delBtn) delBtn.addEventListener('click', () => deletePlaylist(p));

    // rows: play, remove, drag-reorder
    $$('.pl-row', detail).forEach((rowEl) => {
      rowEl.addEventListener('click', (e) => {
        if (e.target.closest('.pl-x') || e.target.closest('.pl-drag')) return;
        playById(rowEl.dataset.id);
        $$('.pl-row', detail).forEach((r) => r.classList.remove('playing'));
        rowEl.classList.add('playing');
      });
      const x = $('.pl-x', rowEl);
      if (x) x.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = p.tracks.indexOf(rowEl.dataset.id);
        if (idx > -1) p.tracks.splice(idx, 1);
        renderAll();
        raise('Faixa removida', p.name);
      });
    });
    enableDrag(p);
  }

  /* ---------- drag-to-reorder ---------- */
  function enableDrag(p) {
    let dragEl = null;
    $$('.pl-row', detail).forEach((rowEl) => {
      rowEl.addEventListener('dragstart', (e) => { dragEl = rowEl; rowEl.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      rowEl.addEventListener('dragend', () => {
        rowEl.classList.remove('dragging');
        $$('.pl-row.drag-over', detail).forEach((r) => r.classList.remove('drag-over'));
        // commit new order from DOM
        p.tracks = $$('.pl-row', detail).map((r) => r.dataset.id);
        renderAll();
      });
      rowEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragEl || dragEl === rowEl) return;
        const r = rowEl.getBoundingClientRect();
        const after = (e.clientY - r.top) / r.height > 0.5;
        rowEl.parentElement.insertBefore(dragEl, after ? rowEl.nextSibling : rowEl);
      });
    });
  }

  /* ---------- rename ---------- */
  function startRename(p, el) {
    el.setAttribute('contenteditable', 'true');
    el.classList.add('editing');
    const range = document.createRange(); range.selectNodeContents(el);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    el.focus();
    const finish = () => {
      el.removeAttribute('contenteditable'); el.classList.remove('editing');
      const name = el.textContent.trim() || 'Playlist';
      p.name = name; el.removeEventListener('blur', finish); el.removeEventListener('keydown', onKey);
      renderAll();
    };
    const onKey = (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); el.blur(); } };
    el.addEventListener('blur', finish);
    el.addEventListener('keydown', onKey);
  }

  /* ---------- create / delete ---------- */
  function createPlaylist() {
    const id = 'p' + (++seq);
    playlists.push({ id, name: 'Nova playlist', tracks: [] });
    selectedId = id;
    renderAll();
    raise('Nova playlist', '+');
    // jump into rename
    requestAnimationFrame(() => { const el = $('[data-pl-name]', detail); if (el) startRename(byId(id), el); });
  }
  function deletePlaylist(p) {
    const i = playlists.findIndex((x) => x.id === p.id);
    if (i > -1) playlists.splice(i, 1);
    selectedId = playlists.length ? playlists[Math.max(0, i - 1)].id : null;
    renderAll();
    raise(p.name, 'Excluída');
  }

  /* ---------- "Adicionar à playlist" picker (from context menu) ---------- */
  let picker = null;
  function openPicker(trackId) {
    closePicker();
    const t = meta(trackId);
    picker = document.createElement('div');
    picker.className = 'pl-picker-backdrop';
    picker.innerHTML =
      `<div class="pl-picker" role="dialog">
        <div class="pl-picker-head">
          <span class="row-cover cover" style='background:${t ? t.bg : ''}'></span>
          <div class="pl-picker-meta"><div class="pl-picker-title">${t ? esc(t.title) : 'Faixa'}</div><div class="pl-picker-sub">Adicionar à playlist</div></div>
          <button class="pl-picker-x" aria-label="Fechar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>
        <div class="pl-picker-list">
          ${playlists.map((p) => {
            const has = p.tracks.includes(trackId);
            return `<button class="pl-picker-item${has ? ' has' : ''}" data-id="${p.id}">
              ${collage(p)}
              <div class="pl-picker-info"><div class="pl-picker-n">${esc(p.name)}</div><div class="pl-picker-c">${statLine(p)}</div></div>
              <span class="pl-picker-tick">${has ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-11"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'}</span>
            </button>`;
          }).join('')}
        </div>
        <button class="pl-picker-new"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Criar nova playlist com esta faixa</button>
      </div>`;
    document.body.appendChild(picker);
    requestAnimationFrame(() => picker.classList.add('open'));
    picker.addEventListener('click', (e) => { if (e.target === picker) closePicker(); });
    $('.pl-picker-x', picker).addEventListener('click', closePicker);
    $$('.pl-picker-item', picker).forEach((it) => it.addEventListener('click', () => {
      const p = byId(it.dataset.id);
      const idx = p.tracks.indexOf(trackId);
      if (idx > -1) p.tracks.splice(idx, 1); else p.tracks.push(trackId);
      renderAll(); closePicker();
      raise(p.name, idx > -1 ? 'Removida' : 'Adicionada');
    }));
    $('.pl-picker-new', picker).addEventListener('click', () => {
      const id = 'p' + (++seq);
      playlists.push({ id, name: (t ? t.title : 'Playlist'), tracks: [trackId] });
      selectedId = id; renderAll(); closePicker();
      raise('Nova playlist', '+');
    });
  }
  function closePicker() { if (picker) { picker.remove(); picker = null; } }

  /* ---------- header buttons + context action ---------- */
  const newBtn = $('[data-pl-new]');
  if (newBtn) newBtn.addEventListener('click', createPlaylist);
  const sortBtn = $('[data-pl-sort]');
  if (sortBtn) sortBtn.addEventListener('click', () => {
    const p = byId(selectedId); if (!p) return;
    p.tracks.sort((a, b) => (meta(a)?.title || '').localeCompare(meta(b)?.title || ''));
    renderAll(); raise(p.name, 'Ordenada por título');
  });

  document.addEventListener('rolf:ctx', (e) => {
    const { action, row: r } = e.detail;
    if (action === 'playlist' && r && r.dataset.id) openPicker(r.dataset.id);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });

  function raise(text, kicker) { document.dispatchEvent(new CustomEvent('rolf:toast', { detail: { text, kicker } })); }

  renderAll();
})();
