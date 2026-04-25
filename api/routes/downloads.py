# api/routes/downloads.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from core.ingestors.download_manager import get_manager
from core.database import database

router = APIRouter()


class DownloadRequest(BaseModel):
    track_id: str
    title: str = ""
    thumbnail: str = ""
    target_track_id: str | None = None
    asset_type: str = "ORIGINAL_MIX"


@router.post("/downloads")
async def start_download(req: DownloadRequest):
    # req.track_id is the YouTube video id. In MAM terms it is source_ref,
    # not the logical Rolfsound track id.
    conn = database.get_connection()
    try:
        existing_asset = database.get_asset_by_source_ref(conn, "YOUTUBE", req.track_id)
        if existing_asset:
            track = database.get_track(conn, existing_asset["track_id"])
            return {"ok": True, "status": "exists", "track": track, "asset": existing_asset}
    finally:
        conn.close()

    manager = get_manager()
    if manager is None:
        raise HTTPException(status_code=503, detail="Download manager not ready")

    queued = manager.enqueue(
        req.track_id,
        req.title,
        req.thumbnail,
        target_track_id=req.target_track_id,
        asset_type=req.asset_type,
    )
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
