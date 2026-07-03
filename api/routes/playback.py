# api/routes/playback.py

from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from utils import core_client

router = APIRouter()


class PlayRequest(BaseModel):
    track_id: str = ""
    filepath: str = ""
    # Play by absolute queue position (core resolves the track and moves
    # current_index atomically — the right way to play a row from the queue UI).
    index: int | None = None


class SeekRequest(BaseModel):
    position: float


class VolumeRequest(BaseModel):
    volume: float  # 0.0 – 1.0


class RemixRequest(BaseModel):
    pitch_semitones: float | None = None
    tempo_ratio: float | None = None


@router.post("/play")
async def play(req: PlayRequest = None):
    filepath = req.filepath if req else ""
    track_id = req.track_id if req else ""
    index    = req.index    if req else None

    # Play by queue index: core resolves filepath itself.
    if index is not None:
        result = await core_client.play(index=index)
        if result is None:
            raise HTTPException(status_code=503, detail="Core unavailable")
        return result

    # The new UI only knows DB ids (never exposes filesystem paths), so a play
    # request usually arrives with just track_id — resolve the filepath here.
    # Core has no database; sending track_id alone would only work for the
    # track already at the queue's current index.
    if track_id and not filepath:
        from db import database
        conn = database.get_connection()
        try:
            track = database.get_track(conn, track_id)
            if track:
                filepath = track.get("file_path", "") or ""
        finally:
            conn.close()
        if not filepath:
            raise HTTPException(status_code=404, detail="Track not found in library")

    # Resolve to absolute path before sending to core.
    # Core runs in a different working directory — relative paths like
    # "music/track.webm" would resolve to the wrong location in core's CWD.
    # Guard: only resolve non-empty strings — Path("").resolve() returns CWD
    # which would be sent as a bogus filepath.
    if filepath:
        filepath = str(Path(filepath).resolve())

    # Pass None (not empty string) so core_client skips adding to the dict.
    # Core receiving {"filepath": ""} is treated as no filepath provided.
    result = await core_client.play(
        filepath=filepath if filepath else None,
        track_id=track_id if track_id else None,
    )
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/pause")
async def pause():
    result = await core_client.pause()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/skip")
async def skip():
    result = await core_client.skip()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/seek")
async def seek(req: SeekRequest):
    result = await core_client.seek(req.position)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/volume")
async def volume(req: VolumeRequest):
    result = await core_client.set_volume(max(0.0, min(1.0, req.volume)))
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


# Remix roda NO CORE (pitch/tempo do áudio real via remix_engine) — a UI só
# manda parâmetros. Nenhum áudio é processado no navegador.
@router.post("/remix")
async def remix(req: RemixRequest):
    result = await core_client.remix_set(req.pitch_semitones, req.tempo_ratio)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/remix/reset")
async def remix_reset():
    result = await core_client.remix_reset()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result
