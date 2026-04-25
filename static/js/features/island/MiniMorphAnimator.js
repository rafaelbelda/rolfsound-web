// static/js/MiniMorphAnimator.js
// Anima a transição contínua entre o miniplayer (rodapé) e o full player (centro).
//
// miniToFull(miniEl)  — mini pill vira full player
// fullToMini(miniEl)  — full player vira mini pill
//
// Não usa mitose — é um FLIP direto: o player container se reposiciona e
// redimensiona de um estado para o outro via WAAPI.

import AnimationEngine from '/static/js/features/animations/AnimationEngine.js';

// Dimensões do full player (mirrored de playback-mitosis.js)
const PLAYER_W   = 340;
const SQUARE_H   = 340;
const CONTROLS_H = 56;
const GAP        = 10;
const TOTAL_H    = SQUARE_H + GAP + CONTROLS_H; // 406

// Dimensões do miniplayer (deve estar em sync com --mini-* no global.css)
const MINI_W = 460;
const MINI_H = 58;
const MINI_BOTTOM = 30;

// Duração da transição (ms)
const MORPH_DURATION = 480;
const EASE_SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)'; // similar ao --ease-spring

export default class MiniMorphAnimator {
  constructor(manager) {
    this.manager = manager;
    this._active = false;
  }

  // ─── mini → full ────────────────────────────────────────────────────────────

  /**
   * Abre o full player a partir do miniplayer.
   * @param {HTMLElement} miniEl — elemento <rolfsound-miniplayer>
   */
  async miniToFull(miniEl) {
    if (this._active) return;
    this._active = true;

    const manager = this.manager;

    // Posição inicial (mini)
    const miniRect = this._getMiniRect();

    // Posição final (full player)
    const fullRect = this._getFullRect();

    // Esconde conteúdo interno do mini, mantém shell visível como ponto de partida
    miniEl.style.opacity = '0';
    miniEl.style.pointerEvents = 'none';

    // Garante que stale elements anteriores foram limpos
    ['playback-player-container', 'mitosis-bridge'].forEach(id => {
      document.getElementById(id)?.remove();
    });

    // Cria container do player com HTML completo, mas conteúdo escondido
    const container = document.createElement('div');
    container.id = 'playback-player-container';
    container.innerHTML = manager.buildPlayerHTML();
    container.style.cssText = `
      position: fixed;
      z-index: 996;
      overflow: hidden;
      background: var(--color-playback-shell);
      border-radius: var(--radius-dynamic-island);
      border: none;
      box-shadow: none;
      will-change: transform, width, height;
      left: ${miniRect.left}px;
      top: ${miniRect.top}px;
      width: ${miniRect.width}px;
      height: ${miniRect.height}px;
    `;

    // Esconde conteúdo interno durante a animação de morph
    const cover    = container.querySelector('#playback-cover-shell');
    const controls = container.querySelector('#playback-controls-shell');
    if (cover)    cover.style.opacity    = '0';
    if (controls) controls.style.opacity = '0';

    document.body.appendChild(container);
    manager.playerContainer = container;
    manager._crossfader.prefill(container);

    // Pre-impact na ilha
    if (manager.island?.respondToImpact) {
      manager.island.respondToImpact({ sourceVector: { x: 0, y: 1 }, strength: 0.7, duration: 380 });
    }

    // ── WAAPI: anima posição e dimensões ──────────────────────────────────────
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const duration = reduced ? 1 : MORPH_DURATION;

    const anim = container.animate([
      {
        left:         `${miniRect.left}px`,
        top:          `${miniRect.top}px`,
        width:        `${miniRect.width}px`,
        height:       `${miniRect.height}px`,
        borderRadius: 'var(--radius-dynamic-island)',
      },
      {
        left:         `${fullRect.left}px`,
        top:          `${fullRect.top}px`,
        width:        `${fullRect.width}px`,
        height:       `${fullRect.height}px`,
        borderRadius: 'var(--radius-dynamic-island)',
        easing:       EASE_SPRING,
      }
    ], {
      duration,
      fill: 'forwards',
      easing: 'ease-in-out',
    });

    // Revela conteúdo na fase final da animação
    AnimationEngine.schedule(manager, () => {
      if (!container.isConnected) return;
      manager._mitosis._revealPlayerStage(container);
    }, duration * 0.55);

    await anim.finished.catch(() => {});

    if (!container.isConnected) {
      this._active = false;
      return;
    }

    // Commit estilos finais e finaliza
    try { anim.commitStyles(); } catch {}
    anim.cancel();

    // Remove overrides de posicionamento — deixa o player settle no seu próprio estilo
    container.style.left   = `${fullRect.left}px`;
    container.style.top    = `${fullRect.top}px`;
    container.style.width  = `${fullRect.width}px`;
    container.style.height = `${fullRect.height}px`;
    container.style.background    = 'transparent';
    container.style.border        = 'none';
    container.style.boxShadow     = 'none';

    manager._mitosis._settlePlayer(container);
    this._active = false;
  }

  // ─── full → mini ────────────────────────────────────────────────────────────

  /**
   * Fecha o full player voltando pra forma de miniplayer no rodapé.
   * @param {HTMLElement} miniEl — elemento <rolfsound-miniplayer>
   */
  async fullToMini(miniEl) {
    if (this._active) return;
    this._active = true;

    const manager   = this.manager;
    const container = manager.playerContainer;

    if (!container || !container.isConnected) {
      this._active = false;
      miniEl.style.opacity       = '';
      miniEl.style.pointerEvents = '';
      return;
    }

    manager.clearAnimationTimers();
    manager._animator.cancelAll();

    // Fecha o queue panel se estiver aberto
    if (manager.isQueueOpen) {
      AnimationEngine.clearScheduled(manager, '_queueTimers');
      manager.queueContainer?.remove();
      manager.queueContainer = null;
      manager.isQueueOpen = false;
    }

    // Posições
    const fullRect = this._getFullRect();
    const miniRect = this._getMiniRect();

    // ── 1. Esconde conteúdo do player ────────────────────────────────────────
    const cover    = container.querySelector('#playback-cover-shell');
    const controls = container.querySelector('#playback-controls-shell');
    if (controls) {
      controls.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
      controls.style.opacity    = '0';
      controls.style.transform  = `translateY(10px) scale(0.96)`;
    }
    if (cover) {
      cover.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
      cover.style.opacity    = '0';
      cover.style.transform  = 'scale(0.97)';
    }

    // Reaplica shell antes do shrink
    container.style.background   = 'var(--color-playback-shell)';
    container.style.border       = 'none';
    container.style.borderRadius = 'var(--radius-dynamic-island)';
    container.style.boxShadow    = 'none';
    container.style.overflow     = 'hidden';
    container.style.left         = `${fullRect.left}px`;
    container.style.top          = `${fullRect.top}px`;
    container.style.width        = `${fullRect.width}px`;
    container.style.height       = `${fullRect.height}px`;

    // ── 2. Pequena espera pra o fade do conteúdo começar ─────────────────────
    await new Promise(r => setTimeout(r, 80));
    if (!container.isConnected) {
      this._active = false;
      miniEl.style.opacity       = '';
      miniEl.style.pointerEvents = '';
      return;
    }

    // ── 3. WAAPI: anima de full para mini ────────────────────────────────────
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const duration = reduced ? 1 : MORPH_DURATION;

    const anim = container.animate([
      {
        left:   `${fullRect.left}px`,
        top:    `${fullRect.top}px`,
        width:  `${fullRect.width}px`,
        height: `${fullRect.height}px`,
      },
      {
        left:   `${miniRect.left}px`,
        top:    `${miniRect.top}px`,
        width:  `${miniRect.width}px`,
        height: `${miniRect.height}px`,
        easing: EASE_SPRING,
      }
    ], {
      duration,
      fill: 'forwards',
      easing: 'ease-in',
    });

    await anim.finished.catch(() => {});

    // ── 4. Cleanup e reveal do mini ──────────────────────────────────────────
    if (container.isConnected) container.remove();
    manager.playerContainer = null;
    manager._division = null;
    manager.clearDomReferences();

    // Resposta elástica na ilha
    if (manager.island) {
      AnimationEngine.respondToImpact(manager.island, {
        sourceVector:   { x: 0, y: 1 },
        fallbackVector: { x: 0, y: -1 },
        strength: 0.7,
        maxTravel: 6
      });
    }

    // Mostra mini novamente (garantindo que display não seja 'none' em qualquer caso)
    miniEl.style.display       = '';
    miniEl.style.opacity       = '';
    miniEl.style.pointerEvents = '';
    miniEl._visible            = true;

    this._active = false;
  }

  // ─── Geometria ───────────────────────────────────────────────────────────────

  _getMiniRect() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      left:   Math.round((vw - MINI_W) / 2),
      top:    Math.round(vh - MINI_BOTTOM - MINI_H),
      width:  MINI_W,
      height: MINI_H,
    };
  }

  _getFullRect() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      left:   Math.round((vw - PLAYER_W) / 2),
      top:    Math.round((vh - TOTAL_H) / 2),
      width:  PLAYER_W,
      height: TOTAL_H,
    };
  }
}
