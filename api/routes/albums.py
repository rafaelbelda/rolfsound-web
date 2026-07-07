# api/routes/albums.py
"""
Álbuns como entidade. Editar um álbum aqui reflete em todas as suas faixas —
elas herdam title/year/genre/cover via JOIN (ver db.database._TRACK_SELECT),
sem cópia.
"""

import time
from io import BytesIO

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from api.track_view import cover_css
from db import database
from utils.image_processor import COVERS_DIR

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
        # Renomear um single (que carrega o título da faixa) o promove a álbum
        # de verdade — mas só quando o título de fato mudou, senão qualquer
        # save do editor promoveria sem querer.
        title = (data.get("title") or "").strip()
        if album.get("kind") == "single" and title and title != (album.get("title") or ""):
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


@router.post("/albums/{album_id}/cover")
async def upload_album_cover(album_id: str, file: UploadFile = File(...)):
    """Troca a capa do álbum (botão "Trocar capa" dos editores). A imagem vai
    para static/covers/{album_id}.jpg (mesmo diretório das capas do Discogs) e
    a URL fica em albums.cover — as faixas herdam via JOIN. O ?v= muda a cada
    troca para furar o cache do browser (o nome do arquivo é fixo)."""
    conn = database.get_connection()
    try:
        album = database.get_album(conn, album_id)
        if not album:
            raise HTTPException(status_code=404, detail="Album not found")

        raw = await file.read()
        try:
            from PIL import Image
            img = Image.open(BytesIO(raw))
            img.verify()                       # detecta arquivo que não é imagem
            img = Image.open(BytesIO(raw)).convert("RGB")
        except Exception:
            raise HTTPException(status_code=415, detail="Arquivo não é uma imagem válida")

        dest = COVERS_DIR / f"{album_id}.jpg"
        img.save(dest, "JPEG", quality=85)

        cover_url = f"/static/covers/{album_id}.jpg?v={int(time.time())}"
        database.update_album(conn, album_id, {"cover": cover_url})
        conn.commit()
        return {
            "ok": True,
            "cover": cover_url,
            "cover_css": cover_css(cover_url),
            "track_ids": database.album_ids_in_album(conn, album_id),
        }
    finally:
        conn.close()
