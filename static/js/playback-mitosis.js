// static/js/playback-mitosis.js
// Gerencia apenas o estado e lógica de playback
// As animações são delegadas ao AnimationEngine

import AnimationEngine from '/static/js/AnimationEngine.js';

// ─── Dimensões do layout ───────────────────────────────────────────────────
const PLAYER_W   = 340;   // largura da capa e da pílula de controles (px)
const SQUARE_H   = 340;   // altura da capa 1:1 (px)
const CONTROLS_H = 56;    // altura da pílula de controles (px)
const GAP        = 10;    // espaço entre os dois blocos (px)
const TOTAL_H    = SQUARE_H + GAP + CONTROLS_H; // 406px

class PlaybackMitosisManager {
  constructor() {
    this.island = null;
    this.isMorphed = false;
    this.playerContainer = null;

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
    this.startPolling();
    this.startRafLoop();
  }

  registerAnimations() {
    AnimationEngine.registerKeyframes('cellular', `
      /* ─── EXPANSÃO ─── */
      @keyframes cellularExpansion {
        0% {
          animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1);
          top: 60px; left: 50%;
          transform: translate(-50%, 0) scaleY(0);
          width: 450px; height: 38px;
          border-radius: var(--radius-dynamic-island);
          opacity: 0;
        }
        22% {
          animation-timing-function: cubic-bezier(0.25, 0.46, 0.45, 0.94);
          top: 60px; left: 50%;
          transform: translate(-50%, 0) scaleY(1);
          width: 450px; height: 38px;
          border-radius: var(--radius-dynamic-island);
          opacity: 1;
        }
        100% {
          top: 50%; left: 50%;
          transform: translate(-50%, -50%) scaleY(1);
          width: ${PLAYER_W}px; height: ${TOTAL_H}px;
          border-radius: 0px;
          opacity: 1;
        }
      }

      /* ─── CONTRAÇÃO ─── */
      @keyframes cellularContraction {
        0% {
          animation-timing-function: cubic-bezier(0.55, 0, 0.1, 1);
          top: 50%; left: 50%;
          transform: translate(-50%, -50%) scaleY(1);
          width: ${PLAYER_W}px;
          border-radius: 0px;
          opacity: 1;
        }
        82% {
          animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1);
          top: 60px; left: 50%;
          transform: translate(-50%, 0) scaleY(1);
          width: 450px; height: 38px;
          border-radius: var(--radius-dynamic-island);
          opacity: 1;
        }
        100% {
          top: 60px; left: 50%;
          transform: translate(-50%, 0) scaleY(0);
          width: 450px; height: 38px;
          border-radius: var(--radius-dynamic-island);
          opacity: 0;
        }
      }

      #playback-player-container {
        position: fixed !important;
        z-index: 996;
        transform-origin: top center;
        will-change: transform, opacity;
      }
    `);
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
  // MITOSIS CONTROL
  // ─────────────────────────────────────────────────────────────

  morph() {
    if (this.isMorphed) return;
    this.isMorphed = true;

    const playerHTML = this.buildPlayerHTML();

    this.playerContainer = AnimationEngine.createMitosis(this.island, {
      containerHTML: playerHTML,
      startAnimation: 'cellularExpansion',
      containerId: 'playback-player-container',
      duration: 850,
      initialStyle: `
        position: fixed;
        top: 60px;
        left: 50%;
        transform: translate(-50%, 0) scaleY(0);
        transform-origin: top center;
        width: 450px;
        height: 38px;
        border-radius: var(--radius-dynamic-island);
        opacity: 0;
        z-index: 996;
        pointer-events: none;
        overflow: hidden;
      `,
      onComplete: () => {
        if (this.playerContainer) {
          this.playerContainer.style.height = 'auto';
          this.playerContainer.style.overflow = 'visible';
          this.playerContainer.style.pointerEvents = 'auto';
        }
        this.cacheDomElements();
      }
    });

    if (window.meuCursor && typeof window.meuCursor.resetHover === 'function') {
      window.meuCursor.resetHover();
    }
  }

  unmorph() {
    if (!this.isMorphed) return;
    this.isMorphed = false;

    if (this.playerContainer) {
      const h = this.playerContainer.getBoundingClientRect().height;
      this.playerContainer.style.height = h + 'px';
      this.playerContainer.style.overflow = 'hidden';
      this.playerContainer.style.pointerEvents = 'none';
    }

    AnimationEngine.destroyMitosis(this.playerContainer, {
      endAnimation: 'cellularContraction',
      duration: 750,
      onComplete: () => {
        this.playerContainer = null;
        this.clearDomReferences();
      }
    });

    if (window.meuCursor && typeof window.meuCursor.resetHover === 'function') {
      window.meuCursor.resetHover();
    }
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
        }

        #playback-controls-pill {
          width: 100%;
          height: 100%;
          background: rgba(12,12,12,0.88);
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: var(--radius-dynamic-island);
          display: flex;
          align-items: center;
          justify-content: space-evenly;
          padding: 0 10px;
          box-shadow: 0 8px 28px rgba(0,0,0,0.55);
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
          border-radius: 10px;
          color: rgba(255,255,255,0.74);
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
          color: rgba(255,255,255,0.96);
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
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: var(--radius-dynamic-island);
          background: rgba(12,12,12,0.88);
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
          color: rgba(255,255,255,0.74);
          box-shadow: 0 8px 28px rgba(0,0,0,0.55);
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
          border-radius: 999px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 8px;
          font-weight: 700;
          letter-spacing: 0.04em;
          color: #000;
          background: rgba(255,255,255,0.88);
          opacity: 0;
          transition: opacity 0.18s ease;
        }
      </style>

      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: ${G}px;
        width: ${W}px;
        background: transparent;
        box-sizing: border-box;
      ">

        <!-- ── CAPA 1:1 ── -->
        <div style="
          position: relative;
          width: ${W}px;
          height: ${SQ}px;
          border-radius: var(--radius-dynamic-island);
          overflow: hidden;
          flex-shrink: 0;
          background: #0f0f0f;
          border: 1px solid rgba(255,255,255,0.06);
          box-shadow: 0 16px 48px rgba(0,0,0,0.7);
        ">

          <!-- Thumbnail (preenche o quadrado inteiro) -->
          <div id="playback-thumbnail" style="
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #0f0f0f;
          ">
            <svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.12)" style="width: 72px; height: 72px; stroke-width: 1.0;">
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
              rgba(0,0,0,0.82) 0%,
              rgba(0,0,0,0.30) 60%,
              transparent 100%
            );
            z-index: 2;
            pointer-events: none;
          ">
            <div id="playback-title" style="
              font-size: 15px;
              font-weight: 700;
              color: #fff;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
              margin-bottom: 3px;
              letter-spacing: -0.01em;
            ">Nothing playing</div>

            <div id="playback-artist" style="
              font-size: 11px;
              color: rgba(255,255,255,0.55);
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
              letter-spacing: 0.01em;
            ">—</div>
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
            <span id="current-time" style="font-size: 9px; color: rgba(255,255,255,0.45); font-family: 'Courier New', monospace; letter-spacing: 0.04em;">0:00</span>
            <span style="font-size: 9px; color: rgba(255,255,255,0.22); font-family: 'Courier New', monospace;">/</span>
            <span id="total-time" style="font-size: 9px; color: rgba(255,255,255,0.45); font-family: 'Courier New', monospace; letter-spacing: 0.04em;">0:00</span>
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
              background: rgba(255,255,255,0.12);
              position: relative;
              overflow: hidden;
            ">
              <div id="progress-fill" style="
                position: absolute;
                inset: 0;
                width: 0%;
                background: rgba(255,255,255,0.9);
                transition: width 0.08s linear;
                border-radius: 0 1px 1px 0;
              "></div>
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
                background: white; opacity: 0;
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
                background: white; opacity: 0;
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
        ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.3)';
    }
    if (this.dom.shuffleDot) {
      this.dom.shuffleDot.style.opacity = this.state.shuffle ? '1' : '0';
    }
    if (this.dom.btnRepeat) {
      this.dom.btnRepeat.style.color = this.state.repeat
        ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.3)';
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
        ? 'rgba(255,255,255,0.82)'
        : 'rgba(255,255,255,0.48)';
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
    this.statusPollId = setInterval(() => this.pollStatus(), this.pollInterval);
  }

  stopPolling() {
    if (this.statusPollId) {
      clearInterval(this.statusPollId);
      this.statusPollId = null;
    }
  }

  async pollStatus() {
    try {
      const response = await fetch('/api/status');
      if (!response.ok) return;
      const status = await response.json();
      this.applyServerStatus(status);
    } catch (error) {
      console.error('Status poll error:', error);
    }
  }

  applyServerStatus(status) {
    const isGuarded = Date.now() < this.state.guardUntilMs;

    const newState  = status.state || 'idle';
    const prevState = this.state.playState;

    if (!isGuarded) {
      const wasPlaying = prevState === 'playing';
      const nowPlaying = newState  === 'playing';

      if (!wasPlaying && nowPlaying) {
        this.state.sliderPos      = status.position || 0;
        this.state.sliderAnchorMs = Date.now();
      } else if (wasPlaying && !nowPlaying) {
        this.state.sliderPos      = this.getDeadReckonedPos();
        this.state.sliderAnchorMs = 0;
      }

      this.state.playState      = newState;
      this.state.duration       = status.duration > 0 ? status.duration : this.state.duration;
      this.state.currentId      = status.track_id || null;
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
    const tick = () => {
      this.tickProgress();
      this.rafId = requestAnimationFrame(tick);
    };
    tick();
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

  updateThumbnail() {
    if (!this.dom.thumbnail) return;

    const src = this.state.currentTrack.thumbnail;
    if (src) {
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
      if (img.src !== src) {
        img.style.opacity = '0';
        img.src = src;
        img.onload = () => {
          img.style.transition = 'opacity 0.4s ease';
          img.style.opacity = '1';
        };
      }
    } else {
      this.resetThumbnail();
    }
  }

  resetThumbnail() {
    if (!this.dom.thumbnail) return;
    if (!this.dom.thumbnail.querySelector('svg')) {
      this.dom.thumbnail.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.12)"
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
    this.state.guardUntilMs = Date.now() + 1500;

    if (this.state.playState === 'playing') {
      this.state.sliderPos      = this.getDeadReckonedPos();
      this.state.sliderAnchorMs = 0;
      this.state.playState      = 'paused';
      this.setPlayIcon(false);
      try { await fetch('/api/pause', { method: 'POST' }); }
      catch (e) { console.error('Pause failed:', e); }
    } else if (this.state.playState === 'paused') {
      this.state.sliderAnchorMs = Date.now();
      this.state.playState      = 'playing';
      this.setPlayIcon(true);
      try { await fetch('/api/play', { method: 'POST' }); }
      catch (e) { console.error('Play failed:', e); }
    } else {
      if (!this.state.queue.length) {
        this.state.guardUntilMs = 0;
        return;
      }
      this.state.sliderPos      = 0;
      this.state.sliderAnchorMs = Date.now();
      this.state.playState      = 'playing';
      this.setPlayIcon(true);
      try { await fetch('/api/play', { method: 'POST' }); }
      catch (e) { console.error('Play failed:', e); }
    }

    setTimeout(() => this.pollStatus(), 600);
  }

  async skipForward() {
    this.state.guardUntilMs = Date.now() + 1500;
    try {
      await fetch('/api/skip', { method: 'POST' });
      setTimeout(() => this.pollStatus(), 600);
    } catch (e) { console.error('Skip failed:', e); }
  }

  async skipBack() {
    this.state.guardUntilMs = Date.now() + 1500;
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
    if (this.rafId) cancelAnimationFrame(this.rafId);
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