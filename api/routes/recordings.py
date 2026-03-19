# api/routes/recordings.py
"""
GET    /api/recordings          — list all .wav recordings from core's recordings dir
DELETE /api/recordings/{name}   — delete a recording file
POST   /api/recordings/{name}/queue — add a recording to the playback queue
"""

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from utils.config import get
from utils import core_client

router = APIRouter()

AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg"}


def _recordings_dir() -> Path:
    # The recordings dir is defined in rolfsound-core's config.
    # We read it from our own config where the operator should mirror it,
    # or fall back to the standard default.
    return Path(get("recordings_directory", "./recordings"))


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
                "duration_s": None,  # could be populated with soundfile later
            })
    return items


@router.get("/recordings")
async def list_recordings():
    items = _list_recordings()
    return {"recordings": items, "total": len(items)}


@router.delete("/recordings/{name}")
async def delete_recording(name: str):
    # Safety: no path traversal
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = _recordings_dir() / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Recording not found")
    path.unlink()
    return {"ok": True, "deleted": name}


@router.post("/recordings/{name}/queue")
async def queue_recording(name: str):
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = _recordings_dir() / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Recording not found")

    result = core_client.queue_add(
        track_id=name,
        filepath=str(path),
        title=name,
    )
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result