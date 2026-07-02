/* ============================================================
   ROLFSOUND V2 — Custom right-click context menu
   Replaces the native browser menu with a command sheet in the
   Rolfsound visual language. Context-aware: right-clicking a
   track row shows track actions (with its cover + coordinate);
   anywhere else shows a compact library menu.
   ============================================================ */
(function () {
  'use strict';

  const ICON = {
    play:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4 18.6 12 8 18.6z"/></svg>',
    queue:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h11M4 12h11M4 17h7"/><path d="M17 14v6M14 17h6"/></svg>',
    playlist:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6M9 13h6M9 17h3"/></svg>',
    remix:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3.2l9.6 10H20"/><path d="M17 4l3 3-3 3"/><path d="M4 17h3.2l2.6-2.7"/><path d="M14.2 9.7 16.8 7"/><path d="M17 14l3 3-3 3"/></svg>',
    tune:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 8h9M18 8h1M5 16h1M10 16h9"/><circle cx="16" cy="8" r="2.4"/><circle cx="8" cy="16" r="2.4"/></svg>',
    rip:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.4"/><path d="M12 4v3"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r="0.6" fill="currentColor"/></svg>',
    rename:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="M14.5 5.5l4 4L9 19l-4 .9.9-4z"/></svg>',
    fav:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7-4.3-7-9.3A3.7 3.7 0 0 1 12 7a3.7 3.7 0 0 1 7 3.7c0 5-7 9.3-7 9.3z"/></svg>',
    trash:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>',
    add:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    upload:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M8 9l4-4 4 4"/><path d="M5 19h14"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14-4M4 5v4h4"/><path d="M4 13a8 8 0 0 0 14 4M20 19v-4h-4"/></svg>',
    chev:    '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    album:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.3"/></svg>',
    artist:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/></svg>',
    edit:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="M14.5 5.5l4 4L9 19l-4 .9.9-4z"/></svg>',
  };

  // build one menu element, reused
  const menu = document.createElement('div');
  menu.className = 'ctx';
  menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);

  let open = false;
  let currentRow = null;

  function item({ icon, label, kbd, chev, cls = '', action, onClick }) {
    const b = document.createElement('button');
    b.className = 'ctx-item' + (cls ? ' ' + cls : '');
    b.setAttribute('role', 'menuitem');
    b.innerHTML =
      icon +
      `<span class="lbl">${label}</span>` +
      (chev ? ICON.chev : kbd ? `<span class="kbd">${kbd}</span>` : '');
    b.addEventListener('click', () => {
      hide();
      if (action) document.dispatchEvent(new CustomEvent('rolf:ctx', { detail: { action, row: currentRow, label } }));
      onClick && onClick();
    });
    return b;
  }
  function sep() { const s = document.createElement('div'); s.className = 'ctx-sep'; return s; }
  function label(t) { const l = document.createElement('div'); l.className = 'ctx-label'; l.textContent = t; return l; }

  // ---- menu definitions -------------------------------------------------
  function buildTrackMenu(row) {
    menu.innerHTML = '';
    const cover = row.querySelector('.row-cover');
    const title = row.querySelector('.row-title')?.textContent || 'Faixa';
    const artist = row.querySelector('.row-artist')?.textContent || '';
    const bpm = row.querySelector('.row-data')?.textContent || '';
    const key = row.querySelector('.row-key')?.textContent || '';

    const head = document.createElement('div');
    head.className = 'ctx-head';
    head.innerHTML =
      `<span class="ctx-cover" style="${cover ? 'background:' + cover.style.background : ''}"></span>` +
      `<div class="ctx-meta"><div class="ctx-title">${title}</div>` +
      `<div class="ctx-sub">${artist.replace(/·/g, '·')} · ${bpm} BPM · ${key}</div></div>`;
    menu.appendChild(head);

    menu.appendChild(item({ icon: ICON.play, label: 'Tocar agora', cls: 'accent', kbd: '⏎', action: 'play' }));
    menu.appendChild(item({ icon: ICON.queue, label: 'Adicionar à fila', action: 'queue' }));
    menu.appendChild(item({ icon: ICON.playlist, label: 'Adicionar à playlist', chev: true, action: 'playlist' }));
    menu.appendChild(sep());
    menu.appendChild(label('Estúdio'));
    menu.appendChild(item({ icon: ICON.remix, label: 'Abrir no Remixer', kbd: 'R', action: 'remix' }));
    menu.appendChild(item({ icon: ICON.tune, label: 'Ajustar BPM / Pitch', action: 'remix' }));
    menu.appendChild(item({ icon: ICON.upload, label: 'Exportar faixa', action: 'export' }));
    menu.appendChild(sep());
    menu.appendChild(label('Navegar'));
    menu.appendChild(item({ icon: ICON.album, label: 'Ver álbum', action: 'album' }));
    menu.appendChild(item({ icon: ICON.artist, label: 'Ver artista', action: 'artist' }));
    menu.appendChild(sep());
    menu.appendChild(item({ icon: ICON.fav, label: 'Favoritar', action: 'fav' }));
    menu.appendChild(item({ icon: ICON.edit, label: 'Editar informações', action: 'edit' }));
    menu.appendChild(sep());
    menu.appendChild(item({ icon: ICON.trash, label: 'Remover do cofre', cls: 'danger', action: 'remove' }));
  }

  function buildLibraryMenu() {
    menu.innerHTML = '';
    menu.appendChild(label('Acervo'));
    menu.appendChild(item({ icon: ICON.add, label: 'Nova faixa', kbd: '⌘N', action: 'new-track' }));
    menu.appendChild(item({ icon: ICON.rip, label: 'Capturar / Rip', cls: 'accent', action: 'capturar' }));
    menu.appendChild(item({ icon: ICON.playlist, label: 'Nova playlist', action: 'new-playlist' }));
    menu.appendChild(sep());
    menu.appendChild(item({ icon: ICON.refresh, label: 'Sincronizar com o aparelho', action: 'sync' }));
  }

  // ---- positioning + show/hide ------------------------------------------
  function showAt(x, y) {
    menu.classList.add('open');
    open = true;
    // clamp to viewport
    const pad = 10;
    const r = menu.getBoundingClientRect();
    let nx = x, ny = y;
    if (x + r.width + pad > window.innerWidth) nx = x - r.width;
    if (y + r.height + pad > window.innerHeight) ny = Math.max(pad, window.innerHeight - r.height - pad);
    nx = Math.max(pad, nx); ny = Math.max(pad, ny);
    menu.style.setProperty('--ox', x - nx + 'px');
    menu.style.setProperty('--oy', y - ny + 'px');
    menu.style.left = nx + 'px';
    menu.style.top = ny + 'px';
  }
  function hide() {
    if (!open) return;
    menu.classList.remove('open');
    open = false;
  }

  // ---- wire it up -------------------------------------------------------
  document.addEventListener('contextmenu', (e) => {
    // allow native menu inside text inputs
    if (e.target.closest('input, textarea')) return;
    e.preventDefault();

    const row = e.target.closest('.row');
    currentRow = row || null;
    if (row) {
      document.querySelectorAll('.row.ctx-target').forEach((r) => r.classList.remove('ctx-target'));
      row.classList.add('ctx-target');
      buildTrackMenu(row);
    } else {
      buildLibraryMenu();
    }
    // render hidden first to measure, then place
    menu.classList.add('open');
    menu.style.left = '-9999px'; menu.style.top = '-9999px';
    requestAnimationFrame(() => showAt(e.clientX, e.clientY));
  });

  document.addEventListener('pointerdown', (e) => {
    if (open && !e.target.closest('.ctx')) hide();
  });
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
})();
