// static/js/playback-mitosis.js
// Gerencia apenas o estado e lógica de playback
// As animações são delegadas ao AnimationEngine

import AnimationEngine from '/static/js/AnimationEngine.js';
import { measureIslandBarMitosis } from '/static/js/MitosisMetrics.js';

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
    this.divisionMembrane = null;

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
        left: 50%;
        transform: translateX(-50%);
        z-index: 996;
        overflow: hidden;
        display: flex;
        justify-content: center;
        align-items: flex-start;
        backface-visibility: hidden;
        will-change: width, height, top, opacity;
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

  _setDivisionShellState(container, active) {
    const target = container || this.playerContainer;

    if (this.island) {
      if (active) {
        this.island.setAttribute('division-shell', 'true');
      } else {
        this.island.removeAttribute('division-shell');
      }
    }

    if (!target) return;

    if (active) {
      target.style.setProperty('--division-shell-fill', 'transparent');
      target.style.setProperty('--division-shell-border-color', 'transparent');
      target.style.setProperty('--division-shell-shadow', 'none');
      return;
    }

    target.style.removeProperty('--division-shell-fill');
    target.style.removeProperty('--division-shell-border-color');
    target.style.removeProperty('--division-shell-shadow');
  }

  _beginDivisionMembrane(container, options = {}) {
    const islandBar = this._getIslandBarContainer();
    if (!islandBar || !container) return;

    this._clearDivisionMembrane(container);

    const islandStyle = getComputedStyle(islandBar);
    this._setDivisionShellState(container, true);

    this.divisionMembrane = AnimationEngine.createDivisionMembrane({
      topElement: islandBar,
      bottomElement: container,
      bridgeElement: options.bridgeElement || null,
      fillColor: islandStyle.backgroundColor || 'rgba(15, 15, 15, 0.92)',
      strokeColor: islandStyle.borderTopColor || 'rgba(255, 255, 255, 0.06)',
      zIndex: 995
    });

    if (!this.divisionMembrane) {
      this._setDivisionShellState(container, false);
      return;
    }

    if (options.mode === 'split') {
      this.divisionMembrane.setSplit({ bottomElement: container });
      return;
    }

    this.divisionMembrane.setConnected({
      bottomElement: container,
      bridgeElement: options.bridgeElement || null,
      neckWidth: options.neckWidth,
      neckWidthProvider: options.neckWidthProvider
    });
  }

  _setDivisionMembraneMode(mode, options = {}) {
    if (!this.divisionMembrane) return;

    if (mode === 'split') {
      this.divisionMembrane.setSplit({
        bottomElement: options.container || this.playerContainer
      });
      return;
    }

    this.divisionMembrane.setConnected({
      bottomElement: options.container || this.playerContainer,
      bridgeElement: options.bridgeElement || null,
      neckWidth: options.neckWidth,
      neckWidthProvider: options.neckWidthProvider
    });
  }

  _endDivisionMembrane(container, fadeMs = 120) {
    const membrane = this.divisionMembrane;
    this.divisionMembrane = null;

    if (!membrane) {
      this._setDivisionShellState(container, false);
      return;
    }

    membrane.fadeOut(fadeMs, () => {
      this._setDivisionShellState(container, false);
    });
  }

  _clearDivisionMembrane(container = this.playerContainer) {
    if (this.divisionMembrane) {
      this.divisionMembrane.remove();
      this.divisionMembrane = null;
    }

    this._setDivisionShellState(container, false);
  }

  findIsland() {
    this.island = document.querySelector('rolfsound-island');
    if (!this.island) {
      console.warn('RolfsoundIsland not found');
    }
  }

  attachNavigationListener() {
    if (!this.island) return;

    this.island.addEventListener('rolfsound-navigate', (e) => {
      if (e.detail.view === 'playback') {
        this.morph();
      } else {
        this.unmorph();
      }
    });
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
    this._clearDivisionMembrane();

    const playerHTML = this.buildPlayerHTML();
    const metrics    = this.getMitosisMetrics();
    const islandBottom = metrics.originTop + metrics.originHeight;
    const OVERLAP      = PlaybackMitosisManager.BUDDING_OVERLAP;
    const BUD_H        = PlaybackMitosisManager.BUD_HEIGHT;
    const PINCH_GAP    = PlaybackMitosisManager.PINCH_GAP;
    const BRIDGE_W     = PlaybackMitosisManager.BRIDGE_PINCH_W;

    return AnimationEngine.runMitosisStrategy('playback-division-open', {
      island: this.island,
      owner: this
    }, {
      staleIds: ['playback-player-container', 'mitosis-bridge'],
      preImpactOptions: {
        sourceVector: { x: 0, y: 1 },
        strength: 0.88,
        duration: 480
      },
      createContainer: {
        containerId: 'playback-player-container',
        containerHTML: playerHTML,
        initialStyle: `
      position: fixed;
      top: ${islandBottom - OVERLAP}px;
      left: 50%;
      transform: translateX(-50%);
      width: ${metrics.originWidth}px;
      height: 0px;
      border-radius: 0 0 var(--radius-dynamic-island) var(--radius-dynamic-island);
      background: var(--division-shell-fill, var(--color-playback-shell));
      border: 1px solid var(--division-shell-border-color, var(--color-border-subtle));
      border-top: none;
      box-shadow: var(--division-shell-shadow, none);
      z-index: 996;
      overflow: hidden;
      pointer-events: none;
      opacity: 1;
      will-change: width, height, top, border-radius;
      transition: height 0.36s var(--ease-emphasized);
    `
      },
      createBridge: {
        containerId: 'mitosis-bridge',
        initialStyle: `
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      width: ${metrics.originWidth - 2}px;
      top: ${islandBottom - 1}px;
      height: 2px;
      background: transparent;
      z-index: 996;
      border-radius: 0;
      pointer-events: none;
      opacity: 0;
      will-change: width, border-radius, opacity;
      transition:
        width 0.32s var(--ease-standard),
        height 0.3s var(--ease-standard),
        border-radius 0.28s ease,
        opacity 0.14s ease;
    `
      },
      isActive: (container) => container === this.playerContainer,
      onCreated: ({ container, bridge }) => {
        this.playerContainer = container;
        this._beginDivisionMembrane(container, {
          mode: 'connected',
          bridgeElement: bridge
        });
        // Pré-carrega o thumbnail antes de cacheDomElements — evita flash de "Nothing playing"
        this._prefillPlayerContent(container);
      },
      onBud: ({ container }) => {
        container.style.height = `${BUD_H + OVERLAP}px`;
      },
      onPinch: ({ container, bridge }) => {
        container.style.transition = `
        top 0.38s var(--ease-standard),
        height 0.38s var(--ease-standard),
        width 0.52s var(--ease-standard),
        border-radius 0.34s cubic-bezier(0.25, 1, 0.5, 1),
        border-top 0.1s ease,
        box-shadow 0.3s ease
      `;
      container.style.top    = `${islandBottom + PINCH_GAP}px`;
      container.style.height = `${BUD_H}px`;
      container.style.borderRadius = 'var(--radius-dynamic-island)';
      container.style.borderTop   = '1px solid var(--division-shell-border-color, var(--color-border-subtle))';
      container.style.boxShadow   = 'var(--division-shell-shadow, var(--shadow-elevated))';

      bridge.style.height       = `${PINCH_GAP + 2}px`;
      bridge.style.width        = `${BRIDGE_W}px`;
      bridge.style.borderRadius = `${BRIDGE_W / 2}px`;
      },
      onBridgeFade: ({ bridge }) => {
        if (!bridge) return;
        bridge.style.opacity = '0';
        bridge.style.width = '0px';
      },
      onGrow: ({ container, bridge }) => {
        this._setDivisionMembraneMode('split', { container });
        if (bridge && bridge.parentNode) bridge.remove();
        container.style.transition = `
        width 0.58s var(--ease-standard),
        height 0.58s var(--ease-standard),
        top 0.58s var(--ease-standard),
        border-radius 0.46s cubic-bezier(0.25, 1, 0.5, 1)
      `;
      container.style.width  = `${PLAYER_W}px`;
      container.style.height = `${TOTAL_H}px`;
      container.style.top    = `${metrics.targetTop}px`;
      },
      onReveal: (container) => {
        this._endDivisionMembrane(container);
        this._revealPlayerStage(container);
      },
      onSettled: (container) => {
        this._settlePlayer(container);
      },
      onCursorReset: () => {
        if (window.meuCursor && typeof window.meuCursor.resetHover === 'function') {
          window.meuCursor.resetHover();
        }
      }
    });
  }

  /** Finaliza a expansão: revela conteúdo e remove casca visual */
  _revealPlayerStage(container) {
    if (!container || !container.parentNode || container !== this.playerContainer) return;

    container.style.overflow   = 'visible';
    container.style.background = 'transparent';
    container.style.border     = 'none';
    container.style.boxShadow  = 'none';

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
    }, 170);
  }

  /** Finaliza a expansão: libera interação e garante estado final */
  _settlePlayer(container) {
    if (!container || !container.parentNode || container !== this.playerContainer) return;
    container.style.transition   = 'none';
    container.style.overflow     = 'visible';
    container.style.pointerEvents = 'auto';
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

    const container = this.playerContainer;
    if (!container) {
      this.clearDomReferences();
      return;
    }

    const metrics      = this.getMitosisMetrics();
    const islandBottom = metrics.originTop + metrics.originHeight;
    const OVERLAP      = PlaybackMitosisManager.BUDDING_OVERLAP;

    return AnimationEngine.runMitosisStrategy('playback-division-close', {
      island: this.island,
      owner: this
    }, {
      container,
      isActive: (node) => node === this.playerContainer,
      onMissing: () => {
        this._clearDivisionMembrane();
        this.clearDomReferences();
      },
      onStart: (activeContainer) => {
        this._beginDivisionMembrane(activeContainer, {
          mode: 'split'
        });

        const cover = activeContainer.querySelector('#playback-cover-shell');
        const controls = activeContainer.querySelector('#playback-controls-shell');

        if (controls) {
          controls.style.opacity = '0';
          controls.style.transform = `translateY(-${CONTROLS_H + GAP}px) scale(0.94)`;
        }

        if (cover) {
          cover.style.opacity = '0';
          cover.style.transform = 'translateY(10px) scale(0.985)';
        }
      },
      onShrink: (activeContainer) => {
        activeContainer.style.transition = 'none';
        activeContainer.style.overflow = 'hidden';
        activeContainer.style.pointerEvents = 'none';
        activeContainer.style.background = 'var(--division-shell-fill, var(--color-playback-shell))';
        activeContainer.style.border = '1px solid var(--division-shell-border-color, var(--color-border-subtle))';
        activeContainer.style.boxShadow = 'var(--division-shell-shadow, var(--shadow-elevated))';

        activeContainer.getBoundingClientRect();

        AnimationEngine.afterFrames(() => {
          if (!activeContainer.parentNode || activeContainer !== this.playerContainer) return;
          activeContainer.style.transition = `
          width 0.46s var(--ease-standard),
          height 0.46s var(--ease-standard),
          top 0.46s var(--ease-standard),
          border-radius 0.38s cubic-bezier(0.25, 1, 0.5, 1)
        `;
          activeContainer.style.width = `${metrics.originWidth}px`;
          activeContainer.style.height = `${metrics.originHeight}px`;
          activeContainer.style.top = `${islandBottom + 4}px`;
          activeContainer.style.borderRadius = 'var(--radius-dynamic-island)';
        });
      },
      onAbsorb: (activeContainer) => {
        this._setDivisionMembraneMode('connected', {
          container: activeContainer,
          neckWidthProvider: ({ topRect, bottomRect }) => Math.min(topRect.width, bottomRect.width)
        });

        activeContainer.style.transition = `
        height 0.3s var(--ease-standard),
        top 0.3s var(--ease-standard),
        border-radius 0.24s ease,
        border-top 0.08s ease,
        opacity 0.16s ease 0.14s
      `;
        activeContainer.style.top = `${islandBottom - OVERLAP}px`;
        activeContainer.style.height = '0px';
        activeContainer.style.borderRadius = '0 0 var(--radius-dynamic-island) var(--radius-dynamic-island)';
        activeContainer.style.borderTop = 'none';
        activeContainer.style.opacity = '0';
      },
      onCleanup: (activeContainer) => {
        this._removePlayer(activeContainer, {
        sourceVector: { x: 0, y: 1 },
        fallbackVector: { x: 0, y: -1 },
        strength: 1.0,
        maxTravel: 9
        });
      },
      onCursorReset: () => {
        if (window.meuCursor && typeof window.meuCursor.resetHover === 'function') {
          window.meuCursor.resetHover();
        }
      }
    });
  }

  /** Remove o container do player do DOM */
  _removePlayer(container, impactOptions = null) {
    this.clearAnimationTimers();
    this._clearDivisionMembrane(container);
    if (impactOptions && this.island) {
      AnimationEngine.respondToImpact(this.island, impactOptions);
    }
    const bridge = document.getElementById('mitosis-bridge');
    if (bridge) {
      AnimationEngine.destroyMitosis(bridge, { duration: 0, endAnimation: '' });
    }
    AnimationEngine.destroyMitosis(container, {
      duration: 0,
      endAnimation: '',
      onComplete: () => {
        this.playerContainer = null;
        this.clearDomReferences();
      }
    });
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
            transform 0.52s cubic-bezier(0.32, 0.72, 0, 1);
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
            transform 0.58s cubic-bezier(0.32, 0.72, 0, 1);
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

        #btn-queue {
          position: absolute;
          top: 50%;
          left: calc(100% + 4px);
          transform: translateY(-50%) translateX(-4px) scale(0.6);
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
          opacity: 0;
          pointer-events: none;
          transition:
            opacity 0.22s ease,
            transform 0.45s cubic-bezier(0.34, 1.2, 0.64, 1),
            color 0.18s ease;
        }

        #playback-controls-shell:hover #btn-queue,
        #playback-controls-shell:focus-within #btn-queue {
          opacity: 1;
          pointer-events: auto;
          transform: translateY(-50%) translateX(0) scale(1);
        }

        #btn-queue svg {
          width: 15px;
          height: 15px;
          stroke-width: 1.9;
          pointer-events: none;
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
                  width: 0%;
                  background: var(--color-progress-fill);
                  transition: width 0.08s linear;
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
  }

  async toggleShuffle() {
    this.state.shuffle = !this.state.shuffle;
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
    this.state.currentTrack = {
      title:     status.title     || '',
      artist:    status.artist    || '',
      thumbnail: status.thumbnail || ''
    };

    // Sync shuffle/repeat do servidor se disponível
    if (typeof status.shuffle !== 'undefined') this.state.shuffle = !!status.shuffle;
    if (typeof status.repeat  !== 'undefined') this.state.repeat  = !!status.repeat;

    this.render();

    // Notifica o sistema de tema reativo quando a faixa muda ou a fila termina.
    // NÃO dispara para troca de play/pause — essas são tratadas diretamente
    // em togglePlayPause() para evitar race conditions com o estado do servidor.
    const wentToIdle = newState === 'idle' && prevState !== 'idle';
    if (trackChanged || wentToIdle) {
      this._dispatchThemeEvent();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // TEMA REATIVO
  // ─────────────────────────────────────────────────────────────

  /**
   * Emite `rolfsound-now-playing-changed` com o estado atual.
   * Chamado de: applyServerStatus (mudança de faixa / idle natural)
   * e togglePlayPause (intent imediato do utilizador).
   */
  _dispatchThemeEvent() {
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
      this.dom.progressFill.style.width = pct + '%';
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
      if (this.dom.progressFill) this.dom.progressFill.style.width = '0%';
      this.resetThumbnail();
    }

    this.syncToggleButtons();
    this.syncQueueButton();
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

    let img = this.dom.thumbnail.querySelector('img');
    if (!img) {
      this.dom.thumbnail.innerHTML = '';
      img = document.createElement('img');
      img.style.cssText = `
          width: 100%; height: 100%;
          object-fit: cover;
          display: block;
        `;
      this.dom.thumbnail.appendChild(img);
    }

    const thumbKey = `${this.state.currentId || ''}|${this.state.currentTrack.thumbnail || ''}`;
    if (img.dataset.thumbKey === thumbKey) return;
    img.dataset.thumbKey = thumbKey;
    img.style.opacity = '0';

    const tryLoad = (index = 0) => {
      const src = candidates[index];
      if (!src) {
        this.resetThumbnail();
        return;
      }

      img.onload = () => {
        img.dataset.src = src;
        img.style.transition = 'opacity 0.4s ease';
        img.style.opacity = '1';
      };

      img.onerror = () => {
        tryLoad(index + 1);
      };

      img.src = src;
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

    const img = document.createElement('img');
    img.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0;';
    img.dataset.thumbKey = thumbKey;

    const tryLoad = (index = 0) => {
      const src = candidates[index];
      if (!src) return; // deixa o SVG placeholder no lugar

      img.onload = () => {
        // Só substitui se o container ainda existir e o trackKey não tiver mudado
        if (!container.isConnected) return;
        img.dataset.src = src;
        thumbEl.innerHTML = '';
        thumbEl.appendChild(img);
        img.style.transition = 'opacity 0.4s ease';
        img.style.opacity = '1';
      };

      img.onerror = () => tryLoad(index + 1);
      img.src = src;
    };

    tryLoad();
  }

  resetThumbnail() {
    if (!this.dom.thumbnail) return;
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
      this._dispatchThemeEvent();  // intent imediato — fundo vai a neutro já
      try { await fetch('/api/pause', { method: 'POST' }); }
      catch (e) { console.error('Pause failed:', e); }
    } else if (this.state.playState === 'paused') {
      // /pause é toggle no core: pausa quando tocando, retoma quando pausado.
      // NÃO chamar /play aqui — ele recomeça a faixa do zero.
      // Ancora APÓS a API confirmar — evita que o timer corra antes do áudio retomar.
      this.state.playState = 'playing';
      this.setPlayIcon(true);
      this._dispatchThemeEvent();  // intent imediato — fundo reativa cores já
      try {
        await fetch('/api/pause', { method: 'POST' });
        this.state.sliderAnchorMs = Date.now();
      } catch (e) {
        // Reverte se a chamada falhou
        this.state.playState = 'paused';
        this.setPlayIcon(false);
        this._dispatchThemeEvent();  // reverte o tema também
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

    setTimeout(() => this.pollStatus(), 600);
  }

  async skipForward() {
    this.state.guardUntilMs = Date.now() + 3000;
    try {
      await fetch('/api/skip', { method: 'POST' });
      setTimeout(() => this.pollStatus(), 600);
    } catch (e) { console.error('Skip failed:', e); }
  }

  async skipBack() {
    this.state.guardUntilMs = Date.now() + 3000;
    try {
      await fetch('/api/queue/previous', { method: 'POST' });
      setTimeout(() => this.pollStatus(), 600);
    } catch (e) { console.error('Skip back failed:', e); }
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

      setTimeout(() => this.pollStatus(), 400);
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