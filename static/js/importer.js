/* ============================================================
   ROLFSOUND V2 — Intake: importar arquivos por drag & drop
   · Solte arquivos de áudio em qualquer lugar do app: a camada
     de captura aparece (retículo + mira de coordenadas), o
     arquivo sobe para POST api/library/upload e a ficha técnica
     abre na gaveta do dock — capa, campos editáveis, fatos do
     arquivo e o manifesto de etiquetas cruas.
   · Sem etiquetas de título/artista, dispara a identificação
     por impressão digital (rota /identify já existente).
   · Pontos de entrada: drop, botão "Importar" no Acervo, menu
     de contexto ("Importar arquivos" / "Ficha técnica").
   ============================================================ */
(function () {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const dock  = $('[data-dock]');
  const panel = $('[data-panel]');
  const inner = $('[data-panel-inner]');
  if (!dock || !panel || !inner) return;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const toast = (text, kicker) =>
    document.dispatchEvent(new CustomEvent('rolf:toast', { detail: { text, kicker } }));

  const OK_EXT = ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'webm'];
  const extOf = (name) => (name.split('.').pop() || '').toLowerCase();

  /* ---------- formatação ---------- */
  const mmss = (sec) => {
    sec = Math.max(0, Math.floor(+sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };
  const fmtSize = (b) => {
    if (!b) return '';
    if (b < 1048576) return Math.round(b / 1024) + ' KB';
    return (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
  };
  const fmtKHz = (sr) => sr ? (sr / 1000).toFixed(1).replace(/\.0$/, '') + ' kHz' : '';
  const fmtCh = (n) => n === 1 ? 'Mono' : n === 2 ? 'Estéreo' : n ? n + ' canais' : '';
  // aspas simples: o valor vai dentro de style="…" (aspas duplas quebrariam o atributo)
  const coverBg = (url) => {
    if (!url) return '';
    const u = String(url).replace(/'/g, '%27').replace(/"/g, '%22');
    return "url('" + u + "') center/cover no-repeat, #141416";
  };

  /* ============================================================
     CAMADA DE DROP — retículo + mira de coordenadas
     ============================================================ */
  const intake = document.createElement('div');
  intake.className = 'intake';
  intake.setAttribute('aria-hidden', 'true');
  intake.innerHTML =
    '<span class="intake-x"></span><span class="intake-y"></span>' +
    '<div class="intake-ret">' +
      '<i class="tick tl"></i><i class="tick tr"></i><i class="tick bl"></i><i class="tick br"></i>' +
      '<div class="intake-eyebrow">Intake · Catalogação</div>' +
      '<div class="intake-title">Solte no cofre</div>' +
      '<div class="intake-sub">O arquivo entra no Acervo com as etiquetas, a capa embutida e a ficha técnica completa.</div>' +
      '<div class="intake-fmts">MP3 · FLAC · WAV · M4A · AAC · OGG · OPUS</div>' +
    '</div>' +
    '<span class="intake-read">—</span>';
  document.body.appendChild(intake);
  const xLine = $('.intake-x', intake);
  const yLine = $('.intake-y', intake);
  const read  = $('.intake-read', intake);

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  function showIntake(on) {
    intake.classList.toggle('on', on);
    intake.setAttribute('aria-hidden', on ? 'false' : 'true');
    if (!on) dragDepth = 0;
  }
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    showIntake(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const x = e.clientX, y = e.clientY;
    xLine.style.top = y + 'px';
    yLine.style.left = x + 'px';
    read.style.left = x + 'px';
    read.style.top = y + 'px';
    read.textContent =
      'X ' + String(Math.round(x)).padStart(4, '0') +
      ' · Y ' + String(Math.round(y)).padStart(4, '0');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showIntake(false);
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    showIntake(false);
    addFiles(e.dataTransfer.files);
  });

  /* ============================================================
     SESSÃO DE INTAKE
     item: { name, file, state, pct, dossier, error, standalone, row }
     state: fila | enviando | identificando | ok | dup | erro
     ============================================================ */
  const session = { items: [], active: -1, uploading: false };

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.accept = OK_EXT.map((x) => '.' + x).join(',') + ',audio/*';
  picker.style.display = 'none';
  document.body.appendChild(picker);
  picker.addEventListener('change', () => {
    addFiles(picker.files);
    picker.value = '';
  });

  function addFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const good = files.filter((f) => OK_EXT.includes(extOf(f.name)));
    const bad = files.length - good.length;
    if (bad) toast(bad === 1 ? 'Arquivo ignorado — formato não suportado' : bad + ' arquivos ignorados — formato não suportado', 'Intake');
    if (!good.length) return;
    // itens standalone (ficha de faixa existente) não se misturam à sessão
    session.items = session.items.filter((i) => !i.standalone);
    good.forEach((f) => session.items.push({ name: f.name, file: f, state: 'fila', pct: 0, dossier: null, error: '' }));
    session.active = session.items.length - good.length;
    openPanel();
    pump();
  }

  /* upload sequencial com progresso */
  function pump() {
    if (session.uploading) return;
    const item = session.items.find((i) => i.state === 'fila');
    if (!item) { maybeAnnounceDone(); return; }
    session.uploading = true;
    item.state = 'enviando';
    renderIfOpen();

    const form = new FormData();
    form.append('file', item.file, item.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'api/library/upload');
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        item.pct = Math.round((e.loaded / e.total) * 100);
        updateProgress(item);
      }
    });
    xhr.addEventListener('load', () => {
      session.uploading = false;
      if (xhr.status >= 200 && xhr.status < 300) {
        try { item.dossier = JSON.parse(xhr.responseText); } catch (_) { item.dossier = null; }
        if (!item.dossier) {
          item.state = 'erro'; item.error = 'Resposta inválida do servidor';
        } else {
          item.file = null; // libera memória
          finishItem(item);
        }
      } else {
        let msg = 'Falha no envio';
        try { msg = JSON.parse(xhr.responseText).detail || msg; } catch (_) {}
        item.state = 'erro'; item.error = msg;
        toast(item.name, 'Falhou');
      }
      renderIfOpen();
      pump();
    });
    xhr.addEventListener('error', () => {
      session.uploading = false;
      item.state = 'erro'; item.error = 'Falha no envio — verifique a conexão';
      toast(item.name, 'Falhou');
      renderIfOpen();
      pump();
    });
    xhr.send(form);
  }

  function finishItem(item) {
    const t = item.dossier.track || {};
    item.state = item.dossier.duplicate_of ? 'dup' : 'ok';
    toast(t.title || item.name, 'No cofre');
    // sem título/artista nas etiquetas → identificação automática
    if (t.status !== 'identified') identify(item, true);
  }

  /* identificação por impressão digital (AcoustID → Shazam → Discogs) */
  async function identify(item, auto) {
    const t = item.dossier && item.dossier.track;
    if (!t || item.state === 'identificando') return;
    const prev = item.state;
    item.state = 'identificando';
    renderIfOpen();
    try {
      const res = await fetch('api/library/' + encodeURIComponent(t.id) + '/identify', { method: 'POST' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const fresh = await fetch('api/library/' + encodeURIComponent(t.id) + '/dossier');
      if (fresh.ok) item.dossier = await fresh.json();
      const nt = item.dossier.track || {};
      item.state = item.dossier.duplicate_of ? 'dup' : 'ok';
      if (nt.status === 'identified') toast(nt.title || item.name, 'Identificada');
      else if (!auto) toast('Sem correspondência na base', 'Não identificada');
    } catch (e) {
      console.error('identify failed:', e);
      item.state = prev === 'identificando' ? 'ok' : prev;
      if (!auto) toast('Não foi possível identificar', 'Erro');
    }
    renderIfOpen();
  }

  function maybeAnnounceDone() {
    const real = session.items.filter((i) => !i.standalone);
    if (!real.length || real.some((i) => i.state === 'fila' || i.state === 'enviando')) return;
    // sessão terminou com a gaveta fechada → avisa (a atualização acontece no Concluir)
    if (!dock.classList.contains('panel-open')) {
      toast(real.length === 1 ? 'Importação concluída' : real.length + ' arquivos importados', 'Intake');
    }
  }

  /* ============================================================
     GAVETA — ficha técnica
     ============================================================ */
  function openPanel() {
    dock.classList.add('panel-open', 'panel-tall');
    dock.classList.remove('queue-open');
    const qb = $('[data-queue-open]'); if (qb) qb.classList.remove('is-on');
    const q = $('[data-queue]'); if (q) q.setAttribute('aria-hidden', 'true');
    panel.setAttribute('aria-hidden', 'false');
    render();
  }
  function closePanel() {
    dock.classList.remove('panel-open');
    panel.setAttribute('aria-hidden', 'true');
  }
  function renderIfOpen() {
    if (dock.classList.contains('panel-open') && $('[data-imp-root]', inner)) render();
  }
  function activeItem() {
    return session.items[session.active] || null;
  }

  const ST_LABEL = {
    fila: 'Na fila', enviando: 'Enviando', identificando: 'Identificando',
    ok: 'No cofre', dup: 'Duplicata?', erro: 'Falhou',
  };

  function railHtml() {
    const chips = session.items.map((i, idx) => {
      const nm = (i.dossier && i.dossier.track && i.dossier.track.title) || i.name;
      const pct = i.state === 'enviando' ? ' · ' + i.pct + '%' : '';
      return '<button class="imp-chip' + (idx === session.active ? ' on' : '') + '" data-st="' + i.state + '" data-idx="' + idx + '">' +
        '<span class="st"></span><span class="nm">' + esc(nm) + '</span><span data-chip-pct>' + pct + '</span></button>';
    }).join('');
    const add = '<button class="imp-chip add" data-imp-add>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Adicionar</button>';
    return '<div class="imp-rail" data-imp-rail>' + chips + add + '</div>';
  }

  function factsHtml(d) {
    const f = d.file || {};
    const t = d.track || {};
    const rows = [
      ['Formato', f.codec || f.ext || ''],
      ['Duração', f.duration ? mmss(f.duration) : (t.duration ? mmss(t.duration) : '')],
      ['Amostragem', fmtKHz(f.sample_rate)],
      ['Taxa', f.bitrate ? f.bitrate + ' kbps' : ''],
      ['Canais', fmtCh(f.channels)],
      ['Bits', f.bits ? f.bits + '-bit' : ''],
      ['Tamanho', fmtSize(f.size)],
    ].filter((r) => r[1]);
    const file = f.name ? '<div class="imp-fact"><span>Arquivo</span><b title="' + esc(f.name) + '">' + esc(f.name) + '</b></div>' : '';
    return rows.map((r) => '<div class="imp-fact"><span>' + r[0] + '</span><b>' + esc(r[1]) + '</b></div>').join('') + file;
  }

  function coordLine(d) {
    const f = d.file || {};
    return [f.codec || f.ext, fmtKHz(f.sample_rate), f.bitrate ? f.bitrate + ' kbps' : '']
      .filter(Boolean).join(' · ');
  }

  const FIELDS = [
    ['title',  'Título da faixa', 'col2', ''],
    ['artist', 'Artista', '', ''],
    ['album',  'Álbum', '', ''],
    ['year',   'Ano de lançamento', '', 'mono'],
    ['genre',  'Gênero', '', ''],
    ['bpm',    'BPM', '', 'mono'],
    ['key',    'Tom', '', 'mono'],
  ];

  function fieldsHtml(t) {
    return '<div class="tpp-fields">' + FIELDS.map(([k, label, col, mono]) =>
      '<div class="tpp-field' + (col ? ' ' + col : '') + '"><span class="tpp-label">' + label + '</span>' +
      '<input class="tpp-input' + (mono ? ' mono' : '') + '" data-f="' + k + '" value="' + esc(t[k] == null ? '' : t[k]) + '"></div>'
    ).join('') + '</div>';
  }

  function statusHtml(item) {
    const d = item.dossier || {};
    const t = d.track || {};
    if (item.state === 'identificando') return '<div class="imp-status busy">Identificando pela impressão digital…</div>';
    if (item.state === 'erro') return '<div class="imp-status erro">' + esc(item.error || 'Falhou') + '</div>';
    const dup = d.duplicate_of
      ? '<div class="imp-status">Possível duplicata de ' + esc(d.duplicate_of.title || d.duplicate_of.id) +
        (d.duplicate_of.artist ? ' — ' + esc(d.duplicate_of.artist) : '') + '</div>'
      : '';
    if (t.status === 'identified') return '<div class="imp-status ok">No cofre · etiquetas aplicadas</div>' + dup;
    return '<div class="imp-status">No cofre · sem etiquetas de título/artista — identifique pela impressão digital</div>' + dup;
  }

  function manifestHtml(d) {
    const list = d.manifest || [];
    const rows = list.map((x) =>
      '<div class="imp-tag"><span class="k">' + esc(x.k) + '</span><span class="v">' + esc(x.v) + '</span></div>'
    ).join('');
    return '<div class="imp-manifest">' +
      '<div class="imp-manifest-head">Etiquetas do arquivo' + (list.length ? '<span class="n">' + list.length + '</span>' : '') + '</div>' +
      '<div class="imp-manifest-scroll">' +
      (rows || '<div class="imp-manifest-empty">O arquivo não trouxe etiquetas embutidas.<br>Identifique pela impressão digital para preencher a ficha.</div>') +
      '</div></div>';
  }

  function bodyHtml(item) {
    if (!item) return '<div class="imp-void">Nenhum arquivo selecionado</div>';
    if (!item.dossier) {
      if (item.state === 'erro') return '<div class="imp-void">' + esc(item.error || 'Falhou') + '</div>';
      const label = item.state === 'enviando' ? 'Enviando · ' + item.pct + '%' : 'Na fila';
      return '<div class="imp-body"><div class="imp-side">' +
        '<div class="imp-art"><span class="no-art">' + esc(extOf(item.name).toUpperCase()) + '</span></div></div>' +
        '<div class="imp-fields-wrap">' +
        '<div class="imp-status busy" data-up-label>' + label + '</div>' +
        '<div class="imp-progress"><span data-up-bar style="width:' + item.pct + '%"></span></div>' +
        '</div><div class="imp-manifest"><div class="imp-manifest-head">Etiquetas do arquivo</div>' +
        '<div class="imp-manifest-empty">Lendo o arquivo…</div></div></div>';
    }
    const d = item.dossier, t = d.track || {};
    const art = d.cover
      ? '<div class="imp-art" style="background:' + coverBg(d.cover) + '"></div>'
      : '<div class="imp-art"><span class="no-art">Sem capa</span></div>';
    return '<div class="imp-body">' +
      '<div class="imp-side">' + art +
        '<div class="imp-coord">' + esc(coordLine(d)) + '</div>' +
        '<div class="imp-facts">' + factsHtml(d) + '</div>' +
      '</div>' +
      '<div class="imp-fields-wrap">' + statusHtml(item) + fieldsHtml(t) + '</div>' +
      manifestHtml(d) +
      '</div>';
  }

  function render() {
    const item = activeItem();
    const standalone = item && item.standalone;
    const title = (item && ((item.dossier && item.dossier.track && item.dossier.track.title) || item.name)) || 'Importar';
    const canIdentify = item && item.dossier && item.dossier.track && !(item.dossier.file || {}).missing;

    inner.innerHTML =
      '<div data-imp-root style="display:flex;flex-direction:column;height:100%">' +
      '<div class="tpp-head">' +
        '<div><div class="tpp-kicker">' + (standalone ? 'Ficha técnica' : 'Intake · Ficha técnica') + '</div>' +
        '<div class="tpp-h-title">' + esc(title) + '</div></div>' +
        '<div class="tpp-spacer"></div>' +
        (canIdentify ? '<button class="tpp-btn" data-imp-identify' + (item.state === 'identificando' ? ' disabled' : '') + '>Identificar</button>' : '') +
        (canIdentify ? '<button class="tpp-btn" data-imp-save hidden>Salvar alterações</button>' : '') +
        (standalone
          ? '<button class="tpp-close" data-imp-close aria-label="Fechar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></button>'
          : '<button class="tpp-btn accent" data-imp-done><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-11"/></svg>Concluir</button>') +
      '</div>' +
      (standalone ? '' : railHtml()) +
      bodyHtml(item) +
      '</div>';

    wire();
  }

  function updateProgress(item) {
    // atualização leve durante o envio, sem re-renderizar os inputs
    if (!dock.classList.contains('panel-open')) return;
    const bar = $('[data-up-bar]', inner);
    const label = $('[data-up-label]', inner);
    if (bar) bar.style.width = item.pct + '%';
    if (label) label.textContent = 'Enviando · ' + item.pct + '%';
    const chip = $('.imp-chip[data-idx="' + session.items.indexOf(item) + '"] [data-chip-pct]', inner);
    if (chip) chip.textContent = ' · ' + item.pct + '%';
  }

  function wire() {
    const item = activeItem();

    $$('.imp-chip[data-idx]', inner).forEach((c) => c.addEventListener('click', () => {
      session.active = +c.dataset.idx;
      render();
    }));
    const add = $('[data-imp-add]', inner);
    if (add) add.addEventListener('click', () => picker.click());

    const done = $('[data-imp-done]', inner);
    if (done) done.addEventListener('click', () => {
      closePanel();
      const saved = session.items.some((i) => i.dossier && !i.standalone);
      session.items = []; session.active = -1;
      if (saved) {
        toast('Atualizando o Acervo…', 'Intake');
        setTimeout(() => location.reload(), 650);
      }
    });
    const close = $('[data-imp-close]', inner);
    if (close) close.addEventListener('click', closePanel);

    const idBtn = $('[data-imp-identify]', inner);
    if (idBtn && item) idBtn.addEventListener('click', () => identify(item, false));

    const saveBtn = $('[data-imp-save]', inner);
    if (saveBtn && item) {
      $$('.tpp-input', inner).forEach((inp) =>
        inp.addEventListener('input', () => { saveBtn.hidden = false; }));
      saveBtn.addEventListener('click', () => saveEdits(item, saveBtn));
    }
  }

  async function saveEdits(item, btn) {
    const t = item.dossier.track;
    const get = (f) => { const el = $('[data-f="' + f + '"]', inner); return el ? el.value.trim() : ''; };
    const v = { title: get('title'), artist: get('artist'), album: get('album'), year: get('year'), genre: get('genre'), bpm: get('bpm'), key: get('key') };
    btn.disabled = true;
    try {
      const res = await fetch('api/library/' + encodeURIComponent(t.id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: v.title, artist: v.artist, album: v.album,
          year: v.year ? Number(v.year) : null,
          genre: v.genre, bpm: v.bpm ? Number(v.bpm) : null, key: v.key,
        }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      Object.assign(t, { title: v.title, artist: v.artist, album: v.album, year: v.year, genre: v.genre, bpm: v.bpm, key: v.key });
      syncRow(item, v);
      btn.hidden = true;
      const headTitle = $('.tpp-h-title', inner);
      if (headTitle) headTitle.textContent = v.title || item.name;
      toast(v.title || item.name, 'Salvo');
    } catch (e) {
      console.error('save dossier failed:', e);
      toast('Não foi possível salvar', 'Erro');
    } finally {
      btn.disabled = false;
    }
  }

  /* espelha edições na row do ledger (fichas de faixas já renderizadas) */
  function syncRow(item, v) {
    const row = item.row ||
      $('.screen[data-screen="acervo"] .row[data-id="' + (CSS && CSS.escape ? CSS.escape(item.dossier.track.id) : item.dossier.track.id) + '"]');
    if (!row) return;
    row.dataset.title = v.title; row.dataset.artist = v.artist;
    row.dataset.album = v.album; row.dataset.year = v.year;
    row.dataset.genre = v.genre; row.dataset.bpm = v.bpm; row.dataset.key = v.key;
    const set = (sel, val) => { const el = row.querySelector(sel); if (el) el.textContent = val; };
    set('.row-title', v.title); set('.row-artist', v.artist);
    set('.row-data', v.bpm); set('.row-key', v.key);
  }

  /* ---------- ficha de uma faixa que já está no cofre ---------- */
  async function openDossierFor(row) {
    const id = row && row.dataset.id;
    if (!id) return;
    try {
      const res = await fetch('api/library/' + encodeURIComponent(id) + '/dossier');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const dossier = await res.json();
      session.items = [{ name: (dossier.file || {}).name || id, state: 'ok', pct: 100, dossier, standalone: true, row }];
      session.active = 0;
      openPanel();
    } catch (e) {
      console.error('dossier failed:', e);
      toast('Não foi possível abrir a ficha', 'Erro');
    }
  }

  /* ---------- pontos de entrada ---------- */
  const openBtn = $('[data-import-open]');
  if (openBtn) openBtn.addEventListener('click', () => {
    const pending = session.items.some((i) => !i.standalone);
    if (pending) openPanel();
    else picker.click();
  });

  document.addEventListener('rolf:ctx', (e) => {
    const { action, row } = e.detail || {};
    if (action === 'import') picker.click();
    if (action === 'dossier' && row) openDossierFor(row);
  });
})();
