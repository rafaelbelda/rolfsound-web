import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx
from tinytag import TinyTag

from db import database
from utils import config as cfg

logger = logging.getLogger(__name__)

ACOUSTID_KEY = "inv3qSYC56"
_ROOT = Path(__file__).parent.parent.parent
_FPCALC = str(_ROOT / ("fpcalc.exe" if sys.platform == "win32" else "fpcalc"))
_USER_AGENT = "Rolfsound/1.0"
_SHAZAM_WORKER = str(Path(__file__).parent / "_shazam_worker.py")
_SHAZAM_TIMEOUT = 30
BPM_SEMAPHORE = asyncio.Semaphore(2)


def extract_local_tags(file_path: str, track_id: str) -> dict:
    result = {
        "title": None,
        "artist": None,
        "album": None,
        "year": None,
        "duration": None,
        "thumbnail": None,
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
    except Exception as e:
        if "No tag reader found" not in str(e):
            logger.debug(f"Could not read local tags from {file_path}: {e}")
    return result


def _discogs_auth_header() -> str | None:
    import urllib.parse
    import uuid

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
        "oauth_consumer_key": ck,
        "oauth_nonce": uuid.uuid4().hex,
        "oauth_signature_method": "PLAINTEXT",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": at,
        "oauth_version": "1.0",
        "oauth_signature": f"{urllib.parse.quote(cs, safe='')}&{urllib.parse.quote(as_, safe='')}",
    }
    parts = ", ".join(f'{k}="{urllib.parse.quote(v, safe="")}"' for k, v in sorted(params.items()))
    return f"OAuth {parts}"


async def fingerprint(path: str) -> dict | None:
    try:
        import acoustid
        import av
        import numpy as np

        target_sr = 44100
        n_channels = 2
        max_seconds = 120
        frames: list[np.ndarray] = []
        collected = 0
        duration = 0.0

        with av.open(path) as container:
            if container.duration:
                duration = container.duration / 1_000_000
            resampler = av.audio.resampler.AudioResampler(
                format="s16", layout="stereo", rate=target_sr
            )
            max_samples = target_sr * n_channels * max_seconds
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
            duration = collected / (target_sr * n_channels)

        pcm = np.concatenate(frames).astype(np.int16).tobytes()
        fp_str = acoustid.fingerprint(target_sr, n_channels, [pcm])
        return {"duration": duration, "fingerprint": fp_str}
    except ImportError:
        logger.debug("libchromaprint not available, falling back to fpcalc")
    except Exception as e:
        logger.debug(f"native fingerprint failed, falling back to fpcalc: {e}")

    result = subprocess.run([_FPCALC, "-json", path], capture_output=True, text=True)
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


async def lookup_acoustid(fp: dict) -> dict | None:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                "https://api.acoustid.org/v2/lookup",
                params={
                    "client": ACOUSTID_KEY,
                    "duration": int(fp["duration"]),
                    "fingerprint": fp["fingerprint"],
                    "meta": "recordings+releasegroups+compress",
                },
            )
        data = r.json()
    except Exception as e:
        logger.debug(f"AcoustID lookup failed: {e}")
        return None

    results = data.get("results", [])
    if not results:
        return None
    best = max(results, key=lambda x: x.get("score", 0))
    if best.get("score", 0) < 0.8:
        return None
    recordings = best.get("recordings", [])
    return recordings[0] if recordings else None


async def lookup_shazam(file_path: str) -> dict | None:
    import tempfile
    import wave

    import numpy as np

    tmp_wav = None
    try:
        import av

        fd, tmp_wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        target_sr = 16000
        max_samples = target_sr * 20
        frames: list[np.ndarray] = []
        collected = 0

        with av.open(file_path) as container:
            resampler = av.audio.resampler.AudioResampler(
                format="s16", layout="mono", rate=target_sr
            )
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
            return None

        pcm = np.concatenate(frames).astype(np.int16).tobytes()
        with wave.open(tmp_wav, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(target_sr)
            wf.writeframes(pcm)

        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            _SHAZAM_WORKER,
            tmp_wav,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, _stderr = await asyncio.wait_for(proc.communicate(), timeout=_SHAZAM_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return None

        if proc.returncode != 0:
            return None

        lines = (stdout or b"").decode("utf-8", errors="replace").strip().splitlines()
        payload = lines[-1] if lines else "null"
        data = json.loads(payload)
        if not data:
            return None
        return {"artist": data.get("artist", ""), "title": data.get("title", "")}
    except Exception:
        return None
    finally:
        if tmp_wav and os.path.exists(tmp_wav):
            os.remove(tmp_wav)


async def lookup_discogs(artist: str, title: str) -> dict | None:
    headers = {"User-Agent": _USER_AGENT}
    base_params: dict = {"q": f"{artist} {title}".strip()}
    auth = _discogs_auth_header()
    if auth:
        headers["Authorization"] = auth
    else:
        ck = cfg.get("discogs_consumer_key", "")
        cs = cfg.get("discogs_consumer_secret", "")
        if ck and cs:
            base_params["key"] = ck
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
        non_vinyl = [x for x in results if "Vinyl" not in x.get("format", [])]
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


async def detect_bpm(file_path: str) -> int | None:
    async with BPM_SEMAPHORE:
        try:
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-i",
                file_path,
                "-af",
                "bpm",
                "-f",
                "null",
                "-",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=45.0)
            output = stderr.decode("utf-8", errors="ignore")
            match = re.search(r"BPM:\s*([\d.]+)", output)
            if match:
                return int(round(float(match.group(1))))
        except asyncio.TimeoutError:
            proc.kill()
            logger.warning(f"Timeout detecting BPM for {file_path}")
        except Exception as e:
            logger.warning(f"Could not detect BPM for {file_path}: {e}")
    return None


async def identify_track(file_path: str, track_id: str, fallback_title: str = "") -> dict:
    local_tags = await asyncio.to_thread(extract_local_tags, file_path, track_id)

    artist = local_tags.get("artist")
    title = local_tags.get("title")
    thumbnail = local_tags.get("thumbnail")
    year = local_tags.get("year")
    duration = local_tags.get("duration")
    identity_source = "local_tags" if title and artist else None
    mb_id = None
    raw_fp = None

    if title and artist:
        logger.debug(f"Indexer [{track_id}]: local tags found, fingerprinting for identity")
    else:
        logger.info(f"Indexer [{track_id}]: metadata incomplete, starting fingerprint")

    fp = await fingerprint(file_path)
    if fp:
        duration = duration or fp["duration"]
        raw_fp = fp["fingerprint"]

        recording = await lookup_acoustid(fp)
        if recording:
            recording_artist = recording["artists"][0]["name"] if recording.get("artists") else None
            artist = recording_artist or artist
            title = recording.get("title") or title
            mb_id = recording.get("id")
            identity_source = "acoustid"

        if not recording:
            needs_metadata = not title or not artist
            needs_strong_confirmation = identity_source in {"local_tags", "filename", None}
            if needs_metadata or needs_strong_confirmation:
                shazam = await lookup_shazam(file_path)
                if shazam:
                    artist = shazam["artist"] or artist
                    title = shazam["title"] or title
                    identity_source = "shazam"

    if not title and fallback_title:
        title = re.sub(
            r"\s*[\(\[].*[\)\]]|\s+-\s+(?:official.*|lyric.*)|\s+\|\s+.*$",
            "",
            fallback_title,
            flags=re.IGNORECASE,
        ).strip(" -") or fallback_title
        identity_source = identity_source or "filename"

    if not title:
        return {
            "status": "unidentified",
            "reason": "no_match",
            "raw_fp": raw_fp,
            "identity_source": identity_source or "unknown",
        }

    discogs = None
    if title and (not thumbnail or not year):
        logger.info(f"Indexer [{track_id}]: fetching Discogs enrichment")
        discogs = await lookup_discogs(artist or "", title)

    if discogs and not artist:
        raw_artists = discogs.get("title", "")
        if " - " in raw_artists:
            artist, title = raw_artists.split(" - ", 1)

    return {
        "status": "identified",
        "title": title,
        "artist": artist,
        "duration": duration,
        "mb_recording_id": mb_id,
        "discogs_id": discogs.get("id") if discogs else None,
        "thumbnail": thumbnail or (discogs.get("cover_image") if discogs else None),
        "label": discogs.get("label", [None])[0] if discogs else None,
        "year": year or (discogs.get("year") if discogs else None),
        "raw_fp": raw_fp,
        "identity_source": identity_source or "unknown",
    }


async def index_asset(asset_id: str, allow_identity_resolution: bool = True) -> dict:
    from api.ws.endpoint import get_manager as get_ws_manager

    conn = database.get_connection()
    try:
        asset = database.get_asset(conn, asset_id)
        if not asset:
            return {"status": "failed", "reason": "asset_not_found"}
        track = database.get_track(conn, asset["track_id"])
        if not track:
            return {"status": "failed", "reason": "track_not_found"}
        track_id = track["id"]
        file_path = asset["file_path"]
        fallback_title = track.get("title") or Path(file_path).stem
    finally:
        conn.close()

    meta = await identify_track(file_path, track_id, fallback_title=fallback_title)
    logger.info(f"index_asset {asset_id}: status={meta['status']}")

    track_update: dict = {"status": meta["status"]}
    if meta["status"] == "identified":
        track_update.update({
            "title": meta.get("title"),
            "artist": meta.get("artist"),
            "duration": meta.get("duration"),
            "mb_recording_id": meta.get("mb_recording_id"),
            "discogs_id": meta.get("discogs_id"),
            "label": meta.get("label"),
            "year": meta.get("year"),
        })
        if meta.get("thumbnail"):
            track_update["thumbnail"] = meta["thumbnail"]

    bpm = await detect_bpm(file_path)
    if bpm:
        track_update["bpm"] = bpm
    if meta.get("raw_fp"):
        track_update["fingerprint"] = meta["raw_fp"]

    current_track_id = track_id
    conn = database.get_connection()
    try:
        asset = database.get_asset(conn, asset_id)
        if not asset:
            return {"status": "failed", "reason": "asset_not_found"}
        track = database.get_track(conn, asset["track_id"])
        if not track:
            return {"status": "failed", "reason": "track_not_found"}

        database.update_asset_analysis(conn, asset_id, {
            "analysis_status": meta["status"],
            "duration": track_update.get("duration"),
            "bpm": track_update.get("bpm"),
            "fingerprint": track_update.get("fingerprint"),
        })

        can_update_track = (
            track.get("status") in (None, "", "pending_identity", "unidentified")
            or not track.get("title")
            or not track.get("artist")
        )
        if can_update_track:
            database.update_track_metadata(conn, track["id"], track_update)
        conn.commit()
        current_track_id = track["id"]
    except Exception as e:
        conn.rollback()
        logger.error(f"Error saving analysis for asset {asset_id}: {e}")
    finally:
        conn.close()

    resolved_track_id = current_track_id
    if allow_identity_resolution and meta.get("status") == "identified":
        resolved_track_id = await asyncio.to_thread(_resolve_identity, asset_id, meta) or current_track_id

    conn = database.get_connection()
    try:
        full_track = database.get_track(conn, resolved_track_id)
    finally:
        conn.close()

    ws_manager = get_ws_manager()
    if ws_manager and full_track:
        await ws_manager.broadcast({
            "type": "event.track_updated",
            "payload": full_track,
            "ts": int(time.time() * 1000),
        })
        logger.info(f"UI notified via WebSocket for Track {resolved_track_id}")

    meta["track_id"] = resolved_track_id
    meta["asset_id"] = asset_id
    return meta


async def index_file(track_id: str, file_path: str) -> dict:
    conn = database.get_connection()
    try:
        asset = database.get_asset_by_path(conn, file_path)
        if not asset:
            fast_asset = database.get_fast_play_asset(conn, track_id)
            asset = fast_asset if fast_asset and fast_asset.get("file_path") == file_path else None
    finally:
        conn.close()

    if not asset:
        return {"status": "failed", "reason": "asset_not_found"}
    return await index_asset(asset["id"], allow_identity_resolution=False)


def _resolve_identity(asset_id: str, meta: dict) -> str | None:
    conn = database.get_connection()
    try:
        asset = database.get_asset(conn, asset_id)
        if not asset:
            return None

        source_track_id = asset["track_id"]
        match_meta = dict(meta)
        if meta.get("raw_fp"):
            match_meta["fingerprint"] = meta["raw_fp"]

        matches = database.find_identity_matches(conn, match_meta, exclude_track_id=source_track_id)
        if not matches:
            return source_track_id

        best = matches[0]
        inferred_asset_type = _infer_asset_type(meta.get("title") or "", asset.get("asset_type"))

        if best["score"] >= 0.93:
            new_path = _move_asset_to_track_bundle(asset, best["track_id"], inferred_asset_type)
            if new_path and new_path != asset["file_path"]:
                database.update_asset_path(conn, asset_id, new_path)
            database.reassign_asset(
                conn,
                asset_id=asset_id,
                target_track_id=best["track_id"],
                asset_type=inferred_asset_type,
                set_primary=False,
            )
            database.add_identity_candidate(
                conn,
                asset_id,
                best["track_id"],
                best["score"],
                best["reasons"],
                status="auto_merged",
            )
            conn.commit()
            logger.info(
                "IdentityResolver: auto-merged asset %s into track %s (score %.2f)",
                asset_id,
                best["track_id"],
                best["score"],
            )
            return best["track_id"]

        for match in matches:
            if match["score"] >= 0.72:
                database.add_identity_candidate(
                    conn,
                    asset_id,
                    match["track_id"],
                    match["score"],
                    match["reasons"],
                    status="pending",
                )
                logger.info(
                    "IdentityResolver: candidate asset %s -> track %s (score %.2f)",
                    asset_id,
                    match["track_id"],
                    match["score"],
                )
        conn.commit()
        return source_track_id
    except Exception as e:
        conn.rollback()
        logger.error(f"IdentityResolver failed for asset {asset_id}: {e}")
        return None
    finally:
        conn.close()


def _infer_asset_type(title: str, current_type: str | None) -> str:
    current = (current_type or "ORIGINAL_MIX").upper()
    text = title.lower()
    rules = [
        ("REMIX", r"\bremix\b|rework|edit mix"),
        ("LIVE", r"\blive\b|ao vivo|concert"),
        ("DEMO", r"\bdemo\b|rough|sketch"),
        ("INSTRUMENTAL", r"instrumental|karaoke"),
        ("RADIO_EDIT", r"radio edit|single edit"),
        ("ALT_VERSION", r"\balt\b|alternate|alternative|version|take|unreleased|leak"),
    ]
    for asset_type, pattern in rules:
        if re.search(pattern, text):
            return asset_type
    return "ALT_VERSION" if current == "ORIGINAL_MIX" else current


def _move_asset_to_track_bundle(asset: dict, target_track_id: str, asset_type: str) -> str | None:
    source_path = Path(asset["file_path"])
    if not source_path.exists():
        return None

    music_dir = Path(cfg.get("music_directory", "./music"))
    target_dir = music_dir / target_track_id
    target_dir.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^a-zA-Z0-9_]+", "_", asset_type.lower()).strip("_") or "asset"
    target_path = target_dir / f"{stem}{source_path.suffix.lower()}"
    while target_path.exists():
        target_path = target_dir / f"{stem}_{uuid.uuid4().hex[:8]}{source_path.suffix.lower()}"

    if source_path.resolve() == target_path.resolve():
        return str(source_path)

    shutil.move(str(source_path), str(target_path))
    return str(target_path)
