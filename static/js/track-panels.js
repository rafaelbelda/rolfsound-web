/* ============================================================
   ROLFSOUND V2 — Track panels (editor / album / artist)
   Renders into the morphing dock drawer. Coordinates with the
   queue so only one drawer is open at a time. Album/year are
   derived per crate and become editable (stored on the row).
   ============================================================ */
(function () {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const dock   = $('[data-dock]');
  const panel  = $('[data-panel]');
  const inner  = $('[data-panel-inner]');
  if (!dock || !panel || !inner) return;

  function meta(row) {
    const coord = row.dataset.coord || (row.querySelector('.row-coord')?.textContent || '').replace(/\s+/g, ' ').trim();
    const crate = coord.split('·')[0];
    const def = { album: 'Sem álbum', year: '' };
    const tags = (row.dataset.tags || '').split(',').filter(Boolean);
    return {
      title:  row.dataset.title || row.querySelector('.row-title')?.textContent || 'Faixa',
      artist: row.dataset.artist || row.querySelector('.row-artist')?.textContent || 'Rolf',
      album:  row.dataset.album || def.album,
      year:   row.dataset.year || def.year,
      genre:  row.dataset.genre || (tags[0] ? tags[0][0].toUpperCase() + tags[0].slice(1) : ''),
      bpm:    row.dataset.bpm || row.querySelector('.row-data')?.textContent || '',
      key:    row.dataset.key || row.querySelector('.row-key')?.textContent || '',
      coord, crate,
      bg:     row.querySelector('.row-cover')?.style.background || '',
      dur:    row.querySelector('.row-dur')?.textContent || '',
    };
  }
  function effAlbum(row)  { const m = meta(row); return m.album; }
  function effArtist(row) { return meta(row).artist; }

  const esc = (s) => String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');

  /* ---------- catalogue lookups (for autocomplete + album views) ---------- */
  function acervoRows() { return $$('.screen[data-screen="acervo"] .row'); }
  function uniqueArtists() { return [...new Set(acervoRows().map((r) => meta(r).artist))].filter(Boolean).sort(); }
  function uniqueAlbums()  { return [...new Set(acervoRows().map((r) => meta(r).album))].filter(Boolean).sort(); }
  function albumsByArtist(artist) {
    const map = new Map();
    acervoRows().forEach((r) => {
      const mm = meta(r);
      if (mm.artist !== artist) return;
      if (!map.has(mm.album)) map.set(mm.album, { album: mm.album, year: mm.year, bg: mm.bg, count: 0, coord: mm.coord });
      map.get(mm.album).count++;
    });
    return [...map.values()];
  }

  /* ---------- lightweight autocomplete (artists / albums only) ---------- */
  function attachAutocomplete(input, getOptions) {
    if (!input) return;
    const wrap = input.closest('.tpp-field');
    if (wrap) wrap.classList.add('has-ac');
    let menuEl = null;
    function close() { if (menuEl) { menuEl.remove(); menuEl = null; } }
    function open() {
      close();
      const q = input.value.trim().toLowerCase();
      const opts = getOptions()
        .filter((o) => o && o.toLowerCase().includes(q) && o.toLowerCase() !== q)
        .slice(0, 6);
      if (!opts.length) return;
      menuEl = document.createElement('div');
      menuEl.className = 'tpp-ac';
      opts.forEach((o) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'tpp-ac-item';
        b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>' + esc(o);
        b.addEventListener('mousedown', (ev) => { ev.preventDefault(); input.value = o; close(); input.dispatchEvent(new Event('input', { bubbles: true })); });
        menuEl.appendChild(b);
      });
      (wrap || input.parentElement).appendChild(menuEl);
    }
    input.addEventListener('input', open);
    input.addEventListener('focus', open);
    input.addEventListener('blur', () => setTimeout(close, 130));
  }

  /* ---------- drawer plumbing ---------- */
  function openDrawer(tall) {
    dock.classList.add('panel-open');
    dock.classList.toggle('panel-tall', !!tall);
    dock.classList.remove('queue-open');
    const qb = $('[data-queue-open]'); if (qb) qb.classList.remove('is-on');
    const q = $('[data-queue]'); if (q) q.setAttribute('aria-hidden', 'true');
    panel.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    dock.classList.remove('panel-open');
    panel.setAttribute('aria-hidden', 'true');
  }
  // opening the queue closes this panel
  const queueBtn = $('[data-queue-open]');
  if (queueBtn) queueBtn.addEventListener('click', () => dock.classList.remove('panel-open'));

  function wireClose() {
    const c = $('[data-panel-close]', inner);
    if (c) c.addEventListener('click', closeDrawer);
  }
  function playByCoord(coord) {
    const row = $(`.screen[data-screen="acervo"] .row[data-coord="${coord}"]`);
    if (row) row.click();
  }

  /* ---------- editor ---------- */
  function openEditor(row) {
    const m = meta(row);
    inner.innerHTML =
      `<div class="tpp-head">
        <div><div class="tpp-kicker">Editar informações</div><div class="tpp-h-title">${esc(m.title)}</div></div>
        <div class="tpp-spacer"></div>
        <button class="tpp-btn" data-panel-close>Cancelar</button>
        <button class="tpp-btn accent" data-edit-save><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-11"/></svg>Salvar</button>
      </div>
      <div class="tpp-editor">
        <div class="tpp-edit-cover">
          <div class="tpp-edit-art" style="background:${m.bg}">
            <div class="repl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M8 9l4-4 4 4"/><path d="M5 19h14"/></svg>Trocar capa</div>
          </div>
          <div class="tpp-edit-coord">${esc(m.coord)}</div>
        </div>
        <div class="tpp-fields">
          <div class="tpp-field col2"><span class="tpp-label">Título da faixa</span><input class="tpp-input" data-f="title" value="${esc(m.title)}"></div>
          <div class="tpp-field"><span class="tpp-label">Artista</span><input class="tpp-input" data-f="artist" value="${esc(m.artist)}"></div>
          <div class="tpp-field"><span class="tpp-label">Álbum</span><input class="tpp-input" data-f="album" value="${esc(m.album)}"></div>
          <div class="tpp-field"><span class="tpp-label">Ano de lançamento</span><input class="tpp-input mono" data-f="year" value="${esc(m.year)}"></div>
          <div class="tpp-field"><span class="tpp-label">Gênero</span><input class="tpp-input" data-f="genre" value="${esc(m.genre)}"></div>
          <div class="tpp-field"><span class="tpp-label">BPM</span><input class="tpp-input mono" data-f="bpm" value="${esc(m.bpm)}"></div>
          <div class="tpp-field"><span class="tpp-label">Tom</span><input class="tpp-input mono" data-f="key" value="${esc(m.key)}"></div>
          <div class="tpp-field col2"><span class="tpp-label">Coordenada no cofre</span><input class="tpp-input mono" data-f="coord" value="${esc(m.coord)}"></div>
        </div>
      </div>`;
    wireClose();
    const save = $('[data-edit-save]', inner);
    if (save) save.addEventListener('click', () => {
      const get = (f) => $(`[data-f="${f}"]`, inner)?.value.trim() || '';
      const v = { title: get('title'), artist: get('artist'), album: get('album'), year: get('year'), genre: get('genre'), bpm: get('bpm'), key: get('key'), coord: get('coord') };
      // write back to the row
      row.dataset.title = v.title; row.dataset.artist = v.artist;
      row.dataset.album = v.album; row.dataset.year = v.year; row.dataset.genre = v.genre;
      row.dataset.bpm = v.bpm; row.dataset.key = v.key;
      const t = row.querySelector('.row-title'); if (t) t.textContent = v.title;
      const a = row.querySelector('.row-artist'); if (a) a.textContent = v.artist;
      const b = row.querySelector('.row-data'); if (b) b.textContent = v.bpm;
      const k = row.querySelector('.row-key'); if (k) k.textContent = v.key;
      closeDrawer();
      document.dispatchEvent(new CustomEvent('rolf:toast', { detail: { text: v.title, kicker: 'Salvo' } }));
    });
    // autocomplete on artist + album (never on track title)
    attachAutocomplete($('[data-f="artist"]', inner), uniqueArtists);
    attachAutocomplete($('[data-f="album"]', inner), uniqueAlbums);
    openDrawer();
  }

  /* ---------- album / artist track list ---------- */
  function trackRow(m, i, playingCoord) {
    return `<div class="tpp-trk${m.coord === playingCoord ? ' playing' : ''}" data-coord="${esc(m.coord)}">
      <span class="tpp-trk-idx">${i + 1}</span>
      <span class="row-cover cover" style="background:${m.bg}"></span>
      <span class="tpp-trk-name">${esc(m.title)}</span>
      <span class="tpp-trk-data">${esc(m.bpm)}</span>
      <span class="tpp-trk-key">${esc(m.key)}</span>
      <span class="tpp-trk-dur">${esc(m.dur)}</span>
    </div>`;
  }

  function openAlbum(row) {
    const m = meta(row);
    const playingCoord = document.querySelector('.row.active')?.dataset.coord || '';
    const tracks = $$('.screen[data-screen="acervo"] .row')
      .filter((r) => effAlbum(r) === m.album)
      .map(meta);
    const yrs = [...new Set(tracks.map((t) => t.year))].sort();
    inner.innerHTML =
      `<div class="tpp-head">
        <div class="tpp-kicker">Álbum</div><div class="tpp-spacer"></div>
        <button class="tpp-close" data-panel-close aria-label="Fechar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></button>
      </div>
      <div class="tpp-hero">
        <span class="tpp-hero-art" style="background:${m.bg}"></span>
        <div class="tpp-hero-info">
          <div class="tpp-hero-name">${esc(m.album)}</div>
          <div class="tpp-hero-meta"><span>${esc(m.artist)}</span><span class="d"></span><span>${yrs.join('–')}</span><span class="d"></span><span>${tracks.length} ${tracks.length === 1 ? 'faixa' : 'faixas'}</span><span class="d"></span><span>${esc(m.crate)}</span></div>
        </div>
        <div class="tpp-spacer"></div>
        <button class="tpp-btn accent" data-play-first><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4 18.6 12 8 18.6z"/></svg>Tocar álbum</button>
      </div>
      <div class="tpp-list">${tracks.map((t, i) => trackRow(t, i, playingCoord)).join('')}</div>`;
    wireClose();
    const pf = $('[data-play-first]', inner);
    if (pf && tracks[0]) pf.addEventListener('click', () => playByCoord(tracks[0].coord));
    $$('.tpp-trk', inner).forEach((t) => t.addEventListener('click', () => playByCoord(t.dataset.coord)));
    openDrawer(true);
  }

  function openAlbumByName(name) {
    const row = acervoRows().find((r) => meta(r).album === name);
    if (row) openAlbum(row);
  }

  function openArtist(row) {
    const m = meta(row);
    const playingCoord = document.querySelector('.row.active')?.dataset.coord || '';
    const tracks = acervoRows().filter((r) => effArtist(r) === m.artist).map(meta);
    const albums = albumsByArtist(m.artist);
    const albumCards = albums.map((a) =>
      `<button class="tpp-alb" data-album="${esc(a.album)}">
        <span class="tpp-alb-art" style="background:${a.bg}"></span>
        <span class="tpp-alb-name">${esc(a.album)}</span>
        <span class="tpp-alb-meta">${esc(a.year)} · ${a.count} ${a.count === 1 ? 'faixa' : 'faixas'}</span>
      </button>`).join('');
    inner.innerHTML =
      `<div class="tpp-head">
        <div class="tpp-kicker">Artista</div><div class="tpp-spacer"></div>
        <button class="tpp-close" data-panel-close aria-label="Fechar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></button>
      </div>
      <div class="tpp-hero">
        <span class="tpp-hero-art round" style="background:${m.bg}"></span>
        <div class="tpp-hero-info">
          <div class="tpp-hero-name">${esc(m.artist)}</div>
          <div class="tpp-hero-meta"><span>${tracks.length} ${tracks.length === 1 ? 'faixa' : 'faixas'}</span><span class="d"></span><span>${albums.length} ${albums.length === 1 ? 'álbum' : 'álbuns'}</span><span class="d"></span><span>No cofre</span></div>
        </div>
        <div class="tpp-spacer"></div>
        <button class="tpp-btn accent" data-play-first><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4 18.6 12 8 18.6z"/></svg>Tocar tudo</button>
      </div>
      <div class="tpp-scroll">
        <div class="tpp-section">Álbuns</div>
        <div class="tpp-albums">${albumCards}</div>
        <div class="tpp-section">Faixas</div>
        <div class="tpp-tracks">${tracks.map((t, i) => trackRow(t, i, playingCoord)).join('')}</div>
      </div>`;
    wireClose();
    const pf = $('[data-play-first]', inner);
    if (pf && tracks[0]) pf.addEventListener('click', () => playByCoord(tracks[0].coord));
    $$('.tpp-trk', inner).forEach((t) => t.addEventListener('click', () => playByCoord(t.dataset.coord)));
    $$('.tpp-alb', inner).forEach((a) => a.addEventListener('click', () => openAlbumByName(a.dataset.album)));
    openDrawer(true);
  }

  /* ---------- listen for context-menu actions ---------- */
  document.addEventListener('rolf:ctx', (e) => {
    const { action, row } = e.detail;
    if (!row) return;
    if (action === 'edit')   openEditor(row);
    if (action === 'album')  openAlbum(row);
    if (action === 'artist') openArtist(row);
  });

  // double-click a ledger title cell could also edit — keep it discoverable via Esc to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dock.classList.contains('panel-open')) closeDrawer();
  });
  // click outside the expanded dock minimizes the panel (ignore the context menu that opens it)
  document.addEventListener('pointerdown', (e) => {
    if (!dock.classList.contains('panel-open')) return;
    if (e.target.closest('.tp-dock') || e.target.closest('.ctx')) return;
    closeDrawer();
  });
})();
