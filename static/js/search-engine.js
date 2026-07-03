/* ============================================================
   ROLFSOUND V2 — SEARCH ENGINE (Busca avançada)
   Real querying over the live vault. Reads every track from the
   Acervo as the dataset, then filters by text, date added, format,
   BPM range (draggable dual handle), tags, harmonic key (Camelot
   compatibility), and origin/state — sortable, clearable, live.
   ============================================================ */
(function () {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* ---------- format icons (match Acervo vocabulary) ---------- */
  const FMT_ICON = {
    vinil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/></svg>',
    cd:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><path d="M12 3a9 9 0 0 1 6.4 2.6"/></svg>',
    digital: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 16V8l5-2v8"/><circle cx="5" cy="16" r="2"/><path d="M14 14V6l5-2v8"/><circle cx="14" cy="14" r="2"/></svg>',
  };
  const FMT_LABEL   = { vinil: 'Vinil', cd: 'CD', digital: 'Digital' };
  const STATE_LABEL = { master: 'Master', edit: 'Edit', rip: 'Rip cru' };

  /* ---------- Camelot wheel for harmonic compatibility ---------- */
  const CAMELOT = {
    'C maj': '8B', 'G maj': '9B', 'D maj': '10B', 'A maj': '11B', 'E maj': '12B', 'B maj': '1B',
    'F# maj': '2B', 'Gb maj': '2B', 'Db maj': '3B', 'C# maj': '3B', 'Ab maj': '4B', 'G# maj': '4B',
    'Eb maj': '5B', 'D# maj': '5B', 'Bb maj': '6B', 'A# maj': '6B', 'F maj': '7B',
    'A min': '8A', 'E min': '9A', 'B min': '10A', 'F# min': '11A', 'Gb min': '11A',
    'C# min': '12A', 'Db min': '12A', 'G# min': '1A', 'Ab min': '1A', 'D# min': '2A', 'Eb min': '2A',
    'A# min': '3A', 'Bb min': '3A', 'F min': '4A', 'C min': '5A', 'G min': '6A', 'D min': '7A',
  };
  function camelot(k) { return CAMELOT[(k || '').trim()] || null; }
  function compatible(a, b) {
    const ca = camelot(a), cb = camelot(b);
    if (!ca || !cb) return a === b;
    if (ca === cb) return true;
    const na = parseInt(ca), la = ca.slice(-1);
    const nb = parseInt(cb), lb = cb.slice(-1);
    if (na === nb) return true;                              // relative major/minor
    if (la === lb) { const d = Math.abs(na - nb); return d === 1 || d === 11; } // ±1 on wheel
    return false;
  }

  function mmss(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return m + ':' + (s < 10 ? '0' : '') + s; }

  /* ============================================================
     DATASET — read every Acervo row
     ============================================================ */
  let DATA = [];
  function buildDataset() {
    DATA = $$('.screen[data-screen="acervo"] .row').map((row) => ({
      title:  row.dataset.title || row.querySelector('.row-title')?.textContent || 'Faixa',
      artist: row.querySelector('.row-artist')?.textContent || '',
      id:     row.dataset.id || '',
      bg:     row.querySelector('.row-cover')?.style.background || '',
      added:  parseInt(row.dataset.added, 10) || 0,
      bpm:    parseInt(row.dataset.bpm, 10) || 0,
      key:    (row.dataset.key || '').trim(),
      fmt:    row.dataset.fmt || 'digital',
      state:  row.dataset.state || 'master',
      fav:    row.dataset.fav === '1',
      tags:   (row.dataset.tags || '').split(/\s+/).filter(Boolean),
      dur:    parseInt(row.dataset.dur, 10) || 0,
    }));
  }

  /* ============================================================
     FILTER STATE
     ============================================================ */
  const F = {
    q: '',
    days: Infinity,            // date window
    formats: new Set(),        // empty = all
    bpmLo: 60, bpmHi: 180,
    tags: new Set(),
    key: null,                 // single key, harmonic match
    states: new Set(),         // master/edit/rip/fav
    sort: 'recent',            // recent | title | bpm | key
  };
  const SORTS = ['recent', 'title', 'bpm', 'key'];
  const SORT_LABEL = { recent: 'Recente', title: 'Título', bpm: 'BPM', key: 'Tom' };

  let NOW = Date.now();        // anchored to newest track on init
  const DAY = 86400000;

  /* ============================================================
     APPLY + RENDER
     ============================================================ */
  function passes(t) {
    if (F.q) {
      const hay = (t.title + ' ' + t.artist + ' ' + t.key + ' ' + t.tags.join(' ')).toLowerCase();
      if (!hay.includes(F.q)) return false;
    }
    if (F.days !== Infinity && (NOW - t.added) > F.days * DAY) return false;
    if (F.formats.size && !F.formats.has(t.fmt)) return false;
    if (t.bpm < F.bpmLo || t.bpm > F.bpmHi) return false;
    if (F.tags.size && !t.tags.some((tg) => F.tags.has(tg))) return false;
    if (F.key && !compatible(F.key, t.key)) return false;
    if (F.states.size) {
      let ok = false;
      if (F.states.has('fav') && t.fav) ok = true;
      if (F.states.has(t.state)) ok = true;
      if (!ok) return false;
    }
    return true;
  }

  function sortRows(rows) {
    const by = F.sort;
    return rows.sort((a, b) => {
      if (by === 'recent') return b.added - a.added;
      if (by === 'bpm') return a.bpm - b.bpm;
      if (by === 'key') return (camelot(a.key) || 'zz').localeCompare(camelot(b.key) || 'zz', undefined, { numeric: true }) || a.title.localeCompare(b.title);
      return a.title.localeCompare(b.title); // title
    });
  }

  function highlight(text, q) {
    if (!q) return escapeHtml(text);
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return escapeHtml(text);
    return escapeHtml(text.slice(0, i)) + '<em>' + escapeHtml(text.slice(i, i + q.length)) + '</em>' + escapeHtml(text.slice(i + q.length));
  }
  function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  function render() {
    const list = $('.bsc-list'); if (!list) return;
    let rows = DATA.filter(passes);
    rows = sortRows(rows);

    list.innerHTML = '';
    if (!rows.length) {
      list.classList.add('is-empty');
      const empty = document.createElement('div');
      empty.className = 'bsc-empty';
      empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>' +
        '<div class="bsc-empty-t">Nenhuma faixa corresponde</div>' +
        '<div class="bsc-empty-s">Ajuste os filtros ou limpe a busca</div>';
      list.appendChild(empty);
    } else {
      list.classList.remove('is-empty');
      rows.forEach((t) => list.appendChild(rowEl(t)));
    }

    const c = $('.bsc-count');
    if (c) c.innerHTML = `<b>${rows.length}</b> de ${DATA.length} faixas`;
    updateFacetVals();
  }

  function rowEl(t) {
    const el = document.createElement('div');
    el.className = 'bsc-row';
    el.dataset.id = t.id;
    el.dataset.key = t.key; el.dataset.bpm = t.bpm; el.dataset.fmt = t.fmt;
    el.innerHTML =
      `<span class="row-cover cover" style='background:${t.bg}'></span>` +
      `<div class="bsc-main"><div class="bsc-title row-title">${highlight(t.title, F.q)}</div>` +
      `<div class="bsc-artist row-artist">${escapeHtml(t.artist)}</div></div>` +
      `<span class="bsc-data row-data">${t.bpm}</span>` +
      `<span class="bsc-key row-key">${t.key}</span>` +
      `<span class="fmt">${FMT_ICON[t.fmt] || ''}${FMT_LABEL[t.fmt] || ''}</span>` +
      `<span class="row-data" style="color:var(--ink-faint)">${t.fav ? '★ ' : ''}${STATE_LABEL[t.state] || ''}</span>` +
      `<span class="bsc-dur">${mmss(t.dur)}</span>`;
    el.addEventListener('click', () => {
      $$('.bsc-row').forEach((r) => r.classList.remove('playing'));
      el.classList.add('playing');
      if (window.RolfLoadTransport) window.RolfLoadTransport(el);
    });
    el.addEventListener('dblclick', () => {
      // toca no core (mesmo caminho do clique) e abre o Remixer ao vivo
      if (window.RolfLoadTransport) window.RolfLoadTransport(el);
      const btn = $('.island .isl-btn[data-nav="remixer"]'); if (btn) btn.click();
    });
    return el;
  }

  /* ============================================================
     FACET VALUE LABELS
     ============================================================ */
  function facetByTitle(name) {
    return $$('.bsc .facet-title').find((el) => el.textContent.trim() === name)?.closest('.facet-head');
  }
  function setFacetVal(name, text) {
    const head = facetByTitle(name);
    const v = head?.querySelector('.facet-val');
    if (v) v.textContent = text;
  }
  function updateFacetVals() {
    setFacetVal('Adicionada', F.days === Infinity ? 'Todo o período' : `Últimos ${F.days} dias`);
    setFacetVal('BPM', `${F.bpmLo} – ${F.bpmHi}`);
    setFacetVal('Tom · harmônico', F.key ? `${F.key} · compatíveis` : 'Todos os tons');
  }

  /* ============================================================
     WIRE FACETS
     ============================================================ */
  function findChips(facetTitle) {
    const head = facetByTitle(facetTitle);
    if (!head) return null;
    let n = head.nextElementSibling;
    while (n && !n.classList.contains('chips')) n = n.nextElementSibling;
    return n;
  }

  function wireDate() {
    const chips = findChips('Adicionada'); if (!chips) return;
    const map = { '7 dias': 7, '30 dias': 30, '90 dias': 90, 'Tudo': Infinity };
    $$('.chip', chips).forEach((c) => c.addEventListener('click', () => {
      $$('.chip', chips).forEach((x) => x.classList.remove('on'));
      c.classList.add('on');
      F.days = map[c.textContent.trim()] ?? Infinity;
      render();
    }));
  }

  function wireMulti(facetTitle, set, keyFor) {
    const chips = findChips(facetTitle); if (!chips) return;
    $$('.chip', chips).forEach((c) => c.addEventListener('click', () => {
      c.classList.toggle('on');
      const k = keyFor(c.textContent.trim());
      if (c.classList.contains('on')) set.add(k); else set.delete(k);
      render();
    }));
  }

  function wireKey() {
    const chips = findChips('Tom · harmônico'); if (!chips) return;
    const all = $$('.chip', chips);
    function refreshCompat() {
      all.forEach((c) => {
        const k = c.textContent.trim();
        const isSel = F.key === k;
        c.classList.toggle('on', isSel);
        c.classList.toggle('compat', !isSel && F.key && compatible(F.key, k));
      });
    }
    all.forEach((c) => c.addEventListener('click', () => {
      const k = c.textContent.trim();
      F.key = (F.key === k) ? null : k;     // click active key again → clear
      refreshCompat();
      render();
    }));
    chips._refreshCompat = refreshCompat;
  }

  /* ---------- BPM dual-range drag ---------- */
  function wireBpm() {
    const range = $('.bsc [data-range]'); if (!range) return;
    const sel = range.querySelector('.range-sel');
    const handles = $$('.range-h', range);
    if (handles.length < 2) return;
    const MIN = 60, MAX = 180;
    const toBpm = (frac) => Math.round((MIN + frac * (MAX - MIN)) / 2) * 2;
    const toFrac = (bpm) => (bpm - MIN) / (MAX - MIN);

    function paint() {
      const l = toFrac(F.bpmLo) * 100, r = toFrac(F.bpmHi) * 100;
      handles[0].style.left = l + '%';
      handles[1].style.left = r + '%';
      sel.style.left = l + '%';
      sel.style.right = (100 - r) + '%';
    }
    let active = null;
    const fromEv = (e) => {
      const rect = range.getBoundingClientRect();
      let frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const bpm = toBpm(frac);
      if (active === handles[0]) F.bpmLo = Math.min(bpm, F.bpmHi);
      else F.bpmHi = Math.max(bpm, F.bpmLo);
      paint(); updateFacetVals(); render();
    };
    handles.forEach((h) => {
      h.addEventListener('pointerdown', (e) => { active = h; h.setPointerCapture(e.pointerId); e.preventDefault(); });
      h.addEventListener('pointermove', (e) => { if (active === h) fromEv(e); });
      h.addEventListener('pointerup', (e) => { active = null; h.releasePointerCapture(e.pointerId); });
    });
    // click on track jumps nearest handle
    range.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('range-h')) return;
      const rect = range.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      const bpm = toBpm(frac);
      active = (Math.abs(bpm - F.bpmLo) <= Math.abs(bpm - F.bpmHi)) ? handles[0] : handles[1];
      fromEv(e); active = null;
    });
    range._paint = paint;
    paint();
  }

  function wireSort() {
    const sort = $('.bsc-sort'); if (!sort) return;
    const label = () => { sort.lastChild.textContent = SORT_LABEL[F.sort]; };
    // ensure trailing text node
    if (sort.lastChild.nodeType !== Node.TEXT_NODE) sort.appendChild(document.createTextNode(''));
    label();
    sort.addEventListener('click', () => {
      F.sort = SORTS[(SORTS.indexOf(F.sort) + 1) % SORTS.length];
      label(); render();
    });
  }

  function wireQuery() {
    const input = $('[data-bsc-input]');
    if (input) input.addEventListener('input', () => { F.q = input.value.trim().toLowerCase(); render(); });
    // ⌘K / Ctrl-K focus
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        const bsc = $('.screen[data-screen="busca"]');
        if (bsc && getComputedStyle(bsc).display !== 'none') { e.preventDefault(); input?.focus(); }
      }
    });
  }

  function wireClear() {
    const btn = $$('.bsc .btn-ghost').find((b) => /limpar/i.test(b.textContent));
    if (btn) btn.addEventListener('click', clearAll);
  }

  function clearAll() {
    F.q = ''; F.days = Infinity; F.formats.clear(); F.bpmLo = 60; F.bpmHi = 180;
    F.tags.clear(); F.key = null; F.states.clear();
    const input = $('[data-bsc-input]'); if (input) input.value = '';
    // reset chip visuals
    $$('.bsc .chip').forEach((c) => c.classList.remove('on', 'compat'));
    const dateChips = findChips('Adicionada');
    if (dateChips) { const tudo = $$('.chip', dateChips).find((c) => c.textContent.trim() === 'Tudo'); tudo?.classList.add('on'); }
    const range = $('.bsc [data-range]'); if (range && range._paint) range._paint();
    updateFacetVals();
    render();
  }

  /* ============================================================
     INIT
     ============================================================ */
  function init() {
    buildDataset();
    NOW = DATA.length ? (Math.max(...DATA.map((t) => t.added)) || Date.now()) : Date.now();

    // header crumb count
    const crumb = $('.bsc .top-crumb');
    if (crumb) crumb.innerHTML = `Biblioteca <span class="c-dot"></span> Busca <span class="c-dot"></span> ${DATA.length} faixas indexadas`;

    // start from a clean, useful state (all tracks, newest first)
    $$('.bsc .chip').forEach((c) => c.classList.remove('on', 'compat'));
    const dateChips = findChips('Adicionada');
    if (dateChips) { const tudo = $$('.chip', dateChips).find((c) => c.textContent.trim() === 'Tudo'); tudo?.classList.add('on'); }

    wireQuery();
    wireDate();
    wireMulti('Formato', F.formats, (label) => label.toLowerCase());
    wireMulti('Tags', F.tags, (label) => label.toLowerCase());
    wireKey();
    wireMulti('Origem · estado', F.states, (label) => ({ 'Master': 'master', 'Edit': 'edit', 'Rip cru': 'rip', 'Favoritas': 'fav' }[label] || label.toLowerCase()));
    wireBpm();
    wireSort();
    wireClear();

    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
