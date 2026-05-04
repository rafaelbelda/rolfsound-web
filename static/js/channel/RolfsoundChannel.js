// static/js/channel/RolfsoundChannel.js
import ChannelReconnector from './ChannelReconnector.js';
import IntentQueue from './IntentQueue.js';

/**
 * Utilitário de Throttle para limitar a execução de funções de alta frequência.
 * Essencial para sliders (volume, seek) na interface Apple-style.
 */
const throttle = (func, limit) => {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    }
};

const INTENT_ROUTES = Object.freeze({
    'intent.play': { method: 'POST', path: '/api/play' },
    'intent.pause': { method: 'POST', path: '/api/pause' },
    'intent.seek': { method: 'POST', path: '/api/seek' },
    'intent.volume.set': { method: 'POST', path: '/api/volume' },
    'intent.remix.set': { method: 'POST', path: '/api/remix' },
    'intent.remix.reset': { method: 'POST', path: '/api/remix/reset' },
    // ... manter as outras rotas apenas como fallback REST
});

const WS_URL = '/api/ws';
const HEARTBEAT_MS = 20000;
const PONG_TIMEOUT = 10000;
const COALESCED_TYPES = new Set([
    'audio_monitor',
    'telemetry.audio',
    'event.progress',
    'state.playback',
    'state.remix',
]);

class RolfsoundChannel {
    constructor() {
        this._subs = new Map();
        this._ws = null;
        this._reconnector = new ChannelReconnector();
        this._intentQueue = new IntentQueue(16);
        this._heartbeatId = null;
        this._pongTimerId = null;
        this._transport = 'ws';
        this._pollId = null;
        this._pollInterval = 5000; // Aumentado para 5s (fallback lento é melhor que zumbi rápido)
        this._pendingFrames = new Map();
        this._dispatchRafId = null;

        // Versão otimizada para componentes de UI (Sliders)
        // Limita a 50 envios por segundo (20ms), garantindo fluidez sem flood no socket.
        this.sendThrottled = throttle((type, payload) => this.send(type, payload), 20);

        this._init();
    }

    async _init() {
        // 1. Carregamento instantâneo da UI (Single Fetch)
        await this._fetchInitialStatus();
        
        // 2. Ligar a Via Expressa
        this._selectTransport();
    }

    // ── API Pública ────────────────────────────────────────────────────────

    on(type, fn) {
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
        if (!set) return;
        for (const fn of set) {
            try { fn(payload); }
            catch (e) { console.error(`[RolfsoundChannel] error on "${type}":`, e); }
        }
    }

    async send(type, payload) {
        if (this._transport === 'ws' && this._ws?.readyState === WebSocket.OPEN) {
            return this._sendWs(type, payload);
        }
        
        // Se o WS estiver offline, tentamos via REST (Fallback)
        return this._sendRest(type, payload);
    }

    // ── Lógica de Transporte ───────────────────────────────────────────────

    async _fetchInitialStatus() {
        try {
            const r = await fetch('/api/status');
            if (r.ok) this._publishStatusSnapshot(await r.json());
        } catch (e) { console.warn('[RolfsoundChannel] Initial fetch failed'); }
    }

    _selectTransport() {
        const forced = localStorage.getItem('rolfsound.transport');
        if (forced === 'polling') {
            this._fallbackToPolling();
            return;
        }
        this._connectWs();
    }

    _connectWs() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${proto}://${location.host}${WS_URL}`;

        try {
            this._ws = new WebSocket(url);
        } catch (e) {
            this._fallbackToPolling();
            return;
        }

        this._ws.addEventListener('open', () => {
            console.info('[RolfsoundChannel] Via Expressa ligada');
            this._reconnector.reset();
            this._stopPolling(); // Mata o zumbi se o WS ligar
            this._startHeartbeat();
            this._intentQueue.flush(({ type, payload }) => this._sendWs(type, payload));
        });

        this._ws.addEventListener('message', (ev) => {
            let frame;
            try { frame = JSON.parse(ev.data); } catch { return; }
            this._handleIncomingFrame(frame);
        });

        this._ws.addEventListener('close', () => {
            this._stopHeartbeat();
            if (this._transport !== 'ws') return;
            this._reconnector.schedule(() => this._connectWs());
        });
    }

    _handleIncomingFrame(frame) {
        const { type, payload } = frame || {};
        if (!type) return;

        if (type === 'event.pong' || type === 'ack.ping') this._clearPongTimer();

        if (this._shouldCoalesce(type, payload)) {
            this._queueCoalesced(type, payload);
            return;
        }

        this.publish(type, payload);
    }

    _shouldCoalesce(type, payload = {}) {
        if (type === 'event.download_progress') {
            const status = String(payload?.status || '').toLowerCase();
            return status !== 'complete' && status !== 'failed' && status !== 'error';
        }
        return COALESCED_TYPES.has(type);
    }

    _queueCoalesced(type, payload) {
        this._pendingFrames.set(type, payload);
        if (this._dispatchRafId) return;

        this._dispatchRafId = requestAnimationFrame(() => {
            this._dispatchRafId = null;
            const frames = Array.from(this._pendingFrames.entries());
            this._pendingFrames.clear();
            for (const [frameType, framePayload] of frames) {
                this.publish(frameType, framePayload);
            }
        });
    }

    _sendWs(type, payload) {
        const frame = {
            type,
            payload: payload ?? {},
            id: crypto.randomUUID?.() ?? String(Date.now()),
            ts: Date.now(),
        };
        try {
            this._ws.send(JSON.stringify(frame));
            return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
    }

    // ── Heartbeat (Manutenção de Vida) ────────────────────────────────────

    _startHeartbeat() {
        this._stopHeartbeat();
        this._heartbeatId = setInterval(() => {
            if (this._ws?.readyState !== WebSocket.OPEN) return;
            this._sendWs('intent.ping', {});
            this._pongTimerId = setTimeout(() => {
                console.warn('[RolfsoundChannel] Servidor não respondeu. Reiniciando WS...');
                this._ws?.close();
            }, PONG_TIMEOUT);
        }, HEARTBEAT_MS);
    }

    _stopHeartbeat() {
        clearInterval(this._heartbeatId);
        this._clearPongTimer();
    }

    _clearPongTimer() {
        clearTimeout(this._pongTimerId);
        this._pongTimerId = null;
    }

    // ── Fallback (Código de Emergência) ───────────────────────────────────

    _fallbackToPolling() {
        this._transport = 'polling';
        this._startPolling();
    }

    _startPolling() {
        if (this._pollId) return;
        this._poll();
        this._pollId = setInterval(() => this._poll(), this._pollInterval);
        console.warn('[RolfsoundChannel] Polling de emergência ativado');
    }

    _stopPolling() {
        if (this._pollId) {
            clearInterval(this._pollId);
            this._pollId = null;
            this._transport = 'ws';
        }
    }

    async _poll() {
        if (document.hidden) return;
        try {
            const r = await fetch('/api/status');
            if (r.ok) this._publishStatusSnapshot(await r.json());
        } catch {}
    }

    _publishStatusSnapshot(status) {
        this.publish('state.playback', status);
        const remix = status?.remix;
        if (!remix) return;
        this.publish('state.remix', {
            pitch_semitones: Number(remix.pitch_semitones ?? 0),
            tempo_ratio: Number(remix.tempo_ratio ?? 1),
            reset_on_track_change: Boolean(remix.reset_on_track_change ?? true),
        });
    }

    async _sendRest(type, payload) {
        const route = INTENT_ROUTES[type];
        if (!route) return { ok: false, error: 'no_rest_route' };
        
        try {
            const r = await fetch(route.path, {
                method: route.method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload ?? {})
            });
            return { ok: r.ok };
        } catch (e) { return { ok: false, error: e.message }; }
    }
}

const channel = new RolfsoundChannel();
window.rolfsoundChannel = channel;
export default channel;
