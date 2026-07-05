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
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import Response

from api.deps import is_admin
from db import database

router = APIRouter()


def cover_css(thumbnail: str | None) -> str:
    if not thumbnail:
        return ""
    t = thumbnail
    # Caminho local no disco (scan antigo gravava caminho absoluto): as capas
    # sidecar moram no diretório de música, servido pela montagem /thumbs.
    if not t.startswith(("http://", "https://", "/")):
        t = "/thumbs/" + Path(t).name
    # Aspas simples: o valor entra em style="…" no render.js — aspas duplas
    # fechariam o atributo e a capa não carregava.
    t = t.replace("\\", "/").replace("'", "%27").replace('"', "%22")
    return f"url('{t}') center/cover no-repeat, #141416"


def _track(r: dict, stems: list | None = None, primary: bool = False) -> dict:
    group = r.get("version_group_id") or ""
    return {
        "id":     r.get("id") or "",
        "title":  r.get("title") or "Faixa",
        "artist": r.get("artist") or "",
        # álbum vem do JOIN (a.title): "Single" para singles. album_id é a
        # entidade dona; album_total = "número de músicas"; album_kind = single|album.
        "album":  r.get("album") or "",
        "album_id":    r.get("album_id") or "",
        "album_total": r.get("album_total") or 0,
        "album_kind":  r.get("album_kind") or "album",
        "genre":  r.get("genre") or "",
        # número da faixa no álbum (ordena o painel "Ver álbum"); 0 = sem tag
        "track_no": r.get("track_no") or 0,
        "year":   str(r["year"]) if r.get("year") else "",
        "added":  (r.get("date_added") or 0) * 1000,
        "bpm":    r.get("bpm") or 0,
        "key":    r.get("key") or "",
        "fmt":    "vinil" if r.get("source") == "recording" else "digital",
        "state":  "master" if r.get("status") == "identified" else "rip",
        "fav":    bool(r.get("fav")),
        "tags":   r.get("tags") or [],
        "dur":    r.get("duration") or 0,
        "cover":  cover_css(r.get("thumbnail")),
        # papéis de stems ('vocals'|'drums'|'bass'|'other') — só a VARIAÇÃO
        # Stem Ready os carrega (badge de 4 pontos + lanes no Remixer);
        # a original fica limpa
        "stems":  stems or [],
        # variação Stem Ready: id da original dona dos sidecars ("" = normal)
        "stems_of": r.get("stem_source_id") or "",
        # agrupamento de versões: group = id do grupo (ou ""), primary = é a
        # versão que representa a "pasta" no Acervo, vlabel = rótulo da versão
        "group":  group,
        "vlabel": r.get("version_label") or "",
        "primary": bool(primary),
    }


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
            _track(
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
