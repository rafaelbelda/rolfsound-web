# api/routes/recognition.py

import os
import asyncio
import logging
from fastapi import APIRouter, HTTPException
from shazamio import Shazam

router = APIRouter()
logger = logging.getLogger(__name__)

# Instância global do Shazam
_shazam = Shazam()

# Caminho temporário na RAM do Linux (super rápido e não gasta o cartão SD)
LISTEN_FILE = "/tmp/rolfsound_listen.wav"

async def _record_audio_snippet(duration: int = 5):
    """
    Grava um trecho de áudio usando o ALSA nativo do Raspberry Pi.
    Nota de Hardware: O parâmetro '-D plughw:1,0' define qual placa de som usar.
    Você precisará ajustar isso para a sua placa de áudio conectada via USB.
    """
    # Exemplo de comando ALSA: 
    # arecord -D plughw:1,0 -f cd -d 5 /tmp/rolfsound_listen.wav
    # -f cd: Qualidade de CD (16 bit little endian, 44100, stereo)
    # -d 5: Duração em segundos
    
    # ATENÇÃO: Se omitir o '-D plughw:1,0', ele usará o microfone padrão do sistema.
    cmd = [
        "arecord",
        "-f", "cd",
        "-d", str(duration),
        "-q", # Modo silencioso (sem poluir o log)
        LISTEN_FILE
    ]

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    
    stdout, stderr = await process.communicate()
    
    if process.returncode != 0:
        logger.error(f"Erro na captura de áudio: {stderr.decode()}")
        raise Exception("Falha ao gravar o áudio do hardware.")

@router.post("/recognize")
async def recognize_now_playing():
    """
    Ouve o ambiente por 5 segundos e bate na API do Shazam.
    """
    try:
        # 1. Escuta o Vinil
        logger.info("Iniciando escuta acústica (5s)...")
        await _record_audio_snippet(duration=5)
        
        # Verifica se o arquivo foi realmente criado
        if not os.path.exists(LISTEN_FILE):
            raise HTTPException(status_code=500, detail="Arquivo de áudio não foi gerado.")

        # 2. Analisa com o Shazamio
        logger.info("Enviando assinatura para o Shazam...")
        out = await _shazam.recognize_song(LISTEN_FILE)
        
        # 3. Limpa a bagunça
        os.remove(LISTEN_FILE)

        # 4. Trata a resposta (O JSON do Shazam é gigante, pegamos só o que importa)
        if not out.get('track'):
            return {"match": False, "message": "Nenhuma música identificada."}
            
        track = out['track']
        
        # O Shazam esconde as imagens de alta qualidade dentro da chave 'images'
        images = track.get('images', {})
        coverart = images.get('coverarthq') or images.get('coverart') or ""

        return {
            "match": True,
            "title": track.get('title', 'Unknown Title'),
            "artist": track.get('subtitle', 'Unknown Artist'), # Shazam chama o artista principal de subtitle
            "cover": coverart,
            "shazam_url": track.get('share', {}).get('href', '')
        }

    except Exception as e:
        logger.error(f"Erro no reconhecimento acústico: {e}")
        raise HTTPException(status_code=503, detail="Serviço de reconhecimento indisponível.")