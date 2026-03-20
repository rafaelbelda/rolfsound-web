# api/routes/library.py

import os
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from db import database

router = APIRouter()


@router.post("/library/scan")
async def scan_library():
    """
    Walk the music directory and add any audio files not already in the DB.
    Handles manually added files, tracks downloaded before DB existed, etc.
    """
    from utils.config import get as cfg_get
    music_dir = cfg_get("music_directory", "./music")
    conn = database.get_connection()
    try:
        added = database.scan_and_reconcile(conn, music_dir)
        return {"ok": True, "added": added}
    finally:
        conn.close()


@router.get("/library")
async def list_library():
    conn = database.get_connection()
    try:
        tracks = database.list_tracks(conn)
        return {"tracks": tracks, "total": len(tracks)}
    finally:
        conn.close()


@router.get("/library/{track_id}/download")
async def download_track(track_id: str):
    """Serve the audio file as a download attachment."""
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        filepath = track.get("file_path")
        if not filepath or not os.path.exists(filepath):
            raise HTTPException(status_code=404, detail="File not found on disk")
        filename = Path(filepath).name
        return FileResponse(
            path=filepath,
            filename=filename,
            media_type="application/octet-stream",
        )
    finally:
        conn.close()


@router.get("/library/{track_id}")
async def get_track(track_id: str):
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        return track
    finally:
        conn.close()


@router.delete("/library/{track_id}")
async def delete_track(track_id: str):
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")

        # Delete audio file
        filepath = track.get("file_path")
        if filepath and os.path.exists(filepath):
            os.remove(filepath)

        # Delete local thumbnail if it's a local path (not a URL)
        thumb = track.get("thumbnail", "")
        if thumb and not thumb.startswith("http") and os.path.exists(thumb):
            os.remove(thumb)

        database.delete_track(conn, track_id)
        conn.commit()
        return {"ok": True, "deleted": track_id}
    finally:
        conn.close()