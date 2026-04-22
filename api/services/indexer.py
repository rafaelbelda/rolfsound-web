# api/services/indexer.py

import asyncio
import logging
import subprocess
import json
import httpx
import os
import sys
import time
from pathlib import Path
from tinytag import TinyTag

from utils import config as cfg
from db import database

logger = logging.getLogger(__name__)

ACOUSTID_KEY = "inv3qSYC56"

# fpcalc binary — resolves from project root on all platforms.
_ROOT   = Path(__file__).parent.parent.parent
_FPCALC = str(_ROOT / ("fpcalc.exe" if sys.platform == "win32" else "fpcalc"))

_USER_AGENT = "Rolfsound/1.0"
_SHAZAM_WORKER = str(Path(__file__).parent / "_shazam_worker.py")
_SHAZAM_TIMEOUT = 30  # seconds

# Semáforo para proteger o Raspberry Pi: Limita a 2 o número de instâncias do FFMPEG a correr em simultâneo
BPM_SEMAPHORE = asyncio.Semaphore(2)


# ── FASE 1: LEITURA DE METADADOS LOCAIS ──────────────────────────────────────

def extract_local_tags(file_path: str, track_id: str) -> dict:
    """Lê as tags ID3/FLAC locais e extrai a capa embutida se existir."""
    result = {
        "title": None,
        "artist": None,
        "album": None,
        "year": None,
        "duration": None,
        "thumbnail": None
    }
    
    try:
        tag = TinyTag.get(file_path, image=True)
        
        result["title"] = tag.title
        result["artist"] = tag.artist or tag.albumartist
        result["album"] = tag.album
        result["year"] = int(tag.year[:4]) if tag.year else None
        result["duration"] = tag.duration
        
        image_data = tag.get_image()
        if image_data:
            music_dir = Path(cfg.get("music_directory", "./music"))
            cover_path = music_dir / track_id / "cover.jpg"
            cover_path.parent.mkdir(parents=True, exist_ok=True)
            
            with open(cover_path, "wb") as f:
                f.write(image_data)
                
            result["thumbnail"] = str(cover_path)
            logger.info(f"Capa local extraída com sucesso para {track_id}")
            
    except Exception as e:
        logger.warning(f"Não foi possível ler as tags locais de {file_path}: {e}")
        
    return result


# ── FASE 2: MÉTODOS DE IDENTIFICAÇÃO (INTERNET) ──────────────────────────────

def _discogs_auth_header() -> str | None:
    """Retorna o header Authorization OAuth do utilizador conectado, ou None."""
    import urllib.parse, uuid
    conn = database.get_connection()
    try:
        account = database.get_discogs_account(conn)
    finally:
        conn.close()

    if not account:
        return None 

    ck = cfg.get("discogs_consumer_key", "")
    cs = cfg.get("discogs_consumer_secret", "")
    at = account["access_token"]
    as_ = account["access_secret"]

    params = {
        "oauth_consumer_key":     ck,
        "oauth_nonce":            uuid.uuid4().hex,
        "oauth_signature_method": "PLAINTEXT",
        "oauth_timestamp":        str(int(time.time())),
        "oauth_token":            at,
        "oauth_version":          "1.0",
        "oauth_signature":        f"{urllib.parse.quote(cs, safe='')}&{urllib.parse.quote(as_, safe='')}",
    }
    parts = ", ".join(f'{k}="{urllib.parse.quote(v, safe="")}"' for k, v in sorted(params.items()))
    return f"OAuth {parts}"


async def fingerprint(path: str) -> dict | None:
    """Gera impressão digital digital (Chromaprint)."""
    try:
        import acoustid
        import av
        import numpy as np

        TARGET_SR  = 44100 
        N_CHANNELS = 2     
        MAX_SECONDS = 120  

        frames: list[np.ndarray] = []
        collected = 0
        duration = 0.0

        with av.open(path) as container:
            if container.duration:
                duration = container.duration / 1_000_000 

            resampler = av.audio.resampler.AudioResampler(format="s16", layout="stereo", rate=TARGET_SR)
            max_samples = TARGET_SR * N_CHANNELS * MAX_SECONDS

            for packet in container.demux(audio=0):
                for frame in packet.decode():
                    resampled = resampler.resample(frame)
                    for rf in (resampled if isinstance(resampled, list) else [resampled]):
                        arr = rf.to_ndarray().flatten()
                        remaining = max_samples - collected
                        frames.append(arr[:remaining])
                        collected += min(len(arr), remaining)
                    if collected >= max_samples:
                        break
                if collected >= max_samples:
                    break

        if not frames:
            raise RuntimeError("no audio frames decoded")

        if duration <= 0:
            duration = collected / (TARGET_SR * N_CHANNELS)

        pcm = np.concatenate(frames).astype(np.int16).tobytes()
        fp_str = acoustid.fingerprint(TARGET_SR, N_CHANNELS, [pcm])

        return {"duration": duration, "fingerprint": fp_str}

    except ImportError:
        logger.debug("libchromaprint not available, falling back to fpcalc")
    except Exception as e:
        logger.debug(f"pyacoustid fingerprint failed ({e}), falling back to fpcalc")

    result = subprocess.run([_FPCALC, "-json", path], capture_output=True, text=True)
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


async def lookup_acoustid(fp: dict) -> dict | None:
    """Procura metadados no AcoustID baseados na impressão digital."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            "https://api.acoustid.org/v2/lookup",
            params={
                "client":      ACOUSTID_KEY,
                "duration":    int(fp["duration"]),
                "fingerprint": fp["fingerprint"],
                "meta":        "recordings+releasegroups+compress",
            }
        )
    data = r.json()
    results = data.get("results", [])
    if not results:
        return None

    best = max(results, key=lambda x: x.get("score", 0))
    if best.get("score", 0) < 0.8:
        return None

    recordings = best.get("recordings", [])
    return recordings[0] if recordings else None


async def lookup_shazam(file_path: str) -> dict | None:
    """Identifica a faixa via Shazam através de áudio gravado."""
    import tempfile
    import numpy as np

    tmp_wav = None
    try:
        import av
        fd, tmp_wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)

        TARGET_SR = 16000
        MAX_SAMPLES = TARGET_SR * 20  
        frames: list[np.ndarray] = []
        collected = 0
        
        with av.open(file_path) as container:
            resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=TARGET_SR)
            for packet in container.demux(audio=0):
                for frame in packet.decode():
                    resampled = resampler.resample(frame)
                    for rf in (resampled if isinstance(resampled, list) else [resampled]):
                        arr = rf.to_ndarray().flatten()
                        remaining = MAX_SAMPLES - collected
                        frames.append(arr[:remaining])
                        collected += min(len(arr), remaining)
                    if collected >= MAX_SAMPLES:
                        break
                if collected >= MAX_SAMPLES:
                    break

        if not frames:
            return None

        pcm = np.concatenate(frames).astype(np.int16).tobytes()

        import wave
        with wave.open(tmp_wav, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(TARGET_SR)
            wf.writeframes(pcm)

        proc = await asyncio.create_subprocess_exec(
            sys.executable, _SHAZAM_WORKER, tmp_wav,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=_SHAZAM_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return None

        if proc.returncode != 0:
            return None

        line = (stdout or b"").decode("utf-8", errors="replace").strip().splitlines()
        payload = line[-1] if line else "null"
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            return None

        if not data:
            return None
            
        return {"artist": data.get("artist", ""), "title": data.get("title", "")}
    except Exception:
        return None
    finally:
        if tmp_wav and os.path.exists(tmp_wav):
            os.remove(tmp_wav)


async def lookup_discogs(artist: str, title: str) -> dict | None:
    """Busca dados de lançamento, capas em alta definição e editora."""
    headers = {"User-Agent": _USER_AGENT}
    base_params: dict = {"q": f"{artist} {title}".strip()}

    auth = _discogs_auth_header()
    if auth:
        headers["Authorization"] = auth
    else:
        ck = cfg.get("discogs_consumer_key", "")
        cs = cfg.get("discogs_consumer_secret", "")
        if ck and cs:
            base_params["key"]    = ck
            base_params["secret"] = cs

    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            "https://api.discogs.com/database/search",
            params={**base_params, "type": "master"},
            headers=headers,
        )
        masters = r.json().get("results", [])
        if masters:
            master = masters[0]
            mid = master.get("id")
            if mid:
                try:
                    mr = await client.get(f"https://api.discogs.com/masters/{mid}", headers=headers)
                    if mr.status_code == 200:
                        full = mr.json()
                        images = full.get("images", [])
                        primary = next((i for i in images if i.get("type") == "primary"), None)
                        best = primary or (images[0] if images else None)
                        if best:
                            master["cover_image"] = best["uri"]
                except Exception:
                    pass
            return master

        r = await client.get(
            "https://api.discogs.com/database/search",
            params={**base_params, "type": "release"},
            headers=headers,
        )
        results = r.json().get("results", [])
        if not results:
            return None

        with_master = [x for x in results if x.get("master_id")]
        non_vinyl   = [x for x in results if "Vinyl" not in x.get("format", [])]
        release = (with_master or non_vinyl or results)[0]

        master_id = release.get("master_id")
        if master_id:
            try:
                mr = await client.get(f"https://api.discogs.com/masters/{master_id}", headers=headers)
                if mr.status_code == 200:
                    master_data = mr.json()
                    images = master_data.get("images", [])
                    primary = next((i for i in images if i.get("type") == "primary"), None)
                    best = primary or (images[0] if images else None)
                    if best:
                        release["cover_image"] = best["uri"]
            except Exception:
                pass

    return release


# ── FASE 3: PROTEÇÃO DO FFMPEG (SEMAPHORE) ───────────────────────────────────

async def detect_bpm(file_path: str) -> int | None:
    """Usa o filtro nativo do FFMPEG com limite de instâncias concorrentes."""
    import re
    # Bloqueia a execução se já existirem 2 FFMPEGs a correr
    async with BPM_SEMAPHORE:
        try:
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg", "-i", file_path, "-af", "bpm", "-f", "null", "-",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=45.0)
            output = stderr.decode("utf-8", errors="ignore")
            
            match = re.search(r"BPM:\s*([\d\.]+)", output)
            if match:
                bpm_float = float(match.group(1))
                return int(round(bpm_float))
        except asyncio.TimeoutError:
            proc.kill()
            logger.warning(f"Timeout na deteção de BPM para {file_path}")
        except Exception as e:
            logger.warning(f"Falha na deteção de BPM para {file_path}: {e}")
            
    return None


# ── FASE 4: O NOVO FLUXO INTELIGENTE DE IDENTIFICAÇÃO ────────────────────────

async def identify_track(file_path: str, track_id: str, fallback_title: str = "") -> dict:
    """
    O Fluxo de Prioridades:
    1. Tags Locais -> 2. Fingerprint (AcoustID) -> 3. Áudio (Shazam) -> 4. Enriquecimento (Discogs)
    """
    
    local_tags = await asyncio.to_thread(extract_local_tags, file_path, track_id)
    
    artist = local_tags.get("artist")
    title  = local_tags.get("title")
    thumbnail = local_tags.get("thumbnail")
    year = local_tags.get("year")
    duration = local_tags.get("duration")
    mb_id = None
    raw_fp = None

    # Recorre à identificação web apenas se os metadados locais faltarem
    if not title or not artist:
        logger.info(f"Indexer [{track_id}]: Metadados incompletos, a iniciar Fingerprint...")
        fp = await fingerprint(file_path)
        
        if fp:
            duration = duration or fp["duration"]
            raw_fp = fp["fingerprint"]
            
            recording = await lookup_acoustid(fp)
            if recording:
                artist = recording["artists"][0]["name"] if recording.get("artists") else None
                title  = recording.get("title")
                mb_id  = recording.get("id")

            if not title:
                shazam = await lookup_shazam(file_path)
                if shazam:
                    artist = shazam["artist"]
                    title  = shazam["title"]

    # Fallback: limpar o nome do ficheiro para não apresentar "[OFFICIAL VIDEO]"
    if not title and fallback_title:
        import re
        title = re.sub(
            r"\s*[\(\[].*[\)\]]|\s+-\s+(?:official.*|lyric.*)|\s+\|\s+.*$",
            "", fallback_title, flags=re.IGNORECASE
        ).strip(" -") or fallback_title

    if not title:
        return {"status": "unidentified", "reason": "no_match", "raw_fp": raw_fp}

    # Enriquecimento com Discogs (Busca capas HQ se a tag local não tiver)
    discogs = None
    if title and (not thumbnail or not year):
        logger.info(f"Indexer [{track_id}]: A buscar enriquecimento visual no Discogs...")
        discogs = await lookup_discogs(artist or "", title)

    if discogs and not artist:
        raw_artists = discogs.get("title", "")
        if " - " in raw_artists:
            artist, title = raw_artists.split(" - ", 1)

    return {
        "status":          "identified",
        "title":           title,
        "artist":          artist,
        "duration":        duration,
        "mb_recording_id": mb_id,
        "discogs_id":      discogs.get("id") if discogs else None,
        "thumbnail":       thumbnail or (discogs.get("cover_image") if discogs else None),
        "label":           discogs.get("label", [None])[0] if discogs else None,
        "year":            year or (discogs.get("year") if discogs else None),
        "raw_fp":          raw_fp
    }


# ── FASE 5: O ORQUESTRADOR FINAL E BROADCASTER ────────────────────────────────

async def index_file(track_id: str, file_path: str) -> dict:
    """Avalia a faixa e notifica a UI instantaneamente via WebSocket."""
    # Importado localmente para evitar circular imports
    from api.ws.endpoint import get_manager as get_ws_manager 
    
    fallback_title = ""
    conn = database.get_connection()
    try:
        row = database.get_track(conn, track_id)
        if row:
            fallback_title = row.get("title") or ""
    finally:
        conn.close()

    # Passamos o track_id para ele saber onde guardar as capas extraídas
    meta = await identify_track(file_path, track_id, fallback_title=fallback_title)
    
    logger.info(f"index_file {track_id}: status={meta['status']}")

    update: dict = {"status": meta["status"]}
    if meta["status"] == "identified":
        update.update({
            "title":           meta.get("title"),
            "artist":          meta.get("artist"),
            "duration":        meta.get("duration"),
            "mb_recording_id": meta.get("mb_recording_id"),
            "discogs_id":      meta.get("discogs_id"),
            "label":           meta.get("label"),
            "year":            meta.get("year"),
        })
        if meta.get("thumbnail"):
            update["thumbnail"] = meta["thumbnail"]

    logger.debug(f"A iniciar cálculo de BPM protegido para {track_id}...")
    bpm = await detect_bpm(file_path)
    if bpm:
        update["bpm"] = bpm
        logger.debug(f"BPM detetado para {track_id}: {bpm}")

    if meta.get("raw_fp"):
        update["fingerprint"] = meta["raw_fp"]

    # 1. Guarda tudo na Base de Dados
    conn = database.get_connection()
    try:
        database.update_track_metadata(conn, track_id, update)
        conn.commit()
        
        # 2. BROADCAST (Latência Zero de UI)
        ws_manager = get_ws_manager()
        if ws_manager:
            # Pega o registo completo e atualizado para a UI receber a verdade absoluta
            full_track = database.get_track(conn, track_id)
            if full_track:
                await ws_manager.broadcast({
                    "type": "event.track_updated",
                    "payload": full_track,
                    "ts": int(time.time() * 1000)
                })
                logger.info(f"UI notificada via WebSocket para a Track {track_id}")
                
    except Exception as e:
        logger.error(f"Erro ao atualizar DB ou disparar broadcast em {track_id}: {e}")
    finally:
        conn.close()

    return meta