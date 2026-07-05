/* ============================================================
   ROLFSOUND V2 — Acervo: filter · group · sort engine
   Operates on the existing ledger rows (never re-creates them,
   so click/context handlers bound elsewhere stay intact). It
   filters by format/state/favorite/search, sorts by a chosen
   field, and groups into collapsible crate / key / format
   sections with live counts.
   ============================================================ */
(function () {
  'use strict';

  const scope = document.querySelector('.screen[data-screen="acervo"]');
  if (!scope) return;
  const scroll = scope.querySelector('.ledger-scroll');
  const tblHead = scroll.querySelector('.tbl-head');
  const rows = [...scroll.querySelectorAll('.row')];

  // empty-state element
  const empty = document.createElement('div');
  empty.className = 'acv-empty';
  empty.innerHTML =
    '<span class="ae-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M16 16l4 4M8 11h6"/></svg></span>' +
    '<div class="ae-title">Nenhuma faixa</div>' +
    '<div class="ae-sub">Ajuste os filtros</div>';
  scroll.appendChild(empty);

  // album/artist grids (siblings of the ledger, toggled via [data-mode] on scope)
  const albumsGrid  = scope.querySelector('[data-acv-albums-grid]');
  const albumsWrap  = scope.querySelector('[data-acv-albums-wrap]');
  const artistsGrid = scope.querySelector('[data-acv-artists-grid]');
  const artistsWrap = scope.querySelector('[data-acv-artists-wrap]');
  const modeSeg     = scope.querySelector('[data-acv-mode]');

  function emptyCard(title) {
    const el = document.createElement('div');
    el.className = 'acv-empty';
    el.innerHTML =
      '<span class="ae-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M16 16l4 4M8 11h6"/></svg></span>' +
      '<div class="ae-title">' + title + '</div>' +
      '<div class="ae-sub">Ajuste os filtros</div>';
    return el;
  }
  const emptyAlbums  = emptyCard('Nenhum álbum');
  const emptyArtists = emptyCard('Nenhum artista');
  if (albumsWrap)  albumsWrap.appendChild(emptyAlbums);
  if (artistsWrap) artistsWrap.appendChild(emptyArtists);

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  function rowMeta(r) {
    const d = r.dataset;
    const def = { album: 'Sem álbum', year: '' };
    return {
      artist:  d.artist || r.querySelector('.row-artist')?.textContent.trim() || 'Rolf',
      album:   d.album  || def.album,
      // agrupa por album_id (singles distintos não fundem, mesmo nomeados "Single")
      albumId: d.albumId || (d.album || def.album),
      year:    d.year   || def.year,
      bg:      r.querySelector('.row-cover')?.style.background || '',
    };
  }
  const ALL_ALBUMS  = new Set(rows.map((r) => rowMeta(r).albumId)).size;
  const ALL_ARTISTS = new Set(rows.map((r) => rowMeta(r).artist)).size;

  const state = {
    fmt: new Set(), st: new Set(), fav: false, q: '',
    group: 'flat', sortKey: 'added', dir: -1, mode: 'tracks',
  };
  const collapsed = new Set();

  const SORT_LABEL = { added: 'Adicionada', bpm: 'BPM', key: 'Tom', title: 'Título', dur: 'Duração' };
  const FMT_LABEL = { vinil: 'Vinil', cd: 'CD', digital: 'Digital' };
  const FMT_SVG = {
    vinil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/></svg>',
    cd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><path d="M12 3a9 9 0 0 1 6.4 2.6"/></svg>',
    digital: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 16V8l5-2v8"/><circle cx="5" cy="16" r="2"/><path d="M14 14V6l5-2v8"/><circle cx="14" cy="14" r="2"/></svg>',
  };

  function matches(r) {
    const d = r.dataset;
    if (state.fmt.size && !state.fmt.has(d.fmt)) return false;
    if (state.st.size && !state.st.has(d.state)) return false;
    if (state.fav && d.fav !== '1') return false;
    if (state.q) {
      const m = rowMeta(r);
      const hay = (d.title + ' ' + d.key + ' ' + d.tags + ' ' + m.artist + ' ' + m.album).toLowerCase();
      if (!hay.includes(state.q)) return false;
    }
    return true;
  }

  function setCrumb(label, count, word) {
    const crumb = scope.querySelector('.top-crumb');
    if (crumb) crumb.innerHTML = 'Biblioteca <span class="c-dot"></span> ' + label + ' <span class="c-dot"></span> ' + count + ' ' + word;
  }
  function setCount(n, total, singular, plural) {
    const countEl = scope.querySelector('[data-acv-count]');
    const totalEl = countEl && countEl.parentElement;
    if (totalEl) totalEl.innerHTML = '<b data-acv-count>' + n + '</b> de ' + total + ' ' + (total === 1 ? singular : plural);
  }

  /* ---------- group by album / artist → cards ---------- */
  function groupBy(field) {
    const map = new Map();
    rows.filter(matches).forEach((r) => {
      const m = rowMeta(r);
      // key = identidade (album_id p/ álbuns); name = rótulo exibido
      const key = field === 'album' ? m.albumId : m.artist;
      const name = field === 'album' ? m.album : m.artist;
      if (!map.has(key)) map.set(key, { key, name, artist: m.artist, year: m.year, rows: [] });
      map.get(key).rows.push(r);
    });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  function collageCells(list) {
    const cells = [];
    for (let i = 0; i < 4; i++) {
      const bg = list[i] ? (list[i].querySelector('.row-cover')?.style.background || '') : 'linear-gradient(150deg,#1a1a1e,#0c0c0f)';
      // single-quoted: .style.background re-serializes url() with double
      // quotes, which would otherwise close this attribute early.
      cells.push("<span style='background:" + bg + "'></span>");
    }
    return cells.join('');
  }
  function wireCards(grid, groups, action) {
    grid.querySelectorAll('.acv-card').forEach((card) => {
      const g = groups.find((x) => x.key === card.dataset.key);
      if (!g) return;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.acv-card-play')) { e.stopPropagation(); g.rows[0] && g.rows[0].click(); return; }
        document.dispatchEvent(new CustomEvent('rolf:ctx', { detail: { action, row: g.rows[0] } }));
      });
    });
  }

  function renderAlbums() {
    if (!albumsGrid) return;
    const groups = groupBy('album');
    albumsWrap.classList.toggle('is-empty', groups.length === 0);
    albumsGrid.innerHTML = groups.map((g) => {
      const n = g.rows.length;
      return '<div class="acv-card" data-key="' + esc(g.key) + '">' +
        '<div class="acv-card-art"><div class="collage">' + collageCells(g.rows) + '</div>' +
        '<div class="acv-card-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4 18.6 12 8 18.6z"/></svg></div></div>' +
        '<div class="acv-card-name">' + esc(g.name) + '</div>' +
        '<div class="acv-card-meta">' + esc(g.artist) + ' · ' + esc(g.year) + ' · ' + n + (n === 1 ? ' faixa' : ' faixas') + '</div>' +
        '</div>';
    }).join('');
    wireCards(albumsGrid, groups, 'album');
    setCount(groups.length, ALL_ALBUMS, 'álbum', 'álbuns');
    setCrumb('Álbuns', ALL_ALBUMS, ALL_ALBUMS === 1 ? 'álbum no cofre' : 'álbuns no cofre');
  }

  function renderArtists() {
    if (!artistsGrid) return;
    const groups = groupBy('artist');
    artistsWrap.classList.toggle('is-empty', groups.length === 0);
    artistsGrid.innerHTML = groups.map((g) => {
      const n = g.rows.length;
      const albumsCount = new Set(g.rows.map((r) => rowMeta(r).albumId)).size;
      const bg = g.rows[0]?.querySelector('.row-cover')?.style.background || '';
      return '<div class="acv-card" data-key="' + esc(g.key) + '">' +
        "<div class=\"acv-card-art round\" style='background:" + bg + "'>" +
        '<div class="acv-card-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4 18.6 12 8 18.6z"/></svg></div></div>' +
        '<div class="acv-card-name">' + esc(g.name) + '</div>' +
        '<div class="acv-card-meta">' + albumsCount + (albumsCount === 1 ? ' álbum · ' : ' álbuns · ') + n + (n === 1 ? ' faixa' : ' faixas') + '</div>' +
        '</div>';
    }).join('');
    wireCards(artistsGrid, groups, 'artist');
    setCount(groups.length, ALL_ARTISTS, 'artista', 'artistas');
    setCrumb('Artistas', ALL_ARTISTS, ALL_ARTISTS === 1 ? 'artista no cofre' : 'artistas no cofre');
  }

  function cmp(a, b) {
    const k = state.sortKey, da = a.dataset, db = b.dataset;
    let r;
    if (k === 'bpm' || k === 'dur' || k === 'added') r = (+da[k]) - (+db[k]);
    else r = (da[k] || '').localeCompare(db[k] || '');
    if (r === 0) r = (+db.added || 0) - (+da.added || 0);
    return r * state.dir;
  }

  function groupKey(r) {
    if (state.group === 'fmt') return r.dataset.fmt;
    if (state.group === 'key') return r.dataset.key;
    return '';
  }

  function buildHead(key, list) {
    const bpms = list.map((r) => +r.dataset.bpm);
    const lo = Math.min(...bpms), hi = Math.max(...bpms);
    const range = lo === hi ? lo + ' BPM' : lo + '–' + hi + ' BPM';
    let id = '', name = '';
    if (state.group === 'fmt') { id = FMT_SVG[key] || ''; name = FMT_LABEL[key] || key; }
    else { id = ''; name = key; }

    const head = document.createElement('div');
    head.className = 'group-head' + (collapsed.has(key) ? ' collapsed' : '');
    head.dataset.key = key;
    head.innerHTML =
      (id ? '<span class="gh-id">' + id + '</span>' : '') +
      '<span class="gh-name">' + name + '</span>' +
      '<span class="gh-stats">' + range + '</span>' +
      '<span class="gh-rule"></span>' +
      '<span class="gh-count">' + list.length + (list.length === 1 ? ' faixa' : ' faixas') + '</span>' +
      '<svg class="gh-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    head.addEventListener('click', () => {
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      render();
    });
    return head;
  }

  function render() {
    if (state.mode === 'albums')  { renderAlbums(); return; }
    if (state.mode === 'artists') { renderArtists(); return; }
    renderTracks();
  }

  function renderTracks() {
    const visible = rows.filter(matches).sort(cmp);

    // detach heads + rows
    scroll.querySelectorAll('.group-head').forEach((h) => h.remove());
    rows.forEach((r) => { r.classList.remove('is-collapsed'); r.remove(); });

    if (state.group === 'flat') {
      visible.forEach((r) => scroll.appendChild(r));
    } else {
      const map = new Map();
      visible.forEach((r) => {
        const k = groupKey(r);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(r);
      });
      const keys = [...map.keys()].sort((a, b) => a.localeCompare(b));
      keys.forEach((k) => {
        const list = map.get(k);
        scroll.appendChild(buildHead(k, list));
        const hide = collapsed.has(k);
        list.forEach((r) => { if (hide) r.classList.add('is-collapsed'); scroll.appendChild(r); });
      });
    }

    // copy: vault truly empty vs. filters hiding everything
    empty.querySelector('.ae-title').textContent = rows.length ? 'Nenhuma faixa' : 'Cofre vazio';
    empty.querySelector('.ae-sub').textContent = rows.length ? 'Ajuste os filtros' : 'Capture ou importe faixas para começar';
    scroll.appendChild(empty);
    scroll.classList.toggle('is-empty', visible.length === 0);

    setCount(visible.length, rows.length, 'faixa', 'faixas');
    setCrumb('Faixas', rows.length, 'no cofre');
  }

  /* ---------- quick filters ---------- */
  const allChip = scope.querySelector('.chip-all');
  scope.querySelectorAll('.acv-quick .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const f = chip.dataset.filter;
      if (f === 'all') {
        state.fmt.clear(); state.st.clear(); state.fav = false;
      } else if (f === 'fav') {
        state.fav = !state.fav; chip.classList.toggle('on', state.fav);
      } else {
        const set = f === 'fmt' ? state.fmt : state.st;
        const v = chip.dataset.val;
        if (set.has(v)) set.delete(v); else set.add(v);
        chip.classList.toggle('on', set.has(v));
      }
      const anyActive = state.fmt.size || state.st.size || state.fav;
      if (f === 'all') {
        scope.querySelectorAll('.acv-quick .chip').forEach((c) => c.classList.toggle('on', c === allChip));
      } else if (allChip) {
        allChip.classList.toggle('on', !anyActive);
      }
      render();
    });
  });

  /* ---------- group-by ---------- */
  scope.querySelectorAll('[data-acv-group] button').forEach((b) => {
    b.addEventListener('click', () => {
      scope.querySelectorAll('[data-acv-group] button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.group = b.dataset.group;
      collapsed.clear();
      render();
    });
  });

  /* ---------- sort menu ---------- */
  const sortBtn = scope.querySelector('[data-acv-sortbtn]');
  const sortMenu = scope.querySelector('[data-acv-sortmenu]');
  const sortLabel = scope.querySelector('[data-acv-sortlabel]');
  function closeSort() { sortMenu.classList.remove('open'); }
  if (sortBtn) sortBtn.addEventListener('click', (e) => { e.stopPropagation(); sortMenu.classList.toggle('open'); });
  document.addEventListener('click', (e) => { if (!sortMenu.contains(e.target) && e.target !== sortBtn) closeSort(); });
  scope.querySelectorAll('[data-acv-sortmenu] .acv-menu-item').forEach((it) => {
    it.addEventListener('click', () => {
      const s = it.dataset.sort;
      if (s === 'dir') {
        state.dir *= -1;
        sortBtn.classList.toggle('desc', state.dir < 0);
      } else {
        state.sortKey = s;
        scope.querySelectorAll('[data-acv-sortmenu] .acv-menu-item').forEach((x) => {
          if (x.dataset.sort !== 'dir') x.classList.toggle('active', x === it);
        });
        if (sortLabel) sortLabel.textContent = SORT_LABEL[s];
        closeSort();
      }
      render();
    });
  });

  /* ---------- search ---------- */
  const search = scope.querySelector('[data-acv-search]');
  if (search) search.addEventListener('input', () => { state.q = search.value.trim().toLowerCase(); render(); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && scope.classList.contains('active')) {
      e.preventDefault(); search && search.focus();
    }
  });

  /* ---------- mode tabs (Faixas · Álbuns · Artistas) ---------- */
  if (modeSeg) {
    modeSeg.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        modeSeg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        state.mode = b.dataset.mode;
        scope.dataset.mode = state.mode;
        render();
      });
    });
  }

  /* ---------- view toggle (list / grid) ---------- */
  scope.querySelectorAll('[data-acv-view] button').forEach((b) => {
    b.addEventListener('click', () => {
      scope.querySelectorAll('[data-acv-view] button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      scroll.classList.toggle('as-grid', b.dataset.view === 'grid');
    });
  });

  render();
})();
