# api/routes/pads.py
"""
Pads de sample do Remixer (módulo Loop → FX-PADS.md parte B).

Cada faixa tem 6 slots persistidos em track_pads (in/out em segundos da
fonte). O ÁUDIO não é persistido: o core (PadSampler) recaptura o trecho
do arquivo da faixa quando os pads são (re)empurrados — o que acontece
a cada play, porque troca de faixa limpa os pads no core.

POST /api/pads/set    {track_id, index, start_s, end_s} — salva no DB e
                      captura no core (se a faixa for a atual)
POST /api/pads/clear  {track_id, index}                 — remove dos dois
POST /api/pads/on     {index} · POST /api/pads/off      — proxies do toggle
GET  /api/library/{id}/pads                             — slots salvos
"""

import logging
import time

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import database
from utils import core_client
from utils.config import get as cfg_get

logger = logging.getLogger(__name__)
router = APIRouter()

N_PADS = 6


class PadSetRequest(BaseModel):
    track_id: str
    index: int          # 0–5
    start_s: float
    end_s: float


class PadClearRequest(BaseModel):
    track_id: str
    index: int


class PadOnRequest(BaseModel):
    index: int


async def push_pads_to_core(track_id: str) -> None:
    """Empurra os pads salvos da faixa pro core (após um play). Best-effort:
    falha vira log, nunca erro do play."""
    conn = database.get_connection()
    try:
        pads = database.get_pads(conn, track_id)
    finally:
        conn.close()
    for p in pads:
        r = await core_client.pad_set(p["pad_index"], p["start_s"], p["end_s"])
        if r is None:
            logger.debug(f"pads: push falhou (core offline?) — {track_id}")
            return
    if pads:
        logger.info(f"pads: {len(pads)} pad(s) de {track_id} empurrados pro core")


def push_pads_to_core_sync(track_id: str) -> None:
    """Versão síncrona para a thread do EventPoller (avanço de fila).
    httpx próprio e curto — não toca no AsyncClient compartilhado."""
    conn = database.get_connection()
    try:
        pads = database.get_pads(conn, track_id)
    finally:
        conn.close()
    if not pads:
        return
    base = cfg_get("core_url", "http://localhost:8765").rstrip("/")
    try:
        with httpx.Client(timeout=httpx.Timeout(3.0, connect=1.0)) as http:
            for p in pads:
                http.post(base + "/pads/set", json={
                    "index":   p["pad_index"],
                    "start_s": p["start_s"],
                    "end_s":   p["end_s"],
                })
        logger.info(f"pads: {len(pads)} pad(s) de {track_id} empurrados (poller)")
    except Exception as e:
        logger.debug(f"pads: push síncrono falhou: {e}")


@router.get("/library/{track_id}/pads")
async def list_pads(track_id: str):
    conn = database.get_connection()
    try:
        if not database.get_track(conn, track_id):
            raise HTTPException(status_code=404, detail="Track not found")
        return {"pads": database.get_pads(conn, track_id)}
    finally:
        conn.close()


@router.post("/pads/set")
async def pad_set(req: PadSetRequest):
    if not (0 <= req.index < N_PADS) or req.end_s <= req.start_s:
        raise HTTPException(status_code=400, detail="Invalid pad index or range")
    conn = database.get_connection()
    try:
        if not database.get_track(conn, req.track_id):
            raise HTTPException(status_code=404, detail="Track not found")
        database.upsert_pad(
            conn, req.track_id, req.index,
            float(req.start_s), float(req.end_s), int(time.time()),
        )
        conn.commit()
    finally:
        conn.close()
    # Captura no core (a UI só grava pads da faixa que está tocando; se o
    # core não tiver faixa, o DB fica e o próximo play empurra).
    result = await core_client.pad_set(req.index, req.start_s, req.end_s)
    return {"ok": True, "captured": result is not None and result.get("ok", False)}


@router.post("/pads/clear")
async def pad_clear(req: PadClearRequest):
    if not (0 <= req.index < N_PADS):
        raise HTTPException(status_code=400, detail="Invalid pad index")
    conn = database.get_connection()
    try:
        database.delete_pad(conn, req.track_id, req.index)
        conn.commit()
    finally:
        conn.close()
    await core_client.pad_clear(req.index)
    return {"ok": True}


@router.post("/pads/on")
async def pad_on(req: PadOnRequest):
    if not (0 <= req.index < N_PADS):
        raise HTTPException(status_code=400, detail="Invalid pad index")
    result = await core_client.pad_on(req.index)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/pads/off")
async def pad_off():
    result = await core_client.pad_off()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result
