# api/routes/playback.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from utils import core_client

router = APIRouter()


class PlayRequest(BaseModel):
    track_id: str = ""
    filepath: str = ""


class SeekRequest(BaseModel):
    position: float


@router.post("/play")
async def play(req: PlayRequest = None):
    result = await core_client.play(
        filepath=req.filepath if req else None,
        track_id=req.track_id if req else None,
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