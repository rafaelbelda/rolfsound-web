// static/js/playback/device-audio/DeviceAudioController.js
//
// Singleton engine for "Play on this device". Owns the audio WebSocket, the
// AudioContext + jitter-buffer worklet, the gapless-handoff handshake, and a
// small state machine. The UI (<rolfsound-device-toggle>) only reflects state
// emitted here — mirroring the RolfsoundChannel-singleton / RolfsoundControl
// split used everywhere else in the app.
//
// Exposed as window.deviceAudio. Listen via deviceAudio.addEventListener(
// 'change', e => e.detail.state). States:
//   idle            nothing here (audio on the Pi)
//   connecting      WS opening / worklet spinning up
//   prebuffering    hello accepted, filling the buffer (Pi still audible)
//   playing         committed — this device owns playback (handoff confirmed)
//   stopping        deliberate stop in flight
//   paused          unexpected drop AFTER handoff → backend paused the track
//   another-device  superseded (4002) — another device took over
//   busy            session_busy (4001) — awaiting take-over confirmation
//
// See docs/front-repo-play-on-device-notes.md for the locked protocol.

import { audioWsUrl, controlUrl } from './endpoints.js';
import { getThumbnailCandidates } from '/static/js/utils/thumbnails.js';
import { getDisplayArtist } from '/static/js/utils/trackMeta.js';

const WORKLET_URL  = '/static/js/playback/device-audio/pcm-player-worklet.js';
const PREBUFFER_MS = 200;

class DeviceAudioController extends EventTarget {
  constructor() {
    super();
    this._state = 'idle';
    this._reason = null;

    this._ctx = null;
    this._workletReady = false;
    this._node = null;
    this._ws = null;

    // Per-session handshake flags.
    this._handoffSupported = false;
    this._readySent = false;
    this._committed = false;     // handoff committed → Pi is muted, we own playback
    this._deliberate = false;    // we initiated the close (bye)
    this._format = 's16le';

    this._byeTimer = null;

    this._wireMediaSessionState();
  }

  get state() { return this._state; }

  // ── State plumbing ──────────────────────────────────────────────────────

  _setState(state, reason = null) {
    if (state === this._state && reason === this._reason) return;
    this._state = state;
    this._reason = reason;
    this.dispatchEvent(new CustomEvent('change', { detail: { state, reason } }));
  }

  _isActive() {
    return this._state === 'connecting'
        || this._state === 'prebuffering'
        || this._state === 'playing';
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * "Play on this device". MUST be called synchronously from a user gesture —
   * the AudioContext is created/resumed inside this call stack so iOS Safari
   * doesn't silently block playback. Everything after that is async.
   */
  playHere({ force = false } = {}) {
    if (this._isActive()) return;

    // 1. SYNCHRONOUS (gesture-critical): the AudioContext must be born here.
    try {
      this._ensureContextSync();
    } catch (e) {
      this._setState('idle', 'audio_unavailable');
      console.error('[deviceAudio] AudioContext unavailable:', e);
      return;
    }

    // 2. Async continuation.
    this._setState('connecting');
    this._start(force).catch((e) => {
      console.error('[deviceAudio] start failed:', e);
      this._teardownAudio();
      this._setState('idle', 'start_failed');
    });
  }

  /** Take over a busy session (after session_busy). */
  takeOver() {
    // Any prior socket is already closed by the server on 4001; just reconnect.
    this.playHere({ force: true });
  }

  /** Deliberate stop — keep audio playing on the Pi (no pause). */
  stopHere() {
    const ws = this._ws;
    if (!ws) { this._setState('idle'); return; }

    this._deliberate = true;
    this._setState('stopping');
    try { ws.send(JSON.stringify({ type: 'bye' })); } catch {}
    try { ws.close(1000); } catch {}

    // Safety net if the server never closes.
    clearTimeout(this._byeTimer);
    this._byeTimer = setTimeout(() => {
      if (this._ws === ws) this._onClose({ code: 1000 });
    }, 1500);
  }

  /** One-shot fetch of the core's routing state (for initial UI sync). */
  async getOutputStatus() {
    try {
      const r = await fetch(controlUrl('/output'));
      if (r.ok) return await r.json();
    } catch {}
    return null;
  }

  // ── AudioContext / graph ────────────────────────────────────────────────

  _ensureContextSync() {
    if (!this._ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      // Request 48000 to match the source; the worklet resamples if a browser
      // refuses and hands us a different rate. Some Safari versions throw on an
      // unsupported sampleRate — fall back to the default context in that case.
      try {
        this._ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
      } catch {
        this._ctx = new Ctx({ latencyHint: 'interactive' });
      }
    }
    // resume() must be invoked inside the gesture; the promise can settle later.
    if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
  }

  async _start(force) {
    if (!this._workletReady) {
      await this._ctx.audioWorklet.addModule(WORKLET_URL);
      this._workletReady = true;
    }
    this._buildGraph();
    this._openSocket(force);
  }

  _buildGraph() {
    this._node = new AudioWorkletNode(this._ctx, 'pcm-player', { outputChannelCount: [2] });
    this._node.port.onmessage = (e) => this._onWorkletMessage(e.data);
    this._node.port.postMessage({ type: 'config', prebufferMs: PREBUFFER_MS });
    this._node.connect(this._ctx.destination);
  }

  _onWorkletMessage(data) {
    if (!data || data.type !== 'playing') return; // ignore depth/underrun telemetry
    // Audio is now actually reaching the speakers.
    if (this._handoffSupported) {
      if (!this._readySent) {
        this._readySent = true;
        try { this._ws?.send(JSON.stringify({ type: 'ready' })); } catch {}
      }
    } else {
      // Older backend: no handshake — Pi muted on connect, we own it now.
      this._committed = true;
      this._updateMediaSession();
      this._setState('playing');
    }
  }

  // ── WebSocket / protocol ────────────────────────────────────────────────

  _openSocket(force) {
    this._handoffSupported = false;
    this._readySent = false;
    this._committed = false;
    this._deliberate = false;

    const ws = new WebSocket(audioWsUrl());
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: 'hello', force: !!force, format: 's16le' }));
      } catch {}
      this._setState('prebuffering');
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') { this._onTextFrame(ev.data); return; }
      const i16 = new Int16Array(ev.data); // byteLength / 4 = stereo frame count
      this._node?.port.postMessage(i16, [i16.buffer]);
    };

    ws.onerror = () => { /* a close event always follows; handled there */ };
    ws.onclose = (ev) => this._onClose(ev);
  }

  _onTextFrame(text) {
    let frame;
    try { frame = JSON.parse(text); } catch { return; }

    switch (frame.type) {
      case 'hello':
        this._handoffSupported = frame.handoff === 'ready';
        if (frame.format) this._format = frame.format;
        break;

      case 'handoff':
        if (frame.sink === 'client') {
          this._committed = true;
          this._updateMediaSession();
          this._setState('playing');
        }
        break;

      case 'error':
        if (frame.reason === 'session_busy') {
          this._setState('busy', 'session_busy');
        } else {
          this._setState('idle', frame.reason || 'error');
        }
        break;
    }
  }

  _onClose(ev) {
    clearTimeout(this._byeTimer);
    const code = ev?.code;
    const wasCommitted = this._committed;
    const wasDeliberate = this._deliberate;

    this._teardownAudio();

    if (wasDeliberate || code === 1000) {
      this._setState('idle');                    // playing on Pi, not paused
    } else if (code === 4001) {
      this._setState('busy', 'session_busy');    // offer take-over
    } else if (code === 4002) {
      this._setState('another-device');          // do NOT auto-reconnect
    } else if (wasCommitted) {
      this._setState('paused', 'unexpected_drop'); // backend paused the track
    } else {
      this._setState('idle', 'dropped_prebuffer'); // Pi was never muted
    }
  }

  _teardownAudio() {
    if (this._ws) {
      this._ws.onopen = this._ws.onmessage = this._ws.onerror = this._ws.onclose = null;
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    if (this._node) {
      try { this._node.port.onmessage = null; } catch {}
      try { this._node.disconnect(); } catch {}
      this._node = null;
    }
    // Keep the AudioContext (and loaded worklet module) around for a fast re-tap;
    // suspend it so an idle device isn't holding the audio hardware awake.
    if (this._ctx && this._ctx.state === 'running') this._ctx.suspend().catch(() => {});

    this._committed = false;
    this._readySent = false;
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none';
  }

  // ── Media Session (lock-screen controls + metadata) ─────────────────────

  _wireMediaSessionState() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const ch = () => window.rolfsoundChannel;
    try {
      ms.setActionHandler('play',          () => ch()?.send('intent.pause', {}));
      ms.setActionHandler('pause',         () => ch()?.send('intent.pause', {}));
      ms.setActionHandler('nexttrack',     () => ch()?.send('intent.skip', { direction: 'fwd' }));
      ms.setActionHandler('previoustrack', () => ch()?.send('intent.skip', { direction: 'back' }));
    } catch {}
    this._storeWired = false;
    this._ensureStoreListeners();
  }

  /**
   * Attach playbackStore listeners once it exists. The store singleton is
   * created by a script that loads AFTER this module, so constructor-time
   * wiring would miss it — we (re)try lazily, including on first commit.
   */
  _ensureStoreListeners() {
    if (this._storeWired) return;
    const store = window.playbackStore;
    if (!store) return;
    this._storeWired = true;

    const refresh = () => { if (this._committed) this._updateMediaSession(); };
    store.addEventListener('track-change', refresh);
    store.addEventListener('metadata-change', refresh);
    store.addEventListener('state-change', () => {
      if (this._committed && navigator.mediaSession) {
        navigator.mediaSession.playbackState =
          store.state?.playState === 'playing' ? 'playing' : 'paused';
      }
    });
  }

  _updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    this._ensureStoreListeners();
    const track = window.playbackStore?.state?.currentTrack;
    if (!track) return;

    const id = track.id || track.track_id;
    const artwork = getThumbnailCandidates({ thumbnail: track.thumbnail, id, track_id: id })
      .slice(0, 1)
      .map((src) => ({ src }));

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || 'Rolfsound',
        artist: getDisplayArtist(track) || '',
        artwork,
      });
      navigator.mediaSession.playbackState = 'playing';
    } catch {}
  }
}

const deviceAudio = new DeviceAudioController();
window.deviceAudio = deviceAudio;
export default deviceAudio;
