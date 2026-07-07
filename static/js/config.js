/* ============================================================
   ROLFSOUND V2 — Config persistente (data-cfg-key)
   Fonte única de load/persist da tela Configurações: todo controle
   anotado com data-cfg-key é pintado no boot a partir de UM
   GET /api/settings e persistido com POST parcial na mudança
   (config.json da web; settings.py repassa ao core o que for
   runtime — ex.: stems_keep_mix).

   O comportamento visual (toggle .on / .active) continua no
   prototype.js — este script carrega DEPOIS, então os listeners
   daqui só leem o estado resultante e persistem. A aparência
   salva (acento / densidade / movimento reduzido) é aplicada
   pelos hooks de window.RolfAppearance (prototype.js).

   Controles suportados:
     · switch     [data-sw][data-cfg-key]       → booleano (.on)
     · segmentado [data-cfg-seg][data-cfg-key]  → string (data-val do botão)
   ============================================================ */
(function () {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  function save(patch) {
    fetch('api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: patch }),
    }).catch((e) => console.error('config save failed:', e));
  }

  /* ---------- pintar o estado salvo ---------- */
  function paint(cfg) {
    $$('.cfg [data-sw][data-cfg-key]').forEach((sw) => {
      const v = cfg[sw.dataset.cfgKey];
      if (typeof v === 'boolean') sw.classList.toggle('on', v);
    });
    $$('.cfg [data-cfg-seg][data-cfg-key]').forEach((g) => {
      const v = cfg[g.dataset.cfgKey];
      const btn = $$('button', g).find((b) => b.dataset.val === v);
      if (btn) $$('button', g).forEach((x) => x.classList.toggle('active', x === btn));
    });
    // aplica a aparência salva (não só o visual do controle)
    const A = window.RolfAppearance || {};
    if (A.reduceMotion) A.reduceMotion(cfg.ui_reduce_motion === true);
    if (A.density && cfg.ui_viz_density) A.density(cfg.ui_viz_density);
  }

  /* ---------- persistir mudanças ---------- */
  $$('.cfg [data-sw][data-cfg-key]').forEach((sw) => {
    sw.addEventListener('click', () => {
      save({ [sw.dataset.cfgKey]: sw.classList.contains('on') });   // prototype.js já togglou
    });
  });
  $$('.cfg [data-cfg-seg][data-cfg-key]').forEach((g) => {
    g.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b && b.dataset.val) save({ [g.dataset.cfgKey]: b.dataset.val });
    });
  });
  fetch('api/settings')
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => { if (cfg) paint(cfg); })
    .catch(() => {});
})();
