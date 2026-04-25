from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Literal

from core.database import database

router = APIRouter()


class CreatePlaylistRequest(BaseModel):
    name: str


class RenamePlaylistRequest(BaseModel):
    name: str


class AddPlaylistTrackRequest(BaseModel):
    track_id: str


@router.get("/playlists")
async def list_playlists():
    conn = database.get_connection()
    try:
        playlists = database.list_playlists(conn)
        return {"playlists": playlists, "total": len(playlists)}
    finally:
        conn.close()


@router.post("/playlists")
async def create_playlist(req: CreatePlaylistRequest):
    name = (req.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Playlist name is required")

    conn = database.get_connection()
    try:
        playlist_id = database.create_playlist(conn, name)
        playlist = database.get_playlist(conn, playlist_id)
        if not playlist:
            raise HTTPException(status_code=500, detail="Playlist creation failed")
        playlist["track_count"] = 0
        return playlist
    finally:
        conn.close()


@router.patch("/playlists/{playlist_id}")
async def rename_playlist(playlist_id: int, req: RenamePlaylistRequest):
    name = (req.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Playlist name is required")

    conn = database.get_connection()
    try:
        playlist = database.get_playlist(conn, playlist_id)
        if not playlist:
            raise HTTPException(status_code=404, detail="Playlist not found")

        database.rename_playlist(conn, playlist_id, name)
        return {"ok": True, "id": playlist_id, "name": name}
    finally:
        conn.close()


@router.delete("/playlists/{playlist_id}")
async def delete_playlist(playlist_id: int):
    conn = database.get_connection()
    try:
        playlist = database.get_playlist(conn, playlist_id)
        if not playlist:
            raise HTTPException(status_code=404, detail="Playlist not found")

        database.delete_playlist(conn, playlist_id)
        return {"ok": True}
    finally:
        conn.close()


@router.get("/playlists/{playlist_id}/tracks")
async def get_playlist_tracks(
    playlist_id: int,
    sort: str = Query(default="position", description="Sort field"),
    order: Literal["asc", "desc"] = Query(default="asc"),
):
    conn = database.get_connection()
    try:
        playlist = database.get_playlist(conn, playlist_id)
        if not playlist:
            raise HTTPException(status_code=404, detail="Playlist not found")

        tracks = database.get_playlist_tracks(conn, playlist_id, sort_by=sort, sort_order=order)
        return {"playlist": playlist, "tracks": tracks, "total": len(tracks)}
    finally:
        conn.close()


@router.post("/playlists/{playlist_id}/tracks")
async def add_track_to_playlist(playlist_id: int, req: AddPlaylistTrackRequest):
    track_id = (req.track_id or "").strip()
    if not track_id:
        raise HTTPException(status_code=400, detail="track_id is required")

    conn = database.get_connection()
    try:
        playlist = database.get_playlist(conn, playlist_id)
        if not playlist:
            raise HTTPException(status_code=404, detail="Playlist not found")

        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")

        already_in = database.track_already_in_playlist(conn, playlist_id, track_id)
        if already_in:
            return {"ok": True, "duplicate": True}

        database.add_track_to_playlist(conn, playlist_id, track_id)
        return {"ok": True, "duplicate": False}
    finally:
        conn.close()


@router.delete("/playlists/{playlist_id}/tracks/{track_id}")
async def remove_track_from_playlist(playlist_id: int, track_id: str):
    conn = database.get_connection()
    try:
        playlist = database.get_playlist(conn, playlist_id)
        if not playlist:
            raise HTTPException(status_code=404, detail="Playlist not found")

        database.remove_track_from_playlist(conn, playlist_id, track_id)
        return {"ok": True}
    finally:
        conn.close()
