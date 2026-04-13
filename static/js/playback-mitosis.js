// static/js/playback-mitosis.js
// Gerencia apenas o estado e lógica de playback
// As animações são delegadas ao AnimationEngine

import AnimationEngine from '/static/js/AnimationEngine.js';
import { measureIslandBarMitosis } from '/static/js/MitosisMetrics.js';
import Animator from '/static/js/Animator.js';

// ─── Dimensões do layout ───────────────────────────────────────────────────
const PLAYER_W   = 340;   // largura da capa e da pílula de controles (px)
const SQUARE_H   = 340;   // altura da capa 1:1 (px)
const CONTROLS_H = 56;    // altura da pílula de controles (px)
const GAP        = 10;    // espaço entre os dois blocos (px)
const TOTAL_H    = SQUARE_H + GAP + CONTROLS_H; // 406px
const MITOSIS_DROP = 22;  // deslocamento vertical adicional para a cópia (px)

class PlaybackMitosisManager {
  constructor() {
    this.island = null;
    this.isMorphed = false;
    this.playerContainer = null;
    this._division = null;
    this.isQueueOpen = false;
    this.queueContainer = null;

    // ─── Estado Único (Source of Truth) ───
    this.state = {
      playState: 'idle',
      currentId: null,
      currentQueueIdx: -1,
      duration: 0,

      sliderPos: 0,
      sliderAnchorMs: 0,
      guardUntilMs: 0,

      queue: [],

      shuffle: false,
      repeat: false,   // 'off' | 'one' | 'all'  (bool simples por ora)

      currentTrack: {
        title: '',
        artist: '',
        thumbnail: ''
      }
    };

    // ─── Thumbnail crossfade state ───
    this._thumbCurrentEl = null;  // <img> atualmente visível
    this._thumbPendingEl = null;  // <img> sendo carregado (cancelável)

    // ─── WAAPI Animator (interruptible GPU-composited animations) ───
    this._animator = new Animator();

    // ─── Theme dispatch dedup ───
    this._lastThemeKey = null;

    // ─── RAF Loop ───
    this.rafId = null;
    this.rafPos = -1;
    this.rafTime = '';
    this.animationTimers = new Set();

    // ─── Polling ───
    this.statusPollId = null;
    this.pollInterval = 1500;

    // ─── DOM References ───
    this.dom = {
      title: null,
      artist: null,
      thumbnail: null,
      currentTime: null,
      totalTime: null,
      progressFill: null,
      progressBar: null,
      playIcon: null,
      pauseIcon: null,
      btnPlayPause: null,
      btnSkipBack: null,
      btnSkipFwd: null,
      btnShuffle: null,
      btnRepeat: null,
      btnQueue: null,
      queueCount: null,
    };

    this.init();
  }

  init() {
    this.registerAnimations();
    this.findIsland();
    this.attachNavigationListener();
    // Polling e RAF iniciam sob demanda (morph/unmorph), não no boot
    this.startPolling();
  }

  registerAnimations() {
    // Usa CSS transitions em width/height/top (não scale),
    // evitando distorção visual. Para um único elemento position:fixed,
    // o custo de layout é mínimo.
    AnimationEngine.registerKeyframes('cellular', `
      #playback-player-container {
        position: fixed !important;
        z-index: 996;
        overflow: hidden;
        display: flex;
        justify-content: center;
        align-items: flex-start;
        backface-visibility: hidden;
        will-change: transform, clip-path, opacity;
      }
    `);
  }

  getMitosisMetrics() {
    const base = measureIslandBarMitosis(this.island, {
      originTop: 15,
      originWidth: 450,
      originHeight: 38,
      copyGap: 7,
      extraDrop: MITOSIS_DROP
    });

    base.targetTop = (window.innerHeight - TOTAL_H) / 2;
    return base;
  }

  scheduleAnimation(callback, delay) {
    return AnimationEngine.schedule(this, callback, delay);
  }

  clearAnimationTimers() {
    AnimationEngine.clearScheduled(this);
  }

  _getIslandBarContainer() {
    return this.island?.shadowRoot?.getElementById('bar-container') || null;
  }

  findIsland() {
    this.island = document.querySelector('rolfsound-island');
    if (!this.island) {
      console.warn('RolfsoundIsland not found');
    }
  }

  attachNavigationListener() {
    if (!this.island) return;

    this._onNavigate = (e) => {
      if (e.detail.view === 'playback') {
        this.morph();
      } else {
        this.unmorph();
      }
    };
    this.island.addEventListener('rolfsound-navigate', this._onNavigate);

    // ── Sync player open/close state with browser back/forward navigation ──
    this._onPopState = (e) => {
      const isPlayback = window.location.pathname === '/playback';
      if (isPlayback && !this.isMorphed) {
        this.morph();
      } else if (!isPlayback && this.isMorphed) {
        this.unmorph();
      }
    };
    window.addEventListener('popstate', this._onPopState);

    // ── Restore player on hard-refresh at /playback ──
    // customElements.whenDefined resolves almost immediately (rolfsound-island is
    // defined by the module script that runs before playback-mitosis.js). We add
    // a one-frame delay so the island shadow DOM finishes its first render and
    // index.html has set active-tab="playback" before the morph animation starts.
    if (window.location.pathname === '/playback') {
      customElements.whenDefined('rolfsound-island').then(() => {
        AnimationEngine.schedule(this, () => {
          if (!this.isMorphed) this.morph();
        }, 80, 'animationTimers');
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // MITOSIS CONTROL — Divisão Celular
  //
  // morph():   ilha incha → brota célula-filha → ponte conecta →
  //            clivagem (ponte estreita) → filha se destaca → cresce
  // unmorph(): conteúdo some → filha encolhe → sobe até a ilha →
  //            absorção (height→0) → impacto na ilha
  // ─────────────────────────────────────────────────────────────

  static BUDDING_OVERLAP = 6;   // px de sobreposição com a base da ilha
  static BUD_HEIGHT      = 52;  // altura visível do broto antes do pinch
  static PINCH_GAP       = 14;  // espaço entre ilha e filha na clivagem
  static BRIDGE_PINCH_W  = 14;  // largura da ponte no ponto de clivagem

  morph() {
    if (this.isMorphed) return;
    this.isMorphed = true;
    this.clearAnimationTimers();
    this._animator.cancelAll();
    if (this._division) { this._division.abort(); this._division = null; }

    // ── Update URL without adding a duplicate entry ──
    if (window.location.pathname !== '/playback') {
      window.history.pushState({ rolfsound: 'playback' }, '', '/playback');
    }

    // ── Clean stale elements ──
    ['playback-player-container', 'mitosis-bridge'].forEach(id => {
      const stale = document.getElementById(id);
      if (stale) stale.remove();
    });

    const metrics  = this.getMitosisMetrics();
    const islandBar = this._getIslandBarContainer();
    if (!islandBar) return;

    // ── Pre-impact on island ──
    if (this.island?.respondToImpact) {
      this.island.respondToImpact({
        sourceVector: { x: 0, y: 1 },
        strength: 0.88,
        duration: 480
      });
    }

    // ── Create child element (content ready before animation) ──
    const child = document.createElement('div');
    child.id = 'playback-player-container';
    child.innerHTML = this.buildPlayerHTML();
    child.style.cssText = `
      background: var(--color-playback-shell);
      border: none;
      box-shadow: none;
      will-change: transform, clip-path, opacity;
      border-radius: var(--radius-dynamic-island);
    `;
    this.playerContainer = child;
    this._prefillPlayerContent(child);

    // ── Membrane style from island computed style ──
    const islandStyle = getComputedStyle(islandBar);

    Promise.resolve(AnimationEngine.mitosisFull(this.island, {
      owner: this,
      id: 'playback-player',
      parent: islandBar,
      child,
      shellTarget: this.island,
      target: {
        top: metrics.targetTop,
        width: PLAYER_W,
        height: TOTAL_H,
      },
      budSize: PlaybackMitosisManager.BUD_HEIGHT,
      budOverlap: PlaybackMitosisManager.BUDDING_OVERLAP,
      budDuration: 280,
      pinchGap: PlaybackMitosisManager.PINCH_GAP,
      pinchWidth: PlaybackMitosisManager.BRIDGE_PINCH_W,
      pinchDuration: 260,
      splitDuration: 430,
      membraneOptions: {
        fillColor: islandStyle.backgroundColor || 'rgba(15, 15, 15, 0.92)',
        strokeColor: islandStyle.borderTopColor || 'rgba(255, 255, 255, 0.06)',
        shadowOpacity: 0.28,
        shadowBlur: 6,
        shadowOffsetY: 4,
        zIndex: 995,
      },
      onPhase: (phase, ctx) => {
        if (phase === 'split') {
          this._revealPlayerStage(ctx.child);
        }
      },
      onSettled: ({ child: container }) => {
        this._settlePlayer(container);
      },
      onRemoved: () => this._onDivisionRemoved(),
    }))
      .then((division) => {
        if (!division) return;
        if (!this.isMorphed || this.playerContainer !== child) {
          division.abort?.();
          return;
        }
        this._division = division;
      })
      .catch((error) => {
        console.error('Playback full mitosis open failed:', error);
      });

    if (window.meuCursor?.resetHover) window.meuCursor.resetHover();
  }

  /** Finaliza a expansão: revela conteúdo e remove casca visual */
  _revealPlayerStage(container) {
    if (!container || !container.parentNode || container !== this.playerContainer) return;

    container.style.overflow   = 'visible';
    // Keep the shell surface during split so the island never appears to vanish.
    // The shell is removed in _settlePlayer once content is fully visible.

    const cover    = container.querySelector('#playback-cover-shell');
    const controls = container.querySelector('#playback-controls-shell');

    if (cover) {
      cover.style.opacity   = '1';
      cover.style.transform = 'translateY(0) scale(1)';
    }

    this.scheduleAnimation(() => {
      if (!controls || !container.parentNode || container !== this.playerContainer) return;
      controls.style.opacity   = '1';
      controls.style.transform = 'translateY(0) scale(1)';
    }, 110);
  }

  /** Finaliza a expansão: libera interação e garante estado final */
  _settlePlayer(container) {
    if (!container || !container.parentNode || container !== this.playerContainer) return;

    // DivisionAnimator already called releaseAll + cleared clipPath/transform.
    // We clean up playback-specific visuals here.
    container.style.background   = 'transparent';
    container.style.border       = 'none';
    container.style.boxShadow    = 'none';

    const cover    = container.querySelector('#playback-cover-shell');
    const controls = container.querySelector('#playback-controls-shell');
    if (cover) {
      cover.style.opacity   = '1';
      cover.style.transform = 'translateY(0) scale(1)';
    }
    if (controls) {
      controls.style.opacity   = '1';
      controls.style.transform = 'translateY(0) scale(1)';
    }

    this.cacheDomElements();
    this.startRafLoop();
  }

  // ─────────────────────────────────────────────────────────────
  // UNMORPH — Absorção reversa (célula-filha volta para a ilha)
  // ─────────────────────────────────────────────────────────────

  unmorph() {
    if (!this.isMorphed) return;
    this.isMorphed = false;
    this.stopRafLoop();
    this.clearAnimationTimers();
    this._animator.cancelAll();

    // ── Restore URL — use replaceState so closing the player doesn't add a
    //    history entry (next Back press goes to the page before playback) ──
    if (window.location.pathname === '/playback') {
      window.history.replaceState({ rolfsound: 'library' }, '', '/library');
    }

    // ── If queue panel is open, destroy it instantly ──
    if (this.isQueueOpen) {
      AnimationEngine.clearScheduled(this, '_queueTimers');
      if (this.queueContainer && this.queueContainer.parentNode) {
        this.queueContainer.remove();
      }
      this.queueContainer = null;
      this.isQueueOpen    = false;
    }

    const container = this.playerContainer;
    if (!container) {
      this.clearDomReferences();
      return;
    }

    // ── Hide player content before absorb ──
    const cover    = container.querySelector('#playback-cover-shell');
    const controls = container.querySelector('#playback-controls-shell');
    if (controls) {
      controls.style.opacity   = '0';
      controls.style.transform = `translateY(-${CONTROLS_H + GAP}px) scale(0.94)`;
    }
    if (cover) {
      cover.style.opacity   = '0';
      cover.style.transform = 'translateY(10px) scale(0.985)';
    }

    // ── Re-apply shell appearance for the shrink animation ──
    // Child stays borderless — membrane provides the outline during absorb.
    container.style.background = 'var(--color-playback-shell)';
    container.style.border     = 'none';
    container.style.borderRadius = 'var(--radius-dynamic-island)';
    container.style.boxShadow  = 'none';

    const closeDivision = (division) => {
      Promise.resolve(AnimationEngine.undoMitosisFull(this.island, {
        owner: this,
        id: 'playback-player',
        division,
        forceSettled: true,
        forceAbortRemove: true,
        child: container,
        onForceRemoved: () => this._removePlayer(container),
      })).catch((error) => {
        console.error('Playback full mitosis close failed:', error);
        this._removePlayer(container);
      });
    };

    if (this._division) {
      closeDivision(this._division);
    } else {
      const islandBar = this._getIslandBarContainer();
      if (!islandBar) {
        this._removePlayer(container);
        return;
      }

      const islandStyle = getComputedStyle(islandBar);
      const metrics = this.getMitosisMetrics();

      Promise.resolve(AnimationEngine.mitosisFull(this.island, {
        owner: this,
        id: 'playback-player',
        parent: islandBar,
        child: container,
        shellTarget: this.island,
        target: {
          top: metrics.targetTop,
          width: PLAYER_W,
          height: TOTAL_H,
        },
        budSize: PlaybackMitosisManager.BUD_HEIGHT,
        budOverlap: PlaybackMitosisManager.BUDDING_OVERLAP,
        budDuration: 240,
        pinchGap: PlaybackMitosisManager.PINCH_GAP,
        pinchWidth: PlaybackMitosisManager.BRIDGE_PINCH_W,
        splitDuration: 380,
        membraneOptions: {
          fillColor: islandStyle.backgroundColor || 'rgba(15, 15, 15, 0.92)',
          strokeColor: islandStyle.borderTopColor || 'rgba(255, 255, 255, 0.06)',
          shadowOpacity: 0.28,
          shadowBlur: 6,
          shadowOffsetY: 4,
          zIndex: 995,
        },
        onRemoved: () => this._onDivisionRemoved(),
        autoRun: false,
        startPhase: 'settled',
      }))
        .then((division) => {
          if (!division) {
            this._removePlayer(container);
            return;
          }

          this._division = division;
          closeDivision(division);
        })
        .catch((error) => {
          console.error('Playback full mitosis fallback create failed:', error);
          this._removePlayer(container);
        });
    }

    if (window.meuCursor?.resetHover) window.meuCursor.resetHover();
  }

  /** Cleanup after the division child is removed */
  _onDivisionRemoved() {
    if (this.island) {
      AnimationEngine.respondToImpact(this.island, {
        sourceVector:   { x: 0, y: 1 },
        fallbackVector: { x: 0, y: -1 },
        strength: 1.0,
        maxTravel: 9
      });
    }
    this.clearAnimationTimers();
    this.playerContainer = null;
    this._division = null;
    this.clearDomReferences();
  }

  /** Remove o container do player do DOM (fallback for edge cases) */
  _removePlayer(container) {
    this.clearAnimationTimers();
    if (container?.parentNode) container.remove();
    this.playerContainer = null;
    this._division = null;
    this.clearDomReferences();
  }

  // ─────────────────────────────────────────────────────────────
  // HTML DO PLAYER — layout minimalista cover-first
  // ─────────────────────────────────────────────────────────────

  buildPlayerHTML() {
    const W = PLAYER_W;
    const SQ = SQUARE_H;
    const CH = CONTROLS_H;
    const G  = GAP;

    return `
      <style>
        #playback-controls-shell {
          position: relative;
          width: ${W}px;
          height: ${CH}px;
          flex-shrink: 0;
          overflow: visible;
          opacity: 0;
          transform: translateY(-${CH + G}px) scale(0.94);
          transform-origin: top center;
          z-index: 1;
          transition:
            opacity 0.24s ease,
            transform 0.52s var(--ease-standard);
        }

        #playback-cover-shell {
          position: relative;
          width: ${W}px;
          height: ${SQ}px;
          flex-shrink: 0;
          opacity: 0;
          transform: translateY(10px) scale(0.985);
          transform-origin: top center;
          z-index: 2;
          transition:
            opacity 0.24s ease,
            transform 0.58s var(--ease-standard);
        }

        #playback-controls-pill {
          width: 100%;
          height: 100%;
          background: var(--color-playback-pill);
          backdrop-filter: blur(var(--blur-playback));
          -webkit-backdrop-filter: blur(var(--blur-playback));
          border: 1px solid var(--color-border-soft);
          border-radius: var(--radius-dynamic-island);
          display: flex;
          align-items: center;
          justify-content: space-evenly;
          padding: 0 10px;
          box-shadow: var(--shadow-playback-pill);
        }

        .playback-control-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 38px;
          height: 38px;
          padding: 0;
          background: transparent;
          border: none;
          border-radius: var(--radius-lg);
          color: var(--color-text-control);
          transition: color 0.18s ease, transform 0.18s ease;
          position: relative;
          flex: 0 0 auto;
        }

        .playback-control-btn svg {
          width: 14px;
          height: 14px;
          stroke-width: 2;
          pointer-events: none;
        }

        .playback-control-btn:active {
          transform: scale(0.96);
        }

        .playback-control-btn-main {
          width: 42px;
          height: 42px;
          color: var(--color-text-control-strong);
        }

        .playback-control-btn-main svg {
          width: 18px;
          height: 18px;
        }

        /* ── Extended hover zone: captures mouse to the right of the controls pill ── */
        #playback-controls-shell::after {
          content: '';
          position: absolute;
          left: 100%;
          top: -10px;
          width: ${CH + 20}px;
          height: calc(100% + 20px);
          background: transparent;
          pointer-events: auto;
        }

        #btn-queue {
          position: absolute;
          top: 50%;
          left: calc(100% + 4px);
          transform: translateY(-50%) translateX(-8px) scaleX(0.14) scaleY(0.74);
          transform-origin: center left;
          width: ${CH}px;
          height: ${CH}px;
          padding: 0;
          border: 1px solid var(--color-border-soft);
          border-radius: var(--radius-dynamic-island);
          background: var(--color-playback-pill);
          backdrop-filter: blur(var(--blur-playback));
          -webkit-backdrop-filter: blur(var(--blur-playback));
          color: var(--color-text-control);
          box-shadow: var(--shadow-playback-pill);
          clip-path: inset(26% 76% 26% 0 round 999px);
          pointer-events: none;
          z-index: 1; /* Stacks above the ::after hover-zone pseudo-element */
          transition:
            clip-path 0.34s var(--ease-emphasized),
            transform 0.45s var(--ease-spring),
            border-radius 0.28s var(--ease-snappy),
            color 0.18s ease;
        }

        #playback-controls-shell:hover #btn-queue,
        #playback-controls-shell:focus-within #btn-queue {
          pointer-events: auto;
          transform: translateY(-50%) translateX(0) scale(1);
          clip-path: inset(0 0 0 0 round var(--radius-dynamic-island));
        }

        #btn-queue.queue-open {
          pointer-events: none !important;
          transform: translateY(-50%) translateX(0) scaleX(0.2) scaleY(0.8) !important;
          clip-path: inset(30% 80% 30% 0 round 999px) !important;
          transition: clip-path 0.18s ease, transform 0.18s ease !important;
        }

        #btn-queue svg {
          width: 15px;
          height: 15px;
          stroke-width: 1.9;
          pointer-events: none;
        }

        /* ── Queue hint label (visible when button is hidden, fades when button appears) ── */
        #queue-btn-hint {
          position: absolute;
          top: 50%;
          left: calc(100% + 4px);
          transform: translateY(-50%);
          width: ${CH}px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 5px;
          pointer-events: none;
          opacity: 1;
          transition: opacity 0.18s ease;
        }

        #playback-controls-shell:hover #queue-btn-hint,
        #playback-controls-shell:focus-within #queue-btn-hint {
          opacity: 0;
          transition: opacity 0.1s ease;
        }

        .queue-hint-line-v {
          display: block;
          width: 1px;
          height: 10px;
          background: rgba(255, 255, 255, 0.1);
        }

        .queue-hint-text {
          font-size: 8px;
          letter-spacing: 1.8px;
          text-transform: uppercase;
          color: var(--color-text-disabled);
          white-space: nowrap;
          font-weight: 500;
        }

        #queue-count {
          position: absolute;
          top: 8px;
          right: 7px;
          min-width: 14px;
          height: 14px;
          padding: 0 4px;
          border-radius: var(--radius-full);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: var(--fs-2xs);
          font-weight: 700;
          letter-spacing: 0.04em;
          color: var(--color-badge-text);
          background: var(--color-badge-bg);
          opacity: 0;
          transition: opacity 0.18s ease;
        }
      </style>

      <div id="playback-inner-wrapper" style="
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: ${G}px;
        width: ${W}px;
        background: transparent;
        box-sizing: border-box;
        opacity: 1;
      ">

        <!-- ── CAPA 1:1 ── -->
        <div id="playback-cover-shell">
          <div style="
            position: relative;
            width: ${W}px;
            height: ${SQ}px;
            border-radius: var(--radius-dynamic-island);
            overflow: hidden;
            flex-shrink: 0;
            background: var(--color-playback-cover);
            border: 1px solid var(--color-border-subtle);
            box-shadow: var(--shadow-cover);
          ">

            <!-- Thumbnail (preenche o quadrado inteiro) -->
            <div id="playback-thumbnail" style="
              position: absolute;
              inset: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              background: var(--color-playback-cover);
            ">
              <svg viewBox="0 0 24 24" fill="none" stroke="var(--color-playback-icon-muted)" style="width: 72px; height: 72px; stroke-width: 1.0;">
                <circle cx="12" cy="12" r="10"/>
                <polygon points="10,8 16,12 10,16"/>
              </svg>
            </div>

            <!-- Gradiente + info (canto inferior esquerdo) -->
            <div style="
              position: absolute;
              bottom: 0; left: 0; right: 0;
              padding: 40px 16px 14px 16px;
              background: linear-gradient(
                to top,
                var(--color-playback-gradient-start) 0%,
                var(--color-playback-gradient-mid) 60%,
                transparent 100%
              );
              z-index: 2;
              pointer-events: none;
            ">
              <div id="playback-title" style="
                font-size: var(--font-size-title-sm);
                font-weight: 700;
                color: var(--color-text-primary);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                margin-bottom: 3px;
                letter-spacing: -0.01em;
              ">${this.escapeHtml(this.state.currentTrack.title || this.state.currentId || 'Nothing playing')}</div>

              <div id="playback-artist" style="
                font-size: var(--fs-md);
                color: var(--color-text-soft);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                letter-spacing: 0.01em;
              ">${this.escapeHtml(this.state.currentTrack.artist || '—')}</div>
            </div>

            <!-- Tempo (canto inferior direito, acima da barra) -->
            <div style="
              position: absolute;
              bottom: 7px;
              right: 12px;
              z-index: 3;
              display: flex;
              align-items: center;
              gap: 3px;
              pointer-events: none;
            ">
              <span id="current-time" style="font-size: var(--fs-xs); color: var(--color-text-time); font-family: var(--font-mono); letter-spacing: 0.04em;">${this.formatTime(this.getDeadReckonedPos())}</span>
              <span style="font-size: var(--fs-xs); color: var(--color-text-disabled); font-family: var(--font-mono);">/</span>
              <span id="total-time" style="font-size: var(--fs-xs); color: var(--color-text-time); font-family: var(--font-mono); letter-spacing: 0.04em;">${this.formatTime(this.state.duration)}</span>
            </div>

            <!-- Barra de progresso: aresta inferior do quadrado -->
            <!-- Wrapper clicável com área de toque maior -->
            <div id="progress-bar" style="
              position: absolute;
              bottom: 0; left: 0; right: 0;
              height: 12px;
              cursor: pointer;
              z-index: 4;
              display: flex;
              align-items: flex-end;
            ">
              <!-- Trilha visual (apenas 2px visíveis no fundo) -->
              <div style="
                width: 100%;
                height: 2px;
                background: var(--color-progress-track);
                position: relative;
                overflow: hidden;
              ">
                <div id="progress-fill" style="
                  position: absolute;
                  inset: 0;
                  width: 100%;
                  transform: scaleX(0);
                  transform-origin: left center;
                  background: var(--color-progress-fill);
                  transition: transform 0.08s linear;
                  border-radius: 0 var(--radius-xs) var(--radius-xs) 0;
                "></div>
              </div>
            </div>
          </div>
        </div>

        <!-- ── PÍLULA DE CONTROLES ── -->
        <div id="playback-controls-shell">
          <div id="playback-controls-pill">

            <!-- Shuffle -->
            <button id="btn-shuffle" class="playback-control-btn hover-target" title="Shuffle">
              <span id="shuffle-dot" style="
                position: absolute; bottom: 5px; left: 50%; transform: translateX(-50%);
                width: 3px; height: 3px; border-radius: 50%;
                background: var(--color-base-white-strong); opacity: 0;
                transition: opacity 0.2s ease;
              "></span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <polyline points="16 3 21 3 21 8"/>
                <line x1="4" y1="20" x2="21" y2="3"/>
                <polyline points="21 16 21 21 16 21"/>
                <line x1="15" y1="15" x2="21" y2="21"/>
              </svg>
            </button>

            <!-- Voltar / Início -->
            <button id="btn-skip-back" class="playback-control-btn hover-target" title="Anterior / Início">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <polygon points="19,20 9,12 19,4"/>
                <line x1="5" y1="19" x2="5" y2="5"/>
              </svg>
            </button>

            <!-- Play / Pause -->
            <button id="btn-play-pause" class="playback-control-btn playback-control-btn-main hover-target" title="Play / Pause">
              <svg id="icon-play" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <polygon points="5,3 19,12 5,21"/>
              </svg>
              <svg id="icon-pause" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="display: none;">
                <rect x="6" y="4" width="4" height="16"/>
                <rect x="14" y="4" width="4" height="16"/>
              </svg>
            </button>

            <!-- Próxima -->
            <button id="btn-skip-fwd" class="playback-control-btn hover-target" title="Próxima">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <polygon points="5,4 15,12 5,20"/>
                <line x1="19" y1="5" x2="19" y2="19"/>
              </svg>
            </button>

            <!-- Repeat -->
            <button id="btn-repeat" class="playback-control-btn hover-target" title="Repeat">
              <span id="repeat-dot" style="
                position: absolute; bottom: 5px; left: 50%; transform: translateX(-50%);
                width: 3px; height: 3px; border-radius: 50%;
                background: var(--color-base-white-strong); opacity: 0;
                transition: opacity 0.2s ease;
              "></span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <polyline points="17 1 21 5 17 9"/>
                <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                <polyline points="7 23 3 19 7 15"/>
                <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
              </svg>
            </button>

          </div>

          <button id="btn-queue" class="hover-target" title="Queue" aria-label="Queue">
            <span id="queue-count">0</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 6h16"/>
              <path d="M4 12h11"/>
              <path d="M4 18h16"/>
            </svg>
          </button>

          <div id="queue-btn-hint" aria-hidden="true">
            <span class="queue-hint-line-v"></span>
            <span class="queue-hint-text">Queue</span>
          </div>
        </div>
      </div>
    `;
  }

  cacheDomElements() {
    const $ = (id) => document.getElementById(id);
    this.dom.title        = $('playback-title');
    this.dom.artist       = $('playback-artist');
    this.dom.thumbnail    = $('playback-thumbnail');
    this.dom.currentTime  = $('current-time');
    this.dom.totalTime    = $('total-time');
    this.dom.progressFill = $('progress-fill');
    this.dom.progressBar  = $('progress-bar');
    this.dom.playIcon     = $('icon-play');
    this.dom.pauseIcon    = $('icon-pause');
    this.dom.btnPlayPause = $('btn-play-pause');
    this.dom.btnSkipBack  = $('btn-skip-back');
    this.dom.btnSkipFwd   = $('btn-skip-fwd');
    this.dom.btnShuffle   = $('btn-shuffle');
    this.dom.btnRepeat    = $('btn-repeat');
    this.dom.btnQueue     = $('btn-queue');
    this.dom.queueCount   = $('queue-count');
    this.dom.shuffleDot   = $('shuffle-dot');
    this.dom.repeatDot    = $('repeat-dot');

    this.attachControlListeners();
    this.syncToggleButtons();
    this.syncQueueButton();
  }

  clearDomReferences() {
    Object.keys(this.dom).forEach(key => { this.dom[key] = null; });
    // Cancela qualquer carga pendente e limpa referências de crossfade
    if (this._thumbPendingEl) {
      this._thumbPendingEl.onload  = null;
      this._thumbPendingEl.onerror = null;
      this._thumbPendingEl = null;
    }
    this._thumbCurrentEl = null;
  }

  attachControlListeners() {
    this.dom.btnPlayPause?.addEventListener('click', () => this.togglePlayPause());
    this.dom.btnSkipBack?.addEventListener('click',  () => this.skipBack());
    this.dom.btnSkipFwd?.addEventListener('click',   () => this.skipForward());
    this.dom.btnShuffle?.addEventListener('click',   () => this.toggleShuffle());
    this.dom.btnRepeat?.addEventListener('click',    () => this.toggleRepeat());
    this.dom.btnQueue?.addEventListener('click',     (e) => this.handleQueueClick(e));
    this.dom.progressBar?.addEventListener('click',  (e) => this.handleSeek(e));
  }

  // ─────────────────────────────────────────────────────────────
  // TOGGLE BUTTONS (Shuffle / Repeat / Queue)
  // ─────────────────────────────────────────────────────────────

  syncToggleButtons() {
    if (this.dom.btnShuffle) {
      this.dom.btnShuffle.style.color = this.state.shuffle
        ? 'var(--color-control-active)' : 'var(--color-control-inactive)';
    }
    if (this.dom.shuffleDot) {
      this.dom.shuffleDot.style.opacity = this.state.shuffle ? '1' : '0';
    }
    if (this.dom.btnRepeat) {
      this.dom.btnRepeat.style.color = this.state.repeat
        ? 'var(--color-control-active)' : 'var(--color-control-inactive)';
    }
    if (this.dom.repeatDot) {
      this.dom.repeatDot.style.opacity = this.state.repeat ? '1' : '0';
    }
  }

  syncQueueButton() {
    const count = Array.isArray(this.state.queue) ? this.state.queue.length : 0;

    if (this.dom.btnQueue) {
      const label = count ? `Queue (${count})` : 'Queue';
      this.dom.btnQueue.title = label;
      this.dom.btnQueue.setAttribute('aria-label', label);
      this.dom.btnQueue.style.color = count
        ? 'var(--color-queue-active)'
        : 'var(--color-queue-inactive)';
    }

    if (this.dom.queueCount) {
      this.dom.queueCount.textContent = count > 99 ? '99+' : String(count);
      this.dom.queueCount.style.opacity = count ? '1' : '0';
    }
  }

  handleQueueClick(event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (this.isQueueOpen) {
      this.closeQueuePanel();
    } else {
      this.openQueuePanel();
    }
  }

  openQueuePanel() {
    if (this.isQueueOpen || !this.playerContainer) return;
    this.isQueueOpen = true;
    AnimationEngine.clearScheduled(this, '_queueTimers');

    const btnEl = this.dom.btnQueue;
    if (!btnEl) { this.isQueueOpen = false; return; }

    // Discard any leftover panel from a mid-close interruption
    if (this.queueContainer && this.queueContainer.parentNode) {
      this._animator.releaseAll(this.queueContainer);
      this.queueContainer.remove();
    }

    // Capture rects before any DOM mutation
    const btnRect    = btnEl.getBoundingClientRect();
    const playerRect = this.playerContainer.getBoundingClientRect();

    // Mark queue as open
    btnEl.classList.add('queue-open');
    const hint = this.playerContainer.querySelector('#queue-btn-hint');
    if (hint) hint.style.opacity = '0';

    // Target geometry: combined block [player | GAP | queue] centered
    const combinedW        = PLAYER_W + GAP + PLAYER_W;  // 690px
    const targetPlayerLeft = (window.innerWidth  - combinedW) / 2;
    const targetQueueLeft  = targetPlayerLeft + PLAYER_W + GAP;
    const targetTop        = (window.innerHeight - TOTAL_H) / 2;

    // ── Create panel at its FINAL position/size — no CSS transitions ──
    const panel = document.createElement('div');
    panel.id = 'queue-panel-container';
    panel.style.cssText = `
      position: fixed;
      left: ${targetQueueLeft}px;
      top: ${targetTop}px;
      width: ${PLAYER_W}px;
      height: ${TOTAL_H}px;
      border-radius: var(--radius-dynamic-island-expanded);
      background: var(--color-playback-pill);
      backdrop-filter: blur(var(--blur-playback));
      -webkit-backdrop-filter: blur(var(--blur-playback));
      border: 1px solid var(--color-border-soft);
      box-shadow: var(--shadow-playback-pill);
      z-index: 995;
      overflow: hidden;
      pointer-events: none;
      will-change: transform;
    `;
    document.body.appendChild(panel);
    this.queueContainer = panel;

    // ── FLIP: compute inverse transform (button center → panel center) ──
    const panelCenterX = targetQueueLeft + PLAYER_W / 2;
    const panelCenterY = targetTop       + TOTAL_H  / 2;
    const btnCenterX   = btnRect.left + btnRect.width  / 2;
    const btnCenterY   = btnRect.top  + btnRect.height / 2;
    const dx     = btnCenterX - panelCenterX;
    const dy     = btnCenterY - panelCenterY;
    const scaleX = btnRect.width  / PLAYER_W;
    const scaleY = btnRect.height / TOTAL_H;

    // ── WAAPI: button position/size → full panel (100% GPU: only transform) ──
    this._animator.play(panel, [
      { transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})` },
      { transform: 'none' }
    ], {
      duration: 520,
      easing: 'cubic-bezier(0.2, 0, 0, 1)'  // --ease-emphasized
    });

    // ── Switch player centering from % to px, slide via WAAPI translateX ──
    const currentPlayerLeft = playerRect.left;
    this.playerContainer.style.transition = 'none';
    this.playerContainer.style.left      = `${currentPlayerLeft}px`;
    this.playerContainer.style.transform = 'none';

    this._animator.play(this.playerContainer, [
      { transform: 'none' },
      { transform: `translateX(${targetPlayerLeft - currentPlayerLeft}px)` }
    ], {
      duration: 480,
      easing: 'cubic-bezier(0.32, 0.72, 0, 1)'  // --ease-standard
    });

    // ── After animation: commit inline styles, enable interaction, inject content ──
    AnimationEngine.schedule(this, () => {
      if (!panel.parentNode || panel !== this.queueContainer) return;

      // Commit player: release fill:forwards and snap to explicit px position
      this._animator.releaseAll(this.playerContainer);
      this.playerContainer.style.left      = `${targetPlayerLeft}px`;
      this.playerContainer.style.transform = 'none';

      // Release panel WAAPI and unlock
      this._animator.releaseAll(panel);
      panel.style.willChange    = '';
      panel.style.pointerEvents = 'auto';
      panel.style.overflowY    = 'auto';
      panel.innerHTML = this.buildQueueHTML();

      const closeBtn = panel.querySelector('#btn-queue-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.closeQueuePanel());
      }

      const list = panel.querySelector('#queue-items-list');
      if (list) {
        list.addEventListener('click', (e) => {
          const row = e.target.closest('.q-item');
          if (!row) return;
          const idx = parseInt(row.dataset.idx, 10);
          if (!isNaN(idx)) this.playQueueItem(idx);
        });
      }

      this.renderQueuePanel();
    }, 560, '_queueTimers');
  }

  closeQueuePanel() {
    if (!this.isQueueOpen || !this.queueContainer) return;
    this.isQueueOpen = false;
    AnimationEngine.clearScheduled(this, '_queueTimers');

    const panel = this.queueContainer;

    if (this.dom.btnQueue) this.dom.btnQueue.classList.remove('queue-open');
    const hint = this.playerContainer?.querySelector('#queue-btn-hint');
    if (hint) hint.style.opacity = '';

    // Target geometry after close
    const targetPlayerLeft = (window.innerWidth  - PLAYER_W) / 2;
    const targetTop        = (window.innerHeight - TOTAL_H)  / 2;
    const finalBtnLeft     = targetPlayerLeft + PLAYER_W + 4;
    const finalBtnTop      = targetTop + SQUARE_H + GAP;

    // ── Slide player back to center via WAAPI translateX ──
    if (this.playerContainer) {
      const currentLeft  = parseFloat(this.playerContainer.style.left) || targetPlayerLeft;
      const playerDeltaX = targetPlayerLeft - currentLeft;
      this._animator.play(this.playerContainer, [
        { transform: 'none' },
        { transform: `translateX(${playerDeltaX}px)` }
      ], {
        duration: 460,
        easing: 'cubic-bezier(0.32, 0.72, 0, 1)'  // --ease-standard
      });
    }

    // ── WAAPI FLIP: full panel → button position/size (100% GPU) ──
    const panelRect    = panel.getBoundingClientRect();
    const panelCenterX = panelRect.left + panelRect.width  / 2;
    const panelCenterY = panelRect.top  + panelRect.height / 2;
    const btnCenterX   = finalBtnLeft + CONTROLS_H / 2;
    const btnCenterY   = finalBtnTop  + CONTROLS_H / 2;
    const dx     = btnCenterX - panelCenterX;
    const dy     = btnCenterY - panelCenterY;
    const scaleX = CONTROLS_H / PLAYER_W;
    const scaleY = CONTROLS_H / TOTAL_H;

    panel.style.pointerEvents = 'none';
    panel.style.overflow      = 'hidden';
    panel.style.willChange    = 'transform, opacity';

    this._animator.play(panel, [
      { transform: 'none',                                                              opacity: '1' },
      { transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`, opacity: '0' }
    ], {
      duration: 420,
      easing: 'cubic-bezier(0.3, 0, 1, 1)'  // --ease-exit
    });

    AnimationEngine.schedule(this, () => {
      // Restore player to pixel-based center (release WAAPI first)
      if (this.playerContainer) {
        this._animator.releaseAll(this.playerContainer);
        this.playerContainer.style.left      = `${targetPlayerLeft}px`;
        this.playerContainer.style.transform = 'none';
      }
      if (panel.parentNode) panel.remove();
      if (panel === this.queueContainer) this.queueContainer = null;
    }, 480, '_queueTimers');
  }

  // ─────────────────────────────────────────────────────────────
  // QUEUE PANEL — conteúdo e renderização
  // ─────────────────────────────────────────────────────────────

  buildQueueHTML() {
    return `<style>
      #queue-panel-inner {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
      #queue-panel-header {
        padding: 10px 10px 10px 16px;
        font-size: 8px;
        letter-spacing: 2px;
        text-transform: uppercase;
        color: var(--color-text-muted);
        border-bottom: 1px solid var(--color-border-subtle);
        flex-shrink: 0;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      #btn-queue-close {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        background: transparent;
        border: none;
        border-radius: var(--radius-lg);
        color: var(--color-text-disabled);
        cursor: pointer;
        transition: color 0.15s ease, background 0.15s ease;
        flex-shrink: 0;
      }
      #btn-queue-close:hover {
        color: var(--color-text-primary);
        background: rgba(255,255,255,0.06);
      }
      #btn-queue-close svg { pointer-events: none; }
      #queue-items-list {
        flex: 1;
        overflow-y: auto;
        padding: 6px 0;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.1) transparent;
      }
      #queue-items-list::-webkit-scrollbar { width: 3px; }
      #queue-items-list::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.1);
        border-radius: 2px;
      }
      .q-item {
        display: flex;
        align-items: center;
        padding: 7px 10px;
        gap: 9px;
        cursor: pointer;
        border-radius: 10px;
        margin: 1px 5px;
        transition: background 0.15s ease;
      }
      .q-item:hover { background: rgba(255,255,255,0.06); }
      .q-item.q-active { background: rgba(255,255,255,0.09); }
      .q-idx {
        font-size: 9px;
        color: var(--color-text-disabled);
        font-family: var(--font-mono);
        width: 16px;
        text-align: right;
        flex-shrink: 0;
      }
      .q-item.q-active .q-idx { color: var(--color-control-active, rgba(255,255,255,0.7)); }
      .q-thumb {
        width: 34px;
        height: 34px;
        border-radius: 6px;
        overflow: hidden;
        flex-shrink: 0;
        background: var(--color-playback-cover);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .q-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .q-meta { flex: 1; min-width: 0; }
      .q-title {
        font-size: var(--fs-sm, 11px);
        font-weight: 600;
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .q-artist {
        font-size: var(--fs-xs, 10px);
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-top: 1px;
      }
      .q-empty {
        text-align: center;
        color: var(--color-text-disabled);
        font-size: var(--fs-sm);
        padding: 48px 16px;
      }
      .q-item.q-active .q-title { color: var(--color-base-white-strong); }
    </style>
    <div id="queue-panel-inner">
      <div id="queue-panel-header">
        <span>Queue</span>
        <button id="btn-queue-close" aria-label="Close queue" title="Close queue">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div id="queue-items-list"></div>
    </div>`;
  }

  renderQueuePanel() {
    if (!this.queueContainer) return;
    const list = this.queueContainer.querySelector('#queue-items-list');
    if (!list) return; // panel not yet populated (still animating open)

    const queue = this.state.queue;
    if (!queue || queue.length === 0) {
      list.innerHTML = '<div class="q-empty">Queue is empty</div>';
      return;
    }

    list.innerHTML = queue.map((track, idx) => {
      const isActive = idx === this.state.currentQueueIdx;
      const thumb    = this.thumbSrc(track.thumbnail);
      const thumbHtml = thumb
        ? `<img src="${this.escapeHtml(thumb)}" alt="" loading="lazy" onerror="this.remove()">`
        : '';
      return `
        <div class="q-item ${isActive ? 'q-active' : ''}" data-idx="${idx}">
          <span class="q-idx">${idx + 1}</span>
          <div class="q-thumb">${thumbHtml}</div>
          <div class="q-meta">
            <div class="q-title">${this.escapeHtml(track.title || track.id || '')}</div>
            <div class="q-artist">${this.escapeHtml(track.artist || '')}</div>
          </div>
        </div>`;
    }).join('');
  }

  async playQueueItem(idx) {
    const track = this.state.queue[idx];
    if (!track) return;

    this.state.guardUntilMs = Date.now() + 3000;
    this._applyOptimisticTrackChange(track, idx);

    try {
      await fetch('/api/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          track_id: track.id  ?? track.track_id ?? '',
          filepath: track.file_path ?? track.filepath ?? ''
        })
      });
      AnimationEngine.schedule(this, () => this.pollStatus(), 250, '_pollRetry');
    } catch (e) {
      console.error('Play queue item failed:', e);
    }
  }

  async toggleShuffle() {
    this.syncToggleButtons();
    try {
      await fetch('/api/shuffle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: this.state.shuffle })
      });
    } catch (e) {
      console.error('Shuffle toggle failed:', e);
    }
  }

  async toggleRepeat() {
    this.state.repeat = !this.state.repeat;
    this.syncToggleButtons();
    try {
      await fetch('/api/repeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: this.state.repeat })
      });
    } catch (e) {
      console.error('Repeat toggle failed:', e);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // POLLING & STATE UPDATES
  // ─────────────────────────────────────────────────────────────

  startPolling() {
    this.pollStatus();
    // Polling adaptativo: rápido quando visível e tocando, lento quando em background
    this.statusPollId = setInterval(() => this.pollStatus(), this.pollInterval);
  }

  stopPolling() {
    if (this.statusPollId) {
      clearInterval(this.statusPollId);
      this.statusPollId = null;
    }
  }

  async pollStatus() {
    // Pula polling se a aba do navegador não estiver visível
    if (document.hidden) return;

    try {
      const response = await fetch('/api/status');
      if (!response.ok) return;
      const status = await response.json();
      this.applyServerStatus(status);

      // Polling adaptativo: 3s quando idle/paused, 1.5s quando tocando
      const idealInterval = (status.state === 'playing') ? 1500 : 3000;
      if (idealInterval !== this.pollInterval) {
        this.pollInterval = idealInterval;
        this.stopPolling();
        this.statusPollId = setInterval(() => this.pollStatus(), this.pollInterval);
      }
    } catch (error) {
      console.error('Status poll error:', error);
    }
  }

  applyServerStatus(status) {
    const isGuarded = Date.now() < this.state.guardUntilMs;

    const newState  = status.state || 'idle';
    const prevState = this.state.playState;

    // Captura trackId anterior ANTES de atualizar o estado
    const prevTrackId  = this.state.currentId;
    const nextTrackId  = status.track_id || null;
    const trackChanged = nextTrackId !== prevTrackId;

    if (!isGuarded) {
      const wasPlaying = prevState === 'playing';
      const nowPlaying = newState  === 'playing';

      // Compensa o lag entre quando o core mediu a posição e quando a recebemos.
      // position_updated_at é o timestamp Unix (s) da última medição no core.
      const posUpdatedAt = status.position_updated_at || 0;
      const networkLag   = (posUpdatedAt > 0 && nowPlaying)
        ? Math.max(0, Date.now() / 1000 - posUpdatedAt)
        : 0;
      const serverPos = Math.min(
        (status.position || 0) + networkLag,
        status.duration || Infinity
      );

      if (prevState === 'idle') {
        // Sincronização inicial: carrega posição do servidor independente do estado
        this.state.sliderPos      = status.position || 0;
        this.state.sliderAnchorMs = nowPlaying ? Date.now() : 0;
      } else if (!wasPlaying && nowPlaying) {
        // Iniciou/resumiu: ancora a partir da posição compensada do servidor
        this.state.sliderPos      = serverPos;
        this.state.sliderAnchorMs = Date.now();
      } else if (wasPlaying && !nowPlaying) {
        // Pausou/parou: congela no valor dead-reckoned atual
        this.state.sliderPos      = this.getDeadReckonedPos();
        this.state.sliderAnchorMs = 0;
      } else if (wasPlaying && nowPlaying && trackChanged) {
        // Faixa trocou enquanto tocava (skip): ancora na nova posição
        this.state.sliderPos      = serverPos;
        this.state.sliderAnchorMs = Date.now();
      }
      // paused→paused e playing→playing (mesma faixa): deixa sozinhos

      this.state.playState       = newState;
      this.state.duration        = status.duration > 0 ? status.duration : this.state.duration;
      this.state.currentId       = nextTrackId;
      this.state.currentQueueIdx = status.queue_current_index ?? -1;

      this.setPlayIcon(!status.paused && newState === 'playing');
    }

    this.state.queue = status.queue || [];

    // Só atualiza metadados da faixa com dados do servidor quando NÃO estamos
    // sob guard OU quando o servidor já convergiu para a mesma faixa.
    // Isso previne que um poll stale (servidor ainda reportando a faixa anterior)
    // sobrescreva os metadados otimistas com título/artista/capa da faixa antiga.
    const serverTrackMatches = !isGuarded || nextTrackId === this.state.currentId;
    if (serverTrackMatches) {
      this.state.currentTrack = {
        title:     status.title     || '',
        artist:    status.artist    || '',
        thumbnail: status.thumbnail || ''
      };
    }

    // Sync shuffle/repeat do servidor se disponível
    if (typeof status.shuffle !== 'undefined') this.state.shuffle = !!status.shuffle;
    if (typeof status.repeat  !== 'undefined') this.state.repeat  = !!status.repeat;

    this.render();

    // Sync now-playing waveform indicator on the island pill
    if (this.island?.setNowPlayingState) {
      this.island.setNowPlayingState(this.state.playState === 'playing');
    }

    // Dispara o evento de tema sempre que o tuple (playState, trackId) mudar.
    // A comparação por chave elimina dispatches redundantes e torna o backdrop
    // orientado ao estado real do servidor — não a cliques de botão.
    const themeKey = `${this.state.playState}|${this.state.currentId}`;
    if (themeKey !== this._lastThemeKey) {
      this._dispatchThemeEvent();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // TEMA REATIVO
  // ─────────────────────────────────────────────────────────────

  /**
   * Emite `rolfsound-now-playing-changed` com o estado atual.
   * Atualiza `_lastThemeKey` antes de disparar — deduplicação em applyServerStatus.
   * Chamado de: applyServerStatus (qualquer mudança de tuple playState+trackId)
   * e _applyOptimisticTrackChange (skip imediato).
   */
  _dispatchThemeEvent() {
    this._lastThemeKey = `${this.state.playState}|${this.state.currentId}`;

    const nextQueueIdx = this.state.currentQueueIdx + 1;
    const nextTrack    = (nextQueueIdx >= 0 && nextQueueIdx < this.state.queue.length)
      ? this.state.queue[nextQueueIdx]
      : null;

    window.dispatchEvent(new CustomEvent('rolfsound-now-playing-changed', {
      detail: {
        trackId:   this.state.currentId,
        thumbnail: this.state.currentTrack.thumbnail,
        source:    this.state.currentId?.length === 11 ? 'youtube' : 'local',
        state:     this.state.playState,
        nextTrack
      }
    }));
  }

  // ─────────────────────────────────────────────────────────────
  // DEAD RECKONING
  // ─────────────────────────────────────────────────────────────

  getDeadReckonedPos() {
    if (this.state.sliderAnchorMs === 0 || this.state.duration === 0) {
      return this.state.sliderPos;
    }
    return Math.min(
      this.state.sliderPos + (Date.now() - this.state.sliderAnchorMs) / 1000,
      this.state.duration
    );
  }

  // ─────────────────────────────────────────────────────────────
  // RAF LOOP
  // ─────────────────────────────────────────────────────────────

  startRafLoop() {
    if (this.rafId) return;
    const tick = () => {
      this.tickProgress();
      this.rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  stopRafLoop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  tickProgress() {
    if (!this.state.duration || !this.isMorphed) return;

    const pos    = this.getDeadReckonedPos();
    const pct    = Math.round((pos / this.state.duration) * 1000) / 10;
    const timeStr = this.formatTime(pos);

    if (pct !== this.rafPos && this.dom.progressFill) {
      this.rafPos = pct;
      this.dom.progressFill.style.transform = `scaleX(${pct / 100})`;
    }

    if (timeStr !== this.rafTime && this.dom.currentTime) {
      this.rafTime = timeStr;
      this.dom.currentTime.textContent = timeStr;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // RENDERING
  // ─────────────────────────────────────────────────────────────

  render() {
    if (!this.isMorphed) return;

    const hasTrack = !!this.state.currentId;

    if (hasTrack) {
      if (this.dom.title)     this.dom.title.textContent  = this.state.currentTrack.title  || this.state.currentId;
      if (this.dom.artist)    this.dom.artist.textContent = this.state.currentTrack.artist || '—';
      if (this.dom.totalTime) this.dom.totalTime.textContent = this.formatTime(this.state.duration);
      this.updateThumbnail();
    } else {
      if (this.dom.title)        this.dom.title.textContent        = 'Nothing playing';
      if (this.dom.artist)       this.dom.artist.textContent       = '—';
      if (this.dom.totalTime)    this.dom.totalTime.textContent    = '0:00';
      if (this.dom.currentTime)  this.dom.currentTime.textContent  = '0:00';
      if (this.dom.progressFill) this.dom.progressFill.style.transform = 'scaleX(0)';
      this.resetThumbnail();
    }

    this.syncToggleButtons();
    this.syncQueueButton();

    // Keep queue panel content in sync when it's open
    if (this.isQueueOpen) this.renderQueuePanel();
  }

  thumbSrc(thumbnail) {
    if (!thumbnail) return null;
    if (thumbnail.startsWith('http') || thumbnail.startsWith('/thumbs/')) return thumbnail;
    return '/thumbs/' + thumbnail.split(/[\\/]/).pop();
  }

  getThumbnailCandidates(thumbnail, trackId = '') {
    const normalized = this.thumbSrc(thumbnail);
    const candidates = [];
    const youtubeId = typeof trackId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(trackId)
      ? trackId
      : '';

    if (youtubeId) {
      candidates.push(`https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`);
      candidates.push(`https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`);
    }

    if (normalized) {
      if (normalized.includes('i.ytimg.com/vi/')) {
        candidates.push(normalized.replace(/\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)\.(?:jpg|webp).*$/i, '/maxresdefault.jpg'));
        candidates.push(normalized.replace(/\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)\.(?:jpg|webp).*$/i, '/hqdefault.jpg'));
      }
      candidates.push(normalized);
    }

    return [...new Set(candidates.filter(Boolean))];
  }

  updateThumbnail() {
    if (!this.dom.thumbnail) return;

    const candidates = this.getThumbnailCandidates(this.state.currentTrack.thumbnail, this.state.currentId);
    if (!candidates.length) {
      this.resetThumbnail();
      return;
    }

    const thumbKey = `${this.state.currentId || ''}|${this.state.currentTrack.thumbnail || ''}`;

    // Já visível com a key certa — nada a fazer
    if (this._thumbCurrentEl && this._thumbCurrentEl.dataset.thumbKey === thumbKey) return;

    // Já a carregar a key certa — não duplicar
    if (this._thumbPendingEl && this._thumbPendingEl.dataset.thumbKey === thumbKey) return;

    // Cancela qualquer carga em curso (skip rápido)
    if (this._thumbPendingEl) {
      this._thumbPendingEl.onload  = null;
      this._thumbPendingEl.onerror = null;
      this._thumbPendingEl.remove();
      this._thumbPendingEl = null;
    }

    const container = this.dom.thumbnail;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    const incoming = document.createElement('img');
    incoming.dataset.thumbKey = thumbKey;
    incoming.style.cssText = `
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      object-fit: cover; display: block;
      opacity: 0; transition: opacity 0.32s ease;
    `;
    this._thumbPendingEl = incoming;

    const tryLoad = (index = 0) => {
      const src = candidates[index];
      if (!src) {
        // Todos os candidatos falharam — mantém o que já está visível
        if (this._thumbPendingEl === incoming) this._thumbPendingEl = null;
        this.resetThumbnail();
        return;
      }

      incoming.onload = () => {
        // Descarta se outra carga mais recente ganhou a corrida
        if (this._thumbPendingEl !== incoming) return;
        this._thumbPendingEl = null;

        incoming.dataset.src = src;
        container.appendChild(incoming);
        incoming.getBoundingClientRect(); // força reflow para a transição funcionar
        incoming.style.opacity = '1';

        const prev = this._thumbCurrentEl;
        this._thumbCurrentEl = incoming;

        // Remove o anterior após a transição. Safety timeout de 500ms caso
        // transitionend não dispare (reflow race, display:none, etc.)
        const cleanupPrev = () => {
          if (prev && prev.parentNode === container) prev.remove();
          if (incoming.parentNode === container && this._thumbCurrentEl === incoming) {
            incoming.style.position   = '';
            incoming.style.inset      = '';
            incoming.style.transition = '';
          }
        };
        let cleaned = false;
        const safeCleanup = () => { if (!cleaned) { cleaned = true; cleanupPrev(); } };
        incoming.addEventListener('transitionend', safeCleanup, { once: true });
        // Safety fallback — cancelled in destroy() if the manager tears down first
        AnimationEngine.schedule(this, safeCleanup, 500, '_thumbCleanup');
      };

      incoming.onerror = () => {
        if (this._thumbPendingEl !== incoming) return;
        tryLoad(index + 1);
      };

      incoming.src = src;
    };

    tryLoad();
  }

  /**
   * Pré-carrega o thumbnail no container imediatamente após ser criado,
   * antes de cacheDomElements() ser chamado. Usa a mesma thumbKey que
   * updateThumbnail() verifica — quando ela for chamada mais tarde, vai
   * detectar que a imagem já está carregada e pular o reload.
   */
  _prefillPlayerContent(container) {
    if (!this.state.currentId) return;

    const thumbEl = container.querySelector('#playback-thumbnail');
    if (!thumbEl) return;

    const candidates = this.getThumbnailCandidates(
      this.state.currentTrack.thumbnail,
      this.state.currentId
    );
    if (!candidates.length) return;

    const thumbKey = `${this.state.currentId || ''}|${this.state.currentTrack.thumbnail || ''}`;

    // Cancela qualquer thumb pendente — _prefillPlayerContent assume o controle
    if (this._thumbPendingEl) {
      this._thumbPendingEl.onload  = null;
      this._thumbPendingEl.onerror = null;
      this._thumbPendingEl = null;
    }

    const img = document.createElement('img');
    img.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0;';
    img.dataset.thumbKey = thumbKey;
    this._thumbPendingEl = img;

    const tryLoad = (index = 0) => {
      const src = candidates[index];
      if (!src) {
        if (this._thumbPendingEl === img) this._thumbPendingEl = null;
        return;
      }

      img.onload = () => {
        if (!container.isConnected) return;
        // Descarta se outra carga mais recente ganhou a corrida
        if (this._thumbPendingEl !== img) return;
        this._thumbPendingEl = null;

        img.dataset.src = src;
        thumbEl.innerHTML = '';
        thumbEl.appendChild(img);
        img.style.transition = 'opacity 0.4s ease';
        img.style.opacity = '1';

        // Registra como imagem ativa — evita que updateThumbnail crie duplicatas
        this._thumbCurrentEl = img;
      };

      img.onerror = () => tryLoad(index + 1);
      img.src = src;
    };

    tryLoad();
  }

  resetThumbnail() {
    if (!this.dom.thumbnail) return;

    // Cancela qualquer carga pendente e limpa referências
    if (this._thumbPendingEl) {
      this._thumbPendingEl.onload  = null;
      this._thumbPendingEl.onerror = null;
      this._thumbPendingEl = null;
    }
    this._thumbCurrentEl = null;

    if (!this.dom.thumbnail.querySelector('svg')) {
      this.dom.thumbnail.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--color-playback-icon-muted)"
             style="width: 72px; height: 72px; stroke-width: 1.0;">
          <circle cx="12" cy="12" r="10"/>
          <polygon points="10,8 16,12 10,16"/>
        </svg>
      `;
    }
  }

  setPlayIcon(isPlaying) {
    if (!this.dom.playIcon || !this.dom.pauseIcon) return;
    this.dom.playIcon.style.display  = isPlaying ? 'none'  : 'block';
    this.dom.pauseIcon.style.display = isPlaying ? 'block' : 'none';
  }

  // ─────────────────────────────────────────────────────────────
  // PLAYBACK CONTROLS
  // ─────────────────────────────────────────────────────────────

  async togglePlayPause() {
    this.state.guardUntilMs = Date.now() + 3000;

    if (this.state.playState === 'playing') {
      this.state.sliderPos      = this.getDeadReckonedPos();
      this.state.sliderAnchorMs = 0;
      this.state.playState      = 'paused';
      this.setPlayIcon(false);
      try { await fetch('/api/pause', { method: 'POST' }); }
      catch (e) { console.error('Pause failed:', e); }
    } else if (this.state.playState === 'paused') {
      // /pause é toggle no core: pausa quando tocando, retoma quando pausado.
      // NÃO chamar /play aqui — ele recomeça a faixa do zero.
      // Ancora APÓS a API confirmar — evita que o timer corra antes do áudio retomar.
      this.state.playState = 'playing';
      this.setPlayIcon(true);
      try {
        await fetch('/api/pause', { method: 'POST' });
        this.state.sliderAnchorMs = Date.now();
      } catch (e) {
        // Reverte se a chamada falhou
        this.state.playState = 'paused';
        this.setPlayIcon(false);
        console.error('Resume failed:', e);
      }
    } else {
      if (!this.state.queue.length) {
        this.state.guardUntilMs = 0;
        return;
      }
      this.state.sliderPos  = 0;
      this.state.playState  = 'playing';
      this.setPlayIcon(true);
      try {
        await fetch('/api/play', { method: 'POST' });
        this.state.sliderAnchorMs = Date.now();
      } catch (e) {
        this.state.playState = 'idle';
        this.setPlayIcon(false);
        console.error('Play failed:', e);
      }
    }

    AnimationEngine.schedule(this, () => this.pollStatus(), 600, '_pollRetry');
  }

  async skipForward() {
    this.state.guardUntilMs = Date.now() + 3000;

    // Atualização otimista: transiciona imediatamente para a próxima faixa da queue
    // sem esperar o poll — elimina o delay de ~600ms antes da capa/tema mudarem.
    const nextIdx   = this.state.currentQueueIdx + 1;
    const nextTrack = this.state.queue[nextIdx];
    if (nextTrack) this._applyOptimisticTrackChange(nextTrack, nextIdx);

    try {
      await fetch('/api/skip', { method: 'POST' });
      AnimationEngine.schedule(this, () => this.pollStatus(), 250, '_pollRetry');
    } catch (e) { console.error('Skip failed:', e); }
  }

  async skipBack() {
    this.state.guardUntilMs = Date.now() + 3000;

    // Lógica padrão de players: se a posição atual > 3s, reinicia a faixa;
    // senão vai para a faixa anterior da queue.
    const prevIdx    = this.state.currentQueueIdx - 1;
    const shouldRestart = this.getDeadReckonedPos() > 3 || prevIdx < 0;

    if (shouldRestart) {
      // Reinicia a faixa atual — zera o slider e manda seek(0) ao core
      this.state.sliderPos      = 0;
      this.state.sliderAnchorMs = this.state.playState === 'playing' ? Date.now() : 0;

      try {
        await fetch('/api/seek', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ position: 0 })
        });
        AnimationEngine.schedule(this, () => this.pollStatus(), 250, '_pollRetry');
      } catch (e) { console.error('Seek-to-start failed:', e); }
    } else {
      // Vai para a faixa anterior
      const prevTrack = this.state.queue[prevIdx];
      if (prevTrack) this._applyOptimisticTrackChange(prevTrack, prevIdx);

      try {
        await fetch('/api/queue/previous', { method: 'POST' });
        AnimationEngine.schedule(this, () => this.pollStatus(), 250, '_pollRetry');
      } catch (e) { console.error('Skip back failed:', e); }
    }
  }

  /**
   * Aplica otimisticamente os metadados de uma faixa antes da confirmação do servidor.
   * Atualiza thumbnail, título, artista e dispara o evento de tema imediatamente.
   * O guard window (3000ms) garante que o poll subsequente não sobrescreva este estado.
   */
  _applyOptimisticTrackChange(track, newIdx) {
    const prevId = this.state.currentId;
    const newId  = track.id ?? track.track_id ?? '';

    this.state.currentId       = newId;
    this.state.currentQueueIdx = newIdx;
    this.state.currentTrack    = {
      title:     track.title     || '',
      artist:    track.artist    || '',
      thumbnail: track.thumbnail || ''
    };
    this.state.sliderPos      = 0;
    this.state.sliderAnchorMs = Date.now();
    this.state.duration       = 0;  // incerto até o poll confirmar

    this.render();

    // Dispara evento de tema apenas se a faixa é diferente
    if (newId !== prevId) this._dispatchThemeEvent();
  }

  async handleSeek(event) {
    if (!this.state.duration) return;

    const rect     = this.dom.progressBar.getBoundingClientRect();
    const percent  = (event.clientX - rect.left) / rect.width;
    const position = Math.max(0, Math.min(percent * this.state.duration, this.state.duration));

    try {
      await fetch('/api/seek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position })
      });

      this.state.guardUntilMs   = Date.now() + 800;
      this.state.sliderPos      = position;
      this.state.sliderAnchorMs = this.state.playState === 'playing' ? Date.now() : 0;

      AnimationEngine.schedule(this, () => this.pollStatus(), 400, '_pollRetry');
    } catch (e) { console.error('Seek failed:', e); }
  }

  // ─────────────────────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────────────────────

  formatTime(seconds) {
    const s    = Math.floor(seconds || 0);
    const mins = Math.floor(s / 60);
    const secs = String(s % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  destroy() {
    this.stopPolling();
    this.stopRafLoop();
    if (this._division) { this._division.destroy(); this._division = null; }
    if (this._animator) this._animator.cancelAll();
    if (this._onNavigate && this.island) {
      this.island.removeEventListener('rolfsound-navigate', this._onNavigate);
      this._onNavigate = null;
    }
    if (this._onPopState) {
      window.removeEventListener('popstate', this._onPopState);
      this._onPopState = null;
    }
    AnimationEngine.clearScheduled(this, '_pollRetry');
    AnimationEngine.clearScheduled(this, '_thumbCleanup');
    AnimationEngine.clearScheduled(this, '_queueTimers');
    if (this.queueContainer && this.queueContainer.parentNode) {
      this.queueContainer.remove();
    }
    this.queueContainer = null;
    this.isQueueOpen = false;
  }
}

// ─── Global instance ───
window.playbackMitosisManager = null;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.playbackMitosisManager = new PlaybackMitosisManager();
  });
} else {
  window.playbackMitosisManager = new PlaybackMitosisManager();
}