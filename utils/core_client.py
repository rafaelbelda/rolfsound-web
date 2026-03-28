# utils/core_client.py
"""
Async HTTP client for rolfsound-core communication.

All functions return None on any failure — callers raise HTTPException(503).

PERSISTENT CLIENT
─────────────────
A single httpx.AsyncClient is reused across all requests. This eliminates
the TCP connection setup overhead (~400-500ms) that occurred when creating
a new client per request. The client maintains a connection pool to core,
so after the first request the connection is reused with near-zero overhead.

Call init_client() from FastAPI lifespan startup.
Call close_client() from FastAPI lifespan shutdown.

TIMEOUT
───────
5s total / 2s connect. Core is local; the connect timeout is generous to
survive transient GIL pressure from sounddevice/portaudio during playback
transitions (the original 1s connect caused spurious 503s when core was
busy tearing down an audio stream).

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

# Generous timeout: core is local but can be briefly busy during stream teardown.
# 2s connect (was 1s — caused spurious 503s during playback transitions).
# 5s total (was 2s — gives sounddevice time to finish cleanup).
TIMEOUT = httpx.Timeout(5.0, connect=2.0)

# Module-level persistent client — initialised in init_client(), closed in close_client().
# Reusing one client eliminates the ~400-500ms TCP setup overhead per request.
_client: httpx.AsyncClient | None = None


def _url(path: str) -> str:
    return get("core_url", "http://localhost:8765").rstrip("/") + path


def init_client() -> None:
    """Create the shared AsyncClient. Call once from FastAPI lifespan startup."""
    global _client
    _client = httpx.AsyncClient(timeout=TIMEOUT)
    logger.info("core_client: persistent AsyncClient created")


async def close_client() -> None:
    """Close the shared AsyncClient. Call from FastAPI lifespan shutdown."""
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None
        logger.info("core_client: AsyncClient closed")


def _get_client() -> httpx.AsyncClient:
    """Return the shared client, creating a fallback if init_client() was not called."""
    global _client
    if _client is None or _client.is_closed:
        logger.warning("core_client: client not initialised — creating on demand")
        _client = httpx.AsyncClient(timeout=TIMEOUT)
    return _client


async def _get(path: str, params: dict = None) -> dict | None:
    try:
        r = await _get_client().get(_url(path), params=params)
        r.raise_for_status()
        return r.json()
    except httpx.ConnectError:
        logger.debug(f"Core unreachable: GET {path}")
    except httpx.TimeoutException:
        logger.debug(f"Core timeout: GET {path}")
    except httpx.HTTPStatusError as e:
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
        r = await _get_client().post(_url(path), json=data or {})
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

async def queue_add(track_id, filepath, title="", thumbnail="", artist="", position=None) -> dict | None:
    p = {"track_id": track_id, "filepath": filepath, "title": title, "thumbnail": thumbnail, "artist": artist}
    if position is not None:
        p["position"] = position
    return await _post("/queue/add", p)

async def queue_remove(position: int) -> dict | None: return await _post("/queue/remove", {"position": position})
async def queue_move(from_pos, to_pos)-> dict | None: return await _post("/queue/move", {"from": from_pos, "to": to_pos})
async def queue_clear()               -> dict | None: return await _post("/queue/clear")
async def queue_previous()            -> dict | None: return await _post("/queue/previous")
async def is_available()              -> bool:        return await get_status() is not None