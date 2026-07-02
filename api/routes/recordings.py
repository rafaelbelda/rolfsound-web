# api/routes/recordings.py
"""
GET    /api/recordings                   — list all recordings from core's dir
GET    /api/recordings/{name}/download   — serve a recording as a file download
DELETE /api/recordings/{name}            — delete a recording file
POST   /api/recordings/{name}/queue      — add a recording to the playback queue
"""

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from utils.config import get
from utils import core_client

router = APIRouter()

AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg"}


def _recordings_dir() -> Path:
    return Path(get("recordings_directory", "./recordings"))


def _safe_name(name: str) -> None:
    """Raise 400 if name contains path traversal characters."""
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Invalid filename")


def _list_recordings() -> list[dict]:
    d = _recordings_dir()
    if not d.exists():
        return []
    items = []
    for f in sorted(d.iterdir(), reverse=True):
        if f.suffix.lower() in AUDIO_EXTS:
            stat = f.stat()
            items.append({
                "name":       f.name,
                "filepath":   str(f),
                "size_bytes": stat.st_size,
                "date":       int(stat.st_mtime),
                "duration_s": None,
            })
    return items


@router.get("/recordings")
async def list_recordings():
    items = _list_recordings()
    return {"recordings": items, "total": len(items)}


@router.get("/recordings/{name}/download")
async def download_recording(name: str):
    """
    Serve a recording file as an attachment so the browser downloads it.
    The dashboard's track row renders an <a href="/api/recordings/{name}/download"
    download> link — this is the route that backs it.
    """
    _safe_name(name)
    path = _recordings_dir() / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Recording not found")
    return FileResponse(
        path=str(path),
        filename=name,
        media_type="application/octet-stream",
    )


@router.delete("/recordings/{name}")
async def delete_recording(name: str):
    _safe_name(name)
    path = _recordings_dir() / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Recording not found")
    path.unlink()
    return {"ok": True, "deleted": name}


@router.post("/recordings/{name}/queue")
async def queue_recording(name: str):
    _safe_name(name)
    path = _recordings_dir() / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Recording not found")
    result = await core_client.queue_add(
        track_id=name,
        filepath=str(path),
        title=name,
    )
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result