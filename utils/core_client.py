# utils/core_client.py
"""
Async HTTP client for rolfsound-core communication.

All functions return None on any failure — callers raise HTTPException(503).

TIMEOUT
───────
2s total / 1s connect. Core is local; if it doesn't respond in 2s it's down.

ERROR LOGGING
─────────────
4xx responses (400 file_not_found, 404 etc.) are expected operational
responses — logged at DEBUG. Only genuine infrastructure errors
(network, timeout, unexpected 5xx) are logged at ERROR.
"""

import logging
import httpx
from utils.config import get

logger  = logging.getLogger(__name__)
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
    except httpx.HTTPStatusError as e:
        # 4xx from core are expected operational responses (file not found etc.)
        # — log at debug so they don't flood the error log.
        status = e.response.status_code
        if status < 500:
            logger.debug(f"Core {status}: GET {path}")
        else:
            logger.error(f"Core {status}: GET {path}")
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
    except httpx.HTTPStatusError as e:
        status = e.response.status_code
        if status < 500:
            logger.debug(f"Core {status}: POST {path}")
        else:
            logger.error(f"Core {status}: POST {path}")
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
    p = {"track_id": track_id, "filepath": filepath, "title": title, "thumbnail": thumbnail}
    if position is not None:
        p["position"] = position
    return await _post("/queue/add", p)

async def queue_remove(position: int) -> dict | None: return await _post("/queue/remove", {"position": position})
async def queue_move(from_pos, to_pos)-> dict | None: return await _post("/queue/move", {"from": from_pos, "to": to_pos})
async def queue_clear()               -> dict | None: return await _post("/queue/clear")
async def queue_previous()            -> dict | None: return await _post("/queue/previous")
async def is_available()              -> bool:        return await get_status() is not None