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
  - tags:  coluna própria (JSON array), editável no dock — não deriva mais de genre
  - cover: thumbnail vira background CSS (url(...))
"""

import json

from fastapi import APIRouter
from fastapi.responses import Response

from api.deps import is_admin
from api.track_view import cover_css, track_view
from db import database

router = APIRouter()


def _albums_payload(conn, rows: list) -> dict:
    """{album_id: {…}} para o front (editor + grid + "Ver álbum"). A capa é a
    própria do álbum, ou deriva do thumbnail da faixa de menor track_no."""
    best_thumb: dict = {}   # album_id -> (track_no, thumbnail)
    for r in rows:
        if r.get("stem_source_id"):          # variação divide o álbum do master
            continue
        aid, thumb = r.get("album_id"), r.get("thumbnail")
        if not aid or not thumb:
            continue
        tno = r.get("track_no") or 1_000_000
        cur = best_thumb.get(aid)
        if cur is None or tno < cur[0]:
            best_thumb[aid] = (tno, thumb)

    out: dict = {}
    for aid, a in database.albums_map(conn).items():
        cover = a.get("cover") or (best_thumb.get(aid) or (None, None))[1]
        out[aid] = {
            "id":     aid,
            "title":  a.get("title") or "Álbum",
            "artist": a.get("artist") or "",
            "year":   str(a["year"]) if a.get("year") else "",
            "genre":  a.get("genre") or "",
            "total":  a.get("total_tracks") or 0,   # "número de músicas" (0 = derivar)
            "count":  a.get("track_count") or 0,     # faixas de fato no acervo
            "kind":   a.get("kind") or "album",
            "cover":  cover_css(cover),
            # cor de acento fixada no editor ("" = derivar da capa ao tocar)
            "accent": a.get("accent") or "",
        }
    return out


@router.get("/bootstrap.js")
async def bootstrap_js():
    conn = database.get_connection()
    try:
        smap = database.stems_map(conn)
        gmap = database.groups_map(conn)
        # {track_id: group_id} para os que são primary do seu grupo
        primary_ids = {g["primary"] for g in gmap.values() if g.get("primary")}
        # Papéis de stems vão SÓ para a variação (smap é keyed pela original,
        # que fica limpa: sem badge, sem lanes)
        rows = database.list_tracks(conn)
        tracks = [
            track_view(
                r,
                smap.get(r.get("stem_source_id")) if r.get("stem_source_id") else [],
                primary=(r.get("id") in primary_ids),
            )
            for r in rows
        ]
        albums = _albums_payload(conn, rows)
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
        "albums": albums,
        "queue": queue,
        "playlists": playlists,
        "groups": gmap,
        "account": {"admin": is_admin()},
    }
    body = "window.RolfsoundData = " + json.dumps(data, ensure_ascii=False) + ";\n"
    return Response(
        content=body,
        media_type="application/javascript; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )
