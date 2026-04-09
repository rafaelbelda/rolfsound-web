// static/js/playback-mitosis.js
// Gerencia apenas o estado e lógica de playback
// As animações são delegadas ao AnimationEngine

import AnimationEngine from '/static/js/AnimationEngine.js';

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
      queueList: null
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
    // Registra as keyframes de mitose no AnimationEngine
    AnimationEngine.registerKeyframes('cellular', `
      /* ─── EXPANSÃO: pílula nasce abaixo da ilha e viaja ao centro ─── */
      @keyframes cellularExpansion {
        0% {
          /* Pílula aparece colapsada logo abaixo da ilha */
          animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1);
          top: 60px;
          left: 50%;
          transform: translate(-50%, 0) scaleY(0);
          width: 450px;
          height: 38px;
          border-radius: 19px;
          opacity: 0;
        }
        22% {
          /* Célula-filha totalmente formada — momento da divisão celular */
          animation-timing-function: cubic-bezier(0.25, 0.46, 0.45, 0.94);
          top: 60px;
          left: 50%;
          transform: translate(-50%, 0) scaleY(1);
          width: 450px;
          height: 38px;
          border-radius: 19px;
          opacity: 1;
        }
        100% {
          /* Player no centro da tela */
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%) scaleY(1);
          width: 380px;
          height: 520px;
          border-radius: 20px;
          opacity: 1;
        }
      }

      /* ─── CONTRAÇÃO: player retorna à pílula e desaparece ─── */
      @keyframes cellularContraction {
        0% {
          /* Player parte do centro — height vem do inline style capturado */
          animation-timing-function: cubic-bezier(0.55, 0, 0.1, 1);
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%) scaleY(1);
          width: 380px;
          border-radius: 20px;
          opacity: 1;
        }
        82% {
          /* Pílula de volta abaixo da ilha */
          animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1);
          top: 60px;
          left: 50%;
          transform: translate(-50%, 0) scaleY(1);
          width: 450px;
          height: 38px;
          border-radius: 19px;
          opacity: 1;
        }
        100% {
          /* Célula colapsa de volta para a ilha */
          top: 60px;
          left: 50%;
          transform: translate(-50%, 0) scaleY(0);
          width: 450px;
          height: 38px;
          border-radius: 19px;
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
      // Estado inicial = pílula colapsada logo abaixo da ilha
      initialStyle: `
        position: fixed;
        top: 60px;
        left: 50%;
        transform: translate(-50%, 0) scaleY(0);
        transform-origin: top center;
        width: 450px;
        height: 38px;
        border-radius: 19px;
        opacity: 0;
        z-index: 996;
        pointer-events: none;
        overflow: hidden;
      `,
      onComplete: () => {
        // Libera a altura fixa e permite interação após animação completa
        if (this.playerContainer) {
          this.playerContainer.style.height = 'auto';
          this.playerContainer.style.overflow = 'visible';
          this.playerContainer.style.pointerEvents = 'auto';
        }
        this.cacheDomElements();
      }
    });

    // Reset cursor quando abre a mitose
    if (window.meuCursor && typeof window.meuCursor.resetHover === 'function') {
      window.meuCursor.resetHover();
    }
  }

  unmorph() {
    if (!this.isMorphed) return;
    this.isMorphed = false;

    // ── Fixa a altura em px antes de contrair (height: auto não é animável) ──
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

    // Reset cursor quando fecha a mitose
    if (window.meuCursor && typeof window.meuCursor.resetHover === 'function') {
      window.meuCursor.resetHover();
    }
  }

  buildPlayerHTML() {
    return `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; background: rgba(15, 15, 15, 0.75); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; padding: 32px 28px; width: 100%; height: 100%; box-sizing: border-box; box-shadow: 0 12px 40px rgba(0,0,0,0.6);">
        
        <!-- Thumbnail -->
        <div id="playback-thumbnail" style="width: 120px; height: 120px; background: rgba(255,255,255,0.08); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; display: flex; align-items: center; justify-content: center; overflow: hidden; color: rgba(255,255,255,0.6); flex-shrink: 0;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="width: 56px; height: 56px; stroke-width: 1.2;">
            <circle cx="12" cy="12" r="10" />
            <polygon points="10,8 16,12 10,16" />
          </svg>
        </div>

        <!-- Info -->
        <div style="display: flex; flex-direction: column; gap: 6px; text-align: center; width: 100%;">
          <div id="playback-title" style="font-size: 18px; font-weight: 700; color: white; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">Nothing playing</div>
          <div id="playback-artist" style="font-size: 12px; color: rgba(255,255,255,0.6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">—</div>
        </div>

        <!-- Progress -->
        <div style="display: flex; flex-direction: column; gap: 8px; width: 100%;">
          <div id="progress-bar" style="height: 3px; background: rgba(255,255,255,0.15); border-radius: 2px; cursor: pointer; position: relative; overflow: hidden; transition: height 0.2s ease;">
            <div id="progress-fill" style="height: 100%; background: white; border-radius: 2px; width: 0%; transition: width 0.08s linear;"></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 10px; color: rgba(255,255,255,0.5); font-family: 'Courier New', monospace;">
            <span id="current-time">0:00</span>
            <span id="total-time">0:00</span>
          </div>
        </div>

        <!-- Controls -->
        <div style="display: flex; align-items: center; justify-content: center; gap: 16px;">
          <button id="btn-skip-back" class="hover-target" style="display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; background: rgba(255,255,255,0.08); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; color: white; transition: all 0.25s ease; padding: 0; font-size: 0;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="width: 16px; height: 16px; stroke-width: 1.8;">
              <polygon points="19,20 9,12 19,4" />
              <line x1="5" y1="19" x2="5" y2="5" />
            </svg>
          </button>
          <button id="btn-play-pause" class="hover-target" style="display: flex; align-items: center; justify-content: center; width: 56px; height: 56px; background: rgba(255,255,255,0.95); border: none; border-radius: 10px; color: black; transition: all 0.25s ease; padding: 0;">
            <svg id="icon-play" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="width: 22px; height: 22px; stroke-width: 1.8;">
              <polygon points="5,3 19,12 5,21" />
            </svg>
            <svg id="icon-pause" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="display: none; width: 22px; height: 22px; stroke-width: 1.8;">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          </button>
          <button id="btn-skip-fwd" class="hover-target" style="display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; background: rgba(255,255,255,0.08); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; color: white; transition: all 0.25s ease; padding: 0; font-size: 0;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="width: 16px; height: 16px; stroke-width: 1.8;">
              <polygon points="5,4 15,12 5,20" />
              <line x1="19" y1="5" x2="19" y2="19" />
            </svg>
          </button>
        </div>

        <!-- Queue -->
        <div style="display: flex; flex-direction: column; gap: 8px; width: 100%; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.08);">
          <div style="font-size: 9px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(255,255,255,0.4);">QUEUE</div>
          <div id="queue-list" style="display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto;">
            <div style="padding: 16px; text-align: center; color: rgba(255,255,255,0.3); font-size: 11px;">Queue is empty</div>
          </div>
        </div>

      </div>
    `;
  }

  cacheDomElements() {
    const search = (id) => document.getElementById(id);
    this.dom.title = search('playback-title');
    this.dom.artist = search('playback-artist');
    this.dom.thumbnail = search('playback-thumbnail');
    this.dom.currentTime = search('current-time');
    this.dom.totalTime = search('total-time');
    this.dom.progressFill = search('progress-fill');
    this.dom.progressBar = search('progress-bar');
    this.dom.playIcon = search('icon-play');
    this.dom.pauseIcon = search('icon-pause');
    this.dom.btnPlayPause = search('btn-play-pause');
    this.dom.btnSkipBack = search('btn-skip-back');
    this.dom.btnSkipFwd = search('btn-skip-fwd');
    this.dom.queueList = search('queue-list');

    this.attachControlListeners();
  }

  clearDomReferences() {
    Object.keys(this.dom).forEach(key => {
      this.dom[key] = null;
    });
  }

  attachControlListeners() {
    if (this.dom.btnPlayPause) {
      this.dom.btnPlayPause.addEventListener('click', () => this.togglePlayPause());
    }
    if (this.dom.btnSkipBack) {
      this.dom.btnSkipBack.addEventListener('click', () => this.skipBack());
    }
    if (this.dom.btnSkipFwd) {
      this.dom.btnSkipFwd.addEventListener('click', () => this.skipForward());
    }
    if (this.dom.progressBar) {
      this.dom.progressBar.addEventListener('click', (e) => this.handleSeek(e));
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

    const newState = status.state || 'idle';
    const prevState = this.state.playState;

    if (!isGuarded) {
      const wasPlaying = prevState === 'playing';
      const nowPlaying = newState === 'playing';

      if (!wasPlaying && nowPlaying) {
        this.state.sliderPos = status.position || 0;
        this.state.sliderAnchorMs = Date.now();
      } else if (wasPlaying && !nowPlaying) {
        this.state.sliderPos = this.getDeadReckonedPos();
        this.state.sliderAnchorMs = 0;
      }

      this.state.playState = newState;
      this.state.duration = status.duration > 0 ? status.duration : this.state.duration;
      this.state.currentId = status.track_id || null;
      this.state.currentQueueIdx = status.queue_current_index ?? -1;

      this.setPlayIcon(!status.paused && newState === 'playing');
    }

    this.state.queue = status.queue || [];
    this.state.currentTrack = {
      title: status.title || '',
      artist: status.artist || '',
      thumbnail: status.thumbnail || ''
    };

    this.render();
    this.renderQueue();
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

    const pos = this.getDeadReckonedPos();
    const pct = Math.round((pos / this.state.duration) * 1000) / 10;
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
      if (this.dom.title) {
        this.dom.title.textContent = this.state.currentTrack.title || this.state.currentId;
      }
      if (this.dom.artist) {
        this.dom.artist.textContent = this.state.currentTrack.artist || '—';
      }
      if (this.dom.totalTime) {
        this.dom.totalTime.textContent = this.formatTime(this.state.duration);
      }

      this.updateThumbnail();
    } else {
      if (this.dom.title) {
        this.dom.title.textContent = 'Nothing playing';
      }
      if (this.dom.artist) {
        this.dom.artist.textContent = '—';
      }
      if (this.dom.totalTime) {
        this.dom.totalTime.textContent = '0:00';
      }
      if (this.dom.currentTime) {
        this.dom.currentTime.textContent = '0:00';
      }
      if (this.dom.progressFill) {
        this.dom.progressFill.style.width = '0%';
      }

      this.resetThumbnail();
    }
  }

  updateThumbnail() {
    if (!this.dom.thumbnail) return;

    const src = this.state.currentTrack.thumbnail;
    if (src) {
      let img = this.dom.thumbnail.querySelector('img');
      if (!img) {
        this.dom.thumbnail.innerHTML = '';
        img = document.createElement('img');
        img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
        this.dom.thumbnail.appendChild(img);
      }
      if (img.src !== src) {
        img.src = src;
      }
    } else {
      this.resetThumbnail();
    }
  }

  resetThumbnail() {
    if (!this.dom.thumbnail) return;
    if (!this.dom.thumbnail.querySelector('svg')) {
      this.dom.thumbnail.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="width: 56px; height: 56px; stroke-width: 1.2;">
          <circle cx="12" cy="12" r="10" />
          <polygon points="10,8 16,12 10,16" />
        </svg>
      `;
    }
  }

  setPlayIcon(isPlaying) {
    if (!this.dom.playIcon || !this.dom.pauseIcon) return;
    this.dom.playIcon.style.display = isPlaying ? 'none' : 'block';
    this.dom.pauseIcon.style.display = isPlaying ? 'block' : 'none';
  }

  renderQueue() {
    if (!this.dom.queueList) return;

    if (!this.state.queue || this.state.queue.length === 0) {
      this.dom.queueList.innerHTML = '<div style="padding: 16px; text-align: center; color: rgba(255,255,255,0.3); font-size: 11px;">Queue is empty</div>';
      return;
    }

    const items = this.state.queue.map((track, idx) => this.createQueueItemHtml(track, idx)).join('');
    this.dom.queueList.innerHTML = items;

    this.dom.queueList.querySelectorAll('.queue-item').forEach((item, idx) => {
      item.addEventListener('click', () => this.playQueueItem(idx));
    });
  }

  createQueueItemHtml(track, idx) {
    const isActive = idx === this.state.currentQueueIdx ? 'active' : '';
    const thumb = track.thumbnail
      ? `<img src="${this.escapeHtml(track.thumbnail)}" alt="" />`
      : '<span>♪</span>';

    return `
      <div class="queue-item hover-target ${isActive}" data-idx="${idx}" style="padding: 10px 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; display: flex; gap: 10px; transition: all 0.2s ease; text-align: left;">
        <div style="width: 36px; height: 36px; flex-shrink: 0; background: rgba(255,255,255,0.06); border-radius: 6px; display: flex; align-items: center; justify-content: center; overflow: hidden; font-size: 9px; color: rgba(255,255,255,0.3);">
          ${thumb}
        </div>
        <div style="flex: 1; min-width: 0;">
          <div style="font-size: 11px; color: white; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500;">${this.escapeHtml(track.title || track.track_id)}</div>
          <div style="font-size: 9px; color: rgba(255,255,255,0.4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.escapeHtml(track.artist || '')}</div>
        </div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────────────────────
  // PLAYBACK CONTROLS
  // ─────────────────────────────────────────────────────────────

  async togglePlayPause() {
    this.state.guardUntilMs = Date.now() + 1500;

    if (this.state.playState === 'playing') {
      this.state.sliderPos = this.getDeadReckonedPos();
      this.state.sliderAnchorMs = 0;
      this.state.playState = 'paused';
      this.setPlayIcon(false);

      try {
        await fetch('/api/pause', { method: 'POST' });
      } catch (e) {
        console.error('Pause failed:', e);
      }
    } else if (this.state.playState === 'paused') {
      this.state.sliderAnchorMs = Date.now();
      this.state.playState = 'playing';
      this.setPlayIcon(true);

      try {
        await fetch('/api/play', { method: 'POST' });
      } catch (e) {
        console.error('Play failed:', e);
      }
    } else {
      if (!this.state.queue.length) {
        this.state.guardUntilMs = 0;
        return;
      }
      this.state.sliderPos = 0;
      this.state.sliderAnchorMs = Date.now();
      this.state.playState = 'playing';
      this.setPlayIcon(true);

      try {
        await fetch('/api/play', { method: 'POST' });
      } catch (e) {
        console.error('Play failed:', e);
      }
    }

    setTimeout(() => this.pollStatus(), 600);
  }

  async skipForward() {
    this.state.guardUntilMs = Date.now() + 1500;
    try {
      await fetch('/api/skip', { method: 'POST' });
      setTimeout(() => this.pollStatus(), 600);
    } catch (e) {
      console.error('Skip failed:', e);
    }
  }

  async skipBack() {
    this.state.guardUntilMs = Date.now() + 1500;
    try {
      await fetch('/api/queue/previous', { method: 'POST' });
      setTimeout(() => this.pollStatus(), 600);
    } catch (e) {
      console.error('Skip back failed:', e);
    }
  }

  async playQueueItem(idx) {
    const track = this.state.queue[idx];
    if (!track) return;

    this.state.guardUntilMs = Date.now() + 1500;
    try {
      const body = {
        track_id: track.track_id || '',
        filepath: track.filepath || ''
      };
      await fetch('/api/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      setTimeout(() => this.pollStatus(), 600);
    } catch (e) {
      console.error('Play queue item failed:', e);
    }
  }

  async handleSeek(event) {
    if (!this.state.duration) return;

    const rect = this.dom.progressBar.getBoundingClientRect();
    const percent = (event.clientX - rect.left) / rect.width;
    const position = Math.max(0, Math.min(percent * this.state.duration, this.state.duration));

    try {
      await fetch('/api/seek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position })
      });

      this.state.guardUntilMs = Date.now() + 800;
      this.state.sliderPos = position;
      this.state.sliderAnchorMs = this.state.playState === 'playing' ? Date.now() : 0;

      setTimeout(() => this.pollStatus(), 400);
    } catch (e) {
      console.error('Seek failed:', e);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────────────────────

  formatTime(seconds) {
    const s = Math.floor(seconds || 0);
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
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
    }
  }
}

// Global instance
window.playbackMitosisManager = null;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.playbackMitosisManager = new PlaybackMitosisManager();
  });
} else {
  window.playbackMitosisManager = new PlaybackMitosisManager();
}
