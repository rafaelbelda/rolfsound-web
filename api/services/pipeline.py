# api/services/pipeline.py
import os
import uuid
import time
import asyncio
import logging
import shutil
from pathlib import Path
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional

from db import database
# Importamos o indexer para disparar a tarefa em background
from api.services.indexer import index_file 

logger = logging.getLogger(__name__)

# ── 1. AS ESTRATÉGIAS DE INGESTÃO (SOURCES) ──────────────────────────────────

class MusicIngestor(ABC):
    """Classe base para qualquer fonte que traga música para o Rolfsound."""
    
    @abstractmethod
    async def fetch_media(self, source_data: Any, temp_dir: str) -> Dict[str, Any]:
        """
        Deve retornar:
        - temp_path: Caminho do ficheiro descarregado/recebido no cache
        - filename: Nome original do ficheiro (usado como título provisório)
        - source: String da origem (YOUTUBE, UPLOAD, VINYL_RIP)
        """
        pass


class UploadIngestor(MusicIngestor):
    async def fetch_media(self, source_data: dict, temp_dir: str) -> Dict[str, Any]:
        file_content = source_data["content"]
        original_filename = source_data["filename"]
        
        # Guarda o buffer recebido da web numa pasta temporária de forma segura
        ext = Path(original_filename).suffix.lower()
        temp_file = os.path.join(temp_dir, f"upload_{uuid.uuid4().hex}{ext}")
        
        with open(temp_file, "wb") as f:
            f.write(file_content)
            
        return {
            "temp_path": temp_file,
            "filename": Path(original_filename).stem, # Tira a extensão (ex: "Bitch_master_v2")
            "source": "UPLOAD"
        }

# ── 2. O GESTOR DA BIBLIOTECA (MAM PIPELINE) ────────────────────────────────

class LibraryManager:
    def __init__(self, music_dir: str = "./music", temp_dir: str = "./cache/.tmp"):
        self.music_dir = Path(music_dir)
        self.temp_dir = Path(temp_dir)
        self.music_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        
    async def process_new_track(self, ingestor: MusicIngestor, source_data: Any) -> Optional[str]:
        """
        O fluxo mestre (Latência Zero para o Frontend):
        1. Ingestão -> 2. Bundle Creation -> 3. DB Insert -> 4. Async Indexing
        """
        
        # 1. INGESTÃO: Traz o ficheiro para o ecossistema (/cache)
        media_info = await ingestor.fetch_media(source_data, str(self.temp_dir))
        temp_path = media_info["temp_path"]
        
        if not os.path.exists(temp_path):
            logger.error("Pipeline: Ingestor falhou em disponibilizar o ficheiro temporário.")
            return None
            
        file_format = Path(temp_path).suffix.replace(".", "").upper()
        track_id = str(uuid.uuid4())
        
        logger.info(f"Pipeline: A iniciar MAM Bundle para Track ID {track_id}")

        # 2. ARMAZENAMENTO FÍSICO (O Padrão Bundle)
        # Cria a pasta isolada para a música: /music/1234-abcd/
        track_bundle_dir = self.music_dir / track_id
        track_bundle_dir.mkdir(parents=True, exist_ok=True)
        
        final_file_name = f"original_mix.{file_format.lower()}"
        final_dest_path = track_bundle_dir / final_file_name
        
        # Move do cache para a library permanente
        shutil.move(temp_path, final_dest_path)

        # 3. BASE DE DADOS (Criação do Placeholder)
        track_data = {
            "id": track_id,
            "title": media_info["filename"], # Título provisório (o nome do ficheiro)
            "artist": "",                    # Desconhecido até o Indexer avaliar
            "date_added": int(time.time()),
            "status": "unidentified",        # Estado fundamental!
            "file_path": str(final_dest_path), 
            "source": media_info["source"]
        }
        
        conn = database.get_connection()
        try:
            # O seu database.py atualizado vai criar a entrada em 'tracks' e em 'assets'
            database.insert_track(conn, track_data)
            conn.commit()
            logger.info(f"Pipeline: Ficheiro guardado e placeholder criado com sucesso.")
        except Exception as e:
            logger.error(f"Pipeline: Erro a guardar na DB: {e}")
            return None
        finally:
            conn.close()

        # 4. O SEGREDO DA LATÊNCIA ZERO: Handoff Assíncrono
        # Disparamos o Indexer em background. O FastAPI não vai ficar à espera que 
        # o Shazam ou o FFMPEG terminem para devolver o Track ID ao utilizador.
        asyncio.create_task(self._trigger_indexer(track_id, str(final_dest_path)))
            
        # 5. Retorna imediatamente para a UI poder mostrar o Toast de "Sucesso"
        return track_id

    async def _trigger_indexer(self, track_id: str, file_path: str):
        """Wrapper isolado para garantir que falhas no Indexer não quebram o processo."""
        try:
            logger.info(f"Pipeline: A delegar Track ID {track_id} para o Indexer em background...")
            # Chama a função que já existe no seu indexer.py atual
            await index_file(track_id, file_path)
            
            # (O Indexer cuidará de fazer o UPDATE na base de dados 
            # e disparar o WebSocket via state_broadcaster para a UI)
        except Exception as e:
            logger.error(f"Pipeline: O Indexer falhou no processamento de {track_id}: {e}")