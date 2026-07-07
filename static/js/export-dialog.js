/* ============================================================
   ROLFSOUND V2 — Popup "Exportar faixa"
   Abre do menu de contexto (action 'export'): escolhe o formato
   de saída (original sem conversão, ou FLAC/MP3/WAV via PyAV no
   servidor), mostra os metadados que serão gravados no arquivo
   (os do Acervo — a fonte é o banco, não as tags antigas do
   arquivo) e o nome final "NN Título.ext". Baixa via
   GET api/library/{id}/download?format=…&cover=…
   ============================================================ */
(function () {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const toast = (text, kicker) =>
    document.dispatchEvent(new CustomEvent('rolf:toast', { detail: { text, kicker } }));

  const FORMATS = [
    { id: 'original', name: 'Original', sub: () => (current.ext ? current.ext.toUpperCase() + ' · ' : '') + 'sem conversão, qualidade intacta' },
    { id: 'flac',     name: 'FLAC',     sub: () => 'Lossless · 16-bit' },
    { id: 'mp3',      name: 'MP3',      sub: () => '320 kbps · compatível com tudo' },
    { id: 'wav',      name: 'WAV',      sub: () => 'PCM 16-bit · sem compressão' },
  ];

  let backdrop = null;
  let current = { id: null, ext: '', fmt: 'original', cover: true, track: null };

  const fileExt = (fp) => {
    const m = /\.([a-z0-9]+)$/i.exec(fp || '');
    return m ? m[1].toLowerCase() : '';
  };
  const exportName = () => {
    const t = current.track || {};
    const no = String(+t.track_no || 0).padStart(2, '0');
    const title = (t.title || 'Faixa').trim();
    const ext = current.fmt === 'original' ? (current.ext || '…') : current.fmt;
    return (no + ' ' + title).replace(/[\\/:*?"<>|]/g, '').trim() + '.' + ext;
  };
  // remux webm/mkv não embute capa — o toggle não se aplica ao Original
  const coverNA = () =>
    current.fmt === 'original' && (current.ext === 'webm' || current.ext === 'mkv');

  function metaRows() {
    const t = current.track || {};
    const dash = '<span class="na">—</span>';
    const pairs = [
      ['Nº',      (+t.track_no || 0) ? String(+t.track_no).padStart(2, '0') : dash],
      ['Título',  esc(t.title) || dash],
      ['Artista', esc(t.artist) || dash],
      ['Álbum',   esc(t.album) || dash],
      ['Ano',     esc(t.year) || dash],
      ['Gênero',  esc(t.genre) || dash],
    ];
    return pairs.map(([k, v]) => `<div class="exp-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  }

  function refresh() {
    if (!backdrop) return;
    $$('.exp-fmt', backdrop).forEach((b) => {
      b.classList.toggle('on', b.dataset.fmt === current.fmt);
      const f = FORMATS.find((x) => x.id === b.dataset.fmt);
      $('.exp-fmt-sub', b).textContent = f.sub();
    });
    $('.exp-meta-grid', backdrop).innerHTML = metaRows();
    $('.exp-file-name', backdrop).textContent = exportName();
    const cov = $('.exp-cover', backdrop);
    cov.classList.toggle('na', coverNA());
    cov.classList.toggle('on', current.cover && !coverNA());
    $('.exp-cover-sub', cov).textContent = coverNA()
      ? 'O container ' + current.ext.toUpperCase() + ' não aceita capa embutida'
      : 'Capa do álbum (ou a thumbnail) dentro do arquivo';
  }

  function open(row) {
    close();
    const id = row.dataset.id;
    if (!id) { toast('Faixa sem arquivo no cofre', '·'); return; }
    const coverBg = row.querySelector('.row-cover')?.style.background || '';
    current = {
      id, ext: '', fmt: 'original', cover: true,
      track: {
        title: row.querySelector('.row-title')?.textContent || 'Faixa',
        artist: row.querySelector('.row-artist')?.textContent || '',
        track_no: 0,
      },
    };

    backdrop = document.createElement('div');
    backdrop.className = 'exp-backdrop';
    backdrop.innerHTML =
      `<div class="exp" role="dialog" aria-label="Exportar faixa">
        <div class="exp-head">
          <span class="row-cover cover" style='background:${coverBg}'></span>
          <div class="exp-head-meta">
            <div class="exp-title">${esc(current.track.title)}</div>
            <div class="exp-sub">Exportar faixa</div>
          </div>
          <button class="exp-x" aria-label="Fechar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>
        <div class="exp-body">
          <div class="exp-label">Formato de saída</div>
          <div class="exp-fmts">
            ${FORMATS.map((f) => `
              <button class="exp-fmt" data-fmt="${f.id}">
                <span class="exp-dot"></span>
                <span class="exp-fmt-name">${f.name}</span>
                <span class="exp-fmt-sub"></span>
              </button>`).join('')}
          </div>
          <div class="exp-label">Metadados gravados <span class="exp-hint">· do Acervo — ajuste em “Editar informações”</span></div>
          <div class="exp-meta-grid"></div>
          <button class="exp-cover">
            <span class="exp-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-11"/></svg></span>
            <span class="exp-cover-meta"><span class="exp-cover-name">Embutir capa</span><span class="exp-cover-sub"></span></span>
          </button>
        </div>
        <div class="exp-foot">
          <div class="exp-file"><span class="exp-file-k">Arquivo</span><span class="exp-file-name"></span></div>
          <div class="exp-actions">
            <button class="exp-btn" data-exp-cancel>Cancelar</button>
            <button class="exp-btn accent" data-exp-go><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v11M8 12l4 4 4-4"/><path d="M5 19h14"/></svg>Exportar</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('open'));

    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    $('.exp-x', backdrop).addEventListener('click', close);
    $('[data-exp-cancel]', backdrop).addEventListener('click', close);
    $$('.exp-fmt', backdrop).forEach((b) =>
      b.addEventListener('click', () => { current.fmt = b.dataset.fmt; refresh(); }));
    $('.exp-cover', backdrop).addEventListener('click', () => {
      if (coverNA()) return;
      current.cover = !current.cover; refresh();
    });
    $('[data-exp-go]', backdrop).addEventListener('click', download);
    refresh();

    // a row só carrega título/artista — o resto (nº, álbum, ano, gênero,
    // extensão do arquivo) vem do banco
    fetch('api/library/' + encodeURIComponent(id))
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => {
        if (!t || !backdrop) return;
        current.track = t;
        current.ext = fileExt(t.file_path);
        refresh();
      })
      .catch(() => {});
  }

  function download() {
    const url = 'api/library/' + encodeURIComponent(current.id) + '/download'
      + '?format=' + current.fmt
      + '&cover=' + ((current.cover && !coverNA()) ? 'true' : 'false');
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(exportName(), current.fmt === 'original' ? 'Exportando' : 'Convertendo e exportando');
    close();
  }

  function close() {
    if (backdrop) { backdrop.remove(); backdrop = null; }
  }

  document.addEventListener('rolf:ctx', (e) => {
    const { action, row } = e.detail;
    if (action === 'export' && row) open(row);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
})();
