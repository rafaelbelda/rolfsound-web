# api/ws/intent_router.py
"""
Maps intent.* frames from WS clients to core_client calls.
Single point of audit for all client-initiated commands.
"""

import logging

from utils import core_client

logger = logging.getLogger(__name__)


async def route(intent_type: str, payload: dict) -> dict:
    handler = _ROUTES.get(intent_type)
    if handler is None:
        logger.warning(f"intent_router: unknown intent '{intent_type}'")
        return {"ok": False, "error": "unknown_intent"}
    try:
        result = await handler(payload)
        return {"ok": True, "data": result}
    except Exception as e:
        logger.error(f"intent_router error ({intent_type}): {e}")
        return {"ok": False, "error": str(e)}


async def _play(p):    return await core_client.play()
async def _pause(p):   return await core_client.pause()

async def _skip(p):
    return (
        await core_client.queue_previous()
        if p.get("direction") == "back"
        else await core_client.skip()
    )

async def _seek(p):    return await core_client.seek(float(p["position"]))
async def _shuffle(p): return await core_client.queue_shuffle(bool(p["enabled"]))
async def _repeat(p):  return await core_client.queue_repeat(str(p["mode"]))
async def _volume(p):  return await core_client.volume(float(p["value"]))

async def _queue_add(p):
    return await core_client.queue_add(
        p["track_id"], p.get("filepath", ""), p.get("title", ""),
        thumbnail=p.get("thumbnail", ""), artist=p.get("artist", ""),
        position=p.get("position"),
    )

async def _queue_remove(p): return await core_client.queue_remove(int(p["index"]))
async def _queue_move(p):   return await core_client.queue_move(int(p["from"]), int(p["to"]))
async def _queue_clear(p):  return await core_client.queue_clear()
async def _ping(p):         return {"pong": True}


_ROUTES = {
    "intent.play":         _play,
    "intent.pause":        _pause,
    "intent.skip":         _skip,
    "intent.seek":         _seek,
    "intent.shuffle.set":  _shuffle,
    "intent.repeat.set":   _repeat,
    "intent.volume.set":   _volume,
    "intent.queue.add":    _queue_add,
    "intent.queue.remove": _queue_remove,
    "intent.queue.move":   _queue_move,
    "intent.queue.clear":  _queue_clear,
    "intent.ping":         _ping,
}
