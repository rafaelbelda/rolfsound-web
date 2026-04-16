// static/js/channel/ChannelReconnector.js
//
// Exponential backoff timer for WebSocket reconnection. Phase 0 stub; Phase 1
// wires it into RolfsoundChannel's WS transport on 'close' events.
//
// Schedule: 250ms → 500ms → 1s → 2s → 4s → 8s cap.

const BACKOFF_MS = Object.freeze([250, 500, 1000, 2000, 4000, 8000]);

export default class ChannelReconnector {
  constructor(schedule = BACKOFF_MS) {
    this._schedule = schedule;
    this._attempt = 0;
    this._timerId = null;
  }

  get nextDelay() {
    return this._schedule[Math.min(this._attempt, this._schedule.length - 1)];
  }

  schedule(onTick) {
    if (typeof onTick !== 'function') {
      throw new TypeError('ChannelReconnector.schedule expects a function');
    }
    this.cancel();
    const delay = this.nextDelay;
    this._attempt += 1;
    this._timerId = setTimeout(() => {
      this._timerId = null;
      onTick();
    }, delay);
    return delay;
  }

  cancel() {
    if (this._timerId !== null) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
  }

  reset() {
    this.cancel();
    this._attempt = 0;
  }
}

export { BACKOFF_MS };
