# api/routes/playback.py

from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from utils.core import core

router = APIRouter()


class PlayRequest(BaseModel):
    track_id: str = ""
    filepath: str = ""


class SeekRequest(BaseModel):
    position: float


@router.post("/play")
async def play(req: PlayRequest = None):
    filepath = req.filepath if req else ""
    track_id = req.track_id if req else ""

    # Resolve to absolute path before sending to core.
    # Core runs in a different working directory — relative paths like
    # "music/track.webm" would resolve to the wrong location in core's CWD.
    # Guard: only resolve non-empty strings — Path("").resolve() returns CWD
    # which would be sent as a bogus filepath.
    if filepath:
        filepath = str(Path(filepath).resolve())

    # Pass None (not empty string) so core skips adding to the dict.
    # Core receiving {"filepath": ""} is treated as no filepath provided.
    result = await core.play(
        filepath=filepath if filepath else None,
        track_id=track_id if track_id else None,
    )
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/pause")
async def pause():
    result = await core.pause()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/skip")
async def skip():
    result = await core.skip()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/seek")
async def seek(req: SeekRequest):
    result = await core.seek(req.position)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result