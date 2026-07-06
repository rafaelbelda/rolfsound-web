/* ============================================================
   ROLFSOUND V2 — Discovery (exclusivo admin)
   Busca no YouTube via SSE (/api/search, biblioteca primeiro,
   resultados do YouTube pingando em seguida) e enfileira
   downloads no yt-dlp (/api/downloads), com progresso ao vivo.

   Gate: o módulo só se ativa quando RolfsoundData.account.admin —
   e mesmo assim a UI é só conveniência: o servidor responde 403
   para contas não-admin. Nada aqui é alcançável num build
   comercial (account_type "standard").
   ============================================================ */
(function () {
  'use strict';

  const D = window.RolfsoundData || {};
  if (!(D.account && D.account.admin)) return;   // some da UI por completo

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const scope = $('.screen[data-screen="discovery"]');
  const navBtn = $('.island .isl-btn[data-nav="discovery"]');
  if (!scope || !navBtn) return;
  navBtn.classList.remove('is-hidden');

  const input   = $('[data-dsc-input]', scope);
  const list    = $('[data-dsc-results]', scope);
  const stateEl = $('[data-dsc-state]', scope);
  const dlWrap  = $('[data-dsc-dlwrap]', scope);
  const dlList  = $('[data-dsc-downloads]', scope);
  const dlCount = $('[data-dsc-dlcount]', scope);

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const mmss = (sec) => {
    if (!sec && sec !== 0) return '—';
    sec = Math.max(0, Math.floor(+sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };
  const toast = (text, kicker) =>
    document.dispatchEvent(new CustomEvent('rolf:toast', { detail: { text, kicker } }));

  const vaultIds = new Set((Array.isArray(D.tracks) ? D.tracks : []).map((t) => t.id));

  /* ============================================================
     BUSCA — SSE sobre /api/search
     ============================================================ */
  let es = null;
  let nResults = 0;

  function setState(text) { if (stateEl) stateEl.textContent = text; }

  function emptyEl(title, sub) {
    const el = document.createElement('div');
    el.className = 'dsc-empty';
    el.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2 13 13l-3.8 1.8L11 11z"/></svg>' +
      '<div class="t">' + esc(title) + '</div>' +
      (sub ? '<div class="s">' + esc(sub) + '</div>' : '');
    return el;
  }

  function rowEl(t, inVault) {
    const el = document.createElement('div');
    el.className = 'dsc-row' + (inVault ? ' in-vault' : '');
    el.innerHTML =
      '<span class="dsc-thumb"' + (t.thumbnail ? ' style="background-image:url(&quot;' + esc(t.thumbnail) + '&quot;)"' : '') + '></span>' +
      '<div class="dsc-main"><div class="dsc-title">' + esc(t.title) + '</div>' +
      '<div class="dsc-channel">' + esc(t.channel || t.artist || '') + '</div></div>' +
      '<span class="dsc-dur">' + mmss(t.duration) + '</span>' +
      (inVault
        ? '<button class="dsc-get done" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-11"/></svg>No cofre</button>'
        : '<button class="dsc-get accent"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>Baixar</button>');
    if (!inVault) {
      const btn = $('.dsc-get', el);
      btn.addEventListener('click', () => startDownload(t, btn));
    }
    return el;
  }

  function closeStream() { if (es) { es.close(); es = null; } }

  function search(q) {
    closeStream();
    list.innerHTML = '';
    nResults = 0;
    q = (q || '').trim();
    if (!q) { setState('Digite para buscar'); return; }
    setState('Buscando…');

    es = new EventSource('api/search?q=' + encodeURIComponent(q));

    // faixas do cofre que casam com a busca — sempre chegam primeiro
    es.addEventListener('library', (e) => {
      try {
        (JSON.parse(e.data).tracks || []).forEach((t) => {
          list.appendChild(rowEl({
            id: t.id, title: t.title, channel: t.artist,
            duration: t.duration, thumbnail: t.thumbnail,
          }, true));
          nResults++;
        });
      } catch (_) {}
    });

    es.addEventListener('result', (e) => {
      try {
        const t = JSON.parse(e.data);
        list.appendChild(rowEl(t, vaultIds.has(t.id)));
        nResults++;
        setState(nResults + ' resultado' + (nResults === 1 ? '' : 's'));
      } catch (_) {}
    });

    // evento "error" DO SERVIDOR traz payload; erro de rede do EventSource não
    es.addEventListener('error', (e) => {
      if (e.data) {
        try { setState(JSON.parse(e.data).message || 'Erro na busca'); } catch (_) {}
      } else if (es && es.readyState === EventSource.CLOSED) {
        setState('Busca indisponível');
        closeStream();
      }
    });

    es.addEventListener('done', () => {
      closeStream();
      if (!nResults) {
        list.appendChild(emptyEl('Nenhum resultado', 'Tente outros termos'));
        setState('0 resultados');
      } else {
        setState(nResults + ' resultado' + (nResults === 1 ? '' : 's'));
      }
    });
  }

  let debounceT = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(() => search(input.value), 450);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(debounceT); search(input.value); }
  });
  navBtn.addEventListener('click', () => setTimeout(() => input.focus(), 80));

  /* ============================================================
     DOWNLOADS — enfileira e acompanha progresso
     ============================================================ */
  const STATUS_LABEL = {
    queued: 'Na fila', downloading: 'Baixando', complete: 'Concluído', failed: 'Falhou',
  };
  let pollT = null;
  let primed = false;            // primeira leitura já feita (ver pollOnce)
  const announced = new Set();   // downloads já anunciados como concluídos

  async function startDownload(t, btn) {
    btn.disabled = true;
    btn.textContent = 'Na fila…';
    try {
      const res = await fetch('api/downloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track_id: t.id, title: t.title, thumbnail: t.thumbnail || '' }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      toast(t.title, 'Download');
      startPolling();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Baixar';
      toast('Falha ao enfileirar download', '·');
    }
  }

  function renderDownloads(items) {
    if (!items.length) { dlWrap.hidden = true; return; }
    dlWrap.hidden = false;
    const active = items.filter((d) => d.status === 'queued' || d.status === 'downloading').length;
    if (dlCount) dlCount.textContent = active ? active + ' em andamento' : 'concluídos';
    dlList.innerHTML = items.map((d) => {
      const pct = Math.max(0, Math.min(100, +d.progress || 0));
      return '<div class="dsc-dl-row ' + esc(d.status) + '">' +
        '<div class="dsc-dl-title">' + esc(d.title || d.track_id) + '</div>' +
        '<div class="dsc-dl-bar"><span style="width:' + (d.status === 'complete' ? 100 : pct) + '%"></span></div>' +
        '<div class="dsc-dl-status">' + (STATUS_LABEL[d.status] || esc(d.status)) + (d.status === 'downloading' ? ' · ' + pct + '%' : '') + '</div>' +
        '</div>';
    }).join('');
  }

  // Faixa concluída entra no Acervo AO VIVO: busca o card no shape da UI e
  // pede pro acervo.js inserir a row (sem reload). Se o Acervo não estiver
  // montado ou algo falhar, cai no aviso antigo de recarregar.
  async function addToVault(d) {
    if (!(window.RolfAcervo && window.RolfAcervo.addTrack)) {
      toast(d.title || d.track_id, 'No cofre — recarregue para ver no Acervo');
      return;
    }
    try {
      const res = await fetch('api/library/' + encodeURIComponent(d.track_id) + '/card');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      window.RolfAcervo.addTrack(await res.json());
      toast(d.title || d.track_id, 'No cofre');
    } catch (_) {
      toast(d.title || d.track_id, 'No cofre — recarregue para ver no Acervo');
    }
  }

  async function pollOnce() {
    try {
      const res = await fetch('api/downloads');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const items = (await res.json()).downloads || [];
      renderDownloads(items);
      // Primeira leitura (load): o que já está 'complete' veio do bootstrap e
      // já está no Acervo — marca como anunciado pra não re-inserir/re-toastar.
      // Só as conclusões que acontecem DURANTE a sessão entram ao vivo.
      if (!primed) {
        items.forEach((d) => { if (d.status === 'complete') announced.add(d.track_id); });
        primed = true;
      }
      items.forEach((d) => {
        if (d.status === 'complete' && !announced.has(d.track_id)) {
          announced.add(d.track_id);
          vaultIds.add(d.track_id);
          addToVault(d);
        }
      });
      const active = items.some((d) => d.status === 'queued' || d.status === 'downloading');
      if (!active) stopPolling();
    } catch (_) {
      stopPolling();
    }
  }
  function startPolling() {
    if (pollT) return;
    pollOnce();
    pollT = setInterval(pollOnce, 1500);
  }
  function stopPolling() {
    if (pollT) { clearInterval(pollT); pollT = null; }
  }

  // Downloads que já existiam (ex.: recarregou a página no meio de um): via
  // startPolling, se algum ainda está ativo o poll CONTINUA até concluir — aí
  // a row entra no Acervo ao vivo também nesse caso. Sem nada ativo, o próprio
  // pollOnce chama stopPolling na primeira volta.
  startPolling();
})();
