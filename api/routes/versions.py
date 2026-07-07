# api/routes/versions.py
"""
Versões alternativas — agrupa faixas que são a mesma música (Instrumental,
Beat Version, Stem Version, feats diferentes, etc.) numa "pasta".

Cada grupo tem um primary_track_id: a versão que toca por padrão. No Acervo só
a versão principal aparece (colapsada); as demais vivem no drawer "Explorar
versões". A troca de rótulo de cada versão reusa PATCH /api/library/{id}.

GET    /library/{id}/versions               grupo da faixa (ou só ela, se solta)
POST   /library/{id}/versions               vincula {member_id} ao grupo de id
DELETE /library/{id}/versions/{member_id}   desvincula (dissolve se sobrar 1)
PATCH  /library/{id}/versions/primary       define a versão padrão {track_id}
GET    /library/{id}/version-suggestions    candidatas por título base + artista
"""

import logging
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import database
from api.routes.bootstrap import cover_css

logger = logging.getLogger(__name__)

router = APIRouter()


class AddVersionRequest(BaseModel):
    member_id: str


class PrimaryRequest(BaseModel):
    track_id: str


# Sufixos entre () ou [] no fim do título (ex.: "(Instrumental)", "[Beat]").
_SUFFIX_RE = re.compile(r"[\(\[][^\)\]]*[\)\]]\s*$")


def _base_title(title: str | None) -> str:
    """Título sem qualificadores de versão, minúsculo — para casar versões."""
    t = (title or "").strip()
    prev = None
    while t and t != prev:
        prev = t
        t = _SUFFIX_RE.sub("", t).strip()
    return t.lower()


def _require_track(conn, track_id: str) -> dict:
    track = database.get_track(conn, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    return track


def _version_dict(t: dict, primary_id: str | None) -> dict:
    return {
        "id":         t.get("id"),
        "title":      t.get("title") or "Faixa",
        "artist":     t.get("artist") or "",
        "label":      t.get("version_label") or "",
        "bpm":        t.get("bpm") or 0,
        "key":        t.get("key") or "",
        "dur":        t.get("duration") or 0,
        "cover":      cover_css(t.get("album_cover") or t.get("thumbnail")),
        "is_primary": t.get("id") == primary_id,
        # variação Stem Ready — versions.js acende o mini badge de 4 pontos
        "stem_ready": bool(t.get("stem_source_id")),
    }


def _group_payload(conn, track: dict) -> dict:
    """Estado do grupo da faixa. Faixa solta → grupo virtual só com ela."""
    group_id = track.get("version_group_id")
    if group_id:
        grp = database.get_version_group(conn, group_id)
        primary_id = grp.get("primary_track_id") if grp else track["id"]
        members = database.get_group_members(conn, group_id)
    else:
        primary_id = track["id"]
        members = [track]
    return {
        "ok": True,
        "group_id": group_id or "",
        "primary_id": primary_id,
        "versions": [_version_dict(t, primary_id) for t in members],
    }


@router.get("/library/{track_id}/versions")
async def list_versions(track_id: str):
    conn = database.get_connection()
    try:
        track = _require_track(conn, track_id)
        return _group_payload(conn, track)
    finally:
        conn.close()


@router.post("/library/{track_id}/versions")
async def add_version(track_id: str, req: AddVersionRequest):
    member_id = req.member_id
    if member_id == track_id:
        raise HTTPException(status_code=400, detail="Uma faixa não é versão de si mesma")
    conn = database.get_connection()
    try:
        track = _require_track(conn, track_id)
        member = _require_track(conn, member_id)

        if member.get("version_group_id"):
            raise HTTPException(
                status_code=400,
                detail="Essa faixa já pertence a outro grupo de versões",
            )

        group_id = track.get("version_group_id")
        if not group_id:
            group_id = database.create_version_group(conn, track_id)
        database.add_to_version_group(conn, group_id, member_id)
        conn.commit()

        track = database.get_track(conn, track_id)
        payload = _group_payload(conn, track)
        logger.info(f"versions: {member_id} vinculado ao grupo {group_id}")
        return payload
    finally:
        conn.close()


@router.delete("/library/{track_id}/versions/{member_id}")
async def remove_version(track_id: str, member_id: str):
    conn = database.get_connection()
    try:
        _require_track(conn, track_id)
        member = _require_track(conn, member_id)
        if not member.get("version_group_id"):
            raise HTTPException(status_code=400, detail="Faixa não está em um grupo")
        database.remove_from_version_group(conn, member_id)
        conn.commit()

        # Após remover, a faixa de referência pode ter ficado sem grupo (grupo
        # dissolvido). Devolve o estado atual da faixa original.
        track = database.get_track(conn, track_id)
        return _group_payload(conn, track)
    finally:
        conn.close()


@router.patch("/library/{track_id}/versions/primary")
async def set_primary(track_id: str, req: PrimaryRequest):
    conn = database.get_connection()
    try:
        track = _require_track(conn, track_id)
        group_id = track.get("version_group_id")
        if not group_id:
            raise HTTPException(status_code=400, detail="Faixa não está em um grupo")
        target = _require_track(conn, req.track_id)
        if target.get("version_group_id") != group_id:
            raise HTTPException(status_code=400, detail="A versão não pertence a este grupo")
        database.set_version_primary(conn, group_id, req.track_id)
        conn.commit()

        track = database.get_track(conn, track_id)
        return _group_payload(conn, track)
    finally:
        conn.close()


@router.get("/library/{track_id}/version-suggestions")
async def version_suggestions(track_id: str):
    """Faixas soltas com mesmo artista e mesmo título base — candidatas a versão."""
    conn = database.get_connection()
    try:
        track = _require_track(conn, track_id)
        base = _base_title(track.get("title"))
        artist = (track.get("artist") or "").strip().lower()
        candidates = []
        if base and artist:
            for r in database.list_tracks(conn):
                if r["id"] == track_id:
                    continue
                if r.get("version_group_id"):
                    continue
                if (r.get("artist") or "").strip().lower() != artist:
                    continue
                if _base_title(r.get("title")) != base:
                    continue
                grp = track.get("version_group_id")
                candidates.append(_version_dict(r, grp))
        return {"ok": True, "suggestions": candidates}
    finally:
        conn.close()
