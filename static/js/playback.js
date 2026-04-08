// static/js/playback.js
// Gerencia o estado de playback, polling, e controles de reprodução

class PlaybackManager {
  constructor() {
    // ─── Estado Único (Source of Truth) ───
    this.state = {
      // Playback states: 'idle' | 'playing' | 'paused'
      playState: 'idle',
      currentId: null,
      currentQueueIdx: -1,
      duration: 0,

      // Dead-reckoning (position sem lag de RTT)
      sliderPos: 0,
      sliderAnchorMs: 0,

      // Guard window: previne stale polls de sobrescrever updates otimistas
      guardUntilMs: 0,

      // Queue
      queue: [],

      // Metadados da faixa atual
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
    this.pollInterval = 1500; // ms

    // ─── DOM References ───
    this.dom = {
      state: null,
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
      queueList: null,
      queueCount: null
    };

    this.init();
  }

  init() {
    this.cacheDomElements();
    this.attachEventListeners();
    this.startPolling();
    this.startRafLoop();
  }

  cacheDomElements() {
    const prefix = '#';
    this.dom.state = document.querySelector(`${prefix}playback-state`);
    this.dom.title = document.querySelector(`${prefix}track-title`);
    this.dom.artist = document.querySelector(`${prefix}track-artist`);
    this.dom.thumbnail = document.querySelector(`${prefix}track-thumbnail`);
    this.dom.currentTime = document.querySelector(`${prefix}current-time`);
    this.dom.totalTime = document.querySelector(`${prefix}total-time`);
    this.dom.progressFill = document.querySelector(`${prefix}progress-fill`);
    this.dom.progressBar = document.querySelector(`${prefix}progress-bar`);
    this.dom.playIcon = document.querySelector(`${prefix}icon-play`);
    this.dom.pauseIcon = document.querySelector(`${prefix}icon-pause`);
    this.dom.btnPlayPause = document.querySelector(`${prefix}btn-play-pause`);
    this.dom.btnSkipBack = document.querySelector(`${prefix}btn-skip-back`);
    this.dom.btnSkipFwd = document.querySelector(`${prefix}btn-skip-fwd`);
    this.dom.queueList = document.querySelector(`${prefix}queue-list`);
    this.dom.queueCount = document.querySelector(`${prefix}queue-count`);
  }

  attachEventListeners() {
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
      if (!response.ok) {
        console.warn('Status poll failed:', response.status);
        return;
      }
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

      // Re-anchor slider apenas em transições, nunca mid-play
      if (!wasPlaying && nowPlaying) {
        // Iniciando/resumindo: pega posição do servidor como baseline
        this.state.sliderPos = status.position || 0;
        this.state.sliderAnchorMs = Date.now();
      } else if (wasPlaying && !nowPlaying) {
        // Parando/pausando: congela na posição dead-reckoned
        this.state.sliderPos = this.getDeadReckonedPos();
        this.state.sliderAnchorMs = 0;
      }
      // playing→playing: deixa sliderPos/sliderAnchorMs completamente sozinhos

      this.state.playState = newState;
      this.state.duration = status.duration > 0 ? status.duration : this.state.duration;
      this.state.currentId = status.track_id || null;
      this.state.currentQueueIdx = status.queue_current_index ?? -1;

      this.setPlayIcon(!status.paused && newState === 'playing');
    }

    // Sempre atualiza fila e campos de display não-guardados
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
  // DEAD RECKONING (Posição sem lag de RTT)
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
  // RAF LOOP (60fps progress update)
  // ─────────────────────────────────────────────────────────────

  startRafLoop() {
    const tick = () => {
      this.tickProgress();
      this.rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  tickProgress() {
    if (!this.state.duration) return;

    const pos = this.getDeadReckonedPos();
    const pct = Math.round((pos / this.state.duration) * 1000) / 10;
    const timeStr = this.formatTime(pos);

    // Apenas escreve no DOM se mudou (evita layout thrash)
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
    // Update state display
    if (this.dom.state) {
      this.dom.state.textContent = this.state.playState.toUpperCase();
    }

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

      // Thumbnail
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
        img.className = 'track-thumbnail-image';
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
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
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

    if (this.dom.queueCount) {
      this.dom.queueCount.textContent = this.state.queue.length ? `(${this.state.queue.length})` : '';
    }

    if (!this.state.queue || this.state.queue.length === 0) {
      this.dom.queueList.innerHTML = '<div class="queue-empty">Queue is empty</div>';
      return;
    }

    // Renderiza itens da fila
    const items = this.state.queue.map((track, idx) => this.createQueueItemHtml(track, idx)).join('');
    this.dom.queueList.innerHTML = items;

    // Re-attach event listeners
    this.dom.queueList.querySelectorAll('.queue-item').forEach((item, idx) => {
      item.addEventListener('click', () => this.playQueueItem(idx));
    });
  }

  createQueueItemHtml(track, idx) {
    const isActive = idx === this.state.currentQueueIdx;
    const activeClass = isActive ? 'active' : '';
    const thumb = track.thumbnail
      ? `<img src="${this.escapeHtml(track.thumbnail)}" alt="" />`
      : '<span>♪</span>';

    return `
      <div class="queue-item ${activeClass}" data-idx="${idx}">
        <div class="queue-item-thumb">${thumb}</div>
        <div class="queue-item-info">
          <div class="queue-item-title">${this.escapeHtml(track.title || track.track_id)}</div>
          <div class="queue-item-artist">${this.escapeHtml(track.artist || '')}</div>
        </div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────────────────────
  // PLAYBACK CONTROLS
  // ─────────────────────────────────────────────────────────────

  async togglePlayPause() {
    // Guard: previne stale poll responses
    this.state.guardUntilMs = Date.now() + 1500;

    if (this.state.playState === 'playing') {
      // Pause: freeze slider at current dead-reckoned position
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
      // Resume: re-anchor from frozen position
      this.state.sliderAnchorMs = Date.now();
      this.state.playState = 'playing';
      this.setPlayIcon(true);
      
      try {
        await fetch('/api/play', { method: 'POST' });
      } catch (e) {
        console.error('Play failed:', e);
      }
    } else {
      // Idle: need something in queue
      if (!this.state.queue.length) {
        this.state.guardUntilMs = 0;
        this.showNotification('Queue is empty');
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

  showNotification(message) {
    // TODO: Integrar com o sistema de notificação da RolfsoundIsland
    console.warn(message);
  }

  destroy() {
    this.stopPolling();
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
    }
  }
}

// Export global instance
window.playbackManager = null;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.playbackManager = new PlaybackManager();
  });
} else {
  window.playbackManager = new PlaybackManager();
}
