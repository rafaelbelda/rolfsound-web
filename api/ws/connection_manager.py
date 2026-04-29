# api/ws/connection_manager.py
"""
Fan-out WebSocket connection manager with bounded per-client backpressure.

Queues carry pre-serialized frames so each broadcast pays the JSON cost once,
then fans the same text out to every connected browser.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)

QUEUE_MAX = 32
BACKPRESSURE_LOG_INTERVAL_S = 2.0

QOS_CRITICAL = "critical"
QOS_LATEST = "latest"
QOS_VOLATILE = "volatile"

CRITICAL_TYPES = frozenset({
    "event.track_changed",
    "event.track_finished",
    "event.track_updated",
})

LATEST_TYPES = frozenset({
    "state.playback",
    "state.remix",
})

VOLATILE_TYPES = frozenset({
    "audio_monitor",      # legacy alias
    "telemetry.audio",
    "event.progress",
})

DOWNLOAD_TERMINAL_STATES = frozenset({"complete", "failed", "error"})


@dataclass(slots=True)
class QueuedFrame:
    frame_type: str
    qos: str
    text: str
    payload_bytes: int


def classify_frame(frame: dict[str, Any]) -> str:
    frame_type = str(frame.get("type") or "")
    payload = frame.get("payload") or {}

    if frame_type == "event.download_progress":
        status = str(payload.get("status") or "").lower()
        return QOS_CRITICAL if status in DOWNLOAD_TERMINAL_STATES else QOS_VOLATILE
    if frame_type in CRITICAL_TYPES or frame_type.startswith("ack."):
        return QOS_CRITICAL
    if frame_type in LATEST_TYPES:
        return QOS_LATEST
    if frame_type in VOLATILE_TYPES:
        return QOS_VOLATILE
    if frame_type.startswith("state."):
        return QOS_LATEST
    if frame_type.startswith("telemetry."):
        return QOS_VOLATILE
    return QOS_CRITICAL


def make_queue_item(frame: dict[str, Any]) -> QueuedFrame:
    text = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
    return QueuedFrame(
        frame_type=str(frame.get("type") or ""),
        qos=classify_frame(frame),
        text=text,
        payload_bytes=len(text.encode("utf-8")),
    )


def enqueue_prepared(q: asyncio.Queue, item: QueuedFrame) -> bool:
    """Best-effort enqueue for one-off initial frames."""
    if not q.full():
        q.put_nowait(item)
        return True

    removed = _remove_first(q, lambda old: old.qos in {QOS_LATEST, QOS_VOLATILE})
    if removed is None:
        return False

    q.put_nowait(item)
    return True


def _remove_first(q: asyncio.Queue, predicate) -> QueuedFrame | None:
    # asyncio.Queue exposes qsize from the underlying deque. We mutate that deque
    # directly because these per-client queues are private to the uvicorn loop.
    queue = q._queue  # noqa: SLF001 - intentional bounded-queue compaction.
    kept = []
    removed = None

    while queue:
        item = queue.popleft()
        if removed is None and predicate(item):
            removed = item
            continue
        kept.append(item)

    queue.extend(kept)
    return removed


class ConnectionManager:
    def __init__(self):
        self._clients: dict[WebSocket, asyncio.Queue] = {}
        self._drop_count = 0
        self._last_drop_log_at = 0.0

    async def connect(self, ws: WebSocket) -> asyncio.Queue:
        await ws.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self._clients[ws] = q
        logger.info(f"WS client connected - {len(self._clients)} total")
        return q

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.pop(ws, None)
        logger.info(f"WS client disconnected - {len(self._clients)} remaining")

    async def broadcast(self, frame: dict[str, Any]) -> None:
        if not self._clients:
            return

        item = make_queue_item(frame)
        dead: list[tuple[WebSocket, str]] = []

        for ws, q in list(self._clients.items()):
            try:
                if self._enqueue(q, item):
                    continue
                if item.qos == QOS_CRITICAL:
                    dead.append((ws, "critical backpressure"))
                else:
                    self._record_drop(item, q)
            except Exception:
                dead.append((ws, "enqueue failed"))

        for ws, reason in dead:
            self._clients.pop(ws, None)
            try:
                await ws.close(code=1013, reason=reason)
            except Exception:
                pass

    def _enqueue(self, q: asyncio.Queue, item: QueuedFrame) -> bool:
        if item.qos in {QOS_LATEST, QOS_VOLATILE}:
            removed_same = _remove_first(q, lambda old: old.frame_type == item.frame_type)
            if removed_same is not None:
                self._record_drop(removed_same, q)

        if not q.full():
            q.put_nowait(item)
            return True

        if item.qos in {QOS_LATEST, QOS_VOLATILE}:
            removed = _remove_first(q, lambda old: old.qos in {QOS_LATEST, QOS_VOLATILE})
            if removed is None:
                return False
            self._record_drop(removed, q)
            q.put_nowait(item)
            return True

        removed = _remove_first(q, lambda old: old.qos in {QOS_LATEST, QOS_VOLATILE})
        if removed is None:
            return False
        self._record_drop(removed, q)
        q.put_nowait(item)
        return True

    def _record_drop(self, item: QueuedFrame, q: asyncio.Queue) -> None:
        self._drop_count += 1
        now = time.monotonic()
        if now - self._last_drop_log_at < BACKPRESSURE_LOG_INTERVAL_S:
            return
        self._last_drop_log_at = now
        logger.warning(
            "WS queue backpressure drop type=%s qos=%s queue_size=%s payload_bytes=%s drop_count=%s",
            item.frame_type,
            item.qos,
            q.qsize(),
            item.payload_bytes,
            self._drop_count,
        )

    @property
    def client_count(self) -> int:
        return len(self._clients)
