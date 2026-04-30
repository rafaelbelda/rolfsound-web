// static/js/features/player/AudioReactiveStore.js
// Small shared audio envelope derived from the backend audio_monitor stream.
// It normalizes tiny RMS/peak values into UI-friendly 0..1 controls and
// exposes them both through getEnvelope() and CSS vars on :root.

import channel from '/static/js/channel/RolfsoundChannel.js';

const STALE_AFTER_MS = 900;
const FRAME_MS = 16.67;
const PUBLISH_MIN_MS = 125;
const PUBLISH_EPSILON = 0.015;

class AudioReactiveStore {
  constructor() {
    this._target = {
      level: 0,
      peak: 0,
      rawLevel: 0,
      rawPeak: 0,
    };

    this._state = {
      level: 0,
      peak: 0,
      energy: 0,
      punch: 0,
      rawLevel: 0,
      rawPeak: 0,
      stale: true,
    };

    this._lastInputTs = 0;
    this._lastSampleTs = 0;
    this._lastComputedAt = 0;
    this._lastPublishAt = 0;
    this._publishedState = {
      level: -1,
      peak: -1,
      energy: -1,
      punch: -1,
    };
    this._unsubs = [
      channel.on('telemetry.audio', (data) => this._handleAudio(data)),
      channel.on('audio_monitor', (data) => this._handleAudio(data)),
    ];
    this._publish(true);
  }

  getEnvelope(now = performance.now()) {
    if (this._lastComputedAt && Math.abs(now - this._lastComputedAt) < 8) {
      return this._state;
    }

    if (!this._lastSampleTs) this._lastSampleTs = now;

    const dt = Math.max(0.25, Math.min(4, (now - this._lastSampleTs) / FRAME_MS));
    this._lastSampleTs = now;

    const stale = !this._lastInputTs || (now - this._lastInputTs) > STALE_AFTER_MS;
    const targetLevel = stale ? 0 : this._target.level;
    const targetPeak = stale ? 0 : this._target.peak;

    this._state.level = AudioReactiveStore._follow(this._state.level, targetLevel, 0.52, 0.13, dt);
    this._state.peak = AudioReactiveStore._follow(this._state.peak, targetPeak, 0.76, 0.18, dt);

    const targetEnergy = Math.max(this._state.level * 0.72, this._state.peak * 0.54);
    this._state.energy = AudioReactiveStore._follow(this._state.energy, targetEnergy, 0.46, 0.10, dt);

    const targetPunch = Math.max(0, this._state.peak - this._state.level * 0.72);
    this._state.punch = AudioReactiveStore._follow(this._state.punch, targetPunch, 0.82, 0.22, dt);

    this._state.rawLevel = stale ? 0 : this._target.rawLevel;
    this._state.rawPeak = stale ? 0 : this._target.rawPeak;
    this._state.stale = stale && this._state.energy < 0.01 && this._state.peak < 0.01;

    this._publish(false, now);
    this._lastComputedAt = now;
    return this._state;
  }

  reset() {
    this._target.level = 0;
    this._target.peak = 0;
    this._target.rawLevel = 0;
    this._target.rawPeak = 0;
    this._state.level = 0;
    this._state.peak = 0;
    this._state.energy = 0;
    this._state.punch = 0;
    this._state.rawLevel = 0;
    this._state.rawPeak = 0;
    this._state.stale = true;
    this._lastComputedAt = 0;
    this._publish(true);
  }

  destroy() {
    this._unsubs.forEach((unsub) => unsub?.());
    this._unsubs = [];
    this.reset();
  }

  _handleAudio(data = {}) {
    const rawLevel = AudioReactiveStore._num(data.level ?? data.rms ?? data.rms_level ?? 0);
    const rawPeak = AudioReactiveStore._num(data.peak ?? rawLevel);

    this._target.rawLevel = rawLevel;
    this._target.rawPeak = rawPeak;
    this._target.level = AudioReactiveStore._compress(rawLevel, 8.6);
    this._target.peak = AudioReactiveStore._compress(rawPeak, 8.2);
    this._lastInputTs = performance.now();
  }

  _publish(force = false, now = performance.now()) {
    if (!force && now - this._lastPublishAt < PUBLISH_MIN_MS) return;

    const next = {
      level: this._state.level,
      peak: this._state.peak,
      energy: this._state.energy,
      punch: this._state.punch,
    };
    const changed = force || Object.keys(next).some((key) => {
      return Math.abs(next[key] - this._publishedState[key]) >= PUBLISH_EPSILON;
    });
    if (!changed) return;

    const root = document.documentElement;
    root.style.setProperty('--rs-audio-level', next.level.toFixed(3));
    root.style.setProperty('--rs-audio-peak', next.peak.toFixed(3));
    root.style.setProperty('--rs-audio-energy', next.energy.toFixed(3));
    root.style.setProperty('--rs-audio-punch', next.punch.toFixed(3));
    this._publishedState = next;
    this._lastPublishAt = now;
  }

  static _num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  }

  static _compress(value, gain) {
    if (value <= 0) return 0;
    return Math.max(0, Math.min(1, Math.sqrt(value) * gain));
  }

  static _follow(current, target, attack, release, dt) {
    const rate = target > current ? attack : release;
    const scaled = 1 - Math.pow(1 - rate, dt);
    return current + (target - current) * scaled;
  }
}

const audioReactiveStore = new AudioReactiveStore();
window.audioReactiveStore = audioReactiveStore;

export { AudioReactiveStore };
export default audioReactiveStore;
