// static/js/RolfsoundMiniplayer.js
// Miniplayer persistente no rodapé — terceira superfície de playback.
// Aparece quando há reprodução ativa fora da aba Now Playing.
// Visual idêntico ao controls pill do full player.
//
// Estados:
//   hidden → show(animate?) → visible → hide(animate?) → hidden
//
// Eventos consumidos:
//   window.playbackStore: 'state-change', 'track-change', 'queue-change', 'progress'
//   window: 'rolfsound-theme-change'
//
// Dispara:
//   'rolfsound-miniplayer-expand' → PlaybackMitosisManager abre o full player
//   'rolfsound-miniplayer-visibility-change' → ilha / animadores reagem

import { getThumbnailCandidates } from '/static/js/utils/thumbnails.js';
import { getDisplayArtist } from '/static/js/utils/trackMeta.js';

class RolfsoundMiniplayer extends HTMLElement {
  static observedAttributes = ['visible'];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    // Estado interno
    this._visible = false;
    this._thumbKey = null;         // dedup crossfade
    this._thumbAEl = null;         // img A (slot par)
    this._thumbBEl = null;         // img B (slot ímpar)
    this._thumbSlot = 0;           // 0 = A visível, 1 = B visível

    // Referências DOM (shadow)
    this.dom = {
      shell:         null,
      thumbWrap:     null,
      title:         null,
      artist:        null,
      btnPlay:       null,
      iconPlay:      null,
      iconPause:     null,
      progressFill:  null,
    };

    // Handlers de store (armazenados pra cleanup)
    this._onStateChange   = null;
    this._onTrackChange   = null;
    this._onMetadataChange = null;
    this._onQueueChange   = null;
    this._onProgress      = null;
    this._onThemeChange   = null;
    this._onExpand        = null;
  }

  connectedCallback() {
    this._render();
    this._cacheDom();
    this._attachHandlers();
    this._syncFromStore();
  }

  disconnectedCallback() {
    const store = window.playbackStore;
    if (store) {
      store.removeEventListener('state-change',  this._onStateChange);
      store.removeEventListener('track-change',  this._onTrackChange);
      store.removeEventListener('metadata-change', this._onMetadataChange);
      store.removeEventListener('queue-change',  this._onQueueChange);
      store.removeEventListener('progress',      this._onProgress);
    }
    window.removeEventListener('rolfsound-theme-change', this._onThemeChange);
  }

  // ─────────────────────────────────────────────────────────────
  // VISIBILIDADE (sem animação — animações vêm do MiniBirthAnimator)
  // ─────────────────────────────────────────────────────────────

  get isVisible() { return this._visible; }

  /** Mostra sem animação (usado no boot se já havia playback) */
  showInstant() {
    if (this._visible) return;
    this._visible = true;
    this.style.display = '';
    this._emitVisibilityChange();
  }

  /** Esconde sem animação */
  hideInstant() {
    if (!this._visible) return;
    this._visible = false;
    this.style.display = 'none';
    this._emitVisibilityChange();
  }

  _emitVisibilityChange() {
    this.dispatchEvent(new CustomEvent('rolfsound-miniplayer-visibility-change', {
      bubbles: true, composed: true,
      detail: { visible: this._visible }
    }));
  }

  // ─────────────────────────────────────────────────────────────
  // SHADOW DOM
  // ─────────────────────────────────────────────────────────────

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          position: fixed;
          bottom: var(--mini-bottom, 30px);
          left: 50%;
          transform: translateX(-50%);
          width: var(--mini-width, 460px);
          height: var(--mini-height, 58px);
          z-index: 994;
          pointer-events: auto;
          cursor: none;
          will-change: transform, opacity, width, height;
        }

        :host([hidden]) { display: none !important; }

        /* Shell principal — pill glass escura, idêntica ao controls pill */
        .mini-shell {
          position: relative;
          width: 100%;
          height: 100%;
          background: var(--color-playback-pill, rgba(12,12,12,0.88));
          backdrop-filter: blur(var(--blur-playback, 24px));
          -webkit-backdrop-filter: blur(var(--blur-playback, 24px));
          border: 1px solid var(--color-border-soft, rgba(255,255,255,0.07));
          border-radius: var(--radius-dynamic-island, 16px);
          box-shadow: var(--shadow-miniplayer, 0 12px 40px rgba(0,0,0,0.65));
          display: flex;
          align-items: center;
          padding: 0 14px 0 12px;
          gap: 12px;
          box-sizing: border-box;
          cursor: none;
          overflow: hidden;
          user-select: none;
        }

        /* Thumbnail circular */
        .mini-thumb {
          position: relative;
          flex: 0 0 44px;
          width: 44px;
          height: 44px;
          border-radius: var(--radius-dynamic-island, 16px);
          overflow: hidden;
          background: var(--color-playback-cover, #0f0f0f);
          flex-shrink: 0;
        }

        .mini-thumb img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          border-radius: var(--radius-dynamic-island, 16px);
          transition: opacity 0.3s ease;
        }

        .mini-thumb .thumb-placeholder {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        /* Metadados: título + artista */
        .mini-meta {
          flex: 1 1 0;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
          pointer-events: none;
        }

        .mini-title {
          font-size: 13px;
          font-weight: 700;
          color: var(--color-text-primary, rgba(255,255,255,0.96));
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          letter-spacing: -0.01em;
          /* Fade mask nas bordas laterais */
          -webkit-mask-image: linear-gradient(to right, black 80%, transparent 100%);
          mask-image: linear-gradient(to right, black 80%, transparent 100%);
        }

        .mini-artist {
          font-size: var(--fs-md, 11px);
          color: var(--color-text-soft, rgba(255,255,255,0.5));
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          letter-spacing: 0.01em;
          -webkit-mask-image: linear-gradient(to right, black 80%, transparent 100%);
          mask-image: linear-gradient(to right, black 80%, transparent 100%);
        }

        /* Controles direitos */
        .mini-controls {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 2px;
        }

        /* Botões de controle */
        .mini-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          padding: 0;
          background: transparent;
          border: none;
          border-radius: 50%;
          color: var(--color-text-control, rgba(255,255,255,0.74));
          cursor: none;
          transition: color 0.18s ease, transform 0.18s ease, opacity 0.2s ease;
          flex-shrink: 0;
        }

        .mini-btn:hover {
          background: var(--rs-theme-hover-bg, rgba(255,255,255,0.07));
          box-shadow: 0 0 14px var(--rs-theme-glow, transparent);
          color: var(--color-text-control-strong, rgba(255,255,255,0.96));
        }

        .mini-btn:active { transform: scale(0.90); }

        .mini-btn svg {
          width: 13px;
          height: 13px;
          stroke-width: 2;
          pointer-events: none;
        }

        /* Play/pause é ligeiramente maior e mais brilhante */
        .mini-btn-main {
          width: 38px;
          height: 38px;
          color: var(--color-text-control-strong, rgba(255,255,255,0.96));
        }

        .mini-btn-main svg {
          width: 16px;
          height: 16px;
        }

        /* Botões de skip: escondidos por default, aparecem no hover */
        .mini-btn-skip {
          opacity: 0;
          pointer-events: none;
          transform: scale(0.85);
          transition: color 0.18s ease, opacity 0.2s ease, transform 0.2s ease;
        }

        .mini-shell:hover .mini-btn-skip {
          opacity: 1;
          pointer-events: auto;
          transform: scale(1);
        }

        .mini-btn-skip:active { transform: scale(0.90) !important; }

        /* Barra de progresso: linha fina na borda inferior do container */
        .mini-progress {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          height: 2px;
          background: var(--color-progress-track, rgba(255,255,255,0.12));
          pointer-events: none;
          overflow: hidden;
          border-radius: 0 0 var(--radius-dynamic-island, 16px) var(--radius-dynamic-island, 16px);
        }

        .mini-progress-fill {
          position: absolute;
          inset: 0;
          width: 100%;
          transform: scaleX(0);
          transform-origin: left center;
          background:
            linear-gradient(
              90deg,
              rgba(255,255,255,0.92),
              rgb(var(--rs-theme-accent-rgb, 255 255 255) / calc(0.70 + var(--rs-theme-intensity, 0) * 0.2))
            );
          box-shadow: 0 0 16px var(--rs-theme-glow, transparent);
          border-radius: 0 var(--radius-xs, 2px) var(--radius-xs, 2px) 0;
          transition: transform 0.08s linear;
        }
      </style>

      <div class="mini-shell" part="shell">

        <!-- Thumbnail circular com crossfade -->
        <div class="mini-thumb" part="thumb">
          <div class="thumb-placeholder">
            <svg viewBox="0 0 24 24" fill="none"
              stroke="var(--color-playback-icon-muted, rgba(255,255,255,0.12))"
              style="width:20px;height:20px;stroke-width:1.4">
              <circle cx="12" cy="12" r="10"/>
              <polygon points="10,8 16,12 10,16"/>
            </svg>
          </div>
        </div>

        <!-- Título + artista -->
        <div class="mini-meta" part="meta">
          <div class="mini-title" part="title">Nada tocando</div>
          <div class="mini-artist" part="artist">—</div>
        </div>

        <!-- Controles -->
        <div class="mini-controls" part="controls">

          <!-- Skip anterior (aparece no hover) -->
          <button class="mini-btn mini-btn-skip hover-target" id="mini-btn-prev"
            title="Anterior" aria-label="Anterior">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <polygon points="19,20 9,12 19,4"/>
              <line x1="5" y1="19" x2="5" y2="5"/>
            </svg>
          </button>

          <!-- Play / Pause (sempre visível) -->
          <button class="mini-btn mini-btn-main hover-target" id="mini-btn-play"
            title="Play / Pause" aria-label="Play / Pause">
            <svg id="mini-icon-play" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <polygon points="5,3 19,12 5,21"/>
            </svg>
            <svg id="mini-icon-pause" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              style="display:none">
              <rect x="6" y="4" width="4" height="16"/>
              <rect x="14" y="4" width="4" height="16"/>
            </svg>
          </button>

          <!-- Skip próxima (aparece no hover) -->
          <button class="mini-btn mini-btn-skip hover-target" id="mini-btn-next"
            title="Próxima" aria-label="Próxima">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <polygon points="5,4 15,12 5,20"/>
              <line x1="19" y1="5" x2="19" y2="19"/>
            </svg>
          </button>

        </div>

        <!-- Progresso na borda inferior -->
        <div class="mini-progress" part="progress">
          <div class="mini-progress-fill" id="mini-progress-fill"></div>
        </div>

      </div>
    `;
  }

  _cacheDom() {
    const sr = this.shadowRoot;
    this.dom.shell        = sr.querySelector('.mini-shell');
    this.dom.thumbWrap    = sr.querySelector('.mini-thumb');
    this.dom.title        = sr.querySelector('.mini-title');
    this.dom.artist       = sr.querySelector('.mini-artist');
    this.dom.btnPlay      = sr.getElementById('mini-btn-play');
    this.dom.btnPrev      = sr.getElementById('mini-btn-prev');
    this.dom.btnNext      = sr.getElementById('mini-btn-next');
    this.dom.iconPlay     = sr.getElementById('mini-icon-play');
    this.dom.iconPause    = sr.getElementById('mini-icon-pause');
    this.dom.progressFill = sr.getElementById('mini-progress-fill');

    // Dois slots de imagem pra crossfade
    this._thumbAEl = document.createElement('img');
    this._thumbBEl = document.createElement('img');
    this._thumbAEl.style.opacity = '0';
    this._thumbBEl.style.opacity = '0';
    this._thumbAEl.setAttribute('aria-hidden', 'true');
    this._thumbBEl.setAttribute('aria-hidden', 'true');
    this.dom.thumbWrap.appendChild(this._thumbAEl);
    this.dom.thumbWrap.appendChild(this._thumbBEl);
  }

  _attachHandlers() {
    // ── Store listeners ───────────────────────────────────────────────────────
    const store = window.playbackStore;
    if (!store) return;

    this._onStateChange = (e) => this._handleStateChange(e.detail);
    this._onTrackChange = (e) => this._handleTrackChange(e.detail);
    this._onMetadataChange = (e) => this._handleTrackChange(e.detail);
    this._onQueueChange = (e) => this._handleQueueChange(e.detail);
    this._onProgress    = (e) => this._handleProgress(e.detail);

    store.addEventListener('state-change',  this._onStateChange);
    store.addEventListener('track-change',  this._onTrackChange);
    store.addEventListener('metadata-change', this._onMetadataChange);
    store.addEventListener('queue-change',  this._onQueueChange);
    store.addEventListener('progress',      this._onProgress);

    // ── Tema reativo ──────────────────────────────────────────────────────────
    this._onThemeChange = (e) => {
      // Reservado: aplicar cores de acento no progress fill quando desejar
    };
    window.addEventListener('rolfsound-theme-change', this._onThemeChange);

    // ── Clique expand (área não-botão expande pro full) ──────────────────────
    this._onExpand = (e) => {
      const isBtn = e.target.closest('.mini-btn');
      if (isBtn) return;
      this._requestExpand();
    };
    this.dom.shell.addEventListener('click', this._onExpand);

    // ── Botão play/pause ──────────────────────────────────────────────────────
    this.dom.btnPlay.addEventListener('click', (e) => {
      e.stopPropagation();
      this._togglePlayback();
    });

    // ── Botões de skip ────────────────────────────────────────────────────────
    this.dom.btnPrev?.addEventListener('click', (e) => {
      e.stopPropagation();
      window.rolfsoundChannel?.send('intent.skip', { direction: 'back' });
    });

    this.dom.btnNext?.addEventListener('click', (e) => {
      e.stopPropagation();
      window.rolfsoundChannel?.send('intent.skip', { direction: 'fwd' });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // SINCRONIZAÇÃO INICIAL
  // ─────────────────────────────────────────────────────────────

  _syncFromStore() {
    const store = window.playbackStore;
    if (!store) return;
    const s = store.state;
    if (!s.currentId) return;
    this._updateMeta(s.currentTrack);
    this._updatePlayIcon(s.playState === 'playing');
    this._updateThumbnail(s.currentTrack?.thumbnail, s.currentId);
  }

  // ─────────────────────────────────────────────────────────────
  // HANDLERS
  // ─────────────────────────────────────────────────────────────

  _handleStateChange(state) {
    this._updatePlayIcon(state.playState === 'playing');
  }

  _handleTrackChange(state) {
    this._updateMeta(state.currentTrack);
    this._updateThumbnail(state.currentTrack?.thumbnail, state.currentId);
  }

  _handleQueueChange(state) {
    // Visibilidade gerida pelo RolfsoundIsland.reconcileMini (Fase 4)
    // Por ora, nada extra aqui
  }

  _handleProgress({ pct }) {
    if (this.dom.progressFill) {
      this.dom.progressFill.style.transform = `scaleX(${pct / 100})`;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // DOM UPDATES
  // ─────────────────────────────────────────────────────────────

  _updateMeta(track) {
    if (!track) return;
    if (this.dom.title)  this.dom.title.textContent  = track.title  || 'Nada tocando';
    if (this.dom.artist) this.dom.artist.textContent = getDisplayArtist(track) || '—';
  }

  _updatePlayIcon(playing) {
    if (!this.dom.iconPlay) return;
    this.dom.iconPlay.style.display  = playing ? 'none' : '';
    this.dom.iconPause.style.display = playing ? ''     : 'none';
  }

  /**
   * Crossfade simples entre dois slots de imagem (A e B).
   * Evita flickering ao trocar de faixa.
   */
  _updateThumbnail(thumbnail, trackId) {
    const key = `${trackId || ''}|${thumbnail || ''}`;
    if (key === this._thumbKey) return;
    this._thumbKey = key;

    const candidates = getThumbnailCandidates({ thumbnail, id: trackId, track_id: trackId });
    if (!candidates.length) {
      this._thumbAEl.style.opacity = '0';
      this._thumbBEl.style.opacity = '0';
      return;
    }

    // Alterna entre slot A e B
    const incoming = this._thumbSlot === 0 ? this._thumbBEl : this._thumbAEl;
    const outgoing = this._thumbSlot === 0 ? this._thumbAEl : this._thumbBEl;
    this._thumbSlot = this._thumbSlot === 0 ? 1 : 0;

    incoming.onload = () => {
      incoming.style.opacity = '1';
      outgoing.style.opacity = '0';
    };
    let candidateIndex = 0;
    incoming.onerror = () => {
      candidateIndex += 1;
      if (candidateIndex < candidates.length) incoming.src = candidates[candidateIndex];
    };
    incoming.src = candidates[candidateIndex];
  }

  _resolveSrc(thumbnail, trackId) {
    return getThumbnailCandidates({ thumbnail, id: trackId, track_id: trackId })[0] || null;

    // Prioridade: thumbnail indexado (Discogs/etc) > fallback YouTube
    if (thumbnail) {
      if (thumbnail.startsWith('http') || thumbnail.startsWith('/thumbs/')) return thumbnail;
      return '/thumbs/' + thumbnail.split(/[\\/]/).pop();
    }
    // Sem thumbnail indexado: usa capa do YouTube como último recurso
    if (typeof trackId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(trackId)) {
      return `https://i.ytimg.com/vi/${trackId}/maxresdefault.jpg`;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // AÇÕES
  // ─────────────────────────────────────────────────────────────

  _requestExpand() {
    if (window.playbackMitosisManager && !window.playbackMitosisManager.isMorphed) {
      window.playbackMitosisManager.morph({ from: 'mini' });
    }
  }

  _togglePlayback() {
    const store = window.playbackStore;
    const state = store?.state?.playState || 'idle';
    if (state === 'idle') {
      window.rolfsoundChannel?.send('intent.play', {});
    } else {
      // core's /api/pause toggles between pause and resume
      window.rolfsoundChannel?.send('intent.pause', {});
    }
  }
}

customElements.define('rolfsound-miniplayer', RolfsoundMiniplayer);

// ─── Global ref ───────────────────────────────────────────────────────────────
window.rolfsoundMiniplayer = null;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.rolfsoundMiniplayer = document.querySelector('rolfsound-miniplayer');
  });
} else {
  window.rolfsoundMiniplayer = document.querySelector('rolfsound-miniplayer');
}
