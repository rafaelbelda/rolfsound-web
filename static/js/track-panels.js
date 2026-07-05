/* ============================================================
   ROLFSOUND V2 — Track panels (editor / album / artist)
   Renders into the morphing dock drawer. Coordinates with the
   queue so only one drawer is open at a time. Album/year come
   from the track data and become editable (stored on the row).
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
    const def = { album: 'Sem álbum', year: '' };
    const tags = (row.dataset.tags || '').split(/\s+/).filter(Boolean);
    return {
      id:     row.dataset.id || '',
      title:  row.dataset.title || row.querySelector('.row-title')?.textContent || 'Faixa',
      artist: row.dataset.artist || row.querySelector('.row-artist')?.textContent || '',
      album:  row.dataset.album || def.album,
      albumId: row.dataset.albumId || '',
      albumTotal: parseInt(row.dataset.albumTotal, 10) || 0,
      albumKind: row.dataset.albumKind || 'album',
      trackNo: parseInt(row.dataset.trackNo, 10) || 0,
      year:   row.dataset.year || def.year,
      genre:  row.dataset.genre || '',
      tags:   tags.join(' '),
      bpm:    row.dataset.bpm || row.querySelector('.row-data')?.textContent || '',
      key:    row.dataset.key || row.querySelector('.row-key')?.textContent || '',
      bg:     row.querySelector('.row-cover')?.style.background || '',
      dur:    row.querySelector('.row-dur')?.textContent || '',
    };
  }
  function effArtist(row) { return meta(row).artist; }

  const esc = (s) => String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
  // Fundo seguro dentro de style='…' (atributo de aspas simples). cover_css usa
  // aspas simples no url(); o background computado (.row-cover) usa aspas duplas.
  // Normalizando p/ aspas duplas, o valor convive com o atributo de aspas simples.
  const bgQuote = (v) => String(v == null ? '' : v).replace(/'/g, '"');

  /* ---------- catalogue lookups (for autocomplete + album views) ---------- */
  function acervoRows() { return $$('.screen[data-screen="acervo"] .row'); }
  // Álbum autoritativo (title/artist/year/genre/total/cover/kind) vem do
  // bootstrap (window.RolfAlbums), chaveado por album_id.
  function albumInfo(id) { return (window.RolfAlbums && window.RolfAlbums[id]) || null; }
  function uniqueArtists() { return [...new Set(acervoRows().map((r) => meta(r).artist))].filter(Boolean).sort(); }
  // Autocomplete de álbum sugere só álbuns "de verdade" (nunca "Single").
  function uniqueAlbums() {
    const cat = Object.values(window.RolfAlbums || {})
      .filter((a) => a && a.kind !== 'single' && a.title).map((a) => a.title);
    const rows = acervoRows().map(meta).filter((m) => m.albumKind !== 'single').map((m) => m.album);
    return [...new Set([...cat, ...rows])].filter((t) => t && t !== 'Single').sort();
  }
  // Álbuns de um artista, agrupados por album_id (singles distintos não fundem).
  function albumsByArtist(artist) {
    const map = new Map();
    acervoRows().forEach((r) => {
      const mm = meta(r);
      if (mm.artist !== artist) return;
      const id = mm.albumId || mm.album;
      if (!map.has(id)) {
        const info = albumInfo(mm.albumId);
        map.set(id, {
          id: mm.albumId,
          album: (info && info.title) || mm.album,
          year:  (info && info.year) || mm.year,
          bg:    (info && info.cover) || mm.bg,
          count: 0,
        });
      }
      map.get(id).count++;
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

  /* ---------- drawer plumbing ----------
     A altura do painel de álbum é sob medida: cresce só o necessário para
     caber as faixas sem rolar, e para de crescer quando esbarraria no topo
     do Acervo (aí a lista rola). Medidas casam com dashboard-panels.css:
     cabeçalho 59 + herói 133 + respiro da lista 22, cada faixa 50. */
  const PANEL_CHROME = 214;   // cabeçalho + herói + padding da lista
  const PANEL_ROW    = 50;    // altura de uma .tpp-trk

  // Altura que caiba `count` faixas, limitada ao espaço livre no Acervo.
  function fitHeight(count) {
    const host = dock.parentElement;
    const avail = host ? host.clientHeight : window.innerHeight;
    // 22 = bottom do dock · 92 = transporte sob o painel · 24 = respiro no topo
    const cap = Math.max(300, avail - 22 - 92 - 24);
    return Math.min(cap, PANEL_CHROME + count * PANEL_ROW);
  }

  function openDrawer(opts) {
    opts = opts || {};
    dock.classList.add('panel-open');
    dock.classList.toggle('panel-tall', !!opts.tall);
    // altura explícita (álbum) vence o CSS; sem ela, limpa p/ voltar às classes
    panel.style.height = opts.height ? opts.height + 'px' : '';
    dock.classList.remove('queue-open');
    const qb = $('[data-queue-open]'); if (qb) qb.classList.remove('is-on');
    const q = $('[data-queue]'); if (q) q.setAttribute('aria-hidden', 'true');
    panel.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    dock.classList.remove('panel-open');
    // solta a altura inline p/ o CSS reassumir e animar o colapso até 0
    panel.style.height = '';
    panel.setAttribute('aria-hidden', 'true');
  }
  // opening the queue closes this panel
  const queueBtn = $('[data-queue-open]');
  if (queueBtn) queueBtn.addEventListener('click', () => {
    dock.classList.remove('panel-open');
    panel.style.height = '';   // não deixa a altura sob medida do álbum sobrando
  });

  function wireClose() {
    const c = $('[data-panel-close]', inner);
    if (c) c.addEventListener('click', closeDrawer);
  }
  function playById(id) {
    const row = $(`.screen[data-screen="acervo"] .row[data-id="${id}"]`);
    if (row) row.click();
  }

  /* ---------- editor ---------- */
  function openEditor(row) {
    const m = meta(row);
    // valor prefilled do campo Álbum (single mostra vazio) — a membership só
    // é reenviada se ESTE campo mudar, senão editar artista/bpm não moveria a
    // faixa de álbum sem querer.
    const origAlbum = m.albumKind === 'single' ? '' : m.album;
    inner.innerHTML =
      `<div class="tpp-head">
        <div><div class="tpp-kicker">Editar informações</div><div class="tpp-h-title">${esc(m.title)}</div></div>
        <div class="tpp-spacer"></div>
        <button class="tpp-btn" data-panel-close>Cancelar</button>
        <button class="tpp-btn accent" data-edit-save><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-11"/></svg>Salvar</button>
      </div>
      <div class="tpp-editor">
        <div class="tpp-edit-cover">
          <div class="tpp-edit-art" style='background:${m.bg}'>
            <div class="repl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M8 9l4-4 4 4"/><path d="M5 19h14"/></svg>Trocar capa</div>
          </div>
        </div>
        <div class="tpp-fields">
          <div class="tpp-field col2"><span class="tpp-label">Título da faixa</span><input class="tpp-input" data-f="title" value="${esc(m.title)}"></div>
          <div class="tpp-field"><span class="tpp-label">Artista</span><input class="tpp-input" data-f="artist" value="${esc(m.artist)}"></div>
          <div class="tpp-field"><span class="tpp-label">Álbum</span><input class="tpp-input" data-f="album" value="${esc(m.albumKind === 'single' ? '' : m.album)}" placeholder="Vazio = Single"></div>
          <div class="tpp-field"><span class="tpp-label">Nº da faixa${m.albumTotal ? ' (de ' + m.albumTotal + ')' : ''}</span><input class="tpp-input mono" data-f="track_no" value="${m.trackNo || ''}" placeholder="—"></div>
          <div class="tpp-field"><span class="tpp-label">BPM</span><input class="tpp-input mono" data-f="bpm" value="${esc(m.bpm)}"></div>
          <div class="tpp-field"><span class="tpp-label">Tom</span><input class="tpp-input mono" data-f="key" value="${esc(m.key)}"></div>
          <div class="tpp-field col2"><span class="tpp-label">Tags</span><input class="tpp-input" data-f="tags" value="${esc(m.tags)}" placeholder="separadas por espaço"></div>
        </div>
        <div class="tpp-editor-note" style="opacity:.55;font-size:12px;margin-top:4px">Ano e gênero agora são do álbum — edite em "Editar álbum".</div>
      </div>`;
    wireClose();
    const save = $('[data-edit-save]', inner);
    if (save) save.addEventListener('click', async () => {
      const get = (f) => $(`[data-f="${f}"]`, inner)?.value.trim() || '';
      const v = { title: get('title'), artist: get('artist'), album: get('album'), trackNo: get('track_no'), bpm: get('bpm'), key: get('key'), tags: get('tags') };
      const tagList = v.tags.split(/\s+/).filter(Boolean);
      const body = {
        title: v.title, artist: v.artist,
        track_no: v.trackNo ? Number(v.trackNo) : 0,
        bpm: v.bpm ? Number(v.bpm) : null, key: v.key,
        tags: tagList,
      };
      // membership só quando o campo Álbum mudou (vazio = Single)
      if (v.album !== origAlbum) body.album = v.album;
      save.disabled = true;
      try {
        const res = await fetch(`api/library/${encodeURIComponent(m.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        // A faixa canônica volta do servidor: se a membership criou/trocou o
        // álbum, ela já traz album/year/genre/kind/total novos (via JOIN).
        const data = await res.json().catch(() => ({}));
        const t = (data && data.track) || {};
        row.dataset.title = v.title; row.dataset.artist = v.artist;
        row.dataset.album = t.album || '';
        if (t.album_id) row.dataset.albumId = t.album_id;
        row.dataset.albumKind = t.album_kind || 'album';
        row.dataset.albumTotal = t.album_total || '';
        row.dataset.year = (t.year != null && t.year !== '') ? String(t.year) : '';
        row.dataset.genre = t.genre || '';
        row.dataset.trackNo = v.trackNo || '';
        row.dataset.bpm = v.bpm; row.dataset.key = v.key; row.dataset.tags = tagList.join(' ');
        // mantém o catálogo em memória coerente p/ "Ver álbum" sem reload
        if (t.album_id && window.RolfAlbums) {
          const prev = window.RolfAlbums[t.album_id] || {};
          window.RolfAlbums[t.album_id] = {
            id: t.album_id, title: t.album || prev.title || '',
            artist: t.artist || prev.artist || '',
            year: (t.year != null && t.year !== '') ? String(t.year) : (prev.year || ''),
            genre: t.genre || prev.genre || '', total: t.album_total || prev.total || 0,
            count: prev.count || 0, kind: t.album_kind || prev.kind || 'album',
            cover: prev.cover || m.bg || '',
          };
        }
        const ti = row.querySelector('.row-title'); if (ti) ti.textContent = v.title;
        const a = row.querySelector('.row-artist'); if (a) a.textContent = v.artist;
        const b = row.querySelector('.row-data'); if (b) b.textContent = v.bpm;
        const k = row.querySelector('.row-key'); if (k) k.textContent = v.key;
        const tagsEl = row.querySelector('.row-tags');
        if (tagsEl) {
          tagsEl.querySelectorAll('.usertag').forEach((el) => el.remove());
          tagsEl.insertAdjacentHTML('beforeend', tagList.map((tg) =>
            '<span class="tag mut usertag">' + esc(tg.charAt(0).toUpperCase() + tg.slice(1)) + '</span>').join(''));
        }
        closeDrawer();
        document.dispatchEvent(new CustomEvent('rolf:toast', { detail: { text: v.title, kicker: 'Salvo' } }));
        // versions.js escuta para sugerir agrupamento por título+artista iguais
        document.dispatchEvent(new CustomEvent('rolf:track-saved', { detail: { id: m.id } }));
      } catch (e) {
        console.error('save track metadata failed:', e);
        document.dispatchEvent(new CustomEvent('rolf:toast', { detail: { text: 'Não foi possível salvar', kicker: 'Erro' } }));
      } finally {
        save.disabled = false;
      }
    });
    // autocomplete on artist + album (never on track title)
    attachAutocomplete($('[data-f="artist"]', inner), uniqueArtists);
    attachAutocomplete($('[data-f="album"]', inner), uniqueAlbums);
    openDrawer();
  }

  /* ---------- album / artist track list ---------- */
  function trackRow(m, i, playingId, numbered) {
    // no álbum mostramos o nº real da faixa; nas outras listas, a posição
    const idx = numbered && m.trackNo ? m.trackNo : i + 1;
    return `<div class="tpp-trk${m.id === playingId ? ' playing' : ''}" data-id="${esc(m.id)}">
      <span class="tpp-trk-idx">${idx}</span>
      <span class="row-cover cover" style='background:${bgQuote(m.bg)}'></span>
      <span class="tpp-trk-name">${esc(m.title)}</span>
      <span class="tpp-trk-data">${esc(m.bpm)}</span>
      <span class="tpp-trk-key">${esc(m.key)}</span>
      <span class="tpp-trk-dur">${esc(m.dur)}</span>
    </div>`;
  }

  // Slot vazio: reservado quando o álbum declara mais faixas (total_tracks) do
  // que as presentes no acervo. Não tem faixa, não é clicável.
  function emptySlotRow(n) {
    return `<div class="tpp-trk empty" aria-disabled="true" style="opacity:.4">
      <span class="tpp-trk-idx">${n}</span>
      <span class="row-cover cover" style="background:#17171a;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)"></span>
      <span class="tpp-trk-name" style="font-style:italic;letter-spacing:.02em">Faixa ${n}</span>
      <span class="tpp-trk-data"></span>
      <span class="tpp-trk-key"></span>
      <span class="tpp-trk-dur">—</span>
    </div>`;
  }

  // Monta as linhas do álbum. Com total_tracks definido, cria `total` slots e
  // encaixa cada faixa no seu nº (track_no); faixas sem nº/estouradas preenchem
  // os buracos restantes e o excedente vai ao fim.
  function albumSlots(tracks, total, playingId) {
    if (!total || total <= 0) {
      return { html: tracks.map((t, i) => trackRow(t, i, playingId, true)).join(''),
               rowCount: tracks.length };
    }
    const slots = new Array(total).fill(null);
    const overflow = [];
    tracks.forEach((t) => {
      const n = t.trackNo;
      if (n >= 1 && n <= total && !slots[n - 1]) slots[n - 1] = t;
      else overflow.push(t);
    });
    let oi = 0;
    for (let i = 0; i < total && oi < overflow.length; i++) {
      if (!slots[i]) slots[i] = overflow[oi++];
    }
    const extra = overflow.slice(oi);   // mais faixas que slots ⇒ acrescenta ao fim
    const html = slots.map((t, i) => t ? trackRow(t, i, playingId, true) : emptySlotRow(i + 1))
      .concat(extra.map((t, i) => trackRow(t, total + i, playingId, true))).join('');
    return { html, rowCount: total + extra.length };
  }

  function openAlbum(row) {
    const albumId = row.dataset.albumId || '';
    const m = meta(row);
    const info = albumInfo(albumId);
    const playingId = document.querySelector('.row.active')?.dataset.id || '';
    // agrupa por album_id (não por nome — senão todos os "Single" fundiriam)
    const tracks = acervoRows()
      .filter((r) => (r.dataset.albumId || '') === albumId)
      .map(meta)
      // ordem do álbum pelo nº da faixa; sem nº vai ao fim, empate mantém
      // a ordem de importação (Array.sort é estável)
      .sort((a, b) => (a.trackNo || Infinity) - (b.trackNo || Infinity));
    const title  = (info && info.title)  || m.album;
    const artist = (info && info.artist) || m.artist;
    const bg     = (info && info.cover)  || m.bg;
    const yrs = [...new Set(tracks.map((t) => t.year))].filter(Boolean).sort();
    const year = (info && info.year) || yrs.join('–');
    const count = tracks.length;
    const total = (info && info.total) || 0;
    const countLabel = (total && total !== count)
      ? (count + ' de ' + total + ' faixas')
      : (count + ' ' + (count === 1 ? 'faixa' : 'faixas'));
    const kicker = (info && info.kind === 'single') ? 'Single' : 'Álbum';
    const slotted = albumSlots(tracks, total, playingId);
    inner.innerHTML =
      `<div class="tpp-head">
        <div class="tpp-kicker">${kicker}</div><div class="tpp-spacer"></div>
        <button class="tpp-btn" data-album-edit><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="M14.5 5.5l4 4L9 19l-4 .9.9-4z"/></svg>Editar</button>
        <button class="tpp-close" data-panel-close aria-label="Fechar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></button>
      </div>
      <div class="tpp-hero">
        <span class="tpp-hero-art" style='background:${bgQuote(bg)}'></span>
        <div class="tpp-hero-info">
          <div class="tpp-hero-name">${esc(title)}</div>
          <div class="tpp-hero-meta"><span>${esc(artist)}</span><span class="d"></span><span>${esc(year)}</span><span class="d"></span><span>${countLabel}</span></div>
        </div>
        <div class="tpp-spacer"></div>
        <button class="tpp-btn accent" data-play-first><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4 18.6 12 8 18.6z"/></svg>Tocar álbum</button>
      </div>
      <div class="tpp-list">${slotted.html}</div>`;
    wireClose();
    const pf = $('[data-play-first]', inner);
    if (pf && tracks[0]) pf.addEventListener('click', () => playById(tracks[0].id));
    const eb = $('[data-album-edit]', inner);
    if (eb) eb.addEventListener('click', () => openAlbumEditor(albumId));
    // slots vazios (.empty) não têm data-id nem clique
    $$('.tpp-trk:not(.empty)', inner).forEach((t) => t.addEventListener('click', () => playById(t.dataset.id)));
    openDrawer({ height: fitHeight(slotted.rowCount) });
  }

  function openAlbumById(albumId) {
    const row = acervoRows().find((r) => (r.dataset.albumId || '') === albumId);
    if (row) openAlbum(row);
  }

  /* ---------- album editor (edita o álbum; as faixas herdam) ---------- */
  function openAlbumEditor(albumId) {
    if (!albumId) return;
    const info = albumInfo(albumId) || {};
    const rows = acervoRows().filter((r) => (r.dataset.albumId || '') === albumId);
    const first = rows[0] ? meta(rows[0]) : {};
    const title  = info.title  || first.album || 'Álbum';
    const artist = info.artist || first.artist || '';
    const year   = info.year   || first.year || '';
    const genre  = info.genre  || first.genre || '';
    const count  = rows.length;
    const total  = info.total || 0;
    const bg     = info.cover || first.bg || '';
    inner.innerHTML =
      `<div class="tpp-head">
        <div><div class="tpp-kicker">Editar álbum · ${count} ${count === 1 ? 'faixa' : 'faixas'}</div><div class="tpp-h-title">${esc(title)}</div></div>
        <div class="tpp-spacer"></div>
        <button class="tpp-btn" data-panel-close>Cancelar</button>
        <button class="tpp-btn accent" data-album-save><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-11"/></svg>Salvar</button>
      </div>
      <div class="tpp-editor">
        <div class="tpp-edit-cover"><div class="tpp-edit-art" style='background:${bgQuote(bg)}'></div></div>
        <div class="tpp-fields">
          <div class="tpp-field col2"><span class="tpp-label">Nome do álbum</span><input class="tpp-input" data-f="title" value="${esc(title)}"></div>
          <div class="tpp-field"><span class="tpp-label">Artista</span><input class="tpp-input" data-f="artist" value="${esc(artist)}"></div>
          <div class="tpp-field"><span class="tpp-label">Ano de lançamento</span><input class="tpp-input mono" data-f="year" value="${esc(year)}"></div>
          <div class="tpp-field"><span class="tpp-label">Gênero</span><input class="tpp-input" data-f="genre" value="${esc(genre)}"></div>
          <div class="tpp-field"><span class="tpp-label">Número de músicas</span><input class="tpp-input mono" data-f="total_tracks" value="${total || ''}" placeholder="${count}"></div>
        </div>
      </div>`;
    wireClose();
    attachAutocomplete($('[data-f="artist"]', inner), uniqueArtists);
    const save = $('[data-album-save]', inner);
    if (save) save.addEventListener('click', async () => {
      const get = (f) => $(`[data-f="${f}"]`, inner)?.value.trim() || '';
      const v = { title: get('title'), artist: get('artist'), year: get('year'), genre: get('genre'), total: get('total_tracks') };
      save.disabled = true;
      try {
        const res = await fetch(`api/albums/${encodeURIComponent(albumId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: v.title, artist: v.artist,
            year: v.year ? Number(v.year) : null,
            genre: v.genre,
            total_tracks: v.total ? Number(v.total) : null,
          }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json().catch(() => ({}));
        const al = (data && data.album) || {};
        const ids = (data && data.track_ids) || [];
        const yStr = (al.year != null && al.year !== '') ? String(al.year) : '';
        if (window.RolfAlbums) {
          const prev = window.RolfAlbums[albumId] || {};
          window.RolfAlbums[albumId] = {
            id: albumId, title: al.title || v.title, artist: al.artist || v.artist,
            year: yStr, genre: al.genre || '', total: al.total_tracks || 0,
            count: prev.count || ids.length, kind: al.kind || prev.kind || 'album',
            cover: prev.cover || bg || '',
          };
        }
        // herança: reflete nos datasets das faixas do álbum (sem reload)
        ids.forEach((id) => {
          const r = acervoRows().find((rr) => rr.dataset.id === id);
          if (!r) return;
          r.dataset.album = al.title || v.title || '';
          r.dataset.year = yStr;
          r.dataset.genre = al.genre || '';
          r.dataset.albumTotal = al.total_tracks || '';
          r.dataset.albumKind = al.kind || 'album';
        });
        document.dispatchEvent(new CustomEvent('rolf:toast', { detail: { text: al.title || v.title, kicker: 'Álbum salvo' } }));
        openAlbumById(albumId);
      } catch (e) {
        console.error('save album failed:', e);
        document.dispatchEvent(new CustomEvent('rolf:toast', { detail: { text: 'Não foi possível salvar', kicker: 'Erro' } }));
      } finally {
        save.disabled = false;
      }
    });
    openDrawer();
  }

  function openArtist(row) {
    const m = meta(row);
    const playingId = document.querySelector('.row.active')?.dataset.id || '';
    const tracks = acervoRows().filter((r) => effArtist(r) === m.artist).map(meta);
    const albums = albumsByArtist(m.artist);
    const albumCards = albums.map((a) =>
      `<button class="tpp-alb" data-album-id="${esc(a.id)}">
        <span class="tpp-alb-art" style='background:${bgQuote(a.bg)}'></span>
        <span class="tpp-alb-name">${esc(a.album)}</span>
        <span class="tpp-alb-meta">${esc(a.year)} · ${a.count} ${a.count === 1 ? 'faixa' : 'faixas'}</span>
      </button>`).join('');
    inner.innerHTML =
      `<div class="tpp-head">
        <div class="tpp-kicker">Artista</div><div class="tpp-spacer"></div>
        <button class="tpp-close" data-panel-close aria-label="Fechar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></button>
      </div>
      <div class="tpp-hero">
        <span class="tpp-hero-art round" style='background:${m.bg}'></span>
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
        <div class="tpp-tracks">${tracks.map((t, i) => trackRow(t, i, playingId)).join('')}</div>
      </div>`;
    wireClose();
    const pf = $('[data-play-first]', inner);
    if (pf && tracks[0]) pf.addEventListener('click', () => playById(tracks[0].id));
    $$('.tpp-trk', inner).forEach((t) => t.addEventListener('click', () => playById(t.dataset.id)));
    $$('.tpp-alb', inner).forEach((a) => a.addEventListener('click', () => openAlbumById(a.dataset.albumId)));
    openDrawer({ tall: true });
  }

  /* ---------- listen for context-menu actions ---------- */
  document.addEventListener('rolf:ctx', (e) => {
    const { action, row } = e.detail;
    if (!row) return;
    if (action === 'edit')       openEditor(row);
    if (action === 'album')      openAlbum(row);
    if (action === 'album-edit') openAlbumEditor(row.dataset.albumId);
    if (action === 'artist')     openArtist(row);
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
