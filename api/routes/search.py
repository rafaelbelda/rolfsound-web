# api/routes/search.py
"""
GET /api/search?q=query
Returns library matches + YouTube results (separated).
"""

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from db import database
from youtube import ytdlp
from utils.config import get

router = APIRouter()


@router.get("/search")
async def search(q: str = Query(..., min_length=1)):
    max_results = get("max_search_results", 10)

    # Library search
    conn = database.get_connection()
    try:
        lib_tracks = database.list_tracks(conn)
    finally:
        conn.close()

    q_lower = q.lower()
    library_results = [
        t for t in lib_tracks
        if q_lower in (t.get("title") or "").lower()
        or q_lower in (t.get("artist") or "").lower()
    ]

    # YouTube search
    yt_results = ytdlp.search(q, max_results=max_results)

    # Remove YouTube results already in library
    lib_ids = {t["id"] for t in library_results}
    yt_results = [t for t in yt_results if t["id"] not in lib_ids]

    return {
        "query": q,
        "library": library_results,
        "youtube": yt_results,
    }