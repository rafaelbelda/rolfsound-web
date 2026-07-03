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
  - tags:  derivadas de genre (schema so guarda um genero por faixa)
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
    genre = r.get("genre") or ""
    group = r.get("version_group_id") or ""
    return {
        "id":     r.get("id") or "",
        "title":  r.get("title") or "Faixa",
        "artist": r.get("artist") or "",
        "album":  r.get("album") or "",
        "year":   str(r["year"]) if r.get("year") else "",
        "added":  (r.get("date_added") or 0) * 1000,
        "bpm":    r.get("bpm") or 0,
        "key":    r.get("key") or "",
        "fmt":    "vinil" if r.get("source") == "recording" else "digital",
        "state":  "master" if r.get("status") == "identified" else "rip",
        "fav":    False,
        "tags":   [genre.lower()] if genre else [],
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
        tracks = [
            _track(
                r,
                smap.get(r.get("stem_source_id")) if r.get("stem_source_id") else [],
                primary=(r.get("id") in primary_ids),
            )
            for r in database.list_tracks(conn)
        ]
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
        "groups": gmap,
        "account": {"admin": is_admin()},
    }
    body = "window.RolfsoundData = " + json.dumps(data, ensure_ascii=False) + ";\n"
    return Response(
        content=body,
        media_type="application/javascript; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )
