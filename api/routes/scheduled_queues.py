# api/routes/scheduled_queues.py
"""
Endpoints for scheduling queue playback at a specific time.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import database

router = APIRouter()


class CreateScheduledQueueRequest(BaseModel):
    name: str
    tracks: list = []          # list of {track_id, filepath, title, thumbnail, artist}
    playlist_id: int | None = None   # alternatively, schedule from a playlist
    scheduled_at: int         # Unix timestamp


@router.get("/queue/scheduled")
async def list_scheduled_queues():
    conn = database.get_connection()
    try:
        items = database.list_scheduled_queues(conn)
        return {"scheduled": items, "total": len(items)}
    finally:
        conn.close()


@router.post("/queue/scheduled")
async def create_scheduled_queue(req: CreateScheduledQueueRequest):
    import time
    name = (req.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    if req.scheduled_at <= int(time.time()):
        raise HTTPException(status_code=400, detail="scheduled_at must be in the future")

    conn = database.get_connection()
    try:
        tracks = list(req.tracks)

        # If a playlist_id is given, load its tracks.
        if req.playlist_id and not tracks:
            playlist = database.get_playlist(conn, req.playlist_id)
            if not playlist:
                raise HTTPException(status_code=404, detail="Playlist not found")
            playlist_tracks = database.get_playlist_tracks(conn, req.playlist_id)
            tracks = [
                {
                    "track_id":  t.get("id", ""),
                    "filepath":  t.get("file_path", ""),
                    "title":     t.get("title", ""),
                    "thumbnail": t.get("thumbnail", ""),
                    "artist":    t.get("artist", ""),
                }
                for t in playlist_tracks
            ]

        if not tracks:
            raise HTTPException(status_code=400, detail="No tracks to schedule")

        sq_id = database.create_scheduled_queue(conn, name, tracks, req.scheduled_at)
        return {"ok": True, "id": sq_id, "name": name, "scheduled_at": req.scheduled_at,
                "track_count": len(tracks)}
    finally:
        conn.close()


@router.delete("/queue/scheduled/{sq_id}")
async def cancel_scheduled_queue(sq_id: int):
    conn = database.get_connection()
    try:
        cancelled = database.cancel_scheduled_queue(conn, sq_id)
        if not cancelled:
            raise HTTPException(status_code=404, detail="Scheduled queue not found or already fired")
        return {"ok": True}
    finally:
        conn.close()
