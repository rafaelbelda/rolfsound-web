// static/js/playback/MitosisStateMachine.js
// Morph/unmorph animation lifecycle for PlaybackMitosisManager.
import AnimationEngine from '/static/js/AnimationEngine.js';
import { measureIslandBarMitosis } from '/static/js/MitosisMetrics.js';

// ── Layout geometry (exported so PlayerShell can import them) ──
export const PLAYER_W     = 340;
export const SQUARE_H     = 340;
export const CONTROLS_H   = 56;
export const GAP          = 10;
export const TOTAL_H      = SQUARE_H + GAP + CONTROLS_H; // 406px
export const MITOSIS_DROP = 22;

/**
 * Compute pixel positions for each slot given a layout mode.
 *
 * Modes:
 *   'player-only'          – player centred
 *   'player+queue'         – player left, queue right  (existing 2-col)
 *   'player+results'       – player left, results right
 *   'player+results+queue' – player left, results centre, queue right
 *
 * @param {'player-only'|'player+queue'|'player+results'|'player+results+queue'} mode
 * @returns {{ playerLeft: number, resultsLeft: number|null, queueLeft: number|null, targetTop: number }}
 */
export function computeLayout(mode) {
    const targetTop = (window.innerHeight - TOTAL_H) / 2;

    if (mode === 'player+queue') {
        const combined = PLAYER_W + GAP + PLAYER_W;
        const origin   = (window.innerWidth - combined) / 2;
        return { playerLeft: origin, resultsLeft: null, queueLeft: origin + PLAYER_W + GAP, targetTop };
    }
    if (mode === 'player+results') {
        const combined = PLAYER_W + GAP + PLAYER_W;
        const origin   = (window.innerWidth - combined) / 2;
        return { playerLeft: origin, resultsLeft: origin + PLAYER_W + GAP, queueLeft: null, targetTop };
    }
    if (mode === 'player+results+queue') {
        const combined = 3 * PLAYER_W + 2 * GAP;
        const origin   = (window.innerWidth - combined) / 2;
        return {
            playerLeft:  origin,
            resultsLeft: origin + PLAYER_W + GAP,
            queueLeft:   origin + 2 * (PLAYER_W + GAP),
            targetTop
        };
    }
    // player-only (default)
    return { playerLeft: (window.innerWidth - PLAYER_W) / 2, resultsLeft: null, queueLeft: null, targetTop };
}

const BUDDING_OVERLAP = 6;
const BUD_HEIGHT      = 52;
const PINCH_GAP       = 14;
const BRIDGE_PINCH_W  = 14;

export default class MitosisStateMachine {
  constructor(manager) {
    this._m = manager;
  }

  registerAnimations() {
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
    const m = this._m;
    const base = measureIslandBarMitosis(m.island, {
      originTop: 15,
      originWidth: 450,
      originHeight: 38,
      copyGap: 7,
      extraDrop: MITOSIS_DROP
    });
    base.targetTop = (window.innerHeight - TOTAL_H) / 2;
    return base;
  }

  _getIslandBarContainer() {
    return this._m.island?.shadowRoot?.getElementById('bar-container') || null;
  }

  findIsland() {
    const m = this._m;
    m.island = document.querySelector('rolfsound-island');
    if (!m.island) console.warn('RolfsoundIsland not found');
  }

  attachNavigationListener() {
    const m = this._m;
    if (!m.island) return;

    m._onNavigate = (e) => {
      if (e.detail.view === 'playback') {
        const mini = document.querySelector('rolfsound-miniplayer');
        m._mitosis.morph(mini?.isVisible ? { from: 'mini' } : {});
      } else {
        m._mitosis.unmorph({ reason: 'tab-switch' });
      }
    };
    m.island.addEventListener('rolfsound-navigate', m._onNavigate);

    m._onPopState = () => {
      const isPlayback = window.location.pathname === '/playback';
      if (isPlayback && !m.isMorphed) m._mitosis.morph();
      else if (!isPlayback && m.isMorphed) m._mitosis.unmorph();
    };
    window.addEventListener('popstate', m._onPopState);

    if (window.location.pathname === '/playback') {
      customElements.whenDefined('rolfsound-island').then(() => {
        AnimationEngine.schedule(m, () => {
          if (!m.isMorphed) m._mitosis.morph();
        }, 80, 'animationTimers');
      });
    }
  }

  // ─── Backdrop ────────────────────────────────────────────────

  _showBackdrop() {
    if (document.getElementById('rolfsound-player-backdrop')) return;
    const bd = document.createElement('div');
    bd.id = 'rolfsound-player-backdrop';
    Object.assign(bd.style, {
      position:            'fixed',
      inset:               '0',
      zIndex:              '990',
      background:          'rgba(0,0,0,0)',
      backdropFilter:      'blur(0px)',
      webkitBackdropFilter:'blur(0px)',
      transition:          'background 0.38s ease, backdrop-filter 0.38s ease, -webkit-backdrop-filter 0.38s ease',
      pointerEvents:       'none',
    });
    document.body.appendChild(bd);
    void bd.offsetHeight;
    bd.style.background           = 'rgba(0,0,0,0.52)';
    bd.style.backdropFilter       = 'blur(7px)';
    bd.style.webkitBackdropFilter = 'blur(7px)';
  }

  _hideBackdrop() {
    const bd = document.getElementById('rolfsound-player-backdrop');
    if (!bd) return;
    bd.style.background           = 'rgba(0,0,0,0)';
    bd.style.backdropFilter       = 'blur(0px)';
    bd.style.webkitBackdropFilter = 'blur(0px)';
    setTimeout(() => bd.remove(), 420);
  }

  // ─── Morph (ilha → célula-filha) ────────────────────────────

  morph(opts = {}) {
    const m = this._m;
    if (m.isMorphed) return;
    m.isMorphed = true;
    this._showBackdrop();
    m.clearAnimationTimers();
    m._animator.cancelAll();
    if (m._division) { m._division.abort(); m._division = null; }

    const mini = document.querySelector('rolfsound-miniplayer');
    if (opts.from === 'mini' && mini?.isVisible) {
      if (window.location.pathname !== '/playback') {
        window.history.pushState({ rolfsound: 'playback' }, '', '/playback');
      }
      m._miniMorphAnimator.miniToFull(mini);
      return;
    }

    if (window.location.pathname !== '/playback') {
      window.history.pushState({ rolfsound: 'playback' }, '', '/playback');
    }

    ['playback-player-container', 'mitosis-bridge'].forEach(id => {
      const stale = document.getElementById(id);
      if (stale) stale.remove();
    });

    const metrics   = this.getMitosisMetrics();
    const islandBar = this._getIslandBarContainer();
    if (!islandBar) return;

    if (m.island?.respondToImpact) {
      m.island.respondToImpact({ sourceVector: { x: 0, y: 1 }, strength: 0.88, duration: 480 });
    }

    const child = document.createElement('div');
    child.id = 'playback-player-container';
    child.innerHTML = m._shell.buildPlayerHTML();
    child.style.cssText = `
      background: var(--color-playback-shell);
      border: none;
      box-shadow: none;
      will-change: transform, clip-path, opacity;
      border-radius: var(--radius-dynamic-island);
    `;
    m.playerContainer = child;
    m._crossfader.prefill(child);

    const islandStyle = getComputedStyle(islandBar);

    Promise.resolve(AnimationEngine.mitosisFull(m.island, {
      owner: m,
      id: 'playback-player',
      parent: islandBar,
      child,
      shellTarget: m.island,
      target: { top: metrics.targetTop, width: PLAYER_W, height: TOTAL_H },
      budSize: BUD_HEIGHT,
      budOverlap: BUDDING_OVERLAP,
      budDuration: 280,
      pinchGap: PINCH_GAP,
      pinchWidth: BRIDGE_PINCH_W,
      pinchDuration: 260,
      splitDuration: 430,
      membraneOptions: {
        fillColor:     islandStyle.backgroundColor || 'rgba(15, 15, 15, 0.92)',
        strokeColor:   islandStyle.borderTopColor  || 'rgba(255, 255, 255, 0.06)',
        shadowOpacity: 0.28,
        shadowBlur:    6,
        shadowOffsetY: 4,
        zIndex:        995,
      },
      onPhase:   (phase, ctx) => { if (phase === 'split') this._revealPlayerStage(ctx.child); },
      onSettled: ({ child: container })  => { this._settlePlayer(container); },
      onRemoved: () => this._onDivisionRemoved(),
    }))
      .then((division) => {
        if (!division) return;
        if (!m.isMorphed || m.playerContainer !== child) { division.abort?.(); return; }
        m._division = division;
      })
      .catch((err) => console.error('Playback full mitosis open failed:', err));

    if (window.meuCursor?.resetHover) window.meuCursor.resetHover();
  }

  _revealPlayerStage(container) {
    const m = this._m;
    if (!container || !container.parentNode || container !== m.playerContainer) return;

    container.style.overflow = 'visible';

    const cover    = container.querySelector('#playback-cover-shell');
    const controls = container.querySelector('#playback-controls-shell');

    if (cover) { cover.style.opacity = '1'; cover.style.transform = 'translateY(0) scale(1)'; }

    m.scheduleAnimation(() => {
      if (!controls || !container.parentNode || container !== m.playerContainer) return;
      controls.style.opacity   = '1';
      controls.style.transform = 'translateY(0) scale(1)';
    }, 110);
  }

  _settlePlayer(container) {
    const m = this._m;
    if (!container || !container.parentNode || container !== m.playerContainer) return;

    container.style.background = 'transparent';
    container.style.border     = 'none';
    container.style.boxShadow  = 'none';

    const cover    = container.querySelector('#playback-cover-shell');
    const controls = container.querySelector('#playback-controls-shell');
    if (cover)    { cover.style.opacity    = '1'; cover.style.transform    = 'translateY(0) scale(1)'; }
    if (controls) { controls.style.opacity = '1'; controls.style.transform = 'translateY(0) scale(1)'; }

    m._shell.cacheDomElements();
  }

  // ─── Unmorph (célula-filha → ilha) ──────────────────────────

  unmorph(opts = {}) {
    const m = this._m;
    if (!m.isMorphed) return;
    m.isMorphed = false;
    this._hideBackdrop();
    m.clearAnimationTimers();
    m._animator.cancelAll();

    const mini = document.querySelector('rolfsound-miniplayer');
    if (window.playbackStore?.hasActivePlayback() && mini) {
      if (window.location.pathname === '/playback') {
        window.history.replaceState({ rolfsound: 'library' }, '', '/library');
      }
      m._miniMorphAnimator.fullToMini(mini);
      return;
    }

    if (window.location.pathname === '/playback') {
      window.history.replaceState({ rolfsound: 'library' }, '', '/library');
    }

    if (m.isQueueOpen) {
      AnimationEngine.clearScheduled(m, '_queueTimers');
      if (m.queueContainer?.parentNode) m.queueContainer.remove();
      m.queueContainer = null;
      m.isQueueOpen    = false;
    }

    const container = m.playerContainer;
    if (!container) { m._shell.clearDomReferences(); return; }

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

    container.style.background   = 'var(--color-playback-shell)';
    container.style.border       = 'none';
    container.style.borderRadius = 'var(--radius-dynamic-island)';
    container.style.boxShadow    = 'none';

    const closeDivision = (division) => {
      Promise.resolve(AnimationEngine.undoMitosisFull(m.island, {
        owner: m,
        id: 'playback-player',
        division,
        forceSettled: true,
        forceAbortRemove: true,
        child: container,
        onForceRemoved: () => this._removePlayer(container),
      })).catch((err) => {
        console.error('Playback full mitosis close failed:', err);
        this._removePlayer(container);
      });
    };

    if (m._division) {
      closeDivision(m._division);
    } else {
      const islandBar = this._getIslandBarContainer();
      if (!islandBar) { this._removePlayer(container); return; }

      const islandStyle = getComputedStyle(islandBar);
      const metrics     = this.getMitosisMetrics();

      Promise.resolve(AnimationEngine.mitosisFull(m.island, {
        owner: m,
        id: 'playback-player',
        parent: islandBar,
        child: container,
        shellTarget: m.island,
        target: { top: metrics.targetTop, width: PLAYER_W, height: TOTAL_H },
        budSize: BUD_HEIGHT,
        budOverlap: BUDDING_OVERLAP,
        budDuration: 240,
        pinchGap: PINCH_GAP,
        pinchWidth: BRIDGE_PINCH_W,
        splitDuration: 380,
        membraneOptions: {
          fillColor:     islandStyle.backgroundColor || 'rgba(15, 15, 15, 0.92)',
          strokeColor:   islandStyle.borderTopColor  || 'rgba(255, 255, 255, 0.06)',
          shadowOpacity: 0.28,
          shadowBlur:    6,
          shadowOffsetY: 4,
          zIndex:        995,
        },
        onRemoved: () => this._onDivisionRemoved(),
        autoRun: false,
        startPhase: 'settled',
      }))
        .then((division) => {
          if (!division) { this._removePlayer(container); return; }
          m._division = division;
          closeDivision(division);
        })
        .catch((err) => {
          console.error('Playback full mitosis fallback create failed:', err);
          this._removePlayer(container);
        });
    }

    if (window.meuCursor?.resetHover) window.meuCursor.resetHover();
  }

  _onDivisionRemoved() {
    const m = this._m;
    if (m.island) {
      AnimationEngine.respondToImpact(m.island, {
        sourceVector:   { x: 0, y: 1 },
        fallbackVector: { x: 0, y: -1 },
        strength: 1.0,
        maxTravel: 9
      });
    }
    m.clearAnimationTimers();
    m.playerContainer = null;
    m._division       = null;
    m._shell.clearDomReferences();
  }

  _removePlayer(container) {
    const m = this._m;
    m.clearAnimationTimers();
    if (container?.parentNode) container.remove();
    m.playerContainer = null;
    m._division       = null;
    m._shell.clearDomReferences();
  }
}
