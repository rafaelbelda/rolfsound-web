/* ============================================================
   ROLFSOUND V2 — Coach marks contextuais (fase 2 do onboarding).
   Dicas que aparecem na 1ª VISITA de cada tela (não no boot):
     · Remixer / Busca → gatilho quando a .screen fica .active
       (MutationObserver, pega nav por clique, duplo-clique ou
       menu de contexto — showScreen não emite evento).
     · Fila → no 1º open do dock que tiver itens.
   Cada tour tem uma flag própria em api/settings
   (coach_remixer_seen…). Nunca dispara com o splash ou as
   boas-vindas na tela. "Rever dicas" (Config) zera as flags.
   ============================================================ */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);

  const TOURS = [
    {
      key: 'coach_remixer_seen', label: 'Remixer', screen: 'remixer',
      steps: [
        { sel: '.rmx-deck .mod.primary', title: 'Pitch & Tempo',
          text: 'Puxe <b>Pitch</b> e <b>Tempo</b> de forma independente — mudar o andamento não altera o tom (e vice-versa). Os passos afinam de semitom em semitom.' },
        { sel: '[data-coach="fx"]', title: 'Filtro & EQ',
          text: '<b>Filtro</b> LP/HP e <b>EQ</b> de 3 bandas, aplicados ao vivo na saída. O <b>Reset</b> no topo zera tudo.' },
        { sel: '.pad-grid', title: 'Pads de sample',
          text: 'Arraste um trecho na forma de onda pra um pad vazio; tocá-lo troca a faixa pelo loop ao vivo. Botão direito limpa o pad.' },
        { sel: '[data-stems-btn]', title: 'Stems',
          text: '<b>Stems</b> abre a versão multipista da faixa — mudo, solo e volume de cada camada em tempo real.' },
      ],
    },
    {
      key: 'coach_busca_seen', label: 'Busca', screen: 'busca',
      steps: [
        { sel: '.bsc-query', title: 'Busca por texto',
          text: 'Busque por <b>faixa, artista ou álbum</b>. O atalho <b>⌘K</b> foca o campo de qualquer tela.' },
        { sel: '.bsc-filters', title: 'Facetas',
          text: 'Refine por <b>período, formato, BPM, tags, tom</b> (mixagem harmônica Camelot) e <b>estado</b> — as facetas combinam entre si.' },
      ],
    },
    {
      key: 'coach_fila_seen', label: 'Fila', queue: true,
      steps: [
        { sel: '[data-queue-list]', title: 'Reordenar a fila',
          text: '<b>Arraste</b> as faixas pra mudar o que toca a seguir.' },
        { sel: '[data-queue-save]', title: 'Salvar como playlist',
          text: '<b>Salvar</b> transforma a fila atual numa playlist do seu acervo.' },
      ],
    },
  ];

  const seen = Object.create(null);
  let ready = false;   // flags de settings carregadas?
  let active = null;   // tour em andamento
  let idx = 0;
  let root = null, hole = null, pop = null, reposition = null;

  function persist(patch) {
    return fetch('api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: patch }),
    }).catch((e) => console.error('coach persist failed:', e));
  }

  // não dispara por cima do splash, das boas-vindas ou de outro tour
  function blocked() { return !!(active || $('.boot-splash') || $('.onb-scrim')); }

  /* ---------- geometria ---------- */
  function unionRect(sel) {
    const els = [...document.querySelectorAll(sel)];
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top);
      x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom);
    });
    if (x1 === Infinity) return null;
    return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
  }

  function placeStep() {
    const step = active.steps[idx];
    const r = unionRect(step.sel);
    if (!r) { // âncora sumiu → avança (ou encerra se for a última)
      if (idx >= active.steps.length - 1) finish(); else { idx++; placeStep(); }
      return;
    }
    const PAD = 8;
    const hx = Math.max(4, r.left - PAD), hy = Math.max(4, r.top - PAD);
    const hw = r.width + PAD * 2, hh = r.height + PAD * 2;
    hole.style.left = hx + 'px'; hole.style.top = hy + 'px';
    hole.style.width = hw + 'px'; hole.style.height = hh + 'px';

    renderPop(step);

    const pr = pop.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight, GAP = 14;
    let top;
    if (hy + hh + GAP + pr.height <= vh - 10) top = hy + hh + GAP;          // abaixo
    else if (hy - GAP - pr.height >= 10) top = hy - GAP - pr.height;         // acima
    else top = Math.min(vh - pr.height - 10, Math.max(10, hy));              // encaixa
    const left = Math.min(vw - pr.width - 10, Math.max(10, hx + hw / 2 - pr.width / 2));
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
  }

  function renderPop(step) {
    const n = active.steps.length, last = idx === n - 1;
    const dots = active.steps.map((_, i) =>
      '<span class="coach-dot' + (i === idx ? ' on' : '') + '"></span>').join('');
    pop.innerHTML =
      '<div class="coach-eyebrow">' + active.label + ' · ' + (idx + 1) + '/' + n + '</div>' +
      '<div class="coach-title">' + step.title + '</div>' +
      '<div class="coach-text">' + step.text + '</div>' +
      '<div class="coach-foot">' +
        '<button class="coach-skip" data-c-skip>Pular</button>' +
        '<div class="coach-dots">' + dots + '</div>' +
        '<div class="coach-btns">' +
          (idx > 0 ? '<button class="coach-btn ghost" data-c-prev>Voltar</button>' : '') +
          '<button class="coach-btn accent" data-c-next>' + (last ? 'Concluir' : 'Próximo') + '</button>' +
        '</div>' +
      '</div>';
    pop.querySelector('[data-c-next]').addEventListener('click', next);
    const p = pop.querySelector('[data-c-prev]'); if (p) p.addEventListener('click', back);
    pop.querySelector('[data-c-skip]').addEventListener('click', finish);
  }

  function next() { if (idx >= active.steps.length - 1) finish(); else { idx++; placeStep(); } }
  function back() { if (idx > 0) { idx--; placeStep(); } }

  function start(tour) {
    if (blocked()) return;
    active = tour; idx = 0;
    root = document.createElement('div'); root.className = 'coach-root';
    hole = document.createElement('div'); hole.className = 'coach-hole';
    pop  = document.createElement('div'); pop.className = 'coach-pop';
    root.appendChild(hole); root.appendChild(pop);
    document.body.appendChild(root);
    root.addEventListener('mousedown', (e) => { if (e.target === root) e.preventDefault(); });
    document.addEventListener('keydown', onKey, true);
    reposition = rafThrottle(() => { if (active) placeStep(); });
    addEventListener('resize', reposition);
    addEventListener('scroll', reposition, true);
    requestAnimationFrame(() => { if (root) { root.classList.add('on'); placeStep(); } });
  }

  function finish() {
    if (!active) return;
    seen[active.key] = true;
    persist({ [active.key]: true });
    teardown();
  }

  function teardown() {
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('resize', reposition);
    removeEventListener('scroll', reposition, true);
    reposition = null; active = null; idx = 0;
    if (!root) return;
    const el = root; root = hole = pop = null;
    el.classList.remove('on');
    let gone = false; const rm = () => { if (gone) return; gone = true; el.remove(); };
    el.addEventListener('transitionend', rm, { once: true });
    setTimeout(rm, 320);
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
  }

  function rafThrottle(fn) {
    let scheduled = false;
    return () => { if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; fn(); }); };
  }

  /* ---------- gatilhos ---------- */
  function maybeStart(tour) {
    if (!ready || !tour || seen[tour.key] || blocked()) return;
    // espera a transição de entrada da tela assentar antes de medir os rects
    setTimeout(() => {
      if (!ready || seen[tour.key] || blocked()) return;
      if (tour.screen) {
        const scr = $('.screen[data-screen="' + tour.screen + '"]');
        if (!scr || !scr.classList.contains('active')) return; // saiu antes
      }
      if (tour.queue && !queueEligible()) return;
      start(tour);
    }, 420);
  }

  function watchScreens() {
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        const el = m.target;
        if (el.classList && el.classList.contains('active') && el.dataset.screen) {
          const t = TOURS.find((x) => x.screen === el.dataset.screen);
          if (t) maybeStart(t);
        }
      }
    });
    document.querySelectorAll('.screen[data-screen]').forEach((s) =>
      obs.observe(s, { attributes: true, attributeFilter: ['class'] }));
  }

  function queueEligible() {
    const dock = $('[data-dock]'), list = $('[data-queue-list]');
    return !!(dock && dock.classList.contains('queue-open') && list && list.children.length);
  }
  function watchQueue() {
    const btn = $('[data-queue-open]');
    if (btn) btn.addEventListener('click', () => maybeStart(TOURS.find((x) => x.queue)));
  }

  /* ---------- reset (Config → Introdução → "Rever dicas") ---------- */
  function reset() {
    const patch = {};
    TOURS.forEach((t) => { seen[t.key] = false; patch[t.key] = false; });
    persist(patch);
    document.dispatchEvent(new CustomEvent('rolf:toast',
      { detail: { text: 'As dicas reaparecem ao visitar cada tela', kicker: 'Dicas' } }));
  }
  window.RolfCoach = {
    reset,
    start: (key) => { const t = TOURS.find((x) => x.key === key); if (t) start(t); },
  };
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('[data-coach-replay]')) { e.preventDefault(); reset(); }
  });

  /* ---------- boot: arma gatilhos e carrega as flags ---------- */
  watchScreens();
  watchQueue();
  fetch('api/settings')
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => { if (cfg) TOURS.forEach((t) => { if (cfg[t.key] === true) seen[t.key] = true; }); ready = true; })
    .catch(() => { ready = true; });
})();
