// static/js/playback/device-audio/pcm-player-worklet.js
//
// AudioWorkletProcessor for "Play on this device".
//
// Receives raw int16-LE interleaved-stereo PCM (48000 Hz) from the main thread
// as Int16Array transferables, converts to Float32 (sample / 32768), buffers it
// in a stereo ring (jitter buffer), and plays it out of the AudioContext.
//
// Two things the main thread relies on:
//   - It does NOT start playing until the buffer reaches the pre-buffer depth.
//     The first time it actually outputs audio it posts {type:'playing'} — that
//     is the precise "samples reached the speakers" cue the gapless-handoff
//     `ready` message must be tied to (NOT socket-open).
//   - If the AudioContext sample rate isn't 48000, it linear-resamples on read,
//     so a browser that refuses a 48000 context doesn't play back at the wrong
//     pitch. (ratio === 1 → pass-through.)

const SOURCE_RATE = 48000;
const RING_CAPACITY_FRAMES = SOURCE_RATE * 4; // ~4 s of headroom

class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._cap = RING_CAPACITY_FRAMES;
    this._l = new Float32Array(this._cap);
    this._r = new Float32Array(this._cap);

    this._writeFrames = 0; // total source frames written (monotonic)
    this._readPos = 0;     // float: total source frames consumed (fractional for resampling)

    this._started = false;
    this._prebufferFrames = Math.round(SOURCE_RATE * 0.2); // 200 ms default
    this._ratio = SOURCE_RATE / sampleRate;                // source frames per output sample
    this._underrun = false;
    this._depthCounter = 0;

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(data) {
    if (data instanceof Int16Array) { this._write(data); return; }
    if (!data || typeof data !== 'object') return;

    if (data.type === 'config' && typeof data.prebufferMs === 'number') {
      this._prebufferFrames = Math.max(1, Math.round(SOURCE_RATE * data.prebufferMs / 1000));
    } else if (data.type === 'flush') {
      this._writeFrames = 0;
      this._readPos = 0;
      this._started = false;
      this._underrun = false;
    }
  }

  _write(int16) {
    const frames = int16.length >> 1; // 2 channels
    if (frames <= 0) return;

    // Overflow guard: if this write would overrun the ring, drop the oldest
    // audio by fast-forwarding the read cursor (bounds latency after a hiccup).
    const buffered = this._writeFrames - this._readPos;
    if (buffered + frames > this._cap) {
      this._readPos = this._writeFrames + frames - this._cap;
    }

    let w = this._writeFrames % this._cap;
    for (let i = 0; i < frames; i++) {
      this._l[w] = int16[2 * i]     / 32768;
      this._r[w] = int16[2 * i + 1] / 32768;
      if (++w === this._cap) w = 0;
    }
    this._writeFrames += frames;
  }

  process(_inputs, outputs) {
    const out  = outputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];
    const n = outL.length;

    // Pre-buffer gate: stay silent until we've accumulated enough depth, then
    // announce that real playback has begun (drives the handoff `ready`).
    if (!this._started) {
      if (this._writeFrames - this._readPos < this._prebufferFrames) {
        outL.fill(0);
        if (outR !== outL) outR.fill(0);
        return true;
      }
      this._started = true;
      this.port.postMessage({ type: 'playing' });
    }

    const ratio = this._ratio;
    for (let i = 0; i < n; i++) {
      if (this._writeFrames - this._readPos < 1.01) {
        // Underrun — emit silence rather than glitching, and flag it once.
        outL[i] = 0;
        if (outR !== outL) outR[i] = 0;
        if (!this._underrun) { this._underrun = true; this.port.postMessage({ type: 'underrun' }); }
        continue;
      }
      this._underrun = false;

      const pos  = this._readPos;
      const i0   = Math.floor(pos);
      const frac = pos - i0;
      const p0   = i0 % this._cap;
      const p1   = (i0 + 1) % this._cap;

      outL[i] = this._l[p0] + (this._l[p1] - this._l[p0]) * frac;
      if (outR !== outL) outR[i] = this._r[p0] + (this._r[p1] - this._r[p0]) * frac;

      this._readPos += ratio;
    }

    // Report buffer depth roughly twice a second (telemetry / health).
    if ((this._depthCounter += n) >= sampleRate / 2) {
      this._depthCounter = 0;
      const depthMs = ((this._writeFrames - this._readPos) / SOURCE_RATE) * 1000;
      this.port.postMessage({ type: 'depth', ms: depthMs });
    }
    return true;
  }
}

registerProcessor('pcm-player', PCMPlayerProcessor);
