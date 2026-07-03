/* ============================================================
   ROLFSOUND V2 — STEMS (versão multipista da faixa)
   Quatro papéis fixos: vocals · drums · bass · other.

   · Botão "Stems" na barra da faixa do Remixer:
       sem stems  → abre a gaveta de intake (upload dos arquivos)
       2+ stems   → liga/desliga as lanes na waveform
   · Lanes: a waveform única se abre em 4 camadas coloridas dentro
     do MESMO .wave-frame — playhead, seek e loop continuam valendo.
     Mudo/solo/gain são visuais nesta fase (como Filtro/EQ): a
     reprodução multipista chega quando o core ganhar mix de stems.
   · Gaveta (dock): 4 slots com drag & drop; múltiplos arquivos são
     distribuídos pelo nome (ex.: *vocals*, *drums*); sobe via
     POST /api/library/{id}/stems/{role}.
   · Fonte da verdade dos papéis presentes: data-stems na row do
     Acervo (bootstrap → render.js); este módulo a mantém em dia.
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
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  const Player = window.RolfPlayer = window.RolfPlayer || {};
  const OK_EXT = ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'webm'];
  const extOf = (name) => (String(name).split('.').pop() || '').toLowerCase();

  const ROLES = [
    { id: 'vocals', label: 'Vocais',  hex: '#d9a45e', hint: 'ex.: faixa_vocals.wav', re: /voc|vox|voz|acap|sing|lead/i },
    { id: 'drums',  label: 'Bateria', hex: '#e0685f', hint: 'ex.: faixa_drums.wav',  re: /drum|bater|perc|beat|kick/i },
    { id: 'bass',   label: 'Baixo',   hex: '#8a90e8', hint: 'ex.: faixa_bass.wav',   re: /bass|baixo|808/i },
    { id: 'other',  label: 'Outros',  hex: '#5fbfa4', hint: 'ex.: faixa_other.wav',  re: /other|instr|outro|melod|music|harm|synth|guitar|piano/i },
  ];
  const roleOf = (id) => ROLES.find((r) => r.id === id);
  ROLES.forEach((r) => {
    const n = parseInt(r.hex.slice(1), 16);
    r.rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });

  /* ---------- estado ---------- */
  let trackId = '';                 // faixa carregada no Remixer (via rolf:track)
  let lanesOn = false;
  const laneUi = {};                // {role: {vol, mute, solo}} — por sessão
  ROLES.forEach((r) => { laneUi[r.id] = { vol: 1, mute: false, solo: false }; });

  const rowFor = (id) =>
    id ? $('.screen[data-screen="acervo"] .row[data-id="' + cssEsc(id) + '"]') : null;

  function rolesFor(id) {
    const row = rowFor(id);
    if (row) return (row.dataset.stems || '').split(/\s+/).filter(Boolean);
    const t = ((window.RolfsoundData || {}).tracks || []).find((x) => x.id === id);
    return (t && t.stems) || [];
  }

  /* espelha os papéis na row (dataset + badge) e no RolfsoundData */
  function updateRowStems(id, roles) {
    const row = rowFor(id);
    if (row) {
      row.dataset.stems = roles.join(' ');
      const tags = row.querySelector('.row-tags');
      if (tags && window.RolfStemsBadgeHtml) {
        const old = tags.querySelector('.tag.stems');
        if (old) old.remove();
        const html = window.RolfStemsBadgeHtml(roles);
        if (html) {
          const state = tags.querySelector('.tag');        // tag de estado vem primeiro
          if (state) state.insertAdjacentHTML('afterend', html);
          else tags.insertAdjacentHTML('afterbegin', html);
        }
      }
    }
    const t = ((window.RolfsoundData || {}).tracks || []).find((x) => x.id === id);
    if (t) t.stems = roles.slice();
  }

  /* ============================================================
     BOTÃO na barra da faixa
     ============================================================ */
  function updateButton() {
    const btn = $('[data-stems-btn]');
    if (!btn) return;
    const roles = trackId ? rolesFor(trackId) : [];
    btn.classList.toggle('disabled', !trackId);
    btn.classList.toggle('none', !!trackId && !roles.length);
    btn.classList.toggle('on', lanesOn);
    btn.setAttribute('aria-pressed', lanesOn ? 'true' : 'false');
    btn.title = !trackId ? 'Selecione uma faixa para usar stems'
      : !roles.length ? 'Adicionar stems — envie as 4 camadas da faixa'
      : lanesOn ? 'Desativar o modo Stems' : 'Ativar o modo Stems';
    const ct = $('[data-stems-count]', btn);
    if (ct) {
      if (roles.length && roles.length < 4) { ct.hidden = false; ct.textContent = roles.length + '/4'; }
      else ct.hidden = true;
    }
  }

  function onButtonClick() {
    if (!trackId) { toast('Selecione uma faixa no Acervo', 'Stems'); return; }
    const roles = rolesFor(trackId);
    if (roles.length < 2) {
      if (roles.length === 1) toast('Adicione pelo menos 2 camadas para ativar', 'Stems');
      openDrawer(trackId);
      return;
    }
    setLanes(!lanesOn);
  }

  /* ============================================================
     LANES — a waveform se abre em camadas
     ============================================================ */
  function waveFrame() { return $('.rmx .wave-frame'); }

  function setLanes(on) {
    const frame = waveFrame();
    if (!frame) return;
    lanesOn = on;
    const rmx = $('.screen.rmx');
    if (on) {
      buildLanes(frame);
      frame.classList.add('stems-on');
      if (rmx) rmx.classList.add('stems-mode');
      paintAll(true);
    } else {
      frame.classList.remove('stems-on');
      if (rmx) rmx.classList.remove('stems-mode');
      const lanes = $('.stem-lanes', frame);
      if (lanes) lanes.remove();
    }
    const lbl = $('.rmx .rmx-wave .sec-label');
    if (lbl) {
      const n = rolesFor(trackId).length;
      if (on) lbl.setAttribute('data-stems', '· Stems · ' + n + '/4 camadas');
      else lbl.removeAttribute('data-stems');
    }
    updateButton();
  }

  function buildLanes(frame) {
    let lanes = $('.stem-lanes', frame);
    if (lanes) lanes.remove();
    lanes = document.createElement('div');
    lanes.className = 'stem-lanes';
    const present = rolesFor(trackId);

    ROLES.forEach((role) => {
      const has = present.includes(role.id);
      const lane = document.createElement('div');
      lane.className = 'stem-lane' + (has ? '' : ' empty');
      lane.dataset.role = role.id;
      lane.style.setProperty('--stem-c', role.hex);

      const chip = `<span class="stem-chip"><span class="dot" style="background:${role.hex}"></span>${role.label}</span>`;
      if (has) {
        const ui = laneUi[role.id];
        lane.innerHTML =
          '<canvas></canvas>' + chip +
          '<div class="stem-ctl">' +
            `<span class="stem-fader" title="Gain — ${role.label}"><span class="ff"></span><span class="fh"></span></span>` +
            '<button class="stem-ms mute" title="Mudo">M</button>' +
            '<button class="stem-ms solo" title="Solo">S</button>' +
          '</div>';
        wireLane(lane, role.id);
        setFaderVisual(lane, ui.vol);
      } else {
        lane.innerHTML = chip +
          '<button class="stem-add"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Adicionar camada</button>';
        const add = $('.stem-add', lane);
        add.addEventListener('pointerdown', (e) => e.stopPropagation());
        add.addEventListener('click', () => openDrawer(trackId, role.id));
      }
      lanes.appendChild(lane);
    });

    frame.appendChild(lanes);
    applyMuteSolo();
  }

  function wireLane(lane, roleId) {
    const ui = laneUi[roleId];
    const ctl = $('.stem-ctl', lane);
    // gestos nos controles não podem virar seek na waveform
    ctl.addEventListener('pointerdown', (e) => e.stopPropagation());

    $('.stem-ms.mute', lane).addEventListener('click', (e) => {
      ui.mute = !ui.mute;
      e.currentTarget.classList.toggle('on', ui.mute);
      applyMuteSolo();
    });
    $('.stem-ms.solo', lane).addEventListener('click', (e) => {
      ui.solo = !ui.solo;
      e.currentTarget.classList.toggle('on', ui.solo);
      applyMuteSolo();
    });

    const fader = $('.stem-fader', lane);
    let drag = false;
    const fromEv = (e) => {
      const r = fader.getBoundingClientRect();
      ui.vol = clamp01((e.clientX - r.left) / r.width);
      setFaderVisual(lane, ui.vol);
      paintLane($('canvas', lane), roleId);
    };
    fader.addEventListener('pointerdown', (e) => {
      drag = true; fader.setPointerCapture(e.pointerId); fromEv(e); e.preventDefault();
    });
    fader.addEventListener('pointermove', (e) => { if (drag) fromEv(e); });
    const end = (e) => { if (!drag) return; drag = false; try { fader.releasePointerCapture(e.pointerId); } catch (_) {} };
    fader.addEventListener('pointerup', end);
    fader.addEventListener('pointercancel', end);
  }

  function setFaderVisual(lane, vol) {
    const ff = $('.stem-fader .ff', lane);
    const fh = $('.stem-fader .fh', lane);
    if (ff) ff.style.width = (vol * 100).toFixed(1) + '%';
    if (fh) fh.style.left = (vol * 100).toFixed(1) + '%';
  }

  function applyMuteSolo() {
    const anySolo = ROLES.some((r) => laneUi[r.id].solo);
    $$('.stem-lane:not(.empty)').forEach((lane) => {
      const ui = laneUi[lane.dataset.role];
      lane.classList.toggle('mut', ui.mute || (anySolo && !ui.solo));
    });
  }

  /* ---------- pintura das camadas ---------- */
  function hash(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const seedFor = (roleId) => (hash(trackId + ':' + roleId) % 997) / 63;

  // caráter de cada papel: a forma da onda conta que camada é
  function ampRole(roleId, i, t, seed) {
    if (roleId === 'vocals') {                       // frases e respiros
      const phrase = Math.sin(t * Math.PI * 2 * 1.35 + seed) + 0.45 * Math.sin(t * Math.PI * 2 * 3.1 + seed * 1.7);
      const gate = phrase > -0.15 ? 1 : 0.1;
      const syl = 0.55 + 0.45 * Math.sin(i * 0.83 + seed * 2.1);
      return gate * (0.32 + 0.62 * syl);
    }
    if (roleId === 'drums') {                        // transientes na grade
      const ph = (i + seed * 7) % 5.5;
      const spike = Math.exp(-ph * 1.15);
      const ghost = 0.15 + 0.1 * Math.sin(i * 2.3 + seed);
      return Math.min(1, ghost + spike * 0.95);
    }
    if (roleId === 'bass') {                         // grave contínuo e redondo
      const slow = 0.5 + 0.34 * Math.sin(t * Math.PI * 2 * 2.2 + seed) + 0.16 * Math.sin(t * Math.PI * 2 * 5.1 + seed * 3.3);
      const round = 0.75 + 0.25 * Math.sin(i * 0.35 + seed);
      return Math.max(0.12, slow * round * 0.85);
    }
    const tex = 0.5 + 0.3 * Math.sin(i * 1.4 + seed * 1.3) + 0.2 * Math.sin(i * 0.23 + seed * 2.9);
    const swell = 0.6 + 0.4 * Math.sin(t * Math.PI * 2 * 1.8 + seed * 0.7);
    return Math.max(0.08, tex * swell * 0.8);        // outros: textura média
  }

  function paintLane(cv, roleId) {
    if (!cv) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const role = roleOf(roleId);
    const [cr, cg, cb] = role.rgb;
    const played = clamp01(Player.pos || 0);
    const seed = seedFor(roleId);
    const gain = 0.35 + 0.65 * laneUi[roleId].vol;
    const barW = 2.5, gap = 2, step = barW + gap;
    const n = Math.max(1, Math.floor(w / step));
    const mid = h / 2;

    for (let i = 0; i < n; i++) {
      const t = i / n;
      const env = 0.25 + 0.75 * Math.sin(Math.min(Math.PI, t * Math.PI * 1.05));
      const a = Math.max(0.04, Math.min(1, ampRole(roleId, i, t, seed) * env)) * gain;
      const bh = Math.max(1.5, a * h * 0.86);
      ctx.fillStyle = (t < played)
        ? `rgba(${cr},${cg},${cb},0.92)`
        : `rgba(${cr},${cg},${cb},0.30)`;
      const x = i * step;
      const r = Math.min(barW / 2, 1.2);
      ctx.beginPath();
      ctx.moveTo(x + r, mid - bh / 2);
      ctx.arcTo(x + barW, mid - bh / 2, x + barW, mid + bh / 2, r);
      ctx.arcTo(x + barW, mid + bh / 2, x, mid + bh / 2, r);
      ctx.arcTo(x, mid + bh / 2, x, mid - bh / 2, r);
      ctx.arcTo(x, mid - bh / 2, x + barW, mid - bh / 2, r);
      ctx.closePath();
      ctx.fill();
    }

    // compassos principais, bem discretos (a régua detalhada fica acima)
    ctx.strokeStyle = 'rgba(232,233,238,0.05)';
    ctx.lineWidth = 1;
    for (let b = 0; b <= 4; b++) {
      const x = Math.round((b / 4) * w) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }

  let tPaint = 0;
  function frame(now) {
    if (lanesOn && now - tPaint > 110) {
      tPaint = now;
      paintAll(false);
    }
    requestAnimationFrame(frame);
  }
  function paintAll() {
    $$('.stem-lane:not(.empty)').forEach((lane) => paintLane($('canvas', lane), lane.dataset.role));
  }

  /* ============================================================
     GAVETA — intake de stems (mesmo dock da ficha técnica)
     ============================================================ */
  const dock  = $('[data-dock]');
  const panel = $('[data-panel]');
  const inner = $('[data-panel-inner]');

  // sessão da gaveta: meta por papel + envios em andamento
  const drawer = { id: '', title: '', duration: 0, meta: {}, busy: {}, err: {}, warn: {} };
  const drawerOpen = () => !!(dock && dock.classList.contains('panel-open') && $('[data-stm-root]', inner));

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.accept = OK_EXT.map((x) => '.' + x).join(',') + ',audio/*';
  picker.style.display = 'none';
  document.body.appendChild(picker);
  picker.addEventListener('change', () => {
    const files = [...picker.files];
    const role = picker.dataset.role || '';
    picker.value = '';
    if (!files.length) return;
    if (role && files.length === 1) upload(role, files[0]);
    else assignFiles(files);
  });

  async function openDrawer(id, focusRole) {
    if (!dock || !panel || !inner) return;
    if (!id) return;
    if (drawer.id && drawer.id !== id) {
      // envios da faixa anterior morrem com a sessão dela
      Object.values(drawer.busy).forEach((b) => { try { b.xhr.abort(); } catch (_) {} });
      drawer.busy = {};
    }
    drawer.id = id;
    const row = rowFor(id);
    drawer.title = (row && row.dataset.title) || ($('.rmx-track-title') || {}).textContent || id;
    drawer.meta = {}; drawer.err = {}; drawer.warn = {};
    try {
      const res = await fetch('api/library/' + encodeURIComponent(id) + '/stems');
      if (res.ok) {
        const data = await res.json();
        drawer.duration = data.duration || 0;
        Object.entries(data.stems || {}).forEach(([role, m]) => { drawer.meta[role] = m; });
      }
    } catch (e) { console.error('stems list failed:', e); }

    dock.classList.add('panel-open', 'panel-tall');
    dock.classList.remove('queue-open');
    const qb = $('[data-queue-open]'); if (qb) qb.classList.remove('is-on');
    const q = $('[data-queue]'); if (q) q.setAttribute('aria-hidden', 'true');
    panel.setAttribute('aria-hidden', 'false');
    renderDrawer();
    if (focusRole) {
      const slot = $('.stm-slot[data-role="' + focusRole + '"] .stm-drop', inner);
      if (slot) slot.focus();
    }
  }

  function closeDrawer() {
    if (!dock) return;
    dock.classList.remove('panel-open');
    if (panel) panel.setAttribute('aria-hidden', 'true');
    // completou 2+ camadas para a faixa aberta no Remixer → liga o modo
    const roles = rolesFor(trackId);
    if (drawer.id && drawer.id === trackId && roles.length >= 2 && !lanesOn) {
      setLanes(true);
      toast('Modo Stems ativo — ' + roles.length + ' camadas', 'Stems');
    }
  }

  const mmss = (sec) => {
    sec = Math.max(0, Math.floor(+sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };
  const fmtSize = (b) => {
    if (!b) return '';
    if (b < 1048576) return Math.round(b / 1024) + ' KB';
    return (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
  };

  function slotHtml(role) {
    const m = drawer.meta[role.id];
    const busy = drawer.busy[role.id];
    const err = drawer.err[role.id];
    let body;
    if (busy) {
      body =
        '<div class="stm-file"><div class="nm">' + esc(busy.name) + '</div>' +
        '<div class="stm-prog"><span data-stm-bar="' + role.id + '" style="width:' + busy.pct + '%"></span></div>' +
        '<div class="stm-status" data-stm-pct="' + role.id + '">Enviando · ' + busy.pct + '%</div></div>';
    } else if (m) {
      const facts = [m.codec, m.duration ? mmss(m.duration) : '', fmtSize(m.size)].filter(Boolean).join(' · ');
      const warn = drawer.warn[role.id] ? '<div class="warn">' + esc(drawer.warn[role.id]) + '</div>' : '';
      body =
        '<div class="stm-file"><div class="nm" title="' + esc(m.name) + '">' + esc(m.name) + '</div>' +
        '<div class="ft">' + esc(facts) + '</div>' + warn + '</div>' +
        '<div class="stm-actions">' +
          '<button class="stm-mini" data-stm-replace="' + role.id + '">Substituir</button>' +
          '<button class="stm-mini danger" data-stm-remove="' + role.id + '">Remover</button>' +
        '</div>';
    } else {
      const errLine = err ? '<div class="stm-status err">' + esc(err) + '</div>' : '';
      body = errLine +
        '<button class="stm-drop" data-stm-pick="' + role.id + '">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M8 9l4-4 4 4"/><path d="M5 19h14"/></svg>' +
          'Solte o arquivo ou clique' +
          '<span style="font-size:9.5px;color:var(--ink-faint)">' + esc(role.hint) + '</span>' +
        '</button>';
    }
    return '<div class="stm-slot" data-role="' + role.id + '" style="--stem-c:' + role.hex + '">' +
      '<div class="stm-slot-head"><span class="dot"></span>' + role.label +
      '<span class="role-en">' + role.id + '</span></div>' + body + '</div>';
  }

  function renderDrawer() {
    if (!inner) return;
    const n = Object.keys(drawer.meta).length;
    inner.innerHTML =
      '<div data-stm-root style="display:flex;flex-direction:column;height:100%">' +
      '<div class="tpp-head">' +
        '<div><div class="tpp-kicker">Stems · Versão multipista</div>' +
        '<div class="tpp-h-title">' + esc(drawer.title) + '</div></div>' +
        '<div class="tpp-spacer"></div>' +
        '<button class="tpp-btn accent" data-stm-done><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-11"/></svg>Concluir</button>' +
      '</div>' +
      '<div class="stm-note">Envie as camadas que você tiver — <b>a soma das quatro reconstrói a faixa</b>. ' +
        'O modo Stems liga com 2 ou mais camadas; solte vários arquivos de uma vez que eu distribuo pelos nomes.</div>' +
      '<div class="stm-grid">' + ROLES.map(slotHtml).join('') + '</div>' +
      '<div class="stm-foot">' +
        '<span>' + n + '/4 camadas</span><span class="sep"></span>' +
        (drawer.duration ? '<span>Master · ' + mmss(drawer.duration) + ' — os stems cobrem a faixa inteira</span>'
                         : '<span>Reprodução multipista chega numa próxima fase</span>') +
      '</div></div>';
    wireDrawer();
  }

  function wireDrawer() {
    const done = $('[data-stm-done]', inner);
    if (done) done.addEventListener('click', closeDrawer);

    $$('[data-stm-pick]', inner).forEach((b) => b.addEventListener('click', () => {
      picker.dataset.role = b.dataset.stmPick;
      picker.multiple = true;
      picker.click();
    }));
    $$('[data-stm-replace]', inner).forEach((b) => b.addEventListener('click', () => {
      picker.dataset.role = b.dataset.stmReplace;
      picker.multiple = false;
      picker.click();
    }));
    $$('[data-stm-remove]', inner).forEach((b) => b.addEventListener('click', () => removeStem(b.dataset.stmRemove)));
  }

  /* distribui vários arquivos pelos papéis (nome → regex; resto em ordem) */
  function assignFiles(fileList) {
    const files = [...fileList].filter((f) => OK_EXT.includes(extOf(f.name)));
    const bad = fileList.length - files.length;
    if (bad) toast(bad === 1 ? 'Arquivo ignorado — formato não suportado' : bad + ' arquivos ignorados — formato não suportado', 'Stems');
    if (!files.length) return;

    const taken = new Set();
    const pairs = files.map((f) => {
      const m = ROLES.find((r) => r.re.test(f.name) && !taken.has(r.id));
      if (m) { taken.add(m.id); return [m.id, f]; }
      return [null, f];
    });
    pairs.forEach((p) => {
      if (p[0]) return;
      const free = ROLES.find((r) => !taken.has(r.id) && !drawer.meta[r.id] && !drawer.busy[r.id])
                || ROLES.find((r) => !taken.has(r.id));
      if (free) { p[0] = free.id; taken.add(free.id); }
    });
    const left = pairs.filter((p) => !p[0]).length;
    if (left) toast(left + (left === 1 ? ' arquivo ficou' : ' arquivos ficaram') + ' de fora — são 4 camadas por faixa', 'Stems');
    pairs.filter((p) => p[0]).forEach(([role, f]) => upload(role, f));
  }

  function upload(role, file) {
    if (!drawer.id) return;
    if (!OK_EXT.includes(extOf(file.name))) {
      toast('Formato não suportado: .' + extOf(file.name), 'Stems');
      return;
    }
    const prev = drawer.busy[role];
    if (prev && prev.xhr) { try { prev.xhr.abort(); } catch (_) {} }

    const id = drawer.id;
    const xhr = new XMLHttpRequest();
    drawer.busy[role] = { name: file.name, pct: 0, xhr };
    drawer.err[role] = '';
    renderDrawer();

    const form = new FormData();
    form.append('file', file, file.name);
    xhr.open('POST', 'api/library/' + encodeURIComponent(id) + '/stems/' + role);
    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      drawer.busy[role].pct = pct;
      const bar = $('[data-stm-bar="' + role + '"]', inner);
      const lab = $('[data-stm-pct="' + role + '"]', inner);
      if (bar) bar.style.width = pct + '%';
      if (lab) lab.textContent = 'Enviando · ' + pct + '%';
    });
    xhr.addEventListener('load', () => {
      const mine = drawer.id === id;      // a gaveta pode ter trocado de faixa
      if (mine) delete drawer.busy[role];
      if (xhr.status >= 200 && xhr.status < 300) {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (_) {}
        if (data && data.stem) {
          if (mine) {
            drawer.meta[role] = data.stem;
            drawer.warn[role] = data.warning || '';
          }
          applyRoleChange(id, role, true);
          toast(roleOf(role).label + ' no lugar', 'Stems');
        } else if (mine) {
          drawer.err[role] = 'Resposta inválida do servidor';
        }
      } else if (mine) {
        let msg = 'Falha no envio';
        try { msg = JSON.parse(xhr.responseText).detail || msg; } catch (_) {}
        drawer.err[role] = msg;
        toast(roleOf(role).label + ' falhou', 'Stems');
      }
      if (drawerOpen()) renderDrawer();
    });
    xhr.addEventListener('error', () => {
      delete drawer.busy[role];
      drawer.err[role] = 'Falha no envio — verifique a conexão';
      if (drawerOpen()) renderDrawer();
    });
    xhr.send(form);
  }

  async function removeStem(role) {
    const id = drawer.id;
    if (!id) return;
    try {
      const res = await fetch('api/library/' + encodeURIComponent(id) + '/stems/' + role, { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      delete drawer.meta[role];
      delete drawer.warn[role];
      applyRoleChange(id, role, false);
      toast(roleOf(role).label + ' removido', 'Stems');
    } catch (e) {
      console.error('stem delete failed:', e);
      toast('Não foi possível remover', 'Stems');
    }
    if (drawerOpen()) renderDrawer();
  }

  /* pós-mudança: row + badge + botão + lanes (se a faixa é a do Remixer) */
  function applyRoleChange(id, role, added) {
    const set = new Set(rolesFor(id));
    if (added) set.add(role); else set.delete(role);
    const roles = ROLES.map((r) => r.id).filter((rid) => set.has(rid));
    updateRowStems(id, roles);
    if (id === trackId) {
      updateButton();
      if (lanesOn) {
        if (roles.length >= 2) setLanes(true);            // reconstrói as lanes
        else { setLanes(false); toast('Modo Stems desligado — menos de 2 camadas', 'Stems'); }
      }
    }
  }

  /* drag & drop na gaveta — intercepta ANTES do intake do importer.js
     (captura na window; com a gaveta aberta, arquivos são stems) */
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  let hoverSlot = null;
  function setHover(slot) {
    if (hoverSlot === slot) return;
    if (hoverSlot) hoverSlot.classList.remove('dragover');
    hoverSlot = slot;
    if (slot) slot.classList.add('dragover');
  }
  ['dragenter', 'dragover'].forEach((type) => {
    window.addEventListener(type, (e) => {
      if (!drawerOpen() || !hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (type === 'dragover') {
        e.dataTransfer.dropEffect = 'copy';
        setHover(e.target.closest ? e.target.closest('.stm-slot') : null);
      }
    }, true);
  });
  window.addEventListener('dragleave', (e) => {
    if (!drawerOpen() || !hasFiles(e)) return;
    e.stopPropagation();
    if (!e.relatedTarget) setHover(null);
  }, true);
  window.addEventListener('drop', (e) => {
    if (!drawerOpen() || !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setHover(null);
    const slot = e.target.closest ? e.target.closest('.stm-slot') : null;
    const files = e.dataTransfer.files;
    if (slot && files.length === 1) upload(slot.dataset.role, files[0]);
    else assignFiles(files);
  }, true);

  /* ============================================================
     WIRING
     ============================================================ */
  function buildManageTool() {
    const tools = $('.rmx .rmx-wave-tools');
    if (!tools || $('.rmx-stems-manage', tools)) return;
    const b = document.createElement('button');
    b.className = 'wave-tool rmx-stems-manage';
    b.type = 'button';
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="M14.5 5.5l4 4L9 19l-4 .9.9-4z"/></svg>Stems';
    b.title = 'Gerenciar os stems desta faixa';
    b.addEventListener('click', () => openDrawer(trackId));
    tools.appendChild(b);
  }

  function init() {
    const btn = $('[data-stems-btn]');
    if (btn) {
      btn.addEventListener('click', onButtonClick);
      // atalho de gestão: botão direito abre a gaveta direto
      btn.addEventListener('contextmenu', (e) => {
        if (!trackId) return;
        e.preventDefault();
        e.stopPropagation();
        openDrawer(trackId);
      });
    }
    buildManageTool();
    updateButton();

    // faixa carregada/trocada no Remixer (prototype.js → showTrack)
    document.addEventListener('rolf:track', (e) => {
      const d = e.detail || {};
      if (d.id === trackId) return;
      trackId = d.id || '';
      if (lanesOn) {
        if (rolesFor(trackId).length >= 2) setLanes(true);  // reconstrói para a nova faixa
        else setLanes(false);
      }
      updateButton();
    });

    // menu de contexto do Acervo: "Stems · Multipista"
    document.addEventListener('rolf:ctx', (e) => {
      const { action, row } = e.detail || {};
      if (action === 'stems' && row && row.dataset.id) openDrawer(row.dataset.id);
    });

    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
