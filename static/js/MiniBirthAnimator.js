// static/js/MiniBirthAnimator.js
// Anima o nascimento e absorção do miniplayer em relação à ilha.
//
// birth()  — mini emerge no rodapé (ilha empurra, mini aparece abaixo)
// absorb() — mini desaparece no rodapé e a ilha recebe impacto de retorno
//
// Abordagem: em vez de uma membrana SVG atravessando toda a altura do viewport,
// o mini "nasce" com um slide-up desde abaixo da tela com spring decay.
// A ilha recebe um impacto visual simultâneo (como se tivesse "expelido" o mini).
// Simples, bonito, e não quebra com viewports de qualquer altura.

import AnimationEngine from '/static/js/AnimationEngine.js';

// Parâmetros de animação
const BIRTH_DURATION   = 540;   // ms — slide-up spring
const ABSORB_DURATION  = 380;   // ms — slide-down exit
const OVERSHOOT_PX     = 12;    // px — overshoot spring pra cima antes de settle
const EASE_SPRING      = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
const EASE_EXIT        = 'cubic-bezier(0.4, 0, 1, 1)';

export default class MiniBirthAnimator {
  constructor() {
    this._active = false;
    this._timers = new Set();
  }

  // ─── Nascimento: mini aparece no rodapé ─────────────────────────────────────

  /**
   * @param {HTMLElement} island  — elemento <rolfsound-island>
   * @param {HTMLElement} miniEl  — elemento <rolfsound-miniplayer>
   */
  async birth({ island, miniEl }) {
    if (this._active) return;
    this._active = true;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // 1. Impacto na ilha — como se ela "expelisse" o mini pra baixo
    if (island?.respondToImpact) {
      island.respondToImpact({
        sourceVector: { x: 0, y: 1 },
        strength: 0.65,
        duration: 420
      });
    }

    // 2. Posiciona mini fora da tela abaixo, invisível
    miniEl.style.display    = '';
    miniEl.style.opacity    = '0';
    miniEl.style.transform  = 'translateX(-50%) translateY(120px)';
    // Desativa a transição do CSS :host para usar apenas WAAPI
    miniEl.style.transition = 'none';

    // Força reflow pra garantir que o estado inicial seja pintado
    miniEl.getBoundingClientRect();

    // 3. Slide-up spring com fade-in
    const duration = reduced ? 1 : BIRTH_DURATION;
    const anim = miniEl.animate([
      {
        opacity:   '0',
        transform: 'translateX(-50%) translateY(120px)',
      },
      {
        opacity:   '1',
        transform: `translateX(-50%) translateY(-${OVERSHOOT_PX}px)`,
        offset:    0.72,
        easing:    EASE_SPRING,
      },
      {
        opacity:   '1',
        transform: 'translateX(-50%) translateY(0px)',
      }
    ], {
      duration,
      fill: 'forwards',
      easing: 'ease-out',
    });

    await anim.finished.catch(() => {});

    // 4. Commit e limpa override de transform (o CSS :host já cuida do posicionamento)
    try { anim.commitStyles(); } catch {}
    anim.cancel();
    miniEl.style.opacity   = '';
    miniEl.style.transform = '';
    miniEl.style.transition = '';

    // Marca como visível oficialmente
    miniEl._visible = true;

    this._active = false;
  }

  // ─── Absorção: mini volta pra ilha ──────────────────────────────────────────

  /**
   * @param {HTMLElement} island  — elemento <rolfsound-island>
   * @param {HTMLElement} miniEl  — elemento <rolfsound-miniplayer>
   */
  async absorb({ island, miniEl }) {
    if (this._active) return;
    this._active = true;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // 1. Slide-down + fade-out
    const duration = reduced ? 1 : ABSORB_DURATION;
    const anim = miniEl.animate([
      {
        opacity:   '1',
        transform: 'translateX(-50%) translateY(0px)',
      },
      {
        opacity:   '0',
        transform: 'translateX(-50%) translateY(100px)',
        easing:    EASE_EXIT,
      }
    ], {
      duration,
      fill: 'forwards',
    });

    // 2. Impacto na ilha na metade da animação (como se estivesse "puxando" o mini)
    const impactDelay = Math.round(duration * 0.4);
    const t = setTimeout(() => {
      this._timers.delete(t);
      if (island?.respondToImpact) {
        island.respondToImpact({
          sourceVector: { x: 0, y: -1 },
          strength: 0.55,
          duration: 360
        });
      }
    }, impactDelay);
    this._timers.add(t);

    await anim.finished.catch(() => {});

    // 3. Esconde
    try { anim.commitStyles(); } catch {}
    anim.cancel();
    miniEl.style.display   = 'none';
    miniEl.style.opacity   = '';
    miniEl.style.transform = '';
    miniEl._visible = false;

    this._active = false;
  }

  destroy() {
    this._timers.forEach(t => clearTimeout(t));
    this._timers.clear();
  }
}
