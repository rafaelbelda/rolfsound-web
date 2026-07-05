/* ============================================================
   ROLFSOUND V2 — VERSÕES ALTERNATIVAS (pasta de versões)
   Agrupa faixas que são a mesma música (Instrumental, Beat,
   Stem Version, feats diferentes…). No Acervo só a versão
   principal aparece, com um selo "N versões"; as demais vivem
   neste drawer.

   · Botão direito → "Explorar versões" (ou clique no selo).
   · Drawer (mesmo dock dos stems): lista as versões, permite
     tocar / enfileirar qualquer uma, definir a principal (a que
     toca por padrão), editar o rótulo e remover do grupo.
   · "Adicionar versão": mini-buscador das faixas soltas.
   · Sugestão automática: ao salvar o editor com título+artista
     que batem com outra faixa, oferece agrupar (você confirma).

   O Acervo (colapsado) é reconciliado ao FECHAR o drawer, quando
   houve mudança estrutural — mesmo padrão de reload do importer.
   ============================================================ */
(function () {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const toast = (text, kicker) =>
    document.dispatchEvent(new CustomEvent('rolf:toast', { detail: { text, kicker } }));
  const mmss = (sec) => {
    sec = Math.max(0, Math.floor(+sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  const dock  = $('[data-dock]');
  const panel = $('[data-panel]');
  const inner = $('[data-panel-inner]');

  async function api(path, method = 'GET', body) {
    const opt = { method };
    if (body !== undefined) {
      opt.headers = { 'Content-Type': 'application/json' };
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(path, opt);
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { msg = (await res.json()).detail || msg; } catch (_) {}
      throw new Error(msg);
    }
    return res.json().catch(() => ({}));
  }

  /* ---------- estado do drawer ---------- */
  const drawer = {
    id: '', group_id: '', primary_id: '',
    versions: [], dirty: false, adding: false, q: '',
  };
  const isVersionsPanel = () => !!(inner && $('[data-ver-root]', inner));

  const rowFor = (id) =>
    id ? $('.screen[data-screen="acervo"] .row[data-id="' + cssEsc(id) + '"]') : null;

  /* ============================================================
     ABRIR / FECHAR (dock compartilhado, igual stems/track-panels)
     ============================================================ */
  async function openDrawer(id) {
    if (!dock || !panel || !inner || !id) return;
    drawer.id = id;
    drawer.dirty = false;
    drawer.adding = false;
    drawer.q = '';
    try {
      const data = await api('api/library/' + encodeURIComponent(id) + '/versions');
      drawer.group_id  = data.group_id || '';
      drawer.primary_id = data.primary_id || id;
      drawer.versions  = data.versions || [];
    } catch (e) {
      console.error('versions list failed:', e);
      toast('Não foi possível abrir as versões', 'Versões');
      return;
    }
    dock.classList.add('panel-open', 'panel-tall');
    panel.style.height = '';   // solta altura sob medida deixada pelo Ver álbum
    dock.classList.remove('queue-open');
    const qb = $('[data-queue-open]'); if (qb) qb.classList.remove('is-on');
    const q = $('[data-queue]'); if (q) q.setAttribute('aria-hidden', 'true');
    panel.setAttribute('aria-hidden', 'false');
    render();
  }

  function closeDrawer() {
    if (!dock) return;
    dock.classList.remove('panel-open');
    if (panel) panel.setAttribute('aria-hidden', 'true');
    // reconciliação do Acervo colapsado (mesma convenção do importer)
    if (drawer.dirty) { drawer.dirty = false; location.reload(); }
  }

  // Fechar por clique fora dispara o handler do track-panels.js (remove
  // panel-open sem passar pelo nosso closeDrawer). Observamos a classe para
  // recarregar o Acervo se algo mudou enquanto as versões estavam abertas.
  if (dock) {
    let wasOpen = dock.classList.contains('panel-open');
    new MutationObserver(() => {
      const open = dock.classList.contains('panel-open');
      if (wasOpen && !open && drawer.dirty && isVersionsPanel()) {
        drawer.dirty = false;
        location.reload();
      }
      wasOpen = open;
    }).observe(dock, { attributes: true, attributeFilter: ['class'] });
  }

  /* ============================================================
     RENDER
     ============================================================ */
  const ICON = {
    play:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4 18.6 12 8 18.6z"/></svg>',
    queue:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h11M4 12h11M4 17h7"/><path d="M17 14v6M14 17h6"/></svg>',
    star:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8L3.5 9.7l5.9-.9z"/></svg>',
    starO:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8L3.5 9.7l5.9-.9z"/></svg>',
    x:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    add:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    chev:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>',
    check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-11"/></svg>',
    tag:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/></svg>',
  };

  function primaryVer() { return drawer.versions.find((v) => v.is_primary) || drawer.versions[0]; }
  function songTitle() { const p = primaryVer(); return p ? p.title : 'Faixa'; }

  // mini badge de 4 pontos: esta versão é a Stem Ready (toca multipista)
  function stemBadgeHtml(v) {
    if (!v.stem_ready) return '';
    const t = ((window.RolfsoundData || {}).tracks || []).find((x) => x.id === v.id);
    const roles = (t && t.stems) || [];
    if (window.RolfStemsBadgeHtml) {
      const html = window.RolfStemsBadgeHtml(roles.length ? roles : ['vocals', 'drums', 'bass', 'other']);
      if (html) return html;
    }
    return '<span class="tag stems" title="Stem Ready — toca multipista">Stems</span>';
  }

  function verRowHtml(v, i) {
    const sub = [v.artist, (+v.bpm ? v.bpm + ' BPM' : ''), v.key].filter(Boolean).join(' · ');
    const labelBtn = v.label
      ? '<button class="ver-label has" data-ver-label="' + esc(v.id) + '">' + esc(v.label) + '</button>'
      : '<button class="ver-label" data-ver-label="' + esc(v.id) + '">' + ICON.tag + 'rótulo</button>';
    return '<div class="ver-trk' + (v.is_primary ? ' primary' : '') + '" data-id="' + esc(v.id) + '">' +
      '<button class="ver-star' + (v.is_primary ? ' on' : '') + '" data-ver-primary="' + esc(v.id) + '"' +
        (v.is_primary ? ' title="Versão principal"' : ' title="Definir como principal"') + '>' +
        (v.is_primary ? ICON.star : ICON.starO) + '</button>' +
      '<span class="row-cover cover ver-cover" style="background:' + (v.cover || '') + '"></span>' +
      '<div class="ver-main"><div class="ver-name">' + esc(v.title) + '</div>' +
        '<div class="ver-sub">' + esc(sub) + '</div></div>' +
      stemBadgeHtml(v) +
      labelBtn +
      '<span class="ver-dur">' + mmss(v.dur) + '</span>' +
      '<div class="ver-actions">' +
        '<button class="ver-act" data-ver-play="' + esc(v.id) + '" title="Tocar esta versão">' + ICON.play + '</button>' +
        '<button class="ver-act" data-ver-queue="' + esc(v.id) + '" title="Adicionar à fila">' + ICON.queue + '</button>' +
        '<button class="ver-act danger" data-ver-remove="' + esc(v.id) + '" title="Remover do grupo">' + ICON.x + '</button>' +
      '</div></div>';
  }

  function candidates() {
    const memberIds = new Set(drawer.versions.map((v) => v.id));
    const q = drawer.q.trim().toLowerCase();
    return ((window.RolfsoundData || {}).tracks || [])
      .filter((t) => !t.group && !memberIds.has(t.id))
      .filter((t) => !q || (t.title || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q))
      .slice(0, 40);
  }

  function pickHtml(t) {
    return '<button class="ver-pick" data-ver-pick="' + esc(t.id) + '">' +
      '<span class="row-cover cover ver-cover" style="background:' + (t.cover || '') + '"></span>' +
      '<span class="ver-pick-main"><span class="ver-pick-name">' + esc(t.title) + '</span>' +
      '<span class="ver-pick-sub">' + esc(t.artist || '') + '</span></span>' +
      '<span class="ver-pick-add">' + ICON.add + '</span></button>';
  }

  function pickerHtml() {
    if (!drawer.adding) return '';
    const list = candidates().map(pickHtml).join('');
    return '<div class="ver-picker">' +
      '<input class="ver-search" data-ver-search placeholder="Buscar faixa solta para vincular…" value="' + esc(drawer.q) + '">' +
      '<div class="ver-pick-list">' + (list || '<div class="ver-empty">Nenhuma faixa solta encontrada.</div>') + '</div>' +
      '</div>';
  }

  function render() {
    if (!inner) return;
    const n = drawer.versions.length;
    const p = primaryVer();
    inner.innerHTML =
      '<div data-ver-root style="display:flex;flex-direction:column;height:100%">' +
      '<div class="tpp-head">' +
        '<div class="tpp-kicker">Versões alternativas</div>' +
        '<div class="tpp-spacer"></div>' +
        '<button class="tpp-close" data-ver-done aria-label="Fechar">' + ICON.chev + '</button>' +
      '</div>' +
      '<div class="tpp-hero">' +
        '<span class="tpp-hero-art" style="background:' + ((p && p.cover) || '') + '"></span>' +
        '<div class="tpp-hero-info">' +
          '<div class="tpp-hero-name">' + esc(songTitle()) + '</div>' +
          '<div class="tpp-hero-meta">' +
            (p && p.artist ? '<span>' + esc(p.artist) + '</span><span class="d"></span>' : '') +
            '<span>' + n + (n === 1 ? ' versão' : ' versões') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="tpp-spacer"></div>' +
        '<button class="tpp-btn accent" data-ver-play-primary>' + ICON.play + 'Tocar principal</button>' +
      '</div>' +
      '<div class="tpp-scroll">' +
        '<div class="tpp-section">Versões — ★ toca ao dar play no Acervo</div>' +
        '<div class="ver-list">' + drawer.versions.map(verRowHtml).join('') + '</div>' +
        '<div class="tpp-section">Adicionar versão</div>' +
        '<div class="ver-add-wrap">' +
          '<button class="ver-add-btn" data-ver-add>' + (drawer.adding ? ICON.x + 'Fechar busca' : ICON.add + 'Vincular outra faixa') + '</button>' +
          pickerHtml() +
        '</div>' +
      '</div>' +
      '</div>';
    wire();
  }

  /* ============================================================
     WIRING
     ============================================================ */
  function verById(id) { return drawer.versions.find((v) => v.id === id); }

  function playVersion(v) {
    if (!v) return;
    if (window.RolfShowTrack) window.RolfShowTrack({
      id: v.id, title: v.title, artist: v.artist, bg: v.cover,
      bpm: v.bpm, key: v.key, dur: v.dur,
    });
    if (window.RolfPlayback) window.RolfPlayback.playTrack(v.id, +v.dur || 0);
    toast(v.title, 'Tocando');
  }

  function queueVersion(v) {
    if (!v) return;
    if (window.RolfPlayback) window.RolfPlayback.queueAdd(v.id);
    toast(v.title, 'Na fila');
  }

  function applyPayload(data) {
    drawer.group_id  = data.group_id || '';
    drawer.primary_id = data.primary_id || drawer.id;
    drawer.versions  = data.versions || [];
    drawer.dirty = true;
    render();
  }

  async function addMember(memberId) {
    try {
      const data = await api('api/library/' + encodeURIComponent(drawer.id) + '/versions', 'POST', { member_id: memberId });
      drawer.adding = false; drawer.q = '';
      applyPayload(data);
      toast('Versão vinculada', 'Versões');
    } catch (e) {
      console.error('add version failed:', e);
      toast(e.message || 'Não foi possível vincular', 'Versões');
    }
  }

  async function setPrimary(id) {
    try {
      const data = await api('api/library/' + encodeURIComponent(drawer.id) + '/versions/primary', 'PATCH', { track_id: id });
      applyPayload(data);
      toast('Versão principal definida', 'Versões');
    } catch (e) {
      console.error('set primary failed:', e);
      toast(e.message || 'Falha ao definir principal', 'Versões');
    }
  }

  async function removeMember(id) {
    try {
      const data = await api('api/library/' + encodeURIComponent(drawer.id) + '/versions/' + encodeURIComponent(id), 'DELETE');
      applyPayload(data);
      toast('Removida do grupo', 'Versões');
    } catch (e) {
      console.error('remove version failed:', e);
      toast(e.message || 'Falha ao remover', 'Versões');
    }
  }

  function editLabel(id, btn) {
    const v = verById(id);
    if (!v) return;
    const input = document.createElement('input');
    input.className = 'ver-label-input';
    input.value = v.label || '';
    input.placeholder = 'ex.: Instrumental';
    btn.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      const val = input.value.trim();
      if (val === (v.label || '')) { render(); return; }
      try {
        await api('api/library/' + encodeURIComponent(id), 'PATCH', { version_label: val });
        v.label = val;
        // rótulo espelhado na row do Acervo (não muda o colapso → sem reload)
        const row = rowFor(id);
        if (row) { if (val) row.dataset.vlabel = val; else row.removeAttribute('data-vlabel'); }
        const t = ((window.RolfsoundData || {}).tracks || []).find((x) => x.id === id);
        if (t) t.vlabel = val;
      } catch (e) {
        console.error('label save failed:', e);
        toast('Não foi possível salvar o rótulo', 'Versões');
      }
      render();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); done = true; render(); }
    });
  }

  function wire() {
    const done = $('[data-ver-done]', inner);
    if (done) done.addEventListener('click', closeDrawer);

    const playP = $('[data-ver-play-primary]', inner);
    if (playP) playP.addEventListener('click', () => playVersion(primaryVer()));

    $$('[data-ver-play]', inner).forEach((b) =>
      b.addEventListener('click', () => playVersion(verById(b.dataset.verPlay))));
    $$('[data-ver-queue]', inner).forEach((b) =>
      b.addEventListener('click', () => queueVersion(verById(b.dataset.verQueue))));
    $$('[data-ver-primary]', inner).forEach((b) =>
      b.addEventListener('click', () => { if (!b.disabled) setPrimary(b.dataset.verPrimary); }));
    $$('[data-ver-remove]', inner).forEach((b) =>
      b.addEventListener('click', () => removeMember(b.dataset.verRemove)));
    $$('[data-ver-label]', inner).forEach((b) =>
      b.addEventListener('click', () => editLabel(b.dataset.verLabel, b)));

    const addBtn = $('[data-ver-add]', inner);
    if (addBtn) addBtn.addEventListener('click', () => { drawer.adding = !drawer.adding; drawer.q = ''; render(); });

    const search = $('[data-ver-search]', inner);
    if (search) {
      search.addEventListener('input', () => {
        drawer.q = search.value;
        const list = $('.ver-pick-list', inner);
        if (list) {
          const html = candidates().map(pickHtml).join('');
          list.innerHTML = html || '<div class="ver-empty">Nenhuma faixa solta encontrada.</div>';
          wirePicks();
        }
      });
      // mantém o foco após re-render parcial
      requestAnimationFrame(() => { const s = $('[data-ver-search]', inner); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } });
    }
    wirePicks();
  }

  function wirePicks() {
    $$('[data-ver-pick]', inner).forEach((b) =>
      b.addEventListener('click', () => addMember(b.dataset.verPick)));
  }

  /* ============================================================
     SUGESTÃO AUTOMÁTICA (após salvar o editor)
     ============================================================ */
  let suggestCard = null;
  function dismissSuggest() { if (suggestCard) { suggestCard.remove(); suggestCard = null; } }

  async function maybeSuggest(id) {
    if (!id) return;
    let data;
    try {
      data = await api('api/library/' + encodeURIComponent(id) + '/version-suggestions');
    } catch (_) { return; }
    const sugg = (data && data.suggestions) || [];
    if (!sugg.length) return;
    showSuggest(id, sugg);
  }

  function showSuggest(id, sugg) {
    dismissSuggest();
    const names = sugg.slice(0, 3).map((s) => s.title).join(', ') + (sugg.length > 3 ? '…' : '');
    suggestCard = document.createElement('div');
    suggestCard.className = 'ver-suggest';
    suggestCard.innerHTML =
      '<div class="ver-suggest-kicker">' + ICON.tag + 'Versões</div>' +
      '<div class="ver-suggest-body">Encontramos <b>' + sugg.length + '</b> faixa' + (sugg.length === 1 ? '' : 's') +
        ' com o mesmo nome e artista (' + esc(names) + '). Agrupar como versões?</div>' +
      '<div class="ver-suggest-actions">' +
        '<button class="tpp-btn" data-sg-no>Agora não</button>' +
        '<button class="tpp-btn accent" data-sg-yes>' + ICON.check + 'Agrupar</button>' +
      '</div>';
    document.body.appendChild(suggestCard);
    $('[data-sg-no]', suggestCard).addEventListener('click', dismissSuggest);
    $('[data-sg-yes]', suggestCard).addEventListener('click', async () => {
      dismissSuggest();
      try {
        for (const s of sugg) {
          await api('api/library/' + encodeURIComponent(id) + '/versions', 'POST', { member_id: s.id });
        }
        toast('Agrupadas como versões', 'Versões');
        setTimeout(() => location.reload(), 500);
      } catch (e) {
        console.error('group suggestion failed:', e);
        toast(e.message || 'Não foi possível agrupar', 'Versões');
      }
    });
    setTimeout(() => { if (suggestCard) dismissSuggest(); }, 12000);
  }

  /* ============================================================
     INIT
     ============================================================ */
  function init() {
    // menu de contexto: "Explorar versões" / "Versões alternativas"
    document.addEventListener('rolf:ctx', (e) => {
      const { action, row } = e.detail || {};
      if (action === 'versions' && row && row.dataset.id) openDrawer(row.dataset.id);
    });

    // clique no selo "N versões" da row (fase de captura para não disparar o play)
    document.addEventListener('click', (e) => {
      const badge = e.target.closest && e.target.closest('.tag.versions');
      if (!badge) return;
      const row = badge.closest('.row');
      if (!row || !row.dataset.id) return;
      e.stopPropagation();
      e.preventDefault();
      openDrawer(row.dataset.id);
    }, true);

    // sugestão após salvar edição de metadados (track-panels.js emite o evento)
    document.addEventListener('rolf:track-saved', (e) => {
      const id = (e.detail || {}).id;
      if (id) maybeSuggest(id);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
