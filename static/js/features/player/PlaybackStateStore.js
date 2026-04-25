// static/js/PlaybackStateStore.js
// Hub de estado de playback. Recebe snapshots do PlaybackMitosisManager
// e emite eventos diferenciados para consumidores (miniplayer, ilha, tema).
//
// Não move nem duplica lógica — apenas observa e notifica.
//
// Eventos emitidos (window.playbackStore.addEventListener):
//   'state-change'  → playState mudou  (detail: estado completo)
//   'track-change'  → currentId mudou  (detail: estado completo)
//   'queue-change'  → queue.length mudou (detail: estado completo)
//   'progress'      → posição mudou durante reprodução (detail: { position, duration })

class PlaybackStateStore extends EventTarget {
  constructor() {
    super();

    // Snapshot do último estado recebido via sync()
    this._state = {
      playState:    'idle',
      currentId:    null,
      currentTrack: { title: '', artist: '', thumbnail: '' },
      queue:        [],
      duration:     0,
      sliderPos:    0,
      sliderAnchorMs: 0,
      shuffle:      false,
      repeat_mode:  'off',
    };

    // Sentinelas para detecção de mudanças
    this._lastPlayState = 'idle';
    this._lastTrackId   = null;
    this._lastTrackMetaKey = '';
    this._lastQueueLen  = 0;

    // RAF para progresso independente (usado pelo miniplayer)
    this._rafId = null;
    this._lastPct = -1;
  }

  // ─── Chamado por PlaybackMitosisManager.applyServerStatus ──────────────────

  sync(managerState) {
    // Copia rasa dos campos relevantes
    this._state = {
      playState:     managerState.playState,
      currentId:     managerState.currentId,
      currentTrack:  { ...managerState.currentTrack },
      queue:         managerState.queue,
      duration:      managerState.duration,
      sliderPos:     managerState.sliderPos,
      sliderAnchorMs: managerState.sliderAnchorMs,
      shuffle:       managerState.shuffle,
      repeat_mode:   managerState.repeat_mode,
    };

    const detail = this._state;

    if (this._state.queue.length !== this._lastQueueLen) {
      this._lastQueueLen = this._state.queue.length;
      this.dispatchEvent(new CustomEvent('queue-change', { detail }));
    }

    if (this._state.playState !== this._lastPlayState) {
      this._lastPlayState = this._state.playState;
      this.dispatchEvent(new CustomEvent('state-change', { detail }));

      // Gerencia o RAF de progresso: roda enquanto tocando
      if (this._state.playState === 'playing') {
        this._startProgressRaf();
      } else {
        this._stopProgressRaf();
        // Emite uma última vez para o miniplayer congelar na posição correta
        this._emitProgress();
      }
    }

    const trackMetaKey = this._trackMetaKey(this._state);
    if (this._state.currentId !== this._lastTrackId) {
      this._lastTrackId = this._state.currentId;
      this._lastTrackMetaKey = trackMetaKey;
      this.dispatchEvent(new CustomEvent('track-change', { detail }));
    } else if (this._state.currentId && trackMetaKey !== this._lastTrackMetaKey) {
      this._lastTrackMetaKey = trackMetaKey;
      this.dispatchEvent(new CustomEvent('metadata-change', { detail }));
    }
  }

  _trackMetaKey(state) {
    const track = state.currentTrack || {};
    return [
      state.currentId || '',
      track.title || '',
      track.artist || '',
      track.thumbnail || ''
    ].join('\u0001');
  }

  // ─── RAF de progresso ───────────────────────────────────────────────────────
  // Calcula dead-reckoning independentemente (sem depender do isMorphed do manager)

  _deadReckonedPos() {
    const { sliderPos, sliderAnchorMs, duration } = this._state;
    if (!sliderAnchorMs || !duration) return sliderPos;
    return Math.min(sliderPos + (Date.now() - sliderAnchorMs) / 1000, duration);
  }

  _emitProgress() {
    const position = this._deadReckonedPos();
    const duration = this._state.duration;
    if (!duration) return;
    const pct = Math.round((position / duration) * 1000) / 10;
    if (pct === this._lastPct) return;
    this._lastPct = pct;
    this.dispatchEvent(new CustomEvent('progress', {
      detail: { position, duration, pct }
    }));
  }

  _startProgressRaf() {
    if (this._rafId) return;
    const tick = () => {
      this._emitProgress();
      this._rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  _stopProgressRaf() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
      this._lastPct = -1;
    }
  }

  // ─── API pública ────────────────────────────────────────────────────────────

  get state() { return this._state; }

  /** Há faixa na fila ou carregada */
  hasActivePlayback() {
    return !!(this._state.currentId || this._state.queue.length > 0);
  }

  isPlaying() {
    return this._state.playState === 'playing';
  }

  destroy() {
    this._stopProgressRaf();
  }
}

// ─── Instância global ──────────────────────────────────────────────────────────
window.playbackStore = new PlaybackStateStore();
export default window.playbackStore;
