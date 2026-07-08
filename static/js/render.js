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
  const groups = (D.groups && typeof D.groups === 'object') ? D.groups : {};
  // Mapa id→álbum (title/artist/year/genre/total/count/kind/cover). Os editores
  // e o "Ver álbum" leem daqui em vez de reconstruir a partir das linhas.
  const albums = (D.albums && typeof D.albums === 'object') ? D.albums : {};
  window.RolfAlbums = albums;

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

  const byId = new Map(tracks.map((t) => [t.id, t]));

  /* ---------- badge de stems (versão multipista) ----------
     Quatro pontos fixos — vocals · drums · bass · other — acesos
     conforme os slots preenchidos. stems.js atualiza após uploads. */
  const STEM_ROLES = ['vocals', 'drums', 'bass', 'other'];
  const STEM_LABEL = { vocals: 'Vocais', drums: 'Bateria', bass: 'Baixo', other: 'Outros' };
  function stemsBadgeHtml(roles) {
    if (!roles || !roles.length) return '';
    const dots = STEM_ROLES.map((r) =>
      '<i data-r="' + r + '"' + (roles.includes(r) ? ' class="on"' : '') + '></i>').join('');
    const names = roles.map((r) => STEM_LABEL[r] || r).join(' · ');
    return '<span class="tag stems" title="Stems · ' + esc(names) + '">' + dots + 'Stems</span>';
  }
  window.RolfStemsBadgeHtml = stemsBadgeHtml;

  /* ---------- badge de versões (pasta de versões alternativas) ----------
     Aceso na versão principal de um grupo com 2+ membros. O clique abre o
     drawer "Explorar versões" (versions.js escuta .tag.versions). */
  function versionsBadgeHtml(count) {
    const n = +count || 0;
    if (n < 2) return '';
    return '<span class="tag versions" role="button" tabindex="0" ' +
      'title="' + n + ' versões — explorar">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>' +
      n + ' versões</span>';
  }
  window.RolfVersionsBadgeHtml = versionsBadgeHtml;
  const groupCount = (t) => (t.group && groups[t.group] && groups[t.group].members)
    ? groups[t.group].members.length : 0;

  /* ---------- Acervo: rows do ledger ---------- */
  function rowHtml(t) {
    const tags = (t.tags || []).map((tg) => '<span class="tag mut usertag">' + esc(cap(tg)) + '</span>').join('');
    const favStar = t.fav ? '<span class="tag fav-star">★</span>' : '';
    const vcount = t.primary ? groupCount(t) : 0;
    return '<div class="row"' +
      ' data-id="' + esc(t.id) + '"' +
      ' data-added="' + (+t.added || 0) + '"' +
      ' data-bpm="' + (+t.bpm || 0) + '"' +
      ' data-key="' + esc(t.key) + '"' +
      ' data-fmt="' + esc(t.fmt) + '"' +
      ' data-state="' + esc(t.state) + '"' +
      ' data-fav="' + (t.fav ? 1 : 0) + '"' +
      ' data-tags="' + esc((t.tags || []).join(' ')) + '"' +
      ' data-stems="' + esc((t.stems || []).join(' ')) + '"' +
      (t.group ? ' data-group="' + esc(t.group) + '"' : '') +
      (t.primary ? ' data-primary="1"' : '') +
      (t.vlabel ? ' data-vlabel="' + esc(t.vlabel) + '"' : '') +
      ' data-title="' + esc(t.title) + '"' +
      ' data-artist="' + esc(t.artist) + '"' +
      (t.album ? ' data-album="' + esc(t.album) + '"' : '') +
      (t.album_id ? ' data-album-id="' + esc(t.album_id) + '"' : '') +
      (t.album_total ? ' data-album-total="' + (+t.album_total) + '"' : '') +
      (t.album_kind ? ' data-album-kind="' + esc(t.album_kind) + '"' : '') +
      (t.track_no ? ' data-track-no="' + (+t.track_no) + '"' : '') +
      (t.year ? ' data-year="' + esc(t.year) + '"' : '') +
      (t.genre ? ' data-genre="' + esc(t.genre) + '"' : '') +
      ' data-plays="' + (+t.plays || 0) + '"' +
      ' data-dur="' + (+t.dur || 0) + '">' +
      '<div class="row-coord">' + dateLabel(t.added) + '</div>' +
      '<span class="row-cover cover" style="background:' + (t.cover || '') + '"></span>' +
      '<div class="row-main"><div class="row-title">' + esc(t.title) + '</div><div class="row-artist">' + esc(t.artist) + '</div></div>' +
      '<div class="row-data">' + (+t.bpm || '') + '</div>' +
      '<div class="row-key">' + esc(t.key) + '</div>' +
      '<div class="row-tags">' + favStar + (STATE_TAG[t.state] || '') + stemsBadgeHtml(t.stems) + versionsBadgeHtml(vcount) + tags + '</div>' +
      '<div class="fmt">' + (FMT_SVG[t.fmt] || '') + (FMT_LABEL[t.fmt] || '') + '</div>' +
      '<div class="row-plays">' + (+t.plays || '') + '</div>' +
      '<div class="row-dur">' + mmss(t.dur) + '</div>' +
      '</div>';
  }

  // acervo.js reusa este markup ao inserir uma faixa nova AO VIVO (download do
  // Discovery concluído) — mesma row do load, sem recarregar a página.
  window.RolfRowHtml = rowHtml;

  // Colapso: no Acervo só entra a versão principal de cada grupo (a "pasta").
  // As versões não-principais vivem no drawer "Explorar versões".
  const ledgerTracks = tracks.filter((t) => !t.group || t.primary);
  const ledger = document.querySelector('.screen[data-screen="acervo"] .ledger-scroll');
  if (ledger) ledger.insertAdjacentHTML('beforeend', ledgerTracks.map(rowHtml).join(''));

  /* ---------- Fila "A seguir" ---------- */
  // absIdx = posição ABSOLUTA na fila do core (usada por /api/queue/remove
  // e /api/play {index}). playback.js reusa este markup ao re-renderizar
  // a fila a partir do /api/status.
  function queueRowHtml(t, i, absIdx) {
    return '<div class="tpq-row" draggable="true"' +
      ' data-bg="' + esc(t.cover || '') + '"' +
      ' data-title="' + esc(t.title) + '"' +
      ' data-artist="' + esc(t.artist) + '"' +
      ' data-bpm="' + (+t.bpm || 0) + '"' +
      ' data-id="' + esc(t.id) + '"' +
      ' data-key="' + esc(t.key) + '"' +
      ' data-qindex="' + (absIdx == null ? i : absIdx) + '"' +
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
  const queueTracks = queue.map((id) => byId.get(id)).filter(Boolean);
  if (queueList) queueList.insertAdjacentHTML('beforeend', queueTracks.map(queueRowHtml).join(''));
  const queueCount = document.querySelector('[data-queue-count]');
  if (queueCount) queueCount.textContent = queueTracks.length;

  /* ---------- Topbar: contagem do cofre ---------- */
  const storeCount = document.querySelector('.tb-status .store .meta span');
  if (storeCount) storeCount.textContent = ledgerTracks.length + (ledgerTracks.length === 1 ? ' faixa' : ' faixas');

  // playback.js re-renderiza a fila com o mesmo markup ao sincronizar com o core
  window.RolfQueueRowHtml = queueRowHtml;
})();
