/* ============================================================
   ROLFSOUND V2 — Onboarding (introdução no primeiro boot)
   · Boas-vindas mostradas UMA vez: um cartão que explica o que é
     o Rolfsound e leva à primeira ação real — importar uma faixa.
   · Estado no SERVIDOR (api/settings → onboarding_done), não em
     localStorage: o importer dá location.reload() ao concluir, e
     só o servidor sobrevive a isso. Dispensar (qualquer botão, X,
     Esc, clique fora) grava onboarding_done=true.
   · Reabrir manualmente: Config → Introdução (botão
     [data-onboard-replay]) chama RolfOnboarding.replay().
   · Coach marks por-tela (Remixer/Busca/Fila) são a fase 2 — este
     módulo é só o momento 1. RolfOnboarding.open() fica exposto
     para elas se apoiarem depois.
   ============================================================ */
(function () {
  'use strict';

  const KEY = 'onboarding_done';
  let scrim = null;
  let handled = false; // o boot já decidiu mostrar/ocultar?

  const svg = (inner, sw) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
    (sw || 1.6) + '" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';

  function persist(done) {
    return fetch('api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { [KEY]: done } }),
    }).catch((e) => console.error('onboarding persist failed:', e));
  }

  const feat = (icon, name, desc) =>
    '<li class="onb-feat"><span class="onb-ic">' + icon + '</span>' +
    '<span class="onb-feat-tx"><b>' + name + '</b><span>' + desc + '</span></span></li>';

  function build() {
    const s = document.createElement('div');
    s.className = 'onb-scrim';
    s.innerHTML =
      '<div class="onb-card" role="dialog" aria-modal="true" aria-labelledby="onb-title">' +
        '<button class="onb-x" data-onb-skip aria-label="Fechar">' +
          svg('<path d="M6 6l12 12M18 6L6 18"/>', 1.8) + '</button>' +
        '<div class="onb-eyebrow">Bem-vindo · Rolfsound 01</div>' +
        '<h2 class="onb-title" id="onb-title">Sua central de <span class="ac">som</span></h2>' +
        '<p class="onb-lede">Toque seu acervo, organize o cofre e remixe ao vivo — ' +
          'tudo num aparelho só.</p>' +
        '<ul class="onb-feats">' +
          feat(svg('<path d="M5 7h14M5 12h14M5 17h9"/>'),
               'Acervo', 'Toque e organize seu cofre de faixas') +
          feat(svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
               'Busca', 'Ache por BPM, tom, tags e formato') +
          feat(svg('<path d="M4 7h3.2l9.6 10H20"/><path d="M17 4l3 3-3 3"/>' +
                   '<path d="M4 17h3.2l2.6-2.7"/><path d="M14.2 9.7 16.8 7"/><path d="M17 14l3 3-3 3"/>'),
               'Remixer', 'Pitch, tempo, filtro, pads e stems ao vivo') +
        '</ul>' +
        '<div class="onb-actions">' +
          '<button class="onb-btn accent" data-onb-import>' +
            svg('<path d="M12 4v10M8 10l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>', 1.7) +
            'Importar minha primeira faixa</button>' +
          '<button class="onb-btn ghost" data-onb-skip>Explorar sozinho</button>' +
        '</div>' +
        '<div class="onb-foot">Dá pra rever em Configurações · Introdução</div>' +
      '</div>';
    return s;
  }

  function open() {
    if (scrim) return;
    scrim = build();
    document.body.appendChild(scrim);
    requestAnimationFrame(() => scrim && scrim.classList.add('on'));
    scrim.querySelectorAll('[data-onb-skip]').forEach((b) => b.addEventListener('click', dismiss));
    const imp = scrim.querySelector('[data-onb-import]');
    if (imp) imp.addEventListener('click', startImport);
    // clique no fundo (fora do cartão) dispensa
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) dismiss(); });
    document.addEventListener('keydown', onKey);
  }

  function close() {
    if (!scrim) return;
    const el = scrim;
    scrim = null;
    document.removeEventListener('keydown', onKey);
    el.classList.remove('on');
    let gone = false;
    const finish = () => { if (gone) return; gone = true; el.remove(); };
    el.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 450); // fallback se a transição não disparar
  }

  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); dismiss(); } }

  // dispensar = marca visto (sobrevive ao reload do importer) + fecha
  function dismiss() { persist(true); close(); }

  function startImport() {
    dismiss();
    const btn = document.querySelector('[data-import-open]');
    if (btn) btn.click();
  }

  // reabrir manualmente (Config → Introdução): volta a flag e mostra de novo
  function replay() { persist(false); open(); }

  window.RolfOnboarding = { open, replay, dismiss };

  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('[data-onboard-replay]');
    if (t) { e.preventDefault(); replay(); }
  });

  // Abre respeitando o boot splash: se o vinil ainda está em tela, espera o
  // `rolf:splash-done` pra as boas-vindas surgirem só DEPOIS da revelação
  // (a flag cobre a corrida caso o splash saia antes do settings resolver).
  function reveal() {
    if (document.querySelector('.boot-splash') && !window.__rolfSplashDone) {
      document.addEventListener('rolf:splash-done', open, { once: true });
    } else {
      open();
    }
  }

  // boot: mostra as boas-vindas enquanto onboarding_done não for true
  fetch('api/settings')
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (handled) return;
      handled = true;
      if (cfg && cfg[KEY] !== true) reveal();
    })
    .catch(() => { handled = true; });
})();
