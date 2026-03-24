# api/routes/search.py
"""
GET /api/search?q=query

SSE stream. Library results fire instantly; YouTube results follow.

SSE events:
  event: library   data: {"tracks": [...]}   — always first, always instant
  event: result    data: {track dict}        — one per YouTube result
  event: error     data: {"message": str}    — non-fatal
  event: done      data: {}                  — always fires

FLOW
────
  1. Check disconnection early — skip everything if client already gone
  2. SQLite library search (~1ms) -> emit "library"
  3. Check disconnection again  — skip YouTube search if client left
  4. Exact cache hit             -> stream results immediately (no delay)
  5. Inflight dedup              -> await existing Future
  6. youtube.search.search()     -> API or yt-dlp depending on config
  7. Emit results, cache, resolve Future
  8. emit "done"

NO ARTIFICIAL DELAY
───────────────────
Cache hits stream results with no sleep between them. The frontend's
fadeIn animation on each row provides visual smoothness without us
adding latency. 50ms * 10 results = 500ms of unnecessary waiting removed.

DISCONNECTION AWARENESS
───────────────────────
request.is_disconnected() is checked before the YouTube search call.
If the user navigates away or the frontend fires AbortController,
we skip the API call entirely — saving quota and CPU.
The check is best-effort (ASGI doesn't guarantee instant detection)
but catches the common case of fast navigation.

INFLIGHT DEDUP
──────────────
_inflight: dict[cache_key -> Future[list[dict]]].
Owner runs the search and resolves Future in finally.
Late arrivals await with asyncio.shield so owner continues
unaffected if a waiter is cancelled.
"""

import asyncio
import json
import logging

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from db import database
from youtube import search as yt_search
from utils.config import get

router = APIRouter()
logger = logging.getLogger(__name__)

# Inflight dedup: cache_key -> Future[list[dict]]
_inflight: dict[str, asyncio.Future] = {}


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.get("/search")
async def search(request: Request, q: str = Query(..., min_length=1)):
    max_results = get("max_search_results", 10)
    q_clean     = q.strip()
    api_key     = get("youtube_api_key", "").strip()
    cache_key   = yt_search.make_cache_key(q_clean, max_results, api_key)

    async def event_stream():

        # ── 1. Early disconnection check ─────────────────────────────
        # Catches the case where the browser fired a new search before
        # this one even started (AbortController + fast typing).
        if await request.is_disconnected():
            return

        # ── 2. Library search ─────────────────────────────────────────
        conn = database.get_connection()
        try:
            library_results = database.search_tracks(conn, q_clean)
        finally:
            conn.close()

        lib_ids = {t["id"] for t in library_results}
        yield _sse("library", {"tracks": library_results})

        # ── 3. Check disconnection before expensive work ──────────────
        # If the user navigated away after library results rendered,
        # skip the YouTube search entirely — saves API quota and CPU.
        if await request.is_disconnected():
            return

        # ── 4. Exact cache hit ────────────────────────────────────────
        cached = yt_search._cache_get(cache_key)
        if cached is not None:
            logger.debug(f"Search cache hit: {q_clean!r}")
            for track in cached:
                if track["id"] not in lib_ids:
                    yield _sse("result", track)
            yield _sse("done", {})
            return

        # ── 5. Inflight dedup ─────────────────────────────────────────
        if cache_key in _inflight:
            logger.debug(f"Search: joining in-flight for {q_clean!r}")
            try:
                results = await asyncio.shield(_inflight[cache_key])
                for track in results:
                    if track["id"] not in lib_ids:
                        yield _sse("result", track)
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.warning(f"Inflight wait error for {q_clean!r}: {e}")
                yield _sse("error", {"message": "Search temporarily unavailable"})
            yield _sse("done", {})
            return

        # ── 6. Owner: run the search ──────────────────────────────────
        loop   = asyncio.get_event_loop()
        future: asyncio.Future = loop.create_future()
        _inflight[cache_key]   = future

        results: list[dict] = []
        try:
            results = await yt_search.search(q_clean, max_results)

            if not results:
                yield _sse("error", {"message": "No results found"})
            else:
                for track in results:
                    if track["id"] not in lib_ids:
                        yield _sse("result", track)

        except Exception as e:
            logger.error(f"Search route error for {q_clean!r}: {e}", exc_info=True)
            yield _sse("error", {"message": "Search failed"})

        finally:
            if not future.done():
                future.set_result(results)
            _inflight.pop(cache_key, None)

        yield _sse("done", {})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )