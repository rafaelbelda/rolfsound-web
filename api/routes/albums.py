# api/routes/albums.py
"""
Álbuns como entidade. Editar um álbum aqui reflete em todas as suas faixas —
elas herdam title/year/genre via JOIN (ver db.database._TRACK_SELECT), sem cópia.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import database

router = APIRouter()


class AlbumMetadataUpdate(BaseModel):
    title: str | None = None
    artist: str | None = None
    year: int | None = None
    genre: str | None = None
    total_tracks: int | None = None      # "número de músicas" (null = derivar)
    cover: str | None = None
    kind: str | None = None


@router.get("/albums")
async def list_albums():
    conn = database.get_connection()
    try:
        return {"albums": database.list_albums(conn)}
    finally:
        conn.close()


@router.get("/albums/{album_id}")
async def get_album(album_id: str):
    conn = database.get_connection()
    try:
        album = database.get_album(conn, album_id)
        if not album:
            raise HTTPException(status_code=404, detail="Album not found")
        return album
    finally:
        conn.close()


@router.patch("/albums/{album_id}")
async def update_album_route(album_id: str, req: AlbumMetadataUpdate):
    """Salva edições do álbum. Devolve o álbum e os ids das faixas afetadas
    (a UI atualiza os datasets dessas linhas)."""
    conn = database.get_connection()
    try:
        album = database.get_album(conn, album_id)
        if not album:
            raise HTTPException(status_code=404, detail="Album not found")
        data = req.model_dump(exclude_unset=True)
        # Renomear um single para algo != "Single" o promove a álbum de verdade.
        title = (data.get("title") or "").strip()
        if album.get("kind") == "single" and title and title != "Single":
            data.setdefault("kind", "album")
        database.update_album(conn, album_id, data)
        conn.commit()
        return {
            "ok": True,
            "album": database.get_album(conn, album_id),
            "track_ids": database.album_ids_in_album(conn, album_id),
        }
    finally:
        conn.close()
