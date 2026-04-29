# api/routes/queue.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from pathlib import Path
from typing import Literal
from utils.core import core
from core.database import database

router = APIRouter()


class AddRequest(BaseModel):
    track_id: str
    asset_id: str | None = None
    filepath: str = ""
    title: str = ""
    thumbnail: str = ""
    position: int | None = None


class RemoveRequest(BaseModel):
    position: int | None = None
    index: int | None = None    # intent.queue.remove sends {index}

    @property
    def resolved(self) -> int:
        v = self.index if self.index is not None else self.position
        if v is None:
            raise ValueError("position or index required")
        return v


class MoveRequest(BaseModel):
    # intent.queue.move sends {from, to} — "from" is a Python keyword so aliases needed
    model_config = {"populate_by_name": True}
    from_pos: int | None = Field(None, alias="from")
    to_pos:   int | None = Field(None, alias="to")

    @property
    def resolved_from(self) -> int:
        if self.from_pos is None:
            raise ValueError("from required")
        return self.from_pos

    @property
    def resolved_to(self) -> int:
        if self.to_pos is None:
            raise ValueError("to required")
        return self.to_pos


class RepeatRequest(BaseModel):
    mode: Literal["off", "one", "all"]


class ShuffleRequest(BaseModel):
    enabled: bool


class SaveAsPlaylistRequest(BaseModel):
    name: str


@router.get("/queue")
async def get_queue():
    result = await core.get_queue()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/add")
async def add_to_queue(req: AddRequest):
    artist = ""
    
    # Lógica MAM: Precisamos do caminho do ficheiro físico (Asset) e dos metadados (Track)
    if req.track_id:
        conn = database.get_connection()
        try:
            # 1. Puxa os Metadados (O conceito da música)
            track_meta = database.get_track(conn, req.track_id)
            if track_meta:
                if not req.title: req.title = track_meta.get("title", "")
                if not req.thumbnail: req.thumbnail = track_meta.get("thumbnail", "")
                artist = track_meta.get("display_artist", track_meta.get("artist", ""))

            # 2. Puxa o Ficheiro Físico (A versão da música)
            if not req.filepath:
                if req.asset_id:
                # O utilizador exigiu uma versão específica (ex: FLAC)
                    row = database.get_asset(conn, req.asset_id)
                else:
                # Fallback: Toca a versão padrão / primeira que encontrar
                    row = database.get_fast_play_asset(conn, req.track_id)
            
                if row:
                    req.filepath = row["file_path"]

        finally:
            conn.close()

    # Se mesmo após a procura não houver ficheiro físico, aborta.
    if not req.filepath:
        raise HTTPException(status_code=404, detail="Ficheiro de áudio físico não encontrado.")

    req.filepath = str(Path(req.filepath).resolve())

    result = await core.queue_add(
        req.track_id, req.filepath, req.title,
        thumbnail=req.thumbnail, artist=artist, position=req.position,
    )
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/remove")
async def remove_from_queue(req: RemoveRequest):
    result = await core.queue_remove(req.resolved)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/move")
async def move_in_queue(req: MoveRequest):
    result = await core.queue_move(req.resolved_from, req.resolved_to)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/clear")
async def clear_queue():
    result = await core.queue_clear()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


# Fix: add /queue/previous so the skip-back button in the dashboard works.
# The dashboard calls API.skipBack() -> POST /api/queue/previous.
@router.post("/queue/previous")
async def previous_in_queue():
    result = await core.queue_previous()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/repeat")
async def set_repeat(req: RepeatRequest):
    result = await core.queue_repeat(req.mode)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/shuffle")
async def set_shuffle(req: ShuffleRequest):
    result = await core.queue_shuffle(req.enabled)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/queue/save-as-playlist")
async def save_queue_as_playlist(req: SaveAsPlaylistRequest):
    from core.database import database
    queue_data = await core.get_queue()
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
