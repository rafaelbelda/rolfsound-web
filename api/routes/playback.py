# api/routes/playback.py

from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from utils.core import core
from core.database import database

router = APIRouter()


class PlayRequest(BaseModel):
    track_id: str = ""
    asset_id: str | None = None  # <-- NOVO: Permite escolher a versão (1:N)
    filepath: str = ""


class SeekRequest(BaseModel):
    position: float


@router.post("/play")
async def play(req: PlayRequest = None):
    filepath = req.filepath if req else ""
    track_id = req.track_id if req else ""
    asset_id = req.asset_id if req else None

    # --- INÍCIO DA INTELIGÊNCIA MAM ---
    # Se recebemos um track_id mas o Frontend não enviou o ficheiro físico,
    # vamos à tabela 'assets' descobrir qual versão carregar.
    if track_id and not filepath:
        conn = database.get_connection()
        try:
            if asset_id:
                # O utilizador clicou numa versão específica (ex: FLAC ou Remix)
                row = database.get_asset(conn, asset_id)
            else:
                # O utilizador só deu "Play" genérico; tocamos a versão padrão
                row = database.get_fast_play_asset(conn, track_id)
            
            if row:
                filepath = row["file_path"]
        finally:
            conn.close()
            
        # Se pedimos uma música nova, mas ela não tem ficheiro físico registado
        if not filepath:
            raise HTTPException(status_code=404, detail="Ficheiro físico não encontrado para esta versão.")
    # --- FIM DA INTELIGÊNCIA MAM ---

    # Resolve to absolute path before sending to core.
    # Core runs in a different working directory — relative paths like
    # "music/track.webm" would resolve to the wrong location in core's CWD.
    # Guard: only resolve non-empty strings — Path("").resolve() returns CWD
    # which would be sent as a bogus filepath.
    if filepath:
        filepath = str(Path(filepath).resolve())

    # Pass None (not empty string) so core skips adding to the dict.
    # Core receiving {"filepath": ""} is treated as no filepath provided.
    result = await core.play(
        filepath=filepath if filepath else None,
        track_id=track_id if track_id else None,
    )
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/pause")
async def pause():
    result = await core.pause()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/skip")
async def skip():
    result = await core.skip()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/seek")
async def seek(req: SeekRequest):
    result = await core.seek(req.position)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result
