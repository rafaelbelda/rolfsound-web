// static/js/playback/PlayerShell.js
// HTML building, DOM caching, queue panel, and outside-click for PlaybackMitosisManager.
import AnimationEngine from '/static/js/features/animations/AnimationEngine.js';
import OverlayBackdropController from '/static/js/features/overlays/OverlayBackdropController.js';
import { PLAYER_W, SQUARE_H, CONTROLS_H, GAP, TOTAL_H, computeLayout } from './MitosisStateMachine.js';
import { getDisplayArtist } from '/static/js/utils/trackMeta.js';

// Touch / coarse-pointer devices have no room for the desktop side-by-side
// remix & queue slots, so those panels are surfaced as centered popups instead.
const isCoarsePointer = () => window.matchMedia?.('(hover: none)')?.matches ?? false;

export default class PlayerShell {
  constructor(manager) {
    this._m = manager;
  }

  // ─────────────────────────────────────────────────────────────
  // HTML BUILDING
  // ─────────────────────────────────────────────────────────────

  buildPlayerHTML() {
    const m  = this._m;
    const W  = PLAYER_W;
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

        /* ── Extended hover zone: captures mouse to the right of the controls pill ── */
        #playback-controls-shell::before {
          content: '';
          position: absolute;
          right: 100%;
          top: -10px;
          width: ${CH + 20}px;
          height: calc(100% + 20px);
          background: transparent;
          pointer-events: auto;
        }

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

        /* Disable hover-catcher when results panel is in the slot to the right */
        .search-open #playback-controls-shell::after {
          pointer-events: none;
        }

        #btn-remix {
          position: absolute;
          top: 50%;
          right: calc(100% + 4px);
          transform: translateY(-50%) translateX(22px) scale(0.32);
          transform-origin: center right;
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
          pointer-events: none;
          opacity: 0;
          z-index: 1;
          will-change: transform, opacity;
          transition:
            transform 0.45s var(--ease-spring),
            border-radius 0.28s var(--ease-snappy),
            opacity 0.18s ease;
        }

        #playback-controls-shell:hover #btn-remix,
        #playback-controls-shell:focus-within #btn-remix {
          pointer-events: auto;
          opacity: 1;
          transform: translateY(-50%) translateX(0) scale(1);
        }

        #btn-remix.remix-open {
          pointer-events: none !important;
          opacity: 0 !important;
          transform: translateY(-50%) translateX(22px) scale(0.32) !important;
          transition:
            transform 0.18s ease,
            opacity 0.18s ease !important;
        }

        #btn-queue {
          position: absolute;
          top: 50%;
          left: calc(100% + 4px);
          transform: translateY(-50%) translateX(-22px) scale(0.32);
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
          pointer-events: none;
          opacity: 0;
          z-index: 1;
          will-change: transform, opacity;
          transition:
            transform 0.45s var(--ease-spring),
            border-radius 0.28s var(--ease-snappy),
            opacity 0.18s ease,
            color 0.18s ease;
        }

        #playback-controls-shell:hover #btn-queue,
        #playback-controls-shell:focus-within #btn-queue {
          pointer-events: auto;
          opacity: 1;
          transform: translateY(-50%) translateX(0) scale(1);
        }

        #btn-queue.queue-open {
          pointer-events: none !important;
          opacity: 0 !important;
          transform: translateY(-50%) translateX(-22px) scale(0.32) !important;
          transition: transform 0.18s ease, opacity 0.18s ease !important;
        }

        #btn-queue svg {
          width: 15px;
          height: 15px;
          stroke-width: 1.9;
          pointer-events: none;
        }

        /* ── Queue hint label ── */
        #btn-remix svg {
          width: 15px;
          height: 15px;
          stroke-width: 1.9;
          pointer-events: none;
        }

        #remix-btn-hint {
          position: absolute;
          top: 50%;
          right: calc(100% + 4px);
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

        #playback-controls-shell:hover #remix-btn-hint,
        #playback-controls-shell:focus-within #remix-btn-hint,
        #btn-remix.remix-open ~ #remix-btn-hint {
          opacity: 0;
          transition: opacity 0.1s ease;
        }

        #playback-controls-shell:hover #queue-btn-hint,
        #playback-controls-shell:focus-within #queue-btn-hint {
          opacity: 0;
          transition: opacity 0.1s ease;
        }

        .side-hint-line-v,
        .queue-hint-line-v {
          display: block;
          width: 1px;
          height: 10px;
          background: rgba(255, 255, 255, 0.1);
        }

        .side-hint-text,
        .queue-hint-text {
          font-size: 8px;
          letter-spacing: 1.8px;
          text-transform: uppercase;
          color: var(--color-text-disabled);
          white-space: nowrap;
          font-weight: 500;
        }

        /* ── Touch: Remix/Queue are hover-revealed and positioned off the pill's
           left/right edges — unreachable on touch and off-screen once the pill is
           near full-width. On coarse pointers, surface them as an always-visible
           pair directly below the controls pill. Desktop hover behavior is
           untouched (these rules are gated to hover:none and come last in source). ── */
        @media (hover: none) {
          /* Drop the desktop side hint labels and the off-pill hover catchers. */
          #remix-btn-hint,
          #queue-btn-hint { display: none; }
          #playback-controls-shell::before,
          #playback-controls-shell::after { display: none; }

          /* While the remix popup is open it rises over the cover; lift the
             controls-shell stacking context above the cover (z-index 2) so the
             panel — nested inside the shell — isn't painted behind the artwork. */
          #playback-controls-shell:has(#btn-remix.remix-open) { z-index: 3; }

          /* The volume knob defaults to top:-42px, floating above the cover in a
             negative-margin strip where iOS hit-testing is unreliable (works only
             when extra space pushes it clear of the top chrome). Anchor it inside
             the cover's top-right corner — a solid, always-hittable region — and
             pin touch-action so the drag is never stolen for a scroll gesture. */
          rolfsound-volume-slider {
            top: 8px !important;
            right: 8px !important;
            touch-action: none;
          }

          /* Device toggle anchored inside the cover too, clear of the volume
             knob (knob is 34px at right:8px → occupies ~8–42px). */
          rolfsound-device-toggle {
            top: 4px !important;
            right: 50px !important;
            touch-action: manipulation;
          }

          #btn-remix,
          #btn-queue {
            position: absolute;
            top: calc(100% + 12px);
            bottom: auto;
            width: 48px;
            height: 48px;
            opacity: 1;
            pointer-events: auto;
            z-index: 2;
          }
          /* Centered pair, 12px apart, below the pill. */
          #btn-remix {
            right: auto;
            left: 50%;
            transform: translateX(calc(-100% - 6px));
            transform-origin: center;
          }
          #btn-queue {
            left: 50%;
            transform: translateX(6px);
            transform-origin: center;
          }
          /* When a panel is open on mobile, hide that button in-place (no
             transform change — avoids the desktop scale/translateY override
             pulling the button to the wrong spot). */
          #btn-remix.remix-open {
            opacity: 0 !important;
            pointer-events: none !important;
            transform: translateX(calc(-100% - 6px)) !important;
          }
          #btn-queue.queue-open {
            opacity: 0 !important;
            pointer-events: none !important;
            transform: translateX(6px) !important;
          }
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

            <!-- Gradiente + info -->
            <div style="
              position: absolute;
              bottom: 0; left: 0; right: 0;
              padding: 40px 88px 14px 16px;
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
              ">${m.escapeHtml(m.state.currentTrack.title || m.state.currentId || 'Nothing playing')}</div>

              <div id="playback-artist" style="
                font-size: var(--fs-md);
                color: var(--color-text-soft);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                letter-spacing: 0.01em;
              ">${m.escapeHtml(getDisplayArtist(m.state.currentTrack) || '—')}</div>
            </div>

            <!-- Seek bar — delegado ao Web Component -->
            <rolfsound-playback-timestamp style="position:absolute;bottom:8px;right:12px;z-index:3;"></rolfsound-playback-timestamp>
            <rolfsound-seek-bar style="position:absolute;bottom:0;left:0;right:0;height:32px;z-index:4;"></rolfsound-seek-bar>

            <!-- Volume slider — delegado ao Web Component -->
          </div>

          <rolfsound-volume-slider style="position:absolute;top:-42px;right:0;z-index:5;"></rolfsound-volume-slider>
          <rolfsound-device-toggle style="position:absolute;top:-42px;right:42px;z-index:5;"></rolfsound-device-toggle>
        </div>

        <!-- ── PÍLULA DE CONTROLES ── -->
        <div id="playback-controls-shell">
          <rolfsound-remix-button id="btn-remix"></rolfsound-remix-button>

          <div id="remix-btn-hint" aria-hidden="true">
            <span class="side-hint-line-v"></span>
            <span class="side-hint-text">Remix</span>
          </div>

          <div id="playback-controls-pill">
            <rolfsound-shuffle-toggle></rolfsound-shuffle-toggle>
            <rolfsound-skip-back></rolfsound-skip-back>
            <rolfsound-play-button></rolfsound-play-button>
            <rolfsound-skip-fwd></rolfsound-skip-fwd>
            <rolfsound-repeat-toggle></rolfsound-repeat-toggle>
          </div>

          <rolfsound-queue-button id="btn-queue"></rolfsound-queue-button>

          <div id="queue-btn-hint" aria-hidden="true">
            <span class="queue-hint-line-v"></span>
            <span class="queue-hint-text">Queue</span>
          </div>
        </div>
      </div>
    `;
  }

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
        cursor: none;
        transition: color 0.15s ease, background 0.15s ease;
        flex-shrink: 0;
      }
      #btn-queue-close:hover { color: var(--color-text-primary); background: rgba(255,255,255,0.06); }
      #btn-queue-close svg { pointer-events: none; }
      #queue-items-list {
        flex: 1;
        overflow-y: auto;
        padding: 6px 0;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.1) transparent;
      }
      #queue-items-list::-webkit-scrollbar { width: 3px; }
      #queue-items-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
      .q-item {
        display: flex;
        align-items: center;
        padding: 7px 10px;
        gap: 9px;
        cursor: none;
        border-radius: 10px;
        margin: 1px 5px;
        transition: background 0.15s ease;
      }
      .q-item:hover { background: var(--rs-theme-hover-bg, rgba(255,255,255,0.06)); }
      .q-item.q-active {
        background: var(--rs-theme-active-bg, rgba(255,255,255,0.09));
        box-shadow: inset 2px 0 0 var(--rs-theme-glow, rgba(255,255,255,0.2));
      }
      .q-idx {
        font-size: 9px;
        color: var(--color-text-disabled);
        font-family: var(--font-mono);
        width: 16px;
        text-align: right;
        flex-shrink: 0;
      }
      .q-item.q-active .q-idx {
        color: rgb(var(--rs-theme-accent-rgb, 255 255 255) / calc(0.72 + var(--rs-theme-intensity, 0) * 0.22));
      }
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
      .q-empty { text-align: center; color: var(--color-text-disabled); font-size: var(--fs-sm); padding: 48px 16px; }
      .q-item.q-active .q-title {
        color: var(--color-base-white-strong);
        text-shadow: 0 0 14px var(--rs-theme-glow, transparent);
      }
      .q-remove {
        display: none;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        background: transparent;
        border: none;
        border-radius: 50%;
        color: var(--color-text-disabled);
        cursor: none;
        flex-shrink: 0;
        transition: color 0.12s ease, background 0.12s ease;
      }
      .q-item:hover .q-remove { display: flex; }
      .q-remove:hover { color: var(--color-text-primary); background: rgba(255,255,255,0.1); }
      .q-remove svg { pointer-events: none; }
      #queue-actions {
        display: flex;
        gap: 4px;
        padding: 6px 10px;
        border-top: 1px solid var(--color-border-subtle);
        flex-shrink: 0;
      }
      .q-action-btn {
        flex: 1;
        padding: 5px 4px;
        font-size: 8px;
        letter-spacing: 0.5px;
        font-weight: 600;
        text-transform: uppercase;
        color: var(--color-text-muted);
        background: transparent;
        border: 1px solid var(--color-border-subtle);
        border-radius: var(--radius-sm);
        cursor: none;
        transition: color 0.12s, background 0.12s, border-color 0.12s;
        white-space: nowrap;
      }
      .q-action-btn:hover { color: var(--color-text-primary); background: rgba(255,255,255,0.06); border-color: var(--color-border-focus); }
      .q-action-btn.q-action-danger:hover { color: #ff6b6b; border-color: rgba(255,107,107,0.4); }
      #queue-history-section { padding: 6px 0 2px; border-bottom: 1px solid var(--color-border-subtle); }
      .q-section-label {
        padding: 2px 16px 4px;
        font-size: 7px;
        letter-spacing: 2px;
        text-transform: uppercase;
        color: var(--color-text-disabled);
        font-weight: 600;
      }
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
      <div id="queue-actions">
        <button class="q-action-btn" id="btn-queue-save" title="Save queue as playlist">Save as playlist</button>
        <button class="q-action-btn q-action-danger" id="btn-queue-clear" title="Clear queue">Clear</button>
      </div>
    </div>`;
  }

  // Adicione este método dentro da classe PlayerShell
  updateTrackVisuals(updatedTrack) {
    const m = this._m;
    const currentTrack = m.state.currentTrack;

    // Verifica se a atualização é para a música que está a tocar agora
    const incomingId = updatedTrack.id || updatedTrack.track_id;
    const playingId  = currentTrack?.id || currentTrack?.track_id || m.state.currentId;

    if (playingId && incomingId && playingId === incomingId) {
      console.log("💿 [PlayerShell] Match de ID! Atualizando interface...", updatedTrack.title);

      // 1. Injeta os dados no State para o Core não apagar a info no próximo segundo
      Object.assign(m.state.currentTrack, updatedTrack);

      // 2. Atualiza os textos do DOM (usando o cache que fizeste no cacheDomElements)
      if (m.dom.title)  m.dom.title.textContent = updatedTrack.title || incomingId;
      if (m.dom.artist) m.dom.artist.textContent = getDisplayArtist(updatedTrack) || '—';

      // 3. Dispara o Crossfader para a nova imagem
      if (m._crossfader) {
        m._crossfader.update(); 
      }
    }

    if (m.isQueueOpen) this.renderQueuePanel();
  }

  // ─────────────────────────────────────────────────────────────
  // DOM MANAGEMENT
  // ─────────────────────────────────────────────────────────────

  cacheDomElements() {
    const m = this._m;
    
    const container = m.playerContainer || document;
    
    m.dom.title     = container.querySelector('#playback-title');
    m.dom.artist    = container.querySelector('#playback-artist');
    m.dom.thumbnail = container.querySelector('#playback-thumbnail');
    
    this.attachControlListeners();
  }

  clearDomReferences() {
    const m = this._m;
    if (m._onOutsideClick) {
      document.removeEventListener('mousedown', m._onOutsideClick);
      m._onOutsideClick = null;
    }
    Object.keys(m.dom).forEach(key => { m.dom[key] = null; });
    m._crossfader.destroy();
  }

  attachControlListeners() {
    const m = this._m;
    m.playerContainer?.addEventListener('rolfsound-queue-click', (e) => this.handleQueueClick(e));
    m.playerContainer?.addEventListener('rolfsound-remix-click', (e) => this.handleRemixClick(e));

    m._onOutsideClick = (e) => {
      if (!m.isMorphed) return;
      const inPlayer = m.playerContainer?.contains(e.target);
      const inQueue  = m.queueContainer?.contains(e.target);
      const inRemix  = m.remixContainer?.contains(e.target);
      const inIsland = e.composedPath?.().some(el => el.tagName === 'ROLFSOUND-ISLAND');
      if (inPlayer || inQueue || inRemix || inIsland) return;
      // On touch the panels are popups floating over a backdrop — an outside tap
      // (including the backdrop itself) should dismiss only the popup, not
      // collapse the whole player.
      if (isCoarsePointer() && m.isQueueOpen) { this.closeQueuePanel(); return; }
      if (isCoarsePointer() && m.isRemixOpen) { this.closeRemixPanel(); return; }
      m._mitosis.unmorph({ reason: 'outside-click' });
    };
    document.addEventListener('mousedown', m._onOutsideClick);
  }

  // ─────────────────────────────────────────────────────────────
  // LAYOUT — multi-column slot system
  // ─────────────────────────────────────────────────────────────

  /**
   * Returns the current layout mode based on open panels. Slots are laid out
   * left→right as: remix, player, results, queue. Remix and queue are mutually
   * exclusive (see openSidePanel), so they never both appear.
   */
  _currentMode() {
    const m          = this._m;
    const parts      = [];
    if (m.isRemixOpen)                              parts.push('remix');
    parts.push('player');
    if (document.body.dataset.searchPanel === 'open') parts.push('results');
    if (m.isQueueOpen)                              parts.push('queue');
    return parts.length === 1 ? 'player-only' : parts.join('+');
  }

  /**
   * Animate player (and queue if open) to the positions defined by the layout mode.
   * Also emits 'rolfsound-layout-applied' so the results panel can reposition.
   * @param {'player-only'|'player+queue'|'player+results'|'player+results+queue'} mode
   * @param {{ duration?: number }} opts
   */
  applyLayout(mode, opts = {}) {
    const m        = this._m;
    const duration = opts.duration ?? 480;
    const ease     = 'cubic-bezier(0.32, 0.72, 0, 1)';

    if (!m.playerContainer) return;

    const { playerLeft, remixLeft, queueLeft, resultsLeft, targetTop } = computeLayout(mode);

    // ── Slide an element from its current `left` to a target `left` ──
    const slideTo = (el, targetLeft) => {
      if (!el || targetLeft == null) return;
      const currentLeft = parseFloat(el.style.left);
      if (!isNaN(currentLeft) && Math.abs(currentLeft - targetLeft) > 0.5) {
        m._animator.play(el, [
          { transform: 'none' },
          { transform: `translateX(${targetLeft - currentLeft}px)` }
        ], { duration, easing: ease });

        AnimationEngine.schedule(m, () => {
          if (!el.parentNode) return;
          m._animator.releaseAll(el);
          el.style.left      = `${targetLeft}px`;
          el.style.transform = 'none';
        }, duration + 80, '_queueTimers');
      } else {
        el.style.left = `${targetLeft}px`;
      }
    };

    slideTo(m.playerContainer, playerLeft);

    // ── Gate hover-catcher ──
    m.playerContainer.classList.toggle('search-open', mode.includes('results'));

    // ── Animate side panels if open ──
    if (m.isRemixOpen) slideTo(m.remixContainer, remixLeft);
    if (m.isQueueOpen) slideTo(m.queueContainer, queueLeft);

    // ── Notify results panel of its new slot ──
    window.dispatchEvent(new CustomEvent('rolfsound-layout-applied', {
      detail: { mode, playerLeft, remixLeft, resultsLeft, queueLeft, targetTop }
    }));
  }

  // ─────────────────────────────────────────────────────────────
  // SIDE PANELS — remix (left) & queue (right) share one mechanism
  // ─────────────────────────────────────────────────────────────

  /** Per-side configuration; `side` is the slide direction (-1 left, +1 right). */
  _panelCfg(key) {
    return key === 'remix'
      ? { key: 'remix', side: -1, openKey: 'isRemixOpen', containerKey: 'remixContainer',
          containerId: 'remix-panel-container', btnId: '#btn-remix', hintId: '#remix-btn-hint',
          setOpen: 'setRemixOpen', rectSide: 'remix', leftKey: 'remixLeft',
          openEvent: 'rolfsound-remix-open', closeEvent: 'rolfsound-remix-close' }
      : { key: 'queue', side: 1, openKey: 'isQueueOpen', containerKey: 'queueContainer',
          containerId: 'queue-panel-container', btnId: '#btn-queue', hintId: '#queue-btn-hint',
          setOpen: 'setQueueOpen', rectSide: 'queue', leftKey: 'queueLeft',
          openEvent: 'rolfsound-queue-open', closeEvent: 'rolfsound-queue-close' };
  }

  handleQueueClick(event) { event?.preventDefault(); event?.stopPropagation(); this.toggleSidePanel('queue'); }
  handleRemixClick(event) { event?.preventDefault(); event?.stopPropagation(); this.toggleSidePanel('remix'); }

  openQueuePanel()  { this.openSidePanel('queue'); }
  closeQueuePanel() { this.closeSidePanel('queue'); }
  openRemixPanel()  { this.openSidePanel('remix'); }
  closeRemixPanel() { this.closeSidePanel('remix'); }

  toggleSidePanel(key) {
    if (this._m[this._panelCfg(key).openKey]) this.closeSidePanel(key);
    else this.openSidePanel(key);
  }

  openSidePanel(key) {
    const m   = this._m;
    const cfg = this._panelCfg(key);
    if (m[cfg.openKey] || !m.playerContainer) return;

    // Remix and queue are mutually exclusive — collapse the other first so the
    // player only ever shares the stage with a single side panel.
    const otherKey = key === 'remix' ? 'queue' : 'remix';
    if (m[this._panelCfg(otherKey).openKey]) this.closeSidePanel(otherKey, { immediate: true });

    m[cfg.openKey] = true;
    AnimationEngine.clearScheduled(m, '_queueTimers');

    const btnEl = m.playerContainer.querySelector(cfg.btnId);
    if (!btnEl) { m[cfg.openKey] = false; return; }

    if (m[cfg.containerKey]?.parentNode) {
      m._animator.releaseAll(m[cfg.containerKey]);
      m[cfg.containerKey].remove();
    }

    const coarse     = isCoarsePointer();
    const btnRect    = (coarse ? null : this._sideButtonRect(cfg.rectSide)) || btnEl.getBoundingClientRect();
    const playerRect = m.playerContainer.getBoundingClientRect();

    btnEl[cfg.setOpen]?.(true);
    const hint = m.playerContainer.querySelector(cfg.hintId);
    if (hint) hint.style.opacity = '0';

    const mode             = this._currentMode();
    const slots            = computeLayout(mode);
    const targetPlayerLeft = slots.playerLeft;
    // On touch there is no room for a side slot — center the panel as a popup
    // over the player and dim the rest with a tap-to-close backdrop.
    const targetTop        = coarse ? Math.max(8, slots.targetTop) : slots.targetTop;
    const targetPanelLeft  = coarse
      ? Math.max(8, (window.innerWidth - PLAYER_W) / 2)
      : slots[cfg.leftKey];

    if (coarse) {
      OverlayBackdropController.show('player-panel', {
        zIndex: 1000,
        interactive: true,
        onBackdropClick: () => this.closeSidePanel(key),
      });
    }

    const panel = document.createElement('div');
    panel.id = cfg.containerId;
    panel.style.cssText = `
      position: fixed;
      left: ${targetPanelLeft}px;
      top: ${targetTop}px;
      width: ${PLAYER_W}px;
      height: ${TOTAL_H}px;
      border-radius: var(--radius-dynamic-island-expanded);
      background: var(--color-playback-pill);
      backdrop-filter: blur(var(--blur-playback));
      -webkit-backdrop-filter: blur(var(--blur-playback));
      border: 1px solid var(--color-border-soft);
      box-shadow: var(--shadow-playback-pill);
      z-index: ${coarse ? 1001 : 995};
      overflow: hidden;
      pointer-events: none;
      will-change: transform;
    `;
    document.body.appendChild(panel);
    m[cfg.containerKey] = panel;

    const panelCenterX = targetPanelLeft + PLAYER_W / 2;
    const panelCenterY = targetTop       + TOTAL_H  / 2;
    const btnCenterX   = btnRect.left + btnRect.width  / 2;
    const btnCenterY   = btnRect.top  + btnRect.height / 2;
    const dx           = btnCenterX - panelCenterX;
    const dy           = btnCenterY - panelCenterY;
    const scaleX       = btnRect.width  / PLAYER_W;
    const scaleY       = btnRect.height / TOTAL_H;

    m._animator.play(panel, [
      { transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})` },
      { transform: 'none' }
    ], { duration: 520, easing: 'cubic-bezier(0.2, 0, 0, 1)' });

    // On touch the player stays centered (panel floats over it as a popup);
    // on desktop it slides to make room for the side-by-side slot.
    if (!coarse) {
      const currentPlayerLeft = playerRect.left;
      m.playerContainer.style.transition = 'none';
      m.playerContainer.style.left       = `${currentPlayerLeft}px`;
      m.playerContainer.style.transform  = 'none';

      m._animator.play(m.playerContainer, [
        { transform: 'none' },
        { transform: `translateX(${targetPlayerLeft - currentPlayerLeft}px)` }
      ], { duration: 480, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
    }

    window.dispatchEvent(new CustomEvent('rolfsound-layout-applied', {
      detail: { mode, playerLeft: targetPlayerLeft, remixLeft: slots.remixLeft,
                resultsLeft: slots.resultsLeft, queueLeft: slots.queueLeft, targetTop }
    }));

    AnimationEngine.schedule(m, () => {
      if (!panel.parentNode || panel !== m[cfg.containerKey]) return;

      if (!coarse) {
        m._animator.releaseAll(m.playerContainer);
        m.playerContainer.style.left      = `${targetPlayerLeft}px`;
        m.playerContainer.style.transform = 'none';
      }

      m._animator.releaseAll(panel);
      // Force the settled box explicitly: if the morph was throttled or paused
      // (mobile background/jank), commitStyles can leave a stale start transform,
      // which would freeze the panel at button size. Pin it to its final rect.
      panel.style.transform     = 'none';
      panel.style.left          = `${targetPanelLeft}px`;
      panel.style.top           = `${targetTop}px`;
      panel.style.willChange    = '';
      panel.style.pointerEvents = 'auto';
      this._mountPanelContent(key, panel);
    }, 560, '_queueTimers');

    window.dispatchEvent(new CustomEvent(cfg.openEvent, { bubbles: true }));
  }

  /** Fill a freshly-settled panel with its content + listeners. */
  _mountPanelContent(key, panel) {
    if (key === 'remix') {
      panel.style.overflow = 'hidden';
      panel.innerHTML = '<rolfsound-remix-panel style="display:block;width:100%;height:100%;"></rolfsound-remix-panel>';
      const el = panel.querySelector('rolfsound-remix-panel');
      // The panel's own close button lives outside playerContainer, so catch its
      // toggle here (it only shows while open → toggle === close).
      el.addEventListener('rolfsound-remix-click', () => this.closeRemixPanel());
      customElements.whenDefined('rolfsound-remix-panel').then(() => el?.activate?.());
      return;
    }

    panel.style.overflowY = 'auto';
    panel.innerHTML = this.buildQueueHTML();

    const closeBtn = panel.querySelector('#btn-queue-close');
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeQueuePanel());

    const list = panel.querySelector('#queue-items-list');
    if (list) {
      list.addEventListener('click', (e) => {
        const row = e.target.closest('.q-item');
        if (!row) return;
        const idx = parseInt(row.dataset.idx, 10);
        if (!isNaN(idx)) this.playQueueItem(idx);
      });
    }

    this._loadRecentHistory().then(() => this.renderQueuePanel());
  }

  _sideButtonRect(side) {
    const shell = this._m.playerContainer?.querySelector('#playback-controls-shell');
    const rect = shell?.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) return null;

    const size = rect.height;
    const gap = 4;
    const top = rect.top + rect.height / 2 - size / 2;
    const bottom = top + size;

    if (side === 'remix') {
      return {
        left: rect.left - size - gap,
        top,
        right: rect.left - gap,
        bottom,
        width: size,
        height: size,
      };
    }

    return {
      left: rect.right + gap,
      top,
      right: rect.right + gap + size,
      bottom,
      width: size,
      height: size,
    };
  }

  /**
   * Collapse a side panel back toward its button.
   * @param {{ immediate?: boolean }} opts - `immediate` tears down without
   *   animating (used for mutual exclusivity and full-player teardown).
   */
  closeSidePanel(key, { immediate = false } = {}) {
    const m   = this._m;
    const cfg = this._panelCfg(key);
    if (!m[cfg.openKey] || !m[cfg.containerKey]) return;
    m[cfg.openKey] = false;
    AnimationEngine.clearScheduled(m, '_queueTimers');

    const coarse = isCoarsePointer();
    const panel  = m[cfg.containerKey];

    const btnEl = m.playerContainer?.querySelector(cfg.btnId);
    btnEl?.[cfg.setOpen]?.(false);
    const hint = m.playerContainer?.querySelector(cfg.hintId);
    if (hint) hint.style.opacity = '';

    if (coarse) OverlayBackdropController.hide('player-panel');

    if (immediate) {
      m._animator.releaseAll(panel);
      if (panel.parentNode) panel.remove();
      if (panel === m[cfg.containerKey]) m[cfg.containerKey] = null;
      window.dispatchEvent(new CustomEvent(cfg.closeEvent, { bubbles: true }));
      return;
    }

    // The remaining mode is computed with this panel's open flag already false.
    const modeAfter        = this._currentMode();
    const slots            = computeLayout(modeAfter);
    const targetPlayerLeft = slots.playerLeft;
    const targetTop        = slots.targetTop;
    const finalBtnTop      = targetTop + SQUARE_H + GAP;
    const finalBtnLeft     = cfg.side > 0
      ? targetPlayerLeft + PLAYER_W + 4
      : targetPlayerLeft - 4 - CONTROLS_H;

    window.dispatchEvent(new CustomEvent('rolfsound-layout-applied', {
      detail: { mode: modeAfter, playerLeft: targetPlayerLeft, remixLeft: slots.remixLeft,
                resultsLeft: slots.resultsLeft, queueLeft: slots.queueLeft, targetTop }
    }));

    // On touch the player never moved, so leave it put and collapse the popup
    // back toward the real (below-pill) button.
    if (m.playerContainer && !coarse) {
      const currentLeft  = parseFloat(m.playerContainer.style.left) || targetPlayerLeft;
      m._animator.play(m.playerContainer, [
        { transform: 'none' },
        { transform: `translateX(${targetPlayerLeft - currentLeft}px)` }
      ], { duration: 460, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
    }

    const liveBtn      = coarse ? btnEl?.getBoundingClientRect?.() : null;
    const btnSize      = liveBtn?.width || CONTROLS_H;
    const panelRect    = panel.getBoundingClientRect();
    const panelCenterX = panelRect.left + panelRect.width  / 2;
    const panelCenterY = panelRect.top  + panelRect.height / 2;
    const btnCenterX   = liveBtn ? liveBtn.left + liveBtn.width  / 2 : finalBtnLeft + CONTROLS_H / 2;
    const btnCenterY   = liveBtn ? liveBtn.top  + liveBtn.height / 2 : finalBtnTop  + CONTROLS_H / 2;
    const dx           = btnCenterX - panelCenterX;
    const dy           = btnCenterY - panelCenterY;
    const scaleX       = btnSize / PLAYER_W;
    const scaleY       = btnSize / TOTAL_H;

    panel.style.pointerEvents = 'none';
    panel.style.overflow      = 'hidden';
    panel.style.willChange    = 'transform, opacity';

    m._animator.play(panel, [
      { transform: 'none', opacity: '1' },
      { transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`, opacity: '0' }
    ], { duration: 420, easing: 'cubic-bezier(0.3, 0, 1, 1)' });

    AnimationEngine.schedule(m, () => {
      if (m.playerContainer && !coarse) {
        m._animator.releaseAll(m.playerContainer);
        m.playerContainer.style.left      = `${targetPlayerLeft}px`;
        m.playerContainer.style.transform = 'none';
      }
      if (panel.parentNode) panel.remove();
      if (panel === m[cfg.containerKey]) m[cfg.containerKey] = null;
    }, 480, '_queueTimers');

    window.dispatchEvent(new CustomEvent(cfg.closeEvent, { bubbles: true }));
  }

  renderQueuePanel() {
    const m = this._m;
    if (!m.queueContainer) return;
    const list = m.queueContainer.querySelector('#queue-items-list');
    if (!list) return;

    const queue   = m.state.queue;
    const history = m.state.recentHistory || [];

    const removeIcon = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

    let historyHtml = '';
    if (history.length > 0) {
      const items = history.slice(0, 5).map(h => {
        const thumb    = m.thumbSrc(h.thumbnail);
        const thumbHtml = thumb ? `<img src="${m.escapeHtml(thumb)}" alt="" loading="lazy" onerror="this.remove()">` : '';
        return `
          <div class="q-item q-history-item" data-track-id="${m.escapeHtml(h.track_id || '')}"
               data-filepath="${m.escapeHtml(h.file_path || h.filepath || '')}" title="Add to queue">
            <span class="q-idx" style="opacity:0.4">↩</span>
            <div class="q-thumb">${thumbHtml}</div>
            <div class="q-meta">
              <div class="q-title" style="opacity:0.7">${m.escapeHtml(h.title || '')}</div>
              <div class="q-artist">${m.escapeHtml(getDisplayArtist(h))}</div>
            </div>
          </div>`;
      }).join('');
      historyHtml = `<div id="queue-history-section"><div class="q-section-label">Recently played</div>${items}</div>`;
    }

    let queueHtml = '';
    if (!queue || queue.length === 0) {
      queueHtml = '<div class="q-empty">Queue is empty</div>';
    } else {
      if (history.length > 0) queueHtml = `<div class="q-section-label" style="padding-top:8px">Up next</div>`;
      queueHtml += queue.map((track, idx) => {
        const isActive  = idx === m.state.currentQueueIdx;
        const thumb     = m.thumbSrc(track.thumbnail);
        const thumbHtml = thumb ? `<img src="${m.escapeHtml(thumb)}" alt="" loading="lazy" onerror="this.remove()">` : '';
        return `
          <div class="q-item ${isActive ? 'q-active' : ''}" data-idx="${idx}">
            <span class="q-idx">${idx + 1}</span>
            <div class="q-thumb">${thumbHtml}</div>
            <div class="q-meta">
              <div class="q-title">${m.escapeHtml(track.title || track.id || '')}</div>
              <div class="q-artist">${m.escapeHtml(getDisplayArtist(track))}</div>
            </div>
            <button class="q-remove" data-remove-idx="${idx}" aria-label="Remove from queue">${removeIcon}</button>
          </div>`;
      }).join('');
    }

    list.innerHTML = historyHtml + queueHtml;

    list.querySelectorAll('.q-remove').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.removeFromQueue(parseInt(btn.dataset.removeIdx, 10));
      });
    });

    list.querySelectorAll('.q-history-item').forEach(item => {
      item.addEventListener('click', async () => {
        const trackId  = item.dataset.trackId;
        const filepath = item.dataset.filepath;
        if (!trackId) return;
        try {
          await window.rolfsoundChannel?.send('intent.queue.add', { track_id: trackId, filepath });
        } catch(e) { console.error('Add from history failed:', e); }
      });
    });

    const btnSave  = m.queueContainer.querySelector('#btn-queue-save');
    const btnClear = m.queueContainer.querySelector('#btn-queue-clear');
    if (btnSave  && !btnSave._wired)  { btnSave._wired  = true; btnSave.addEventListener('click',  () => this.saveQueueAsPlaylist()); }
    if (btnClear && !btnClear._wired) { btnClear._wired = true; btnClear.addEventListener('click', () => this.clearQueue()); }
  }

  // ─────────────────────────────────────────────────────────────
  // QUEUE ACTIONS
  // ─────────────────────────────────────────────────────────────

  async playQueueItem(idx) {
    const m     = this._m;
    const track = m.state.queue[idx];
    if (!track) return;

    m.state.guardUntilMs = Date.now() + 3000;
    m._applyOptimisticTrackChange(track, idx);

    try {
      await fetch('/api/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          track_id: track.id  ?? track.track_id ?? '',
          filepath: track.file_path ?? track.filepath ?? ''
        })
      });
    } catch (e) { console.error('Play queue item failed:', e); }
  }

  async removeFromQueue(idx) {
    try {
      await window.rolfsoundChannel?.send('intent.queue.remove', { index: idx });
    } catch(e) { console.error('Remove from queue failed:', e); }
  }

  async clearQueue() {
    try {
      await window.rolfsoundChannel?.send('intent.queue.clear', {});
    } catch(e) { console.error('Clear queue failed:', e); }
  }

  async saveQueueAsPlaylist() {
    const m    = this._m;
    const name = await m._promptText('Save queue as playlist', 'Enter playlist name');
    if (!name) return;
    try {
      const r = await fetch('/api/queue/save-as-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (r.ok) {
        m._notify(`Saved as "${name}"`);
        window.dispatchEvent(new CustomEvent('rolfsound-playlist-created'));
      }
    } catch(e) { console.error('Save as playlist failed:', e); }
  }

  async _loadRecentHistory() {
    const m = this._m;
    try {
      const r = await fetch('/api/history?limit=5');
      if (!r.ok) return;
      const data = await r.json();
      m.state.recentHistory = (data.history || data || []).slice(0, 5);
    } catch(e) { /* silent */ }
  }
}
