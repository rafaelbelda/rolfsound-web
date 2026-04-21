# api/ws/state_broadcaster.py
"""
Bridges a Core event source (EventPoller OR EventStreamClient) → WS clients.

Both event sources dispatch sync handlers off the uvicorn loop (poller runs
in its own daemon thread; the SSE client uses run_in_executor). That means
`_on_core_event` always runs outside the loop, so we bridge back via
asyncio.run_coroutine_threadsafe().

We also subscribe to `state_refresh` — a synthetic event emitted when a
backlog gap or SSE resync is detected — to force a fresh /status snapshot.
"""

import asyncio
import logging
import time

from utils import core_client

logger = logging.getLogger(__name__)

_manager = None
_loop: asyncio.AbstractEventLoop | None = None
_refresh_task: asyncio.Task | None = None

# Periodic refresh interval — safety net for position updates when core
# doesn't emit playback_tick events (or EventPoller batches them).
_REFRESH_INTERVAL_S = 2.0

_CORE_TO_WS = {
    "track_changed":  "event.track_changed",
    "track_finished": "event.track_finished",
    "audio_monitor":  "audio_monitor",
    "playback_state_changed": "state.playback",
}

# Events that carry their own payload and must NOT trigger a full /status fetch.
_SELF_CONTAINED = frozenset({"playback_tick", "remix_changed", "audio_monitor", "playback_state_changed"})


def init(manager, loop: asyncio.AbstractEventLoop, source) -> None:
    global _manager, _loop, _refresh_task
    _manager = manager
    _loop = loop
    source.on("*", _on_core_event)
    source.on("state_refresh", _on_state_refresh)
    _refresh_task = _loop.create_task(_periodic_refresh(), name="state-refresh")
    logger.info("StateBroadcaster initialised")


def _on_state_refresh(_data: dict) -> None:
    """Core lost our position (ID gap or SSE resync) — resync state."""
    if _loop is None or _manager is None:
        return
    asyncio.run_coroutine_threadsafe(_broadcast_snapshot(), _loop)


def _on_core_event(event: dict) -> None:
    """Called from EventPoller thread — must not touch the event loop directly."""
    if _loop is None or _manager is None:
        return
    asyncio.run_coroutine_threadsafe(_handle_event(event), _loop)


async def _handle_event(event: dict) -> None:
    event_type = event.get("type", "")
    data       = event.get("data", {})

    # 1. Tratamento Especial: Monitor de Áudio (Caminho mais rápido)
    if event_type == "audio_monitor":
        await _manager.broadcast({
            "type": "audio_monitor",
            "payload": data,
            "ts": int(time.time() * 1000),
        })
        return 

    # 2. Tratamento Especial: Mudança de Estado (Cura o Bumerangue)
    if event_type == "playback_state_changed":
        await _manager.broadcast({
            "type": "state.playback",
            "payload": data,
            "ts": int(time.time() * 1000),
        })
        return # <--- ESSENCIAL: impede que o código abaixo peça um snapshot via HTTP!

    # 3. Outros eventos autossuficientes
    if event_type == "playback_tick":
        await _handle_tick(data)
        return

    if event_type == "remix_changed":
        await _handle_remix(data)
        return

    # 4. Fallback: Mapeamento genérico para eventos que sobraram
    ws_type = _CORE_TO_WS.get(event_type)
    if ws_type:
        await _manager.broadcast({
            "type":    ws_type,
            "payload": data,
            "ts":      int(time.time() * 1000),
        })

    # 5. Só faz snapshot se o evento for desconhecido
    if event_type not in _SELF_CONTAINED:
        await _broadcast_snapshot()


async def _handle_remix(data: dict) -> None:
    """Forward core remix_changed as state.remix. reset_on_track_change isn't in
    the event payload, so refetch it lazily from the latest /status snapshot the
    periodic refresh puts on the wire — clients treat missing fields as unchanged."""
    await _manager.broadcast({
        "type":    "state.remix",
        "payload": {
            "pitch_semitones": data.get("pitch_semitones", 0.0),
            "tempo_ratio":     data.get("tempo_ratio",     1.0),
        },
        "ts": int(time.time() * 1000),
    })


async def _handle_tick(data: dict) -> None:
    """Forward tick as event.progress — seek-bar re-anchors dead-reckoning from this."""
    await _manager.broadcast({
        "type": "event.progress",
        "payload": {
            "position":           data.get("position", 0),
            "duration":           data.get("duration", 0),
            # position_updated_at in Unix ms (what seek-bar._anchorMs expects).
            # Use server_ts from core if available; fall back to receipt time.
            "position_updated_at": data.get("server_ts") or int(time.time() * 1000),
        },
        "ts": int(time.time() * 1000),
    })


async def _periodic_refresh() -> None:
    """Periodically broadcast state.playback while WS clients are connected.

    This is the safety net that keeps the seek bar in sync even when the core
    doesn't emit playback_tick events — the EventPoller polls /events every 2s
    but may miss position changes between event log entries.
    """
    while True:
        try:
            await asyncio.sleep(_REFRESH_INTERVAL_S)
            if _manager is None or _manager.client_count == 0:
                continue
            await _broadcast_snapshot()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.debug(f"Periodic refresh error: {e}")


async def _broadcast_snapshot() -> None:
    from api.status_enricher import enrich_status
    raw = await core_client.get_status()
    if raw is None:
        return
    now_ms = int(time.time() * 1000)
    await _manager.broadcast({
        "type":    "state.playback",
        "payload": enrich_status(raw),
        "ts":      now_ms,
    })
    remix = raw.get("remix") or {}
    if remix:
        await _manager.broadcast({
            "type":    "state.remix",
            "payload": {
                "pitch_semitones":       remix.get("pitch_semitones", 0.0),
                "tempo_ratio":           remix.get("tempo_ratio",     1.0),
                "reset_on_track_change": remix.get("reset_on_track_change", True),
            },
            "ts": now_ms,
        })


async def send_initial_snapshot(ws_queue: asyncio.Queue) -> None:
    """Push a fresh state.playback + state.remix snapshot into a freshly connected client queue."""
    from api.status_enricher import enrich_status
    raw = await core_client.get_status()
    if raw is None:
        return
    now_ms = int(time.time() * 1000)
    try:
        ws_queue.put_nowait({
            "type":    "state.playback",
            "payload": enrich_status(raw),
            "ts":      now_ms,
        })
    except asyncio.QueueFull:
        pass
    remix = raw.get("remix") or {}
    if remix:
        try:
            ws_queue.put_nowait({
                "type":    "state.remix",
                "payload": {
                    "pitch_semitones":       remix.get("pitch_semitones", 0.0),
                    "tempo_ratio":           remix.get("tempo_ratio",     1.0),
                    "reset_on_track_change": remix.get("reset_on_track_change", True),
                },
                "ts": now_ms,
            })
        except asyncio.QueueFull:
            pass
