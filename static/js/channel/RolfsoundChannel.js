// static/js/channel/RolfsoundChannel.js
//
// Transport abstraction for UI components.
//
// Transport selection:
//   1. WebSocket at /api/ws (preferred).
//   2. Polling /api/status every 1.5s (automatic fallback if WS unavailable,
//      or forced via localStorage.setItem('rolfsound.transport','polling')).
//
// Public API (frozen across all phases):
//   .on(type, fn)       → subscribe; returns unsubscribe function
//   .send(type, payload) → send an intent; returns { ok, ... }
//   .publish(type, data) → internal fan-out (used by polling path)
//
// Components written against this API need no changes when WS is live.

import ChannelReconnector from './ChannelReconnector.js';
import IntentQueue        from './IntentQueue.js';

const INTENT_ROUTES = Object.freeze({
  'intent.play':         { method: 'POST', path: '/api/play' },
  'intent.pause':        { method: 'POST', path: '/api/pause' },
  'intent.seek':         { method: 'POST', path: '/api/seek' },
  'intent.shuffle.set':  { method: 'POST', path: '/api/queue/shuffle' },
  'intent.repeat.set':   { method: 'POST', path: '/api/queue/repeat' },
  'intent.volume.set':   { method: 'POST', path: '/api/volume' },
  'intent.queue.add':    { method: 'POST', path: '/api/queue/add' },
  'intent.queue.remove': { method: 'POST', path: '/api/queue/remove' },
  'intent.queue.move':   { method: 'POST', path: '/api/queue/move' },
  'intent.queue.clear':  { method: 'POST', path: '/api/queue/clear' },
});

const WS_URL        = '/api/ws';
const HEARTBEAT_MS  = 20_000;
const PONG_TIMEOUT  = 10_000;

class RolfsoundChannel {
  constructor() {
    this._subs       = new Map();
    this._ws         = null;
    this._reconnector = new ChannelReconnector();
    this._intentQueue = new IntentQueue(16);
    this._heartbeatId = null;
    this._pongTimerId = null;
    this._transport  = 'ws';  // 'ws' | 'polling'
    this._pollId     = null;
    this._pollInterval = 1500;

    this._selectTransport();
  }

  // ── Public API ────────────────────────────────────────────────────────

  on(type, fn) {
    if (typeof type !== 'string' || typeof fn !== 'function') {
      throw new TypeError('RolfsoundChannel.on(type, fn) requires a string and a function');
    }
    let set = this._subs.get(type);
    if (!set) { set = new Set(); this._subs.set(type, set); }
    set.add(fn);
    return () => {
      const s = this._subs.get(type);
      if (s) { s.delete(fn); if (s.size === 0) this._subs.delete(type); }
    };
  }

  publish(type, payload) {
    const set = this._subs.get(type);
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try { fn(payload); }
      catch (e) { console.error(`[RolfsoundChannel] subscriber error on "${type}":`, e); }
    }
  }

  async send(type, payload) {
    if (this._transport === 'ws' && this._ws?.readyState === WebSocket.OPEN) {
      return this._sendWs(type, payload);
    }
    // WS offline — buffer intent and fall through to REST
    if (this._transport === 'ws') {
      this._intentQueue.push({ type, payload });
    }
    return this._sendRest(type, payload);
  }

  // ── Transport selection ───────────────────────────────────────────────

  _selectTransport() {
    const forced = localStorage.getItem('rolfsound.transport');
    if (forced === 'polling') {
      this._transport = 'polling';
      this._startPolling();
      return;
    }
    this._transport = 'ws';
    this._connectWs();
  }

  // ── WebSocket ─────────────────────────────────────────────────────────

  _connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url   = `${proto}://${location.host}${WS_URL}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.warn('[RolfsoundChannel] WS constructor failed — falling back to polling', e);
      this._fallbackToPolling();
      return;
    }

    this._ws = ws;

    ws.addEventListener('open', () => {
      this._reconnector.reset();
      this._startHeartbeat();
      this._intentQueue.flush(({ type, payload }) => this._sendWs(type, payload));
    });

    ws.addEventListener('message', (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      const { type, payload } = frame;
      if (type) this.publish(type, payload);
      if (type === 'ack.ping') this._clearPongTimer();
    });

    ws.addEventListener('close', () => {
      this._stopHeartbeat();
      if (this._transport !== 'ws') return;
      const delay = this._reconnector.schedule(() => this._connectWs());
      console.debug(`[RolfsoundChannel] WS closed — reconnecting in ${delay}ms`);
    });

    ws.addEventListener('error', () => {
      // 'close' fires right after 'error', so reconnect logic lives there.
    });
  }

  _sendWs(type, payload) {
    const frame = {
      type,
      payload: payload ?? {},
      id:      crypto.randomUUID?.() ?? String(Date.now()),
      ts:      Date.now(),
    };
    try {
      this._ws.send(JSON.stringify(frame));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatId = setInterval(() => {
      if (this._ws?.readyState !== WebSocket.OPEN) return;
      this._sendWs('intent.ping', {});
      this._pongTimerId = setTimeout(() => {
        console.warn('[RolfsoundChannel] pong timeout — dropping WS');
        this._ws?.close();
      }, PONG_TIMEOUT);
    }, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    clearInterval(this._heartbeatId);
    this._heartbeatId = null;
    this._clearPongTimer();
  }

  _clearPongTimer() {
    clearTimeout(this._pongTimerId);
    this._pongTimerId = null;
  }

  _fallbackToPolling() {
    this._transport = 'polling';
    this._startPolling();
  }

  // ── Polling fallback ──────────────────────────────────────────────────

  _startPolling() {
    if (this._pollId) return;
    this._poll();
    this._pollId = setInterval(() => this._poll(), this._pollInterval);
  }

  async _poll() {
    if (document.hidden) return;
    try {
      const r = await fetch('/api/status');
      if (!r.ok) return;
      const status = await r.json();
      this.publish('state.playback', status);
    } catch { /* network error — silent */ }
  }

  // ── REST fallback for intents ─────────────────────────────────────────

  async _sendRest(type, payload) {
    if (type === 'intent.skip') {
      const dir  = payload?.direction ?? 'fwd';
      const path = dir === 'back' ? '/api/queue/previous' : '/api/skip';
      return this._fetch('POST', path, {});
    }
    const route = INTENT_ROUTES[type];
    if (!route) {
      console.warn(`[RolfsoundChannel] unknown intent "${type}" — ignoring`);
      return { ok: false, error: 'unknown_intent' };
    }
    return this._fetch(route.method, route.path, payload);
  }

  async _fetch(method, path, body) {
    try {
      const opts = { method };
      if (body !== undefined && body !== null) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body    = JSON.stringify(body);
      }
      const r  = await fetch(path, opts);
      let data = null;
      try { data = await r.json(); } catch (_) {}
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
}

const channel = new RolfsoundChannel();
window.rolfsoundChannel = channel;
export default channel;
