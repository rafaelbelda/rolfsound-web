// static/js/channel/RolfsoundChannel.js
//
// Transport abstraction between UI components and the control backend.
//
// Phase 0 (current): subscription hub + intent → REST translator.
//   - Components call .on('state.playback', fn) to receive snapshots.
//   - playback-mitosis.js calls .publish('state.playback', status) after every
//     successful /api/status poll, fanning out to every subscriber.
//   - Components call .send('intent.seek', {position}) — channel maps it to
//     the existing REST endpoint (POST /api/seek).
//
// Phase 1 (planned): swap transport to WebSocket at /api/ws; .publish becomes
// private (fed by the WS reader); polling becomes fallback only.
//
// The public API surface (.on / .send) is frozen for Phase 0+ — components
// written against this interface will NOT need changes when WS lands.

const INTENT_ROUTES = Object.freeze({
  'intent.play':         { method: 'POST', path: '/api/play' },
  'intent.pause':        { method: 'POST', path: '/api/pause' },
  'intent.seek':         { method: 'POST', path: '/api/seek' },
  'intent.shuffle.set':  { method: 'POST', path: '/api/queue/shuffle' },
  'intent.repeat.set':   { method: 'POST', path: '/api/queue/repeat' },
  'intent.queue.add':    { method: 'POST', path: '/api/queue/add' },
  'intent.queue.remove': { method: 'POST', path: '/api/queue/remove' },
  'intent.queue.move':   { method: 'POST', path: '/api/queue/move' },
  'intent.queue.clear':  { method: 'POST', path: '/api/queue/clear' },
});

class RolfsoundChannel {
  constructor() {
    this._subs = new Map();
  }

  on(type, fn) {
    if (typeof type !== 'string' || typeof fn !== 'function') {
      throw new TypeError('RolfsoundChannel.on(type, fn) requires a string and a function');
    }
    let set = this._subs.get(type);
    if (!set) {
      set = new Set();
      this._subs.set(type, set);
    }
    set.add(fn);
    return () => {
      const s = this._subs.get(type);
      if (s) {
        s.delete(fn);
        if (s.size === 0) this._subs.delete(type);
      }
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
    // Intent.skip is split between two REST endpoints depending on direction.
    if (type === 'intent.skip') {
      const dir = payload?.direction ?? 'fwd';
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
        opts.body = JSON.stringify(body);
      }
      const r = await fetch(path, opts);
      const ok = r.ok;
      let data = null;
      try { data = await r.json(); } catch (_) {}
      return { ok, status: r.status, data };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
}

const channel = new RolfsoundChannel();
window.rolfsoundChannel = channel;
export default channel;
