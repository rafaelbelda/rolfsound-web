/* ============================================================
   ROLFSOUND V2 — Render inicial a partir de RolfsoundData
   Constrói as rows do Acervo e da fila antes dos módulos de
   comportamento rodarem (eles ligam handlers nas rows no load,
   então este script PRECISA vir antes de dash.js/prototype.js/
   acervo.js/etc. na ordem dos <script>).
   ============================================================ */
(function () {
  'use strict';

  const D = window.RolfsoundData || {};
  const tracks = Array.isArray(D.tracks) ? D.tracks : [];
  const queue = Array.isArray(D.queue) ? D.queue : [];

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const mmss = (sec) => {
    sec = Math.max(0, Math.floor(+sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };
  const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const dateLabel = (ms) => {
    if (!+ms) return '';
    const d = new Date(+ms);
    return d.getDate() + ' ' + MES[d.getMonth()];
  };
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

  const FMT_SVG = {
    vinil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/></svg>',
    cd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><path d="M12 3a9 9 0 0 1 6.4 2.6"/></svg>',
    digital: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 16V8l5-2v8"/><circle cx="5" cy="16" r="2"/><path d="M14 14V6l5-2v8"/><circle cx="14" cy="14" r="2"/></svg>',
  };
  const FMT_LABEL = { vinil: 'Vinil', cd: 'CD', digital: 'Digital' };
  const STATE_TAG = {
    master: '<span class="tag">Master</span>',
    edit: '<span class="tag mut">Edit</span>',
    rip: '<span class="tag mut">Rip cru</span>',
  };

  const byCoord = new Map(tracks.map((t) => [t.coord, t]));

  /* ---------- Acervo: rows do ledger ---------- */
  function rowHtml(t) {
    const tags = (t.tags || []).map((tg) => '<span class="tag mut">' + esc(cap(tg)) + '</span>').join('');
    return '<div class="row"' +
      ' data-coord="' + esc(t.coord) + '"' +
      ' data-added="' + (+t.added || 0) + '"' +
      ' data-bpm="' + (+t.bpm || 0) + '"' +
      ' data-key="' + esc(t.key) + '"' +
      ' data-fmt="' + esc(t.fmt) + '"' +
      ' data-state="' + esc(t.state) + '"' +
      ' data-fav="' + (t.fav ? 1 : 0) + '"' +
      ' data-tags="' + esc((t.tags || []).join(' ')) + '"' +
      ' data-title="' + esc(t.title) + '"' +
      ' data-artist="' + esc(t.artist) + '"' +
      (t.album ? ' data-album="' + esc(t.album) + '"' : '') +
      (t.year ? ' data-year="' + esc(t.year) + '"' : '') +
      ' data-dur="' + (+t.dur || 0) + '">' +
      '<div class="row-coord">' + dateLabel(t.added) + '</div>' +
      '<span class="row-cover cover" style="background:' + (t.cover || '') + '"></span>' +
      '<div class="row-main"><div class="row-title">' + esc(t.title) + '</div><div class="row-artist">' + esc(t.artist) + '</div></div>' +
      '<div class="row-data">' + (+t.bpm || '') + '</div>' +
      '<div class="row-key">' + esc(t.key) + '</div>' +
      '<div class="row-tags">' + (STATE_TAG[t.state] || '') + tags + '</div>' +
      '<div class="fmt">' + (FMT_SVG[t.fmt] || '') + (FMT_LABEL[t.fmt] || '') + '</div>' +
      '<div class="row-dur">' + mmss(t.dur) + '</div>' +
      '</div>';
  }

  const ledger = document.querySelector('.screen[data-screen="acervo"] .ledger-scroll');
  if (ledger) ledger.insertAdjacentHTML('beforeend', tracks.map(rowHtml).join(''));

  /* ---------- Fila "A seguir" ---------- */
  function queueRowHtml(t, i) {
    return '<div class="tpq-row"' +
      ' data-bg="' + esc(t.cover || '') + '"' +
      ' data-title="' + esc(t.title) + '"' +
      ' data-artist="' + esc(t.artist) + '"' +
      ' data-bpm="' + (+t.bpm || 0) + '"' +
      ' data-coord="' + esc(t.coord) + '"' +
      ' data-key="' + esc(t.key) + '"' +
      ' data-dur="' + (+t.dur || 0) + '">' +
      '<span class="tpq-grip"><i></i><i></i><i></i></span>' +
      '<span class="tpq-idx">' + (i + 1) + '</span>' +
      '<span class="row-cover cover" style="background:' + (t.cover || '') + '"></span>' +
      '<div class="tpq-main"><div class="tpq-name">' + esc(t.title) + '</div><div class="tpq-artist">' + esc(t.artist) + '</div></div>' +
      '<span class="tpq-data">' + (+t.bpm || '') + '</span><span class="tpq-key">' + esc(t.key) + '</span>' +
      '<span class="tpq-dur">' + mmss(t.dur) + '</span>' +
      '<button class="tpq-x" aria-label="Remover"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '</div>';
  }

  const queueList = document.querySelector('[data-queue-list]');
  const queueTracks = queue.map((c) => byCoord.get(c)).filter(Boolean);
  if (queueList) queueList.insertAdjacentHTML('beforeend', queueTracks.map(queueRowHtml).join(''));
  const queueCount = document.querySelector('[data-queue-count]');
  if (queueCount) queueCount.textContent = queueTracks.length;

  /* ---------- Topbar: contagem do cofre ---------- */
  const storeCount = document.querySelector('.tb-status .store .meta span');
  if (storeCount) storeCount.textContent = tracks.length + (tracks.length === 1 ? ' faixa' : ' faixas');
})();
