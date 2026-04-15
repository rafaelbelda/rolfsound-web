# api/services/indexer.py

import logging
import subprocess
import json
import httpx
from pathlib import Path

logger = logging.getLogger(__name__)

ACOUSTID_KEY = "inv3qSYC56"

# fpcalc.exe e ffmpeg.exe na raiz do projeto (dois níveis acima de api/services/)
_FPCALC  = str(Path(__file__).parent.parent.parent / "fpcalc.exe")
_FFMPEG  = str(Path(__file__).parent.parent.parent / "ffmpeg.exe")

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
    result = subprocess.run(
        [_FPCALC, "-json", path],
        capture_output=True, text=True
    )
    if result.returncode != 0:
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
    import tempfile, asyncio, os

    # Converte para WAV mono 16kHz (apenas os primeiros 20s bastam pro Shazam)
    tmp_wav = None
    try:
        fd, tmp_wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        proc = await asyncio.create_subprocess_exec(
            _FFMPEG, "-y", "-i", file_path,
            "-t", "20", "-ar", "16000", "-ac", "1", "-f", "wav", tmp_wav,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
        if proc.returncode != 0 or not os.path.exists(tmp_wav):
            logger.warning("shazam: ffmpeg falhou ao converter para WAV")
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
    params: dict = {"q": f"{artist} {title}".strip(), "type": "release"}

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
            params["key"]    = ck
            params["secret"] = cs
        # else: unauthenticated — Discogs still allows up to 25 req/min

    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            "https://api.discogs.com/database/search",
            params=params,
            headers=headers,
        )
        results = r.json().get("results", [])
        if not results:
            return None

        vinyl = [x for x in results if "Vinyl" in x.get("format", [])]
        release = (vinyl or results)[0]

        # Tenta pegar a capa da Master Release (alta qualidade, sem foto de vinil físico)
        master_id = release.get("master_id")
        if master_id:
            try:
                mr = await client.get(
                    f"https://api.discogs.com/masters/{master_id}",
                    headers=headers,
                )
                if mr.status_code == 200:
                    master = mr.json()
                    images = master.get("images", [])
                    # primary é a capa principal, secondary são fotos do vinil físico
                    primary = next((i for i in images if i.get("type") == "primary"), None)
                    if primary:
                        release["cover_image"] = primary["uri"]
                        logger.debug(f"discogs: capa master {master_id} ok")
            except Exception as e:
                logger.debug(f"discogs: falha ao buscar master {master_id}: {e}")

    return release


async def identify_track(file_path: str, fallback_title: str = "") -> dict:
    """
    Retorna dict com metadados identificados, ou {"status": "unidentified"}.
    Fluxo: fpcalc → AcoustID → Discogs (via MusicBrainz ou fallback_title).
    """
    fp = await fingerprint(file_path)
    if not fp:
        return {"status": "unidentified", "reason": "fpcalc_failed"}
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


async def index_file(track_id: str, file_path: str) -> dict:
    """
    Identifica a faixa via AcoustID + Discogs e persiste os metadados no DB.
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
    raw_fp = await fingerprint(file_path)

    meta = await identify_track(file_path, fallback_title=fallback_title)
    logger.info(f"index_file {track_id}: status={meta['status']} reason={meta.get('reason')}")

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
        # Só sobrescreve thumbnail se o Discogs devolveu uma
        if meta.get("thumbnail"):
            update["thumbnail"] = meta["thumbnail"]

    # Always store the Chromaprint fingerprint for duplicate detection.
    if raw_fp and raw_fp.get("fingerprint"):
        update["fingerprint"] = raw_fp["fingerprint"]

    conn = database.get_connection()
    try:
        database.update_track_metadata(conn, track_id, update)
        conn.commit()
    finally:
        conn.close()

    return meta