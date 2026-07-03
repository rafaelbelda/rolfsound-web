# api/routes/stems.py
"""
Stems — a versão multipista de uma faixa do cofre ("Stem Ready").

Quatro papéis fixos (vocals · drums · bass · other). Quem possui os stems
sobe cada arquivo para o slot correspondente; eles viram sidecars da faixa
master no diretório de música ({id}.stem.{role}.ext) e são catalogados em
track_stems. Ao completar 2 camadas nasce automaticamente a faixa-variação
"Stems" no grupo de versões da original — tocá-la é tocar multipista no
core. Cair para <2 camadas desfaz a variação.

GET    /api/library/{id}/stems                  slots preenchidos + fatos
POST   /api/library/{id}/stems/{role}           sobe/substitui um stem
DELETE /api/library/{id}/stems/{role}           remove arquivo + registro
GET    /api/library/{id}/stems/{role}/download  serve o arquivo
"""

import logging
import os
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from db import database
from utils.config import get as cfg_get
from youtube.ytdlp import AUDIO_EXTENSIONS

from api.routes.upload import _file_facts, _load_audio

logger = logging.getLogger(__name__)

router = APIRouter()

ROLES = ("vocals", "drums", "bass", "other")
ROLE_LABEL = {"vocals": "Vocais", "drums": "Bateria", "bass": "Baixo", "other": "Outros"}

# Tolerância entre a duração do stem e a da faixa master antes de avisar.
_DURATION_SLACK_S = 2.0


def _require_track(conn, track_id: str) -> dict:
    track = database.get_track(conn, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    return track


def _redirect_variant(conn, track_id: str) -> tuple[str, dict]:
    """A gaveta aberta na variação opera sobre a original: os sidecars são
    de X e a variação nunca ganha variação própria."""
    track = _require_track(conn, track_id)
    src = track.get("stem_source_id")
    if src:
        return src, _require_track(conn, src)
    return track_id, track


def resolve_stems(conn, track: dict) -> dict | None:
    """{role: abspath} dos stems da ORIGINAL de uma variação, filtrando o que
    existe no disco. <2 válidos ⇒ None (o play cai no master). Usado por
    /api/play e /api/queue/add."""
    source_id = track.get("stem_source_id")
    if not source_id:
        return None
    out = {}
    for s in database.get_stems(conn, source_id):
        p = s.get("file_path")
        if p and os.path.exists(p):
            out[s["role"]] = str(Path(p).resolve())
    return out if len(out) >= 2 else None


def _variant_ui_payload(conn, variant: dict) -> dict:
    """Faixa no formato da UI + grupo, para o front atualizar RolfsoundData
    sem reload (a variação não tem row no Acervo)."""
    from api.routes.bootstrap import _track
    source_id = variant.get("stem_source_id") or ""
    roles = [s["role"] for s in database.get_stems(conn, source_id)]
    group_id = variant.get("version_group_id") or ""
    group = None
    if group_id:
        grp = database.get_version_group(conn, group_id)
        if grp:
            group = {
                "primary": grp.get("primary_track_id"),
                "members": [t["id"] for t in database.get_group_members(conn, group_id)],
            }
    return {
        "id": variant["id"],
        "group_id": group_id,
        "group": group,
        "track": _track(variant, roles, primary=False),
    }


def sync_stem_variant(conn, source_id: str) -> dict | None:
    """Reconcilia a variação com o nº de camadas: ≥2 cria, <2 desfaz.
    Retorna o payload `variant` da resposta (ou None se nada mudou)."""
    roles = [s["role"] for s in database.get_stems(conn, source_id)]
    variant = database.get_stem_variant(conn, source_id)

    if len(roles) >= 2 and not variant:
        source = database.get_track(conn, source_id)
        variant = database.create_stem_variant(conn, source)
        conn.commit()
        logger.info(f"stems: variação criada — {variant['id']}")
        return {"created": True, **_variant_ui_payload(conn, variant)}

    if len(roles) < 2 and variant:
        database.delete_stem_variant(conn, variant["id"])
        conn.commit()
        logger.info(f"stems: variação desfeita — {variant['id']} (<2 camadas)")
        payload = {"removed": True, "id": variant["id"],
                   "group_id": variant.get("version_group_id") or "",
                   "group": None}
        gid = variant.get("version_group_id")
        if gid:
            grp = database.get_version_group(conn, gid)
            if grp:
                payload["group"] = {
                    "primary": grp.get("primary_track_id"),
                    "members": [t["id"] for t in database.get_group_members(conn, gid)],
                }
        return payload

    return None


def backfill_variants_on_startup() -> None:
    """Chamado do lifespan (api/app.py), junto do scan_and_reconcile."""
    conn = database.get_connection()
    try:
        created = database.backfill_stem_variants(conn)
        conn.commit()
        if created:
            logger.info(f"stems: backfill criou {created} variação(ões) Stem Ready")
    finally:
        conn.close()


def _require_role(role: str) -> str:
    if role not in ROLES:
        raise HTTPException(status_code=404, detail=f"Papel de stem desconhecido: {role}")
    return role


def _stem_dict(row: dict) -> dict:
    p = Path(row.get("file_path") or "")
    return {
        "role":     row.get("role"),
        "name":     p.name,
        "duration": row.get("duration"),
        "size":     row.get("size"),
        "codec":    row.get("codec"),
        "added_at": row.get("added_at"),
        "missing":  not (row.get("file_path") and os.path.exists(row["file_path"])),
    }


@router.get("/library/{track_id}/stems")
async def list_stems(track_id: str):
    conn = database.get_connection()
    try:
        track_id, track = _redirect_variant(conn, track_id)
        stems = {r["role"]: _stem_dict(r) for r in database.get_stems(conn, track_id)}
    finally:
        conn.close()
    return {
        "ok": True,
        "track_id": track_id,
        "duration": track.get("duration"),
        "stems": stems,
    }


@router.post("/library/{track_id}/stems/{role}")
async def upload_stem(track_id: str, role: str, file: UploadFile = File(...)):
    _require_role(role)
    ext = Path(file.filename or "").suffix.lower()
    if ext not in AUDIO_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail=f"Formato não suportado: {ext or 'sem extensão'}",
        )

    conn = database.get_connection()
    try:
        track_id, track = _redirect_variant(conn, track_id)
        previous = database.get_stem(conn, track_id, role)
    finally:
        conn.close()

    music_dir = Path(cfg_get("music_directory", "./music")).resolve()
    music_dir.mkdir(parents=True, exist_ok=True)
    dest = music_dir / f"{track_id}.stem.{role}{ext}"

    try:
        with dest.open("wb") as out:
            shutil.copyfileobj(file.file, out, length=1024 * 1024)
    except Exception as e:
        logger.error(f"stems: falha ao gravar {dest.name}: {e}")
        raise HTTPException(status_code=500, detail="Falha ao gravar o arquivo")
    finally:
        await file.close()

    # Substituição com extensão diferente deixaria o arquivo antigo órfão.
    if previous and previous.get("file_path") and previous["file_path"] != str(dest):
        try:
            os.remove(previous["file_path"])
        except OSError:
            pass

    _easy, raw = _load_audio(str(dest))
    facts = _file_facts(str(dest), raw)
    duration = int(facts["duration"]) if facts.get("duration") else None

    conn = database.get_connection()
    try:
        database.upsert_stem(
            conn, track_id, role,
            file_path=str(dest),
            duration=duration,
            size=facts.get("size") or 0,
            codec=facts.get("codec") or facts.get("ext"),
            added_at=int(time.time()),
        )
        conn.commit()
        stem = database.get_stem(conn, track_id, role)
        # 2ª camada completa ⇒ a variação Stem Ready nasce sozinha.
        variant = sync_stem_variant(conn, track_id)
    finally:
        conn.close()

    warning = None
    master_dur = track.get("duration")
    if duration and master_dur and abs(duration - master_dur) > _DURATION_SLACK_S:
        warning = (
            f"Duração difere da master ({duration}s vs {master_dur}s) — "
            "os stems devem cobrir a faixa inteira."
        )

    logger.info(f"stems: {dest.name} catalogado ({ROLE_LABEL[role]} de '{track_id}')")
    return {"ok": True, "stem": _stem_dict(stem), "warning": warning,
            "variant": variant}


@router.delete("/library/{track_id}/stems/{role}")
async def delete_stem(track_id: str, role: str):
    _require_role(role)
    conn = database.get_connection()
    try:
        track_id, _track_row = _redirect_variant(conn, track_id)
        stem = database.get_stem(conn, track_id, role)
        if not stem:
            raise HTTPException(status_code=404, detail="Stem não encontrado")
        database.delete_stem(conn, track_id, role)
        conn.commit()
        # Caiu para <2 camadas ⇒ a variação é desfeita.
        variant = sync_stem_variant(conn, track_id)
    finally:
        conn.close()

    path = stem.get("file_path")
    if path and os.path.exists(path):
        try:
            os.remove(path)
        except OSError as e:
            logger.warning(f"stems: não removeu {path}: {e}")

    return {"ok": True, "deleted": role, "variant": variant}


@router.get("/library/{track_id}/stems/{role}/download")
async def download_stem(track_id: str, role: str):
    _require_role(role)
    conn = database.get_connection()
    try:
        track_id, _track_row = _redirect_variant(conn, track_id)
        stem = database.get_stem(conn, track_id, role)
    finally:
        conn.close()
    if not stem:
        raise HTTPException(status_code=404, detail="Stem não encontrado")
    path = stem.get("file_path")
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Arquivo não encontrado no disco")
    return FileResponse(
        path=path,
        filename=Path(path).name,
        media_type="application/octet-stream",
    )
