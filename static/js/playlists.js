/* ============================================================
   ROLFSOUND V2 — Playlists (data-driven)
   Real playlist system: collections hold ordered track ids
   into the Acervo. Create, rename, reorder (drag), remove,
   play/shuffle, and add tracks from the context menu.

   Persistência: o banco é a fonte de verdade. O bootstrap
   (GET /api/bootstrap.js) semeia RolfsoundData.playlists com
   id 'p{id-do-banco}'; cada mutação da UI é otimista no modelo
   local e espelhada em /api/playlists/* (criar, renomear,
   excluir, adicionar/remover faixa, reordenar via PUT …/tracks).
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

  /* ---------- model (semeado do banco via bootstrap; mutações via API) ---------- */
  const DEFAULTS = (window.RolfsoundData && Array.isArray(window.RolfsoundData.playlists))
    ? window.RolfsoundData.playlists
    : [];
  const norm = (p) => ({ ...p, tracks: [...(p.tracks || [])] });
  let playlists = DEFAULTS.map(norm);
  let selectedId = playlists[0] && playlists[0].id;
  // chave legada: as playlists agora vivem no banco (ler daqui ressuscitaria
  // playlists excluídas no servidor)
  try { localStorage.removeItem('rolf_playlists_v2'); } catch (_) {}

  /* ---------- persistência no servidor ---------- */
  // id da UI 'p42' -> id 42 do banco (null = playlist só local, ex.: criada
  // com o servidor fora do ar — segue funcionando na sessão, sem persistir)
  const dbid = (id) => {
    const n = +String(id).replace(/^p/, '');
    return Number.isFinite(n) ? n : null;
  };
  async function apiCall(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(method + ' ' + path + ' -> HTTP ' + res.status);
    return res.json().catch(() => ({}));
  }
  // otimista: a UI já mudou; se o servidor falhar, avisa mas não desfaz
  function persist(method, path, body) {
    apiCall(method, path, body).catch((e) => {
      console.error('playlist persist failed:', e);
      raise('Servidor indisponível — mudança não salva', 'Playlists');
    });
  }
  function persistOrder(p) {
    const n = dbid(p.id);
    if (n != null) persist('PUT', `/api/playlists/${n}/tracks`, { track_ids: p.tracks });
  }
  function persistTrackToggle(p, trackId, removed) {
    const n = dbid(p.id);
    if (n == null) return;
    if (removed) persist('DELETE', `/api/playlists/${n}/tracks/${encodeURIComponent(trackId)}`);
    else persist('POST', `/api/playlists/${n}/tracks`, { track_id: trackId });
  }

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

  function renderAll() { renderRail(); renderDetail(); }

  /* ---------- detail wiring ---------- */
  function playById(id) { const r = row(id); if (r) r.click(); }

  // Tocar playlist = carregar a fila do core com a lista inteira e tocar
  // do início (a fila é persistida no servidor). Fallback: 1ª faixa.
  function playPlaylist(p) {
    const ids = tracksOf(p).map((t) => t.id);
    if (!ids.length) return;
    if (window.RolfPlayback && window.RolfPlayback.playList) {
      window.RolfPlayback.playList(ids);
      raise(p.name, 'Tocando');
      return;
    }
    playById(ids[0]);
  }

  function wireDetail(p) {
    // rename
    const nameEl = $('[data-pl-name]', detail);
    if (nameEl) nameEl.addEventListener('click', () => startRename(p, nameEl));
    // play / shuffle / delete
    const playBtn = $('[data-pl-play]', detail);
    if (playBtn) playBtn.addEventListener('click', () => playPlaylist(p));
    const shBtn = $('[data-pl-shuffle]', detail);
    if (shBtn) shBtn.addEventListener('click', () => {
      for (let i = p.tracks.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p.tracks[i], p.tracks[j]] = [p.tracks[j], p.tracks[i]]; }
      persistOrder(p);
      renderAll();
      playPlaylist(p);
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
        if (idx > -1) {
          p.tracks.splice(idx, 1);
          persistTrackToggle(p, rowEl.dataset.id, true);
        }
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
        persistOrder(p);
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
      if (name !== p.name) {
        const n = dbid(p.id);
        if (n != null) persist('PATCH', `/api/playlists/${n}`, { name });
      }
      p.name = name; el.removeEventListener('blur', finish); el.removeEventListener('keydown', onKey);
      renderAll();
    };
    const onKey = (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); el.blur(); } };
    el.addEventListener('blur', finish);
    el.addEventListener('keydown', onKey);
  }

  /* ---------- create / delete ---------- */
  // cria no servidor primeiro para nascer com o id do banco; se ele
  // estiver fora do ar, cria só na sessão (id 'local-…', não persiste)
  async function newPlaylist(name, tracks) {
    let id;
    try {
      const created = await apiCall('POST', '/api/playlists', { name });
      id = 'p' + created.id;
    } catch (e) {
      console.error('playlist create failed:', e);
      id = 'local-' + Date.now();
      raise('Servidor indisponível — playlist só nesta sessão', 'Playlists');
    }
    const p = { id, name, tracks: [...(tracks || [])] };
    playlists.push(p);
    if (p.tracks.length && dbid(id) != null) persistOrder(p);
    return p;
  }
  async function createPlaylist() {
    const p = await newPlaylist('Nova playlist', []);
    selectedId = p.id;
    renderAll();
    raise('Nova playlist', '+');
    // jump into rename
    requestAnimationFrame(() => { const el = $('[data-pl-name]', detail); if (el) startRename(byId(p.id), el); });
  }
  function deletePlaylist(p) {
    const i = playlists.findIndex((x) => x.id === p.id);
    if (i > -1) playlists.splice(i, 1);
    const n = dbid(p.id);
    if (n != null) persist('DELETE', `/api/playlists/${n}`);
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
      persistTrackToggle(p, trackId, idx > -1);
      renderAll(); closePicker();
      raise(p.name, idx > -1 ? 'Removida' : 'Adicionada');
    }));
    $('.pl-picker-new', picker).addEventListener('click', async () => {
      closePicker();
      const p = await newPlaylist((t ? t.title : 'Playlist'), [trackId]);
      selectedId = p.id; renderAll();
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
    persistOrder(p);
    renderAll(); raise(p.name, 'Ordenada por título');
  });

  // fila salva como playlist (botão "Salvar" no dock, prototype.js):
  // o servidor já criou — busca a lista de faixas dele e insere no rail
  document.addEventListener('rolf:playlist-created', async (e) => {
    const { id, name } = e.detail || {};
    if (!id || byId(id)) return;
    let tracks = [];
    const n = dbid(id);
    if (n != null) {
      try {
        const data = await apiCall('GET', `/api/playlists/${n}/tracks`);
        tracks = (data.tracks || []).map((r) => r.id).filter(Boolean);
      } catch (err) { console.error('fetch new playlist failed:', err); }
    }
    playlists.push({ id, name: name || 'Playlist', tracks });
    renderAll();
  });

  document.addEventListener('rolf:ctx', (e) => {
    const { action, row: r } = e.detail;
    if (action === 'playlist' && r && r.dataset.id) openPicker(r.dataset.id);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });

  function raise(text, kicker) { document.dispatchEvent(new CustomEvent('rolf:toast', { detail: { text, kicker } })); }

  renderAll();
})();
