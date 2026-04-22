# api/routes/upload.py
import logging
from fastapi import APIRouter, UploadFile, File, HTTPException
from api.services.pipeline import LibraryManager, UploadIngestor

logger = logging.getLogger(__name__)

# O prefixo já é tratado no app.py, então a rota final será /api/upload
router = APIRouter(tags=["upload"])

# Instanciamos o nosso gestor de biblioteca MAM
# (Os caminhos devem bater com o que você configurou no seu config.py)
library_manager = LibraryManager(music_dir="./music", temp_dir="./cache/.tmp")

@router.post("/upload")
async def upload_music_file(file: UploadFile = File(...)):
    """Recebe um ficheiro de áudio via upload e processa-o na arquitetura MAM"""
    
    # 1. Validação de Segurança (Extensões)
    allowed_extensions = [".mp3", ".wav", ".flac", ".m4a", ".aiff"]
    file_ext = f".{file.filename.split('.')[-1].lower()}" if "." in file.filename else ""
    
    if file_ext not in allowed_extensions:
        raise HTTPException(
            status_code=400, 
            detail=f"Formato de arquivo não suportado. Extensões permitidas: {', '.join(allowed_extensions)}"
        )

    try:
        # 2. Leitura do arquivo em memória
        # Para arquivos de áudio padrão (10MB - 60MB), o FastAPI lida com read() perfeitamente.
        file_content = await file.read()
        
        # 3. Prepara a estratégia de ingestão de Upload
        ingestor = UploadIngestor()
        
        # 4. Envia para o Pipeline orquestrar (Salvar, criar Bundle, Inserir no SQLite)
        track_id = await library_manager.process_new_track(
            ingestor=ingestor, 
            source_data={"content": file_content, "filename": file.filename}
        )
        
        if track_id:
            logger.info(f"Upload processado com sucesso: Track ID {track_id}")
            return {
                "status": "success", 
                "message": "Música adicionada à biblioteca", 
                "track_id": track_id
            }
        else:
            raise HTTPException(status_code=500, detail="Falha silenciosa ao processar o arquivo.")
            
    except Exception as e:
        logger.error(f"Erro catastrófico no upload: {e}")
        raise HTTPException(status_code=500, detail=str(e))