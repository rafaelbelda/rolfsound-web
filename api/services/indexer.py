# api/services/indexer.py

import logging
import subprocess
import json
import httpx
from pathlib import Path

from utils import config as cfg

logger = logging.getLogger(__name__)

ACOUSTID_KEY = "inv3qSYC56"

# fpcalc binary — resolves from project root on all platforms.
# On Windows: fpcalc.exe; on Linux/Mac: fpcalc (no extension).
_ROOT   = Path(__file__).parent.parent.parent
_FPCALC = str(_ROOT / ("fpcalc.exe" if __import__("sys").platform == "win32" else "fpcalc"))

_USER_AGENT = "Rolfsound/1.0"


def _discogs_auth_header() -> str | None:
    """Retorna o header Authorization OAuth do usuário conectado, ou None."""
    import urllib.parse, uuid, time as _time
    from db import database
    from utils import config as cfg

    conn = database.get_connection()
    try:
        account = database.get_discogs_account(conn)
    finally:
        conn.close()

    if not account:
        return None  # no OAuth account — caller falls back to key/secret or unauthenticated

    ck = cfg.get("discogs_consumer_key", "")
    cs = cfg.get("discogs_consumer_secret", "")
    at = account["access_token"]
    as_ = account["access_secret"]

    params = {
        "oauth_consumer_key":     ck,
        "oauth_nonce":            uuid.uuid4().hex,
        "oauth_signature_method": "PLAINTEXT",
        "oauth_timestamp":        str(int(_time.time())),
        "oauth_token":            at,
        "oauth_version":          "1.0",
        "oauth_signature":        f"{urllib.parse.quote(cs, safe='')}&{urllib.parse.quote(as_, safe='')}",
    }
    parts = ", ".join(f'{k}="{urllib.parse.quote(v, safe="")}"' for k, v in sorted(params.items()))
    return f"OAuth {parts}"


async def fingerprint(path: str) -> dict | None:
    """Returns {duration, fingerprint} or None.

    Primary path: pyacoustid + PyAV — no binary needed.
      Requires libchromaprint to be available:
        - Raspberry Pi: apt install libchromaprint1
        - Windows dev: install chromaprint.dll manually (or use fpcalc fallback)

    Fallback path: fpcalc subprocess (fpcalc / fpcalc.exe on PATH or project root).
    """
    # --- Primary: pyacoustid + PyAV ---
    try:
        import acoustid
        import av
        import numpy as np

        TARGET_SR  = 44100   # Chromaprint works best at 44100 Hz
        N_CHANNELS = 2       # stereo matches fpcalc default
        MAX_SECONDS = 120    # Chromaprint fingerprints only the first 120s

        frames: list[np.ndarray] = []
        collected = 0
        duration = 0.0

        with av.open(path) as container:
            if container.duration:
                duration = container.duration / 1_000_000  # µs → s

            resampler = av.audio.resampler.AudioResampler(
                format="s16", layout="stereo", rate=TARGET_SR
            )
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

        logger.debug(f"fingerprint (pyacoustid): duration={duration:.1f}s")
        return {"duration": duration, "fingerprint": fp_str}

    except ImportError:
        logger.debug("libchromaprint not available, falling back to fpcalc")
    except Exception as e:
        logger.debug(f"pyacoustid fingerprint failed ({e}), falling back to fpcalc")

    # --- Fallback: fpcalc subprocess ---
    try:
        result = subprocess.run(
            [_FPCALC, "-json", path],
            capture_output=True, text=True
        )
    except OSError as e:
        logger.debug(f"fpcalc unavailable ({e}), no fingerprint for {path}")
        return None
    if result.returncode != 0:
        logger.warning(f"fpcalc failed (returncode={result.returncode}): {result.stderr.strip()}")
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


async def lookup_acoustid(fp: dict) -> dict | None:
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
        logger.debug(f"acoustid: no results (status={data.get('status')})")
        return None

    best = max(results, key=lambda x: x.get("score", 0))
    logger.debug(f"acoustid: best score={best.get('score')} recordings={len(best.get('recordings', []))}")
    if best.get("score", 0) < 0.8:
        logger.debug(f"acoustid: score too low ({best.get('score')})")
        return None

    recordings = best.get("recordings", [])
    if not recordings:
        logger.debug("acoustid: match found but no recordings attached")
    return recordings[0] if recordings else None


async def lookup_shazam(file_path: str) -> dict | None:
    """Identifica a faixa via Shazam. Retorna {artist, title} ou None."""
    import tempfile, os
    import numpy as np

    # Converte para WAV mono 16kHz via PyAV (sem ffmpeg.exe externo).
    # Apenas os primeiros 20s bastam para o Shazam reconhecer a faixa.
    tmp_wav = None
    try:
        import av
        fd, tmp_wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)

        TARGET_SR = 16000
        MAX_SAMPLES = TARGET_SR * 20  # 20 segundos

        frames: list[np.ndarray] = []
        collected = 0
        with av.open(file_path) as container:
            resampler = av.audio.resampler.AudioResampler(
                format="s16", layout="mono", rate=TARGET_SR
            )
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
            logger.warning("shazam: PyAV não conseguiu decodificar o arquivo")
            return None

        pcm = np.concatenate(frames).astype(np.int16).tobytes()

        # Escreve WAV manualmente (header PCM 16-bit mono)
        import wave
        with wave.open(tmp_wav, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(TARGET_SR)
            wf.writeframes(pcm)

        if not os.path.exists(tmp_wav) or os.path.getsize(tmp_wav) == 0:
            logger.warning("shazam: WAV vazio após conversão")
            return None

        from shazamio import Shazam
        result = await Shazam().recognize(tmp_wav)
        track = result.get("track")
        if not track:
            logger.debug("shazam: sem resultado")
            return None
        artist = track.get("subtitle", "")
        title  = track.get("title", "")
        logger.debug(f"shazam: {artist} - {title}")
        return {"artist": artist, "title": title}
    except Exception as e:
        logger.warning(f"shazam error: {e}")
        return None
    finally:
        if tmp_wav and os.path.exists(tmp_wav):
            os.remove(tmp_wav)


async def lookup_discogs(artist: str, title: str) -> dict | None:
    from utils import config as cfg

    headers = {"User-Agent": _USER_AGENT}
    base_params: dict = {"q": f"{artist} {title}".strip()}

    # Prefer full OAuth when the user has a connected Discogs account.
    # Fall back to consumer key/secret (app-level auth, no user needed).
    # Fall back to unauthenticated public API (25 req/min, sufficient for indexing).
    auth = _discogs_auth_header()
    if auth:
        headers["Authorization"] = auth
    else:
        ck = cfg.get("discogs_consumer_key", "")
        cs = cfg.get("discogs_consumer_secret", "")
        if ck and cs:
            base_params["key"]    = ck
            base_params["secret"] = cs
        # else: unauthenticated — Discogs still allows up to 25 req/min

    async with httpx.AsyncClient(timeout=10) as client:

        # 1. Busca masters diretamente — a cover_image já é a artwork canônica, sem fotos de vinil
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
                    mr = await client.get(
                        f"https://api.discogs.com/masters/{mid}",
                        headers=headers,
                    )
                    if mr.status_code == 200:
                        full = mr.json()
                        images = full.get("images", [])
                        # primary é a capa principal, secondary são fotos do vinil físico
                        primary = next((i for i in images if i.get("type") == "primary"), None)
                        if primary:
                            master["cover_image"] = primary["uri"]
                            logger.debug(f"discogs: capa master {mid} (primary) ok")
                except Exception as e:
                    logger.debug(f"discogs: falha ao buscar master {mid}: {e}")
            return master

        # 2. Fallback: busca em releases individuais, evitando capas de vinil físico
        r = await client.get(
            "https://api.discogs.com/database/search",
            params={**base_params, "type": "release"},
            headers=headers,
        )
        results = r.json().get("results", [])
        if not results:
            return None

        # Prefere releases com master_id (capa canônica) e não-vinyl (sem foto de disco físico)
        with_master = [x for x in results if x.get("master_id")]
        non_vinyl   = [x for x in results if "Vinyl" not in x.get("format", [])]
        release = (with_master or non_vinyl or results)[0]

        # Tenta substituir pela imagem primary da master release
        master_id = release.get("master_id")
        if master_id:
            try:
                mr = await client.get(
                    f"https://api.discogs.com/masters/{master_id}",
                    headers=headers,
                )
                if mr.status_code == 200:
                    master_data = mr.json()
                    images = master_data.get("images", [])
                    primary = next((i for i in images if i.get("type") == "primary"), None)
                    if primary:
                        release["cover_image"] = primary["uri"]
                        logger.debug(f"discogs: capa master {master_id} (via release fallback) ok")
            except Exception as e:
                logger.debug(f"discogs: falha ao buscar master {master_id}: {e}")

    return release


async def identify_track(file_path: str, fallback_title: str = "") -> dict:
    """
    Retorna dict com metadados identificados, ou {"status": "unidentified"}.
    Fluxo: Chromaprint → AcoustID → Shazam → fallback_title → Discogs.
    """
    fp = await fingerprint(file_path)
    if not fp:
        return {"status": "unidentified", "reason": "fingerprint_failed"}
    logger.debug(f"fingerprint ok: duration={fp.get('duration')}")

    artist = None
    title  = None
    mb_id  = None

    recording = await lookup_acoustid(fp)
    if recording:
        logger.debug(f"acoustid match: {recording.get('id')}")
        artist = recording["artists"][0]["name"] if recording.get("artists") else None
        title  = recording.get("title")
        mb_id  = recording.get("id")

    # Shazam: quando AcoustID não tem recordings, tenta reconhecer pelo áudio
    if not title:
        shazam = await lookup_shazam(file_path)
        if shazam:
            artist = shazam["artist"]
            title  = shazam["title"]

    # Fallback final: usar título do YouTube
    if not title and fallback_title:
        logger.debug(f"shazam sem resultado, usando fallback_title={fallback_title!r}")
        title = fallback_title

    # Sem title nenhuma fonte identificou — retorna unidentified.
    if not title:
        return {"status": "unidentified", "reason": "no_match"}

    discogs = None
    if title:
        discogs = await lookup_discogs(artist or "", title)

    # Se achou no Discogs, extrai artist do release caso não tenha vindo do MusicBrainz
    if discogs and not artist:
        raw_artists = discogs.get("title", "")
        # título do Discogs vem no formato "Artist - Title"
        if " - " in raw_artists:
            artist, title = raw_artists.split(" - ", 1)

    return {
        "status":          "identified",
        "title":           title,
        "artist":          artist,
        "duration":        fp["duration"],
        "mb_recording_id": mb_id,
        "discogs_id":      discogs.get("id")                  if discogs else None,
        "thumbnail":       discogs.get("cover_image")         if discogs else None,
        "label":           discogs.get("label", [None])[0]    if discogs else None,
        "year":            discogs.get("year")                if discogs else None,
    }


async def analyze_bpm_key(file_path: str) -> dict:
    """
    Roda a detecção de BPM/tom (Essentia) para file_path.
    Retorna {"bpm":.., "key":..} (chaves ausentes se não detectado) ou {} se
    o toggle estiver desligado. Requer tools/setup_essentia.py já rodado;
    sem o binário configurado isso é um no-op silencioso — nunca propaga
    exceção pro chamador.
    """
    if not cfg.get("bpm_key_analysis_enabled", True):
        return {}
    try:
        from api.services.audio_analysis.essentia import analyze_file
        return await analyze_file(file_path)
    except Exception as e:
        logger.debug(f"audio analysis skipped for {file_path}: {e}")
        return {}


# ── Fila de análise em background (uma faixa por vez) ────────────────────────
# O extrator Essentia é lento e às vezes flaky (binário beta de 2015); rodá-lo
# inline no upload trava um intake em lote. Cada arquivo importado entra
# nesta fila e um único worker processa em sequência — nunca N processos
# Essentia concorrentes numa importação de várias faixas.

_bpm_key_queue: "asyncio.Queue | None" = None
_bpm_key_worker: "asyncio.Task | None" = None


def enqueue_bpm_key_analysis(track_id: str, file_path: str,
                              embedded_bpm: float | None, embedded_key: str | None) -> None:
    """Agenda a análise de BPM/tom para depois — nunca bloqueia o chamador."""
    import asyncio
    global _bpm_key_queue, _bpm_key_worker
    if _bpm_key_queue is None:
        _bpm_key_queue = asyncio.Queue()
    if _bpm_key_worker is None or _bpm_key_worker.done():
        _bpm_key_worker = asyncio.create_task(_bpm_key_worker_loop())
    _bpm_key_queue.put_nowait((track_id, file_path, embedded_bpm, embedded_key))


async def _bpm_key_worker_loop() -> None:
    from db import database
    while True:
        track_id, file_path, embedded_bpm, embedded_key = await _bpm_key_queue.get()
        try:
            analysis = await analyze_bpm_key(file_path)
            fill = {}
            if not embedded_bpm and analysis.get("bpm"):
                fill["bpm"] = analysis["bpm"]
            if not embedded_key and analysis.get("key"):
                fill["key"] = analysis["key"]
            if fill:
                conn = database.get_connection()
                try:
                    database.update_track_metadata(conn, track_id, fill)
                    conn.commit()
                finally:
                    conn.close()
        except Exception:
            logger.exception(f"bpm/key background analysis failed for {track_id}")
        finally:
            _bpm_key_queue.task_done()


# ── Fila de extração de forma de onda (uma faixa por vez) ────────────────────
# Decodificar o arquivo inteiro é bem mais leve que o Essentia, mas ainda é
# CPU-bound — fila própria (não a do BPM/tom) pra a onda ficar pronta rápido
# mesmo com um lote grande de análise Essentia enfileirado atrás.

_waveform_queue: "asyncio.Queue | None" = None
_waveform_worker: "asyncio.Task | None" = None


def enqueue_waveform_analysis(track_id: str, file_path: str) -> None:
    """Agenda a extração dos picos da forma de onda — nunca bloqueia o chamador."""
    import asyncio
    global _waveform_queue, _waveform_worker
    if _waveform_queue is None:
        _waveform_queue = asyncio.Queue()
    if _waveform_worker is None or _waveform_worker.done():
        _waveform_worker = asyncio.create_task(_waveform_worker_loop())
    _waveform_queue.put_nowait((track_id, file_path))


def enqueue_missing_waveform_backfill() -> int:
    """Chamado do lifespan (api/app.py): faixas importadas antes desse recurso
    existir não têm picos ainda — enfileira todas de uma vez (a fila já
    processa uma por vez, então isso não afoga o boot nem a CPU)."""
    import os
    from db import database
    conn = database.get_connection()
    try:
        missing = database.list_tracks_missing_waveform(conn)
    finally:
        conn.close()
    n = 0
    for row in missing:
        file_path = row.get("file_path")
        if file_path and os.path.exists(file_path):
            enqueue_waveform_analysis(row["id"], file_path)
            n += 1
    return n


async def _waveform_worker_loop() -> None:
    import time
    from db import database
    from api.services.audio_analysis.waveform import extract_peaks

    while True:
        track_id, file_path = await _waveform_queue.get()
        try:
            peaks = await extract_peaks(file_path)
            conn = database.get_connection()
            try:
                database.upsert_waveform(conn, track_id, peaks, int(time.time()))
                conn.commit()
            finally:
                conn.close()
        except Exception:
            logger.exception(f"waveform extraction failed for {track_id}")
        finally:
            _waveform_queue.task_done()


async def index_file(track_id: str, file_path: str) -> dict:
    """
    Identifica a faixa via AcoustID + Discogs, roda a análise de BPM/tom
    (Essentia) e persiste os metadados no DB.
    Retorna o dict de metadados (com chave 'status').
    """
    from db import database

    # Pega título atual do DB como fallback para a busca no Discogs
    fallback_title = ""
    conn = database.get_connection()
    try:
        row = database.get_track(conn, track_id)
        if row:
            fallback_title = row.get("title") or ""
    finally:
        conn.close()

    # Run fpcalc separately to capture the raw fingerprint string for dedup.
    # Best-effort like upload.py's own fingerprint call: never let a missing
    # chromaprint/fpcalc take down bpm/tom + forma de onda below.
    try:
        raw_fp = await fingerprint(file_path)
    except Exception as e:
        logger.debug(f"index_file: fingerprint indisponível para {file_path}: {e}")
        raw_fp = None

    meta = await identify_track(file_path, fallback_title=fallback_title)
    logger.info(f"index_file {track_id}: status={meta['status']} reason={meta.get('reason')}")

    update: dict = {"status": meta["status"]}
    identified_year = None
    if meta["status"] == "identified":
        update.update({
            "title":           meta.get("title"),
            "artist":          meta.get("artist"),
            "duration":        meta.get("duration"),
            "mb_recording_id": meta.get("mb_recording_id"),
            "discogs_id":      meta.get("discogs_id"),
            "label":           meta.get("label"),
        })
        # year é do álbum agora (não da faixa) — aplicado abaixo, sem sobrescrever.
        identified_year = meta.get("year")
        # Só sobrescreve thumbnail se o Discogs devolveu uma
        if meta.get("thumbnail"):
            update["thumbnail"] = meta["thumbnail"]

    # Always store the Chromaprint fingerprint for duplicate detection.
    if raw_fp and raw_fp.get("fingerprint"):
        update["fingerprint"] = raw_fp["fingerprint"]

    # BPM/tom via Essentia — independente de status (funciona até em faixas
    # não identificadas).
    analysis = await analyze_bpm_key(file_path)
    if analysis.get("bpm"):
        update["bpm"] = analysis["bpm"]
    if analysis.get("key"):
        update["key"] = analysis["key"]

    # Forma de onda real (Remixer) — mesma lógica de "independe de status",
    # em background pra não segurar quem chamou index_file.
    enqueue_waveform_analysis(track_id, file_path)

    conn = database.get_connection()
    try:
        database.update_track_metadata(conn, track_id, update)
        # O ano identificado é do álbum: preenche só se ainda estiver vazio
        # (não sobrescreve um ano que o usuário já pôs no álbum).
        if identified_year:
            track = database.get_track(conn, track_id)
            album_id = track.get("album_id") if track else None
            if album_id:
                album = database.get_album(conn, album_id)
                if album and not album.get("year"):
                    database.update_album(conn, album_id, {"year": identified_year})
        conn.commit()
    finally:
        conn.close()

    return meta