# api/routes/search.py
"""
GET /api/search?q=query

Streams results via SSE as yt-dlp finds them.
Library results sent first (instant). YouTube results stream one by one.

SSE events:
  event: library   data: {"tracks": [...]}
  event: result    data: {track}
  event: done      data: {}

Kept deliberately simple — single user / household, no inflight dedup needed.
Cache prevents re-running yt-dlp for the same query within 5 minutes.
Hard 20s timeout on the subprocess so it can never hang forever.
"""

import asyncio
import json
import logging

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from db import database
from youtube.ytdlp import _parse_line, _search_cmd, _cache_get, _cache_set
from utils.config import get

router = APIRouter()
logger = logging.getLogger(__name__)

_YT_TIMEOUT = 20  # seconds — hard limit on yt-dlp; kills process if exceeded


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.get("/search")
async def search(q: str = Query(..., min_length=1)):
    max_results = get("max_search_results", 10)
    q_clean     = q.strip()
    cache_key   = f"{q_clean.lower()}:{max_results}"

    # Library search — instant SQLite, independent of core
    conn = database.get_connection()
    try:
        library_results = database.search_tracks(conn, q_clean)
        all_lib_ids     = database.get_all_track_ids(conn)
    finally:
        conn.close()

    async def event_stream():
        # 1. Library results — always first, always instant
        yield _sse("library", {"tracks": library_results})

        # 2. Cache hit — stream all cached results immediately, done
        cached = _cache_get(cache_key)
        if cached is not None:
            for track in cached:
                if track["id"] not in all_lib_ids:
                    yield _sse("result", track)
            yield _sse("done", {})
            return

        # 3. Run yt-dlp, stream results line by line
        collected = []
        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *_search_cmd(q_clean, max_results),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )

            # Read with a per-line timeout so a stalled yt-dlp can't hang forever.
            # If we get no output for _YT_TIMEOUT seconds, we stop and return
            # whatever we collected so far.
            while True:
                try:
                    raw = await asyncio.wait_for(
                        proc.stdout.readline(),
                        timeout=_YT_TIMEOUT,
                    )
                except asyncio.TimeoutError:
                    logger.warning(f"yt-dlp readline timed out for {q_clean!r}")
                    break

                if not raw:  # EOF — subprocess finished cleanly
                    break

                line = raw.decode(errors="replace").strip()
                if not line:
                    continue

                track = _parse_line(line)
                if track and track["id"] not in all_lib_ids:
                    collected.append(track)
                    yield _sse("result", track)

        except FileNotFoundError:
            logger.error("yt-dlp not found — install with: pip install yt-dlp")
        except Exception as e:
            logger.error(f"Search error for {q_clean!r}: {e}")
        finally:
            # Kill subprocess if still running (timeout case)
            if proc and proc.returncode is None:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass
            # Cache whatever we got, even partial results
            if collected:
                _cache_set(cache_key, collected)
            yield _sse("done", {})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
        },
    )