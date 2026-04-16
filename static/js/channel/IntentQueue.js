// static/js/channel/IntentQueue.js
//
// Offline buffer for client → server intents. Phase 0 stub; Phase 1 fills in
// flush-on-reconnect behavior via RolfsoundChannel's WS transport.
//
// Cap is 16 — enough for bursts of user input during a brief reconnect window
// without consuming non-trivial RAM on the Raspberry Pi client.

const DEFAULT_CAPACITY = 16;

export default class IntentQueue {
  constructor(capacity = DEFAULT_CAPACITY) {
    this._capacity = capacity;
    this._items = [];
  }

  get size() { return this._items.length; }
  get isEmpty() { return this._items.length === 0; }

  push(intent) {
    if (this._items.length >= this._capacity) {
      this._items.shift();
    }
    this._items.push(intent);
  }

  async flush(sender) {
    if (typeof sender !== 'function') {
      throw new TypeError('IntentQueue.flush expects a sender function');
    }
    const pending = this._items.slice();
    this._items.length = 0;
    for (const intent of pending) {
      try { await sender(intent); }
      catch (e) { console.error('[IntentQueue] flush error:', e); }
    }
  }

  clear() { this._items.length = 0; }
}
