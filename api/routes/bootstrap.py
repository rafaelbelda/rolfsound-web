# api/routes/bootstrap.py
"""
GET /api/bootstrap.js

Devolve `window.RolfsoundData = {...}` montado do SQLite. O index.html
inclui este script entre static/js/data.js (que define o objeto vazio)
e static/js/render.js (que constrói a UI a partir dele) — ver o formato
de faixa documentado em static/js/data.js.

Mapeamento do schema antigo -> formato da UI:
  - fmt:   source 'recording' -> 'vinil'; resto -> 'digital'
  - state: status 'identified' -> 'master'; resto -> 'rip'
  - bpm/key/tags: ainda nao existem no schema -> vazios ("-" na UI)
  - cover: thumbnail vira background CSS (url(...))
"""

import json

from fastapi import APIRouter
from fastapi.responses import Response

from api.deps import is_admin
from db import database

router = APIRouter()


def _cover(thumbnail: str | None) -> str:
    if not thumbnail:
        return ""
    return f'url("{thumbnail}") center/cover no-repeat, #141416'


def _track(r: dict) -> dict:
    return {
        "id":     r.get("id") or "",
        "title":  r.get("title") or "Faixa",
        "artist": r.get("artist") or "",
        "album":  "",
        "year":   str(r["year"]) if r.get("year") else "",
        "added":  (r.get("date_added") or 0) * 1000,
        "bpm":    0,
        "key":    "",
        "fmt":    "vinil" if r.get("source") == "recording" else "digital",
        "state":  "master" if r.get("status") == "identified" else "rip",
        "fav":    False,
        "tags":   [],
        "dur":    r.get("duration") or 0,
        "cover":  _cover(r.get("thumbnail")),
    }


@router.get("/bootstrap.js")
async def bootstrap_js():
    conn = database.get_connection()
    try:
        tracks = [_track(r) for r in database.list_tracks(conn)]
        known = {t["id"] for t in tracks}

        queue_state = database.load_queue_state(conn)
        queue = [
            t.get("track_id", "")
            for t in queue_state.get("tracks", [])
            if t.get("track_id") in known
        ]

        playlists = []
        for p in database.list_playlists(conn):
            rows = database.get_playlist_tracks(conn, p["id"])
            playlists.append({
                "id":     f'p{p["id"]}',
                "name":   p["name"],
                "tracks": [r["id"] for r in rows if r["id"] in known],
            })
    finally:
        conn.close()

    data = {
        "tracks": tracks,
        "queue": queue,
        "playlists": playlists,
        "account": {"admin": is_admin()},
    }
    body = "window.RolfsoundData = " + json.dumps(data, ensure_ascii=False) + ";\n"
    return Response(
        content=body,
        media_type="application/javascript; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )
