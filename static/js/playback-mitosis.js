// static/js/playback-mitosis.js
// Lean coordinator — delegates to MitosisStateMachine, ThumbnailCrossfader, PlayerShell.
import AnimationEngine   from '/static/js/AnimationEngine.js';
import Animator          from '/static/js/Animator.js';
import MiniMorphAnimator from '/static/js/MiniMorphAnimator.js';
import MitosisStateMachine from '/static/js/playback/MitosisStateMachine.js';
import ThumbnailCrossfader from '/static/js/playback/ThumbnailCrossfader.js';
import PlayerShell         from '/static/js/playback/PlayerShell.js';

class PlaybackMitosisManager {
  constructor() {
    // ─── Morph state ───
    this.island          = null;
    this.isMorphed       = false;
    this.playerContainer = null;
    this._division       = null;
    this.isQueueOpen     = false;
    this.queueContainer  = null;

    // ─── Playback state (single source of truth) ───
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
      repeat_mode: 'off',

      currentTrack: { title: '', artist: '', thumbnail: '' }
    };

    // ─── Animators ───
    this._animator        = new Animator();
    this._miniMorphAnimator = new MiniMorphAnimator(this);

    // ─── Misc ───
    this._lastThemeKey    = null;
    this._onNavigate      = null;
    this._onPopState      = null;
    this._onOutsideClick  = null;
    this.rafId            = null;
    this.rafPos           = -1;
    this.rafTime          = '';
    this.animationTimers  = new Set();

    // ─── DOM references ───
    this.dom = { title: null, artist: null, thumbnail: null };

    // ─── Sub-objects ───
    this._mitosis    = new MitosisStateMachine(this);
    this._crossfader = new ThumbnailCrossfader(this);
    this._shell      = new PlayerShell(this);

    this.init();
  }

  init() {
    this._mitosis.registerAnimations();
    this._mitosis.findIsland();
    this._mitosis.attachNavigationListener();

    // All state updates arrive via the channel (WS push or polling fallback).
    // startPolling() is no longer called here — it conflicted with WS push,
    // causing the seek bar to alternate between correct (tick) and wrong (poll) position.
    window.rolfsoundChannel?.on('state.playback', s => this.applyServerStatus(s));

    // One-shot initial fetch so UI populates immediately before WS handshake.
    this._fetchInitialStatus();
  }

  async _fetchInitialStatus() {
    try {
      const r = await fetch('/api/status');
      if (!r.ok) return;
      this.applyServerStatus(await r.json());
    } catch {}
  }

  // ─────────────────────────────────────────────────────────────
  // DELEGATION — sub-objects expose these via the manager API
  // ─────────────────────────────────────────────────────────────

  morph(opts = {})   { this._mitosis.morph(opts); }
  unmorph(opts = {}) { this._mitosis.unmorph(opts); }

  buildPlayerHTML()      { return this._shell.buildPlayerHTML(); }
  cacheDomElements()     { this._shell.cacheDomElements(); }
  clearDomReferences()   { this._shell.clearDomReferences(); }
  openQueuePanel()       { this._shell.openQueuePanel(); }
  closeQueuePanel()      { this._shell.closeQueuePanel(); }
  renderQueuePanel()     { this._shell.renderQueuePanel(); }

  updateThumbnail()              { this._crossfader.update(); }
  resetThumbnail()               { this._crossfader.reset(); }
  thumbSrc(t)                    { return this._crossfader.thumbSrc(t); }
  getThumbnailCandidates(t, id)  { return this._crossfader.getThumbnailCandidates(t, id); }

  // ─────────────────────────────────────────────────────────────
  // ANIMATION SCHEDULING
  // ─────────────────────────────────────────────────────────────

  scheduleAnimation(callback, delay, tag) {
    return AnimationEngine.schedule(this, callback, delay, tag);
  }

  clearAnimationTimers(tag) {
    AnimationEngine.clearScheduled(this, tag);
  }

  // ─────────────────────────────────────────────────────────────
  // STATE APPLICATION
  // ─────────────────────────────────────────────────────────────

  applyServerStatus(status) {
    const isGuarded  = Date.now() < this.state.guardUntilMs;
    const newState   = status.state || 'idle';
    const prevState  = this.state.playState;
    const prevId     = this.state.currentId;
    const nextId     = status.track_id || null;
    const trackChanged = nextId !== prevId;

    if (!isGuarded) {
      const wasPlaying = prevState === 'playing';
      const nowPlaying = newState  === 'playing';

      const posUpdatedAt = status.position_updated_at || 0;
      // posUpdatedAt is Unix ms (status_enricher converts from core's seconds).
      // Divide by 1000 to get networkLag in seconds for position arithmetic.
      const networkLag   = (posUpdatedAt > 0 && nowPlaying)
        ? Math.max(0, (Date.now() - posUpdatedAt) / 1000) : 0;
      const serverPos = Math.min((status.position || 0) + networkLag, status.duration || Infinity);

      if (prevState === 'idle') {
        this.state.sliderPos      = status.position || 0;
        this.state.sliderAnchorMs = nowPlaying ? Date.now() : 0;
      } else if (!wasPlaying && nowPlaying) {
        this.state.sliderPos      = serverPos;
        this.state.sliderAnchorMs = Date.now();
      } else if (wasPlaying && !nowPlaying) {
        this.state.sliderPos      = this.getDeadReckonedPos();
        this.state.sliderAnchorMs = 0;
      } else if (wasPlaying && nowPlaying && trackChanged) {
        this.state.sliderPos      = serverPos;
        this.state.sliderAnchorMs = Date.now();
      }

      this.state.playState       = newState;
      this.state.duration        = status.duration > 0 ? status.duration : this.state.duration;
      this.state.currentId       = nextId;
      this.state.currentQueueIdx = status.queue_current_index ?? -1;
    }

    this.state.queue = status.queue || [];

    const serverTrackMatches = !isGuarded || nextId === this.state.currentId;
    if (serverTrackMatches) {
      this.state.currentTrack = {
        title:     status.title     || '',
        artist:    status.artist    || '',
        thumbnail: status.thumbnail || ''
      };
    }

    if (typeof status.shuffle     !== 'undefined') this.state.shuffle     = !!status.shuffle;
    if (typeof status.repeat_mode !== 'undefined') this.state.repeat_mode = status.repeat_mode || 'off';
    else if (typeof status.repeat !== 'undefined') this.state.repeat_mode = status.repeat ? 'all' : 'off';

    this.render();

    window.playbackStore?.sync(this.state);

    if (this.island?.setNowPlayingState) {
      this.island.setNowPlayingState(this.state.playState === 'playing');
    }

    const themeKey = `${this.state.playState}|${this.state.currentId}`;
    if (themeKey !== this._lastThemeKey) this._dispatchThemeEvent();
  }

  // ─────────────────────────────────────────────────────────────
  // THEME
  // ─────────────────────────────────────────────────────────────

  _dispatchThemeEvent() {
    this._lastThemeKey = `${this.state.playState}|${this.state.currentId}`;

    const nextQueueIdx = this.state.currentQueueIdx + 1;
    const nextTrack    = (nextQueueIdx >= 0 && nextQueueIdx < this.state.queue.length)
      ? this.state.queue[nextQueueIdx] : null;

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
    if (this.state.sliderAnchorMs === 0 || this.state.duration === 0) return this.state.sliderPos;
    return Math.min(
      this.state.sliderPos + (Date.now() - this.state.sliderAnchorMs) / 1000,
      this.state.duration
    );
  }


  // ─────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────

  render() {
    if (!this.isMorphed) return;

    if (this.state.currentId) {
      if (this.dom.title)  this.dom.title.textContent  = this.state.currentTrack.title  || this.state.currentId;
      if (this.dom.artist) this.dom.artist.textContent = this.state.currentTrack.artist || '—';
      this.updateThumbnail();
    } else {
      if (this.dom.title)  this.dom.title.textContent  = 'Nothing playing';
      if (this.dom.artist) this.dom.artist.textContent = '—';
      this.resetThumbnail();
    }

    if (this.isQueueOpen) this.renderQueuePanel();
  }

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
    this.state.duration       = 0;

    this.render();
    if (newId !== prevId) this._dispatchThemeEvent();
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

  _promptText(title, placeholder) {
    if (typeof window.island?.promptPlaylistName === 'function') {
      return window.island.promptPlaylistName(title, placeholder);
    }
    return Promise.resolve(window.prompt(title) || '');
  }

  _notify(text) {
    if (typeof window.island?.showNotification === 'function') {
      window.island.showNotification({ text, duration: 2200 });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // DESTROY
  // ─────────────────────────────────────────────────────────────

  destroy() {
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
    if (this.queueContainer?.parentNode) this.queueContainer.remove();
    this.queueContainer = null;
    this.isQueueOpen    = false;
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
