/* ============================================================
   ROLFSOUND V2 — Boot splash controller.
   Some quando o app fica pronto (window.load), com um tempo
   mínimo em tela pra a animação ser vista e um teto duro pra
   nunca travar. Ao remover, avisa via `rolf:splash-done` +
   window.__rolfSplashDone — o onboarding espera isso pra abrir
   as boas-vindas só depois da revelação (ver onboarding.js).
   ============================================================ */
(function () {
  'use strict';

  const el = document.querySelector('.boot-splash');
  if (!el) return;

  const START = performance.now();
  const MIN_MS = 1100; // tempo mínimo em tela
  const MAX_MS = 6000; // teto de segurança
  let closing = false;
  let removed = false;

  function remove() {
    if (removed) return;
    removed = true;
    el.remove();
    window.__rolfSplashDone = true;
    document.dispatchEvent(new CustomEvent('rolf:splash-done'));
  }

  function finish() {
    if (closing) return;
    closing = true;
    el.classList.add('hide');
    el.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 800); // fallback se a transição não disparar
  }

  function whenReady() {
    const waited = performance.now() - START;
    setTimeout(finish, Math.max(0, MIN_MS - waited));
  }

  if (document.readyState === 'complete') whenReady();
  else window.addEventListener('load', whenReady, { once: true });

  setTimeout(finish, MAX_MS); // nunca fica preso, mesmo se load não vier
})();
