// static/js/playback/device-audio/endpoints.js
//
// Single source of truth for the "Play on this device" transport endpoints.
//
// The browser never talks to the core's host:port (8765/8768) directly. The
// Caddy edge reverse-proxies two same-origin paths to the core over Tailscale:
//
//   /audio-ws       → core :8768   (raw-PCM audio WebSocket)
//   /control-api/*  → core :8765   (control / status HTTP, prefix stripped)
//
// Connecting same-origin keeps us clear of mixed-content (the dashboard is
// served over HTTPS) and means no Python proxy is needed in rolfsound-web. If
// these paths ever move, this is the only file that changes.

export const AUDIO_WS_PATH   = '/audio-ws';
export const CONTROL_API_BASE = '/control-api';

/** Absolute ws(s):// URL for the audio stream, derived from the current origin. */
export function audioWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${AUDIO_WS_PATH}`;
}

/** Build a control-API URL, e.g. controlUrl('/output') → '/control-api/output'. */
export function controlUrl(path = '') {
  return `${CONTROL_API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}
