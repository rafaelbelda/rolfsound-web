# api/routes/queue.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Literal
from utils import core_client

router = APIRouter()


class AddRequest(BaseModel):
    track_id: str
    filepath: str = ""
    title: str = ""
    thumbnail: str = ""
    position: int | None = None


class RemoveRequest(BaseModel):
    position: int


class MoveRequest(BaseModel):
    from_pos: int
    to_pos: int


class RepeatRequest(BaseModel):
    mode: Literal["off", "one", "all"]


class ShuffleRequest(BaseModel):
    enabled: bool


class SaveAsPlaylistRequest(BaseModel):
    name: str


@router.get("/queue")
async def get_queue():
    result = await core_client.get_queue()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/add")
async def add_to_queue(req: AddRequest):
    # Resolve filepath and thumbnail from library if not provided
    artist = ""
    if req.track_id and (not req.filepath or not req.thumbnail):
        from db import database
        conn = database.get_connection()
        try:
            track = database.get_track(conn, req.track_id)
            if track:
                if not req.filepath:
                    req.filepath  = track.get("file_path", "")
                if not req.title:
                    req.title     = track.get("title", "")
                # Fix: forward thumbnail so queue renders album art
                if not req.thumbnail:
                    req.thumbnail = track.get("thumbnail", "")
                artist = track.get("artist", "")
        finally:
            conn.close()

    result = await core_client.queue_add(
        req.track_id, req.filepath, req.title,
        thumbnail=req.thumbnail, artist=artist, position=req.position,
    )
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/remove")
async def remove_from_queue(req: RemoveRequest):
    result = await core_client.queue_remove(req.position)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/move")
async def move_in_queue(req: MoveRequest):
    result = await core_client.queue_move(req.from_pos, req.to_pos)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/clear")
async def clear_queue():
    result = await core_client.queue_clear()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


# Fix: add /queue/previous so the skip-back button in the dashboard works.
# The dashboard calls API.skipBack() -> POST /api/queue/previous.
@router.post("/queue/previous")
async def previous_in_queue():
    result = await core_client.queue_previous()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/repeat")
async def set_repeat(req: RepeatRequest):
    result = await core_client.queue_repeat(req.mode)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/shuffle")
async def set_shuffle(req: ShuffleRequest):
    result = await core_client.queue_shuffle(req.enabled)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/save-as-playlist")
async def save_queue_as_playlist(req: SaveAsPlaylistRequest):
    from db import database
    queue_data = await core_client.get_queue()
    if queue_data is None:
        raise HTTPException(status_code=503, detail="Core unavailable")

    tracks = queue_data.get("tracks", [])
    if not tracks:
        raise HTTPException(status_code=400, detail="Queue is empty")

    conn = database.get_connection()
    try:
        playlist_id = database.create_playlist(conn, req.name)
        for track in tracks:
            track_id = track.get("track_id", "")
            if track_id:
                database.add_track_to_playlist(conn, playlist_id, track_id)
        return {"id": playlist_id, "name": req.name.strip(), "track_count": len(tracks)}
    finally:
        conn.close()