# api/ws/endpoint.py
"""
FastAPI WebSocket endpoint at GET /api/ws.

Two concurrent tasks per connection:
  - _read_loop:  receives intent.* frames, routes them, sends ack if id present
  - _write_loop: drains the per-client queue and sends frames to the browser
"""

import asyncio
import json
import logging
import time

from fastapi import WebSocket, WebSocketDisconnect

from api.ws.connection_manager import ConnectionManager, QueuedFrame
from api.ws import state_broadcaster, intent_router

logger = logging.getLogger(__name__)

_manager = ConnectionManager()


def get_manager() -> ConnectionManager:
    return _manager


async def ws_endpoint(ws: WebSocket) -> None:
    q = await _manager.connect(ws)
    await state_broadcaster.send_initial_snapshot(q)

    reader = asyncio.create_task(_read_loop(ws))
    writer = asyncio.create_task(_write_loop(ws, q))

    try:
        _done, pending = await asyncio.wait(
            [reader, writer],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
    finally:
        _manager.disconnect(ws)


async def _read_loop(ws: WebSocket) -> None:
    try:
        while True:
            text = await ws.receive_text()
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                logger.warning("WS: invalid JSON received")
                continue

            intent_type = msg.get("type", "")
            payload     = msg.get("payload", {})
            msg_id      = msg.get("id")

            if not intent_type.startswith("intent."):
                continue

            result = await intent_router.route(intent_type, payload)

            if msg_id:
                ack_type = "ack." + intent_type.removeprefix("intent.")
                try:
                    await ws.send_text(json.dumps({
                        "type":    ack_type,
                        "payload": result,
                        "id":      msg_id,
                        "ts":      int(time.time() * 1000),
                    }))
                except Exception:
                    pass

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.debug(f"WS read loop ended: {e}")


async def _write_loop(ws: WebSocket, q: asyncio.Queue) -> None:
    try:
        while True:
            frame = await q.get()
            try:
                if isinstance(frame, QueuedFrame):
                    await ws.send_text(frame.text)
                elif isinstance(frame, str):
                    await ws.send_text(frame)
                else:
                    await ws.send_text(json.dumps(frame, ensure_ascii=False, separators=(",", ":")))
            except Exception:
                break
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.debug(f"WS write loop ended: {e}")
