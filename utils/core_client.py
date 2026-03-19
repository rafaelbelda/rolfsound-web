# utils/core_client.py
"""
HTTP client for rolfsound-core communication.
All requests include timeouts and return None on any failure —
callers raise HTTPException(503) and the dashboard shows its
own "unavailable" message. No stub logic here.
"""

import logging
import httpx
from utils.config import get

logger  = logging.getLogger(__name__)
TIMEOUT = 5.0


def _url(path: str) -> str:
    return get("core_url", "http://localhost:8765").rstrip("/") + path


def _get(path: str, params: dict = None) -> dict | None:
    try:
        r = httpx.get(_url(path), params=params, timeout=TIMEOUT)
        r.raise_for_status()
        return r.json()
    except httpx.ConnectError:
        logger.debug(f"Core unreachable: GET {path}")
    except httpx.TimeoutException:
        logger.debug(f"Core timeout: GET {path}")
    except Exception as e:
        logger.error(f"Core error GET {path}: {e}")
    return None


def _post(path: str, data: dict = None) -> dict | None:
    try:
        r = httpx.post(_url(path), json=data or {}, timeout=TIMEOUT)
        r.raise_for_status()
        return r.json()
    except httpx.ConnectError:
        logger.debug(f"Core unreachable: POST {path}")
    except httpx.TimeoutException:
        logger.debug(f"Core timeout: POST {path}")
    except Exception as e:
        logger.error(f"Core error POST {path}: {e}")
    return None


# ---- Public API ----

def get_status() -> dict | None:          return _get("/status")
def get_queue()  -> dict | None:          return _get("/queue")
def get_events(since: int = 0):           return _get("/events", {"since": since})

def play(filepath=None, track_id=None):
    p = {}
    if filepath:  p["filepath"]  = filepath
    if track_id:  p["track_id"]  = track_id
    return _post("/play", p)

def pause()                    -> dict | None: return _post("/pause")
def skip()                     -> dict | None: return _post("/skip")
def seek(position: float)      -> dict | None: return _post("/seek", {"position": position})

def record_start()             -> dict | None: return _post("/recorder/start")
def record_stop()              -> dict | None: return _post("/recorder/stop")

def queue_add(track_id, filepath, title="", position=None):
    p = {"track_id": track_id, "filepath": filepath, "title": title}
    if position is not None:
        p["position"] = position
    return _post("/queue/add", p)

def queue_remove(position: int) -> dict | None: return _post("/queue/remove", {"position": position})
def queue_move(from_pos, to_pos)-> dict | None: return _post("/queue/move", {"from": from_pos, "to": to_pos})
def queue_clear()               -> dict | None: return _post("/queue/clear")
def is_available()              -> bool:        return get_status() is not None