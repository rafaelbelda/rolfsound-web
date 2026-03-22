# utils/core_client.py
"""
Async HTTP client for rolfsound-core communication.

CRITICAL: All functions are async and use httpx.AsyncClient.
The previous version used synchronous httpx.get/post which blocked
the entire uvicorn event loop for TIMEOUT seconds on every call.
With core offline and the dashboard polling /status every 1.5s and
/monitor every 120ms, this caused 5-30s queuing delays on every
other request (settings, library, search, etc.).

Every async function returns None on any failure — callers raise
HTTPException(503). No blocking I/O anywhere in this module.
"""

import logging
import httpx
from utils.config import get

logger  = logging.getLogger(__name__)

# Aggressive timeout: core is local. If it doesn't respond in 2s it's down.
# 5s was the old value — too long when the dashboard polls constantly.
TIMEOUT = httpx.Timeout(2.0, connect=1.0)


def _url(path: str) -> str:
    return get("core_url", "http://localhost:8765").rstrip("/") + path


async def _get(path: str, params: dict = None) -> dict | None:
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            r = await client.get(_url(path), params=params)
            r.raise_for_status()
            return r.json()
    except httpx.ConnectError:
        logger.debug(f"Core unreachable: GET {path}")
    except httpx.TimeoutException:
        logger.debug(f"Core timeout: GET {path}")
    except Exception as e:
        logger.error(f"Core error GET {path}: {e}")
    return None


async def _post(path: str, data: dict = None) -> dict | None:
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            r = await client.post(_url(path), json=data or {})
            r.raise_for_status()
            return r.json()
    except httpx.ConnectError:
        logger.debug(f"Core unreachable: POST {path}")
    except httpx.TimeoutException:
        logger.debug(f"Core timeout: POST {path}")
    except Exception as e:
        logger.error(f"Core error POST {path}: {e}")
    return None


# ── Public API ────────────────────────────────────────────────────────────────

async def get_status() -> dict | None:    return await _get("/status")
async def get_queue()  -> dict | None:    return await _get("/queue")
async def get_events(since: int = 0):     return await _get("/events", {"since": since})

async def play(filepath=None, track_id=None) -> dict | None:
    p = {}
    if filepath:  p["filepath"]  = filepath
    if track_id:  p["track_id"]  = track_id
    return await _post("/play", p)

async def pause()                    -> dict | None: return await _post("/pause")
async def skip()                     -> dict | None: return await _post("/skip")
async def seek(position: float)      -> dict | None: return await _post("/seek", {"position": position})

async def record_start()             -> dict | None: return await _post("/recorder/start")
async def record_stop()              -> dict | None: return await _post("/recorder/stop")

async def queue_add(track_id, filepath, title="", thumbnail="", position=None) -> dict | None:
    """
    Add a track to core's queue.
    thumbnail is forwarded so the dashboard can render album art in the queue.
    """
    p = {"track_id": track_id, "filepath": filepath, "title": title, "thumbnail": thumbnail}
    if position is not None:
        p["position"] = position
    return await _post("/queue/add", p)

async def queue_remove(position: int) -> dict | None: return await _post("/queue/remove", {"position": position})
async def queue_move(from_pos, to_pos)-> dict | None: return await _post("/queue/move", {"from": from_pos, "to": to_pos})
async def queue_clear()               -> dict | None: return await _post("/queue/clear")

# Fix: add queue_previous so the skip-back button in the dashboard works.
# Matches the POST /queue/previous endpoint now wired in core's api_service.py.
async def queue_previous()            -> dict | None: return await _post("/queue/previous")

async def is_available()              -> bool:        return await get_status() is not None