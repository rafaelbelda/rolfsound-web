# api/ws/state_broadcaster.py
"""
Bridge core events to WebSocket clients.

Network frames are sync points, not the visual clock. High-rate telemetry is
coalesced to the latest sample before it reaches the WS fan-out layer.
"""

from __future__ import annotations

import asyncio
import logging
import time

from api.ws.connection_manager import enqueue_prepared, make_queue_item
from utils.core import core

logger = logging.getLogger(__name__)

_manager = None
_loop: asyncio.AbstractEventLoop | None = None
_refresh_task: asyncio.Task | None = None
_audio_flush_task: asyncio.Task | None = None
_progress_flush_task: asyncio.Task | None = None
_snapshot_flush_task: asyncio.Task | None = None

_pending_audio: dict | None = None
_pending_progress: dict | None = None
_last_audio_emit_at = 0.0
_last_progress_emit_at = 0.0
_last_snapshot_emit_at = 0.0

_REFRESH_INTERVAL_S = 2.0
_AUDIO_MIN_INTERVAL_S = 0.050       # 20 Hz
_PROGRESS_MIN_INTERVAL_S = 1.0      # 1 Hz
_SNAPSHOT_MIN_INTERVAL_S = 0.250    # 4 Hz

_CORE_TO_WS = {
    "track_changed": "event.track_changed",
    "track_finished": "event.track_finished",
    "playback_state_changed": "state.playback",
}

_SELF_CONTAINED = frozenset({
    "playback_tick",
    "remix_changed",
    "audio_monitor",
    "playback_state_changed",
})


def init(manager, loop: asyncio.AbstractEventLoop, source) -> None:
    global _manager, _loop, _refresh_task
    global _audio_flush_task, _progress_flush_task, _snapshot_flush_task
    global _pending_audio, _pending_progress
    global _last_audio_emit_at, _last_progress_emit_at, _last_snapshot_emit_at

    _manager = manager
    _loop = loop
    _audio_flush_task = None
    _progress_flush_task = None
    _snapshot_flush_task = None
    _pending_audio = None
    _pending_progress = None
    _last_audio_emit_at = 0.0
    _last_progress_emit_at = 0.0
    _last_snapshot_emit_at = 0.0

    source.on("*", _on_core_event)
    source.on("state_refresh", _on_state_refresh)
    _refresh_task = _loop.create_task(_periodic_refresh(), name="state-refresh")
    logger.info("StateBroadcaster initialised")


def _on_state_refresh(_data: dict) -> None:
    if _loop is None or _manager is None:
        return
    asyncio.run_coroutine_threadsafe(_broadcast_snapshot(), _loop)


def _on_core_event(event: dict) -> None:
    if _loop is None or _manager is None:
        return
    asyncio.run_coroutine_threadsafe(_handle_event(event), _loop)


async def _handle_event(event: dict) -> None:
    event_type = event.get("type", "")
    data = event.get("data", {})

    if event_type == "audio_monitor":
        await _handle_audio(data)
        return

    if event_type == "playback_state_changed":
        await _broadcast_snapshot()
        return

    if event_type == "playback_tick":
        await _handle_tick(data)
        return

    if event_type == "remix_changed":
        await _handle_remix(data)
        return

    ws_type = _CORE_TO_WS.get(event_type)
    if ws_type:
        await _manager.broadcast({
            "type": ws_type,
            "payload": data,
            "ts": int(time.time() * 1000),
        })

    if event_type not in _SELF_CONTAINED:
        await _broadcast_snapshot()


async def _handle_audio(data: dict) -> None:
    """Coalesce audio telemetry to the latest sample, capped at 20 Hz."""
    global _pending_audio, _audio_flush_task

    _pending_audio = data
    elapsed = time.monotonic() - _last_audio_emit_at

    if elapsed >= _AUDIO_MIN_INTERVAL_S:
        await _flush_audio()
        return

    if _audio_flush_task is None or _audio_flush_task.done():
        _audio_flush_task = asyncio.create_task(
            _delayed_audio_flush(_AUDIO_MIN_INTERVAL_S - elapsed),
            name="audio-telemetry-flush",
        )


async def _delayed_audio_flush(delay_s: float) -> None:
    try:
        await asyncio.sleep(max(0.0, delay_s))
        await _flush_audio()
    except asyncio.CancelledError:
        pass


async def _flush_audio() -> None:
    global _pending_audio, _last_audio_emit_at
    if _manager is None or _pending_audio is None:
        return

    payload = _pending_audio
    _pending_audio = None
    _last_audio_emit_at = time.monotonic()

    await _manager.broadcast({
        "type": "telemetry.audio",
        "payload": payload,
        "ts": int(time.time() * 1000),
    })


async def _handle_remix(data: dict) -> None:
    await _manager.broadcast({
        "type": "state.remix",
        "payload": {
            "pitch_semitones": data.get("pitch_semitones", 0.0),
            "tempo_ratio": data.get("tempo_ratio", 1.0),
        },
        "ts": int(time.time() * 1000),
    })


async def _handle_tick(data: dict) -> None:
    """Forward latest playback tick at 1 Hz; clients dead-reckon between ticks."""
    global _pending_progress, _progress_flush_task

    _pending_progress = data
    elapsed = time.monotonic() - _last_progress_emit_at

    if elapsed >= _PROGRESS_MIN_INTERVAL_S:
        await _flush_progress()
        return

    if _progress_flush_task is None or _progress_flush_task.done():
        _progress_flush_task = asyncio.create_task(
            _delayed_progress_flush(_PROGRESS_MIN_INTERVAL_S - elapsed),
            name="playback-progress-flush",
        )


async def _delayed_progress_flush(delay_s: float) -> None:
    try:
        await asyncio.sleep(max(0.0, delay_s))
        await _flush_progress()
    except asyncio.CancelledError:
        pass


async def _flush_progress() -> None:
    global _pending_progress, _last_progress_emit_at
    if _manager is None or _pending_progress is None:
        return

    data = _pending_progress
    _pending_progress = None
    _last_progress_emit_at = time.monotonic()

    await _manager.broadcast({
        "type": "event.progress",
        "payload": {
            "position": data.get("position", 0),
            "duration": data.get("duration", 0),
            "position_updated_at": data.get("server_ts") or int(time.time() * 1000),
        },
        "ts": int(time.time() * 1000),
    })


async def _periodic_refresh() -> None:
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
    """Emit state.playback at no more than 4 Hz."""
    global _snapshot_flush_task

    elapsed = time.monotonic() - _last_snapshot_emit_at
    if elapsed < _SNAPSHOT_MIN_INTERVAL_S:
        if _snapshot_flush_task is None or _snapshot_flush_task.done():
            _snapshot_flush_task = asyncio.create_task(
                _delayed_snapshot_flush(_SNAPSHOT_MIN_INTERVAL_S - elapsed),
                name="playback-snapshot-flush",
            )
        return

    await _emit_snapshot()


async def _delayed_snapshot_flush(delay_s: float) -> None:
    try:
        await asyncio.sleep(max(0.0, delay_s))
        await _emit_snapshot()
    except asyncio.CancelledError:
        pass


async def _emit_snapshot() -> None:
    global _last_snapshot_emit_at
    if _manager is None:
        return

    # Reserve the slot before I/O so concurrent callers coalesce behind it.
    _last_snapshot_emit_at = time.monotonic()

    from api.services.status_enricher import enrich_status

    raw = await core.get_status()
    if raw is None:
        return

    now_ms = int(time.time() * 1000)
    enriched = enrich_status(raw)
    await _manager.broadcast({
        "type": "state.playback",
        "payload": _compact_playback_payload(enriched),
        "ts": now_ms,
    })

    remix = raw.get("remix") or {}
    if remix:
        await _manager.broadcast({
            "type": "state.remix",
            "payload": {
                "pitch_semitones": remix.get("pitch_semitones", 0.0),
                "tempo_ratio": remix.get("tempo_ratio", 1.0),
                "reset_on_track_change": remix.get("reset_on_track_change", True),
            },
            "ts": now_ms,
        })


def _compact_playback_payload(status: dict) -> dict:
    return {
        "state": status.get("state", "idle"),
        "paused": status.get("paused", False),
        "track_id": status.get("track_id"),
        "title": status.get("title"),
        "artist": status.get("artist"),
        "display_artist": status.get("display_artist", status.get("artist")),
        "album": status.get("album"),
        "thumbnail": status.get("thumbnail"),
        "bpm": status.get("bpm"),
        "position": status.get("position", 0),
        "duration": status.get("duration", 0),
        "position_updated_at": status.get("position_updated_at", int(time.time() * 1000)),
        "volume": status.get("volume", 1.0),
        "queue": status.get("queue", []),
        "queue_current_index": status.get("queue_current_index", -1),
        "repeat_mode": status.get("repeat_mode", "off"),
        "shuffle": status.get("shuffle", False),
    }


async def send_initial_snapshot(ws_queue: asyncio.Queue) -> None:
    """Push a fresh state.playback + state.remix snapshot into a new client queue."""
    from api.services.status_enricher import enrich_status

    raw = await core.get_status()
    if raw is None:
        return

    now_ms = int(time.time() * 1000)
    enqueue_prepared(ws_queue, make_queue_item({
        "type": "state.playback",
        "payload": _compact_playback_payload(enrich_status(raw)),
        "ts": now_ms,
    }))

    remix = raw.get("remix") or {}
    if remix:
        enqueue_prepared(ws_queue, make_queue_item({
            "type": "state.remix",
            "payload": {
                "pitch_semitones": remix.get("pitch_semitones", 0.0),
                "tempo_ratio": remix.get("tempo_ratio", 1.0),
                "reset_on_track_change": remix.get("reset_on_track_change", True),
            },
            "ts": now_ms,
        }))
