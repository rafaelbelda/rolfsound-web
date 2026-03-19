# api/routes/library.py

import os
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from db import database

router = APIRouter()


@router.get("/library")
async def list_library():
    conn = database.get_connection()
    try:
        tracks = database.list_tracks(conn)
        return {"tracks": tracks, "total": len(tracks)}
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