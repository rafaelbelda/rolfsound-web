# api/ws/connection_manager.py
"""
Fan-out WebSocket connection manager with backpressure.
Pattern mirrors utils/monitor_accumulator.py:54-64.

Per-client asyncio.Queue(maxsize=32):
  - state.* frames: drop oldest if full (snapshots are idempotent)
  - event.* frames: never drop — skip slow client instead
"""

import asyncio
import logging

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        self._clients: dict[WebSocket, asyncio.Queue] = {}

    async def connect(self, ws: WebSocket) -> asyncio.Queue:
        await ws.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=32)
        self._clients[ws] = q
        logger.info(f"WS client connected — {len(self._clients)} total")
        return q

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.pop(ws, None)
        logger.info(f"WS client disconnected — {len(self._clients)} remaining")

    async def broadcast(self, frame: dict) -> None:
        if not self._clients:
            return

        is_state = frame.get("type", "").startswith("state.")
        dead: list[WebSocket] = []

        for ws, q in self._clients.items():
            try:
                if q.full():
                    if is_state:
                        try:
                            q.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                    else:
                        logger.warning("WS queue full for event.* frame — client may be slow")
                        continue
                q.put_nowait(frame)
            except Exception:
                dead.append(ws)

        for ws in dead:
            self._clients.pop(ws, None)

    @property
    def client_count(self) -> int:
        return len(self._clients)
