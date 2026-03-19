# api/routes/downloads.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from downloads.manager import get_manager
from db import database

router = APIRouter()


class DownloadRequest(BaseModel):
    track_id: str
    title: str = ""
    thumbnail: str = ""


@router.post("/downloads")
async def start_download(req: DownloadRequest):
    # Check if already in library
    conn = database.get_connection()
    try:
        existing = database.get_track(conn, req.track_id)
        if existing:
            return {"ok": True, "status": "exists", "track": existing}
    finally:
        conn.close()

    manager = get_manager()
    if manager is None:
        raise HTTPException(status_code=503, detail="Download manager not ready")

    queued = manager.enqueue(req.track_id, req.title, req.thumbnail)
    return {"ok": True, "status": "queued" if queued else "already_queued"}


@router.get("/downloads")
async def list_downloads():
    manager = get_manager()
    if manager is None:
        return {"downloads": []}
    return {"downloads": manager.list_all()}


@router.get("/downloads/{track_id}")
async def get_download_status(track_id: str):
    manager = get_manager()
    if manager is None:
        raise HTTPException(status_code=503, detail="Download manager not ready")
    status = manager.get_status(track_id)
    if not status:
        raise HTTPException(status_code=404, detail="Download not found")
    return status