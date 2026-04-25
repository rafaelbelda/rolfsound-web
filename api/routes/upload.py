# api/routes/upload.py
import logging
from typing import List
from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from api.services.pipeline import LibraryManager, UploadIngestor

logger = logging.getLogger(__name__)

# O prefixo já é tratado no app.py, então a rota final será /api/upload
router = APIRouter(tags=["upload"])

# Instanciamos o nosso gestor de biblioteca MAM
library_manager = LibraryManager(music_dir="./music", temp_dir="./cache/.tmp")

@router.post("/upload")
async def upload_music_file(
    files: List[UploadFile] = File(...),
    target_track_id: str | None = Form(None),
    asset_type: str = Form("ORIGINAL_MIX"),
):
    """Recebe um ou mais ficheiros de áudio via upload e processa-os na arquitetura MAM"""
    
    allowed_extensions = [".mp3", ".wav", ".flac", ".m4a", ".aiff"]
    processed_tracks = []

    # Iteramos sobre todos os ficheiros que o utilizador arrastou para a UI
    for file in files:
        file_ext = f".{file.filename.split('.')[-1].lower()}" if "." in file.filename else ""
        
        # Ignora silenciosamente ficheiros que não são de áudio (ex: imagens arrastadas por engano)
        if file_ext not in allowed_extensions:
            logger.warning(f"Ficheiro ignorado (extensão inválida): {file.filename}")
            continue 

        try:
            # Leitura do arquivo em memória
            file_content = await file.read()
            ingestor = UploadIngestor()
            
            # Envia para o Pipeline orquestrar
            track_id = await library_manager.process_new_track(
                ingestor=ingestor, 
                source_data={
                    "content": file_content,
                    "filename": file.filename,
                    "target_track_id": target_track_id,
                    "asset_type": asset_type,
                }
            )
            
            if track_id:
                processed_tracks.append(track_id)
                logger.info(f"Upload processado com sucesso: Track ID {track_id}")
                
        except Exception as e:
            logger.error(f"Erro ao processar {file.filename}: {e}")
            # Em vez de quebrar tudo com Raise, continuamos para tentar salvar as outras músicas do lote

    # Se nenhum ficheiro foi processado com sucesso, devolvemos erro
    if not processed_tracks:
        raise HTTPException(status_code=400, detail="Nenhum ficheiro de áudio válido foi processado.")

    return {
        "status": "success", 
        "message": f"{len(processed_tracks)} música(s) adicionada(s) à biblioteca", 
        "track_ids": processed_tracks
    }
