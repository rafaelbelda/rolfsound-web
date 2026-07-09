/* ============================================================
   ROLFSOUND V2 — Levels feed
   Poller ÚNICO de GET /api/levels, compartilhado entre os
   consumidores (medidor do Remixer, mini-vis do transporte,
   visualizer fullscreen). Cada consumidor se registra com um
   predicado `active()`; o poll (~120 ms) só roda enquanto algum
   estiver ativo — sem consumidor visível/tocando, zero rede.
   Se algum consumidor ativo pedir `bands`, o poll pede o
   espectro junto (FFT em N bandas no core, sob demanda) e expõe
   em RolfLevels.bands. `online` diz se o core respondeu — falso
   manda os consumidores pro fallback sintético de sempre.
   ============================================================ */
(function () {
  'use strict';

  const subs = new Map();   // nome -> { active: fn(), bands: int }

  const S = window.RolfLevels = {
    l: 0, r: 0,             // picos L/R 0..1 do último poll
    bands: null,            // number[] 0..1 (graves → agudos) | null
    online: false,          // o core respondeu no último poll?
    at: 0,                  // performance.now() do último dado novo
    register(name, active, opts) {
      subs.set(name, { active, bands: (opts && opts.bands) || 0 });
      ensure();
    },
  };

  let polling = false;

  // Alguém precisa de dados agora? Devolve o maior nº de bandas pedido.
  function wanted() {
    if (document.hidden) return null;
    let any = false, bands = 0;
    subs.forEach((s) => {
      if (!s.active()) return;
      any = true;
      if (s.bands > bands) bands = s.bands;
    });
    return any ? { bands } : null;
  }

  async function poll() {
    const w = wanted();
    if (!w) {
      polling = false;
      S.online = false; S.l = S.r = 0; S.bands = null;
      return;
    }
    try {
      const res = await fetch('/api/levels' + (w.bands ? '?bands=' + w.bands : ''));
      if (res.ok) {
        const j = await res.json();
        S.l = +j.l || 0;
        S.r = +j.r || 0;
        S.bands = Array.isArray(j.bands) ? j.bands : null;
        S.online = true;
        S.at = performance.now();
      } else {
        S.online = false;
      }
    } catch (_) {
      // core offline — consumidores decaem/caem no sintético
      S.online = false; S.l = S.r = 0; S.bands = null;
    }
    setTimeout(poll, 120);
  }

  function ensure() {
    if (!polling && wanted()) { polling = true; poll(); }
  }

  setInterval(ensure, 800);   // barato: religa quando um consumidor volta
  document.addEventListener('visibilitychange', ensure);
})();
