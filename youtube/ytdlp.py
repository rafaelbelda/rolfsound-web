# youtube/ytdlp.py
"""
YouTube search and download using yt-dlp.

ARCHITECTURE
------------
Search logic lives entirely here. The route (search.py) handles only:
  - SSE protocol (event framing, streaming response)
  - Library filtering (SQLite)
  - Inflight dedup (async future coordination)

Everything yt-dlp related is in this module:
  - _parse_line()       : parse one output line into a track dict
  - search_stream()     : sync generator, yields tracks as yt-dlp finds them
  - search_cmd          : the canonical yt-dlp command (single definition)
  - _cache_get/set()    : unified cache interface (TTLCache or plain dict)
  - get_metadata()      : full per-video metadata after download
  - download()          : audio download with atomic rename
  - download_thumbnail(): save thumbnail locally

SEARCH PERFORMANCE
------------------
Uses --flat-playlist --print with tab-separated fields.
This makes ONE YouTube request for all results vs one per video with --dump-json.
First result streams to the client in ~1-2s.

THUMBNAIL
---------
mqdefault.jpg (320x180) is native 16:9. Never 404s. No black bars.
hqdefault.jpg (480x360) is 4:3 letterboxed — avoided everywhere.

AUDIO QUALITY
-------------
Native stream (opus/m4a) preferred — no re-encode, zero quality loss.
mp3 available but triggers lossy transcode.
"""

import asyncio
import json
import logging
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Generator

logger = logging.getLogger(__name__)

_download_lock = threading.Lock()

AUDIO_EXTENSIONS = {".wav", ".flac", ".opus", ".webm", ".m4a", ".aac", ".ogg", ".mp3"}
_NATIVE_FORMATS  = {"opus", "webm", "m4a", "aac", "ogg"}


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

try:
    from cachetools import TTLCache
    _search_cache = TTLCache(maxsize=500, ttl=300)
    _CACHE_TTL = None  # TTLCache handles expiry automatically
except ImportError:
    _search_cache: dict = {}
    _CACHE_TTL = 300   # manual TTL for plain-dict fallback


def _cache_get(key: str) -> list | None:
    """Unified get — works with TTLCache (auto-expires) or plain dict (manual TTL)."""
    entry = _search_cache.get(key)
    if entry is None:
        return None
    if isinstance(entry, tuple):   # plain dict: (timestamp, results)
        ts, results = entry
        if time.time() - ts > _CACHE_TTL:
            _search_cache.pop(key, None)
            return None
        return results
    return entry                   # TTLCache: value stored directly


def _cache_set(key: str, results: list) -> None:
    """Unified set — works with TTLCache or plain dict."""
    if _CACHE_TTL is None:         # TTLCache
        _search_cache[key] = results
    else:                          # plain dict fallback
        _search_cache[key] = (time.time(), results)


# ---------------------------------------------------------------------------
# yt-dlp search command (single definition — change here, affects everything)
# ---------------------------------------------------------------------------

def _search_cmd(query: str, max_results: int) -> list[str]:
    return [
        "yt-dlp",
        "--flat-playlist",
        "--no-warnings",
        "--ignore-errors",    # skip unavailable videos without stalling
        "--no-call-home",     # skip update check (~100-300ms saved per run)
        "--print", "%(id)s\t%(title)s\t%(duration>%s)s\t%(uploader)s",
        f"ytsearch{max_results}:{query}",
    ]


# ---------------------------------------------------------------------------
# Line parsing
# ---------------------------------------------------------------------------

def _parse_line(line: str) -> dict | None:
    """
    Parse one tab-separated line from yt-dlp --print into a track dict.
    Single definition — both sync search_stream and async route use this.
    If yt-dlp output format changes, fix it here and both paths are fixed.
    """
    parts = line.split("\t")
    if len(parts) < 2:
        return None
    vid_id = parts[0].strip()
    if not vid_id or vid_id in ("NA", "None", ""):
        return None
    title    = parts[1].strip() or "Unknown"
    duration = None
    if len(parts) > 2 and parts[2].strip() not in ("", "NA", "None"):
        try:
            duration = int(parts[2].strip())
        except ValueError:
            pass
    channel = (
        parts[3].strip()
        if len(parts) > 3 and parts[3].strip() not in ("", "NA")
        else ""
    )
    return {
        "id":             vid_id,
        "title":          title,
        "duration":       duration,
        # mqdefault (320×180) is native 16:9 — clean, no black bars, never 404s.
        # hqdefault (480×360) is 4:3 letterboxed — avoid.
        "thumbnail":      f"https://i.ytimg.com/vi/{vid_id}/mqdefault.jpg",
        "channel":        channel,
        "published_date": None,   # not in flat-playlist mode; set after download
    }


# ---------------------------------------------------------------------------
# Search — sync generator (used by the async route via async subprocess)
# ---------------------------------------------------------------------------

def search_stream(query: str, max_results: int) -> Generator[dict, None, None]:
    """
    Sync generator: yields one track dict per result as yt-dlp finds it.
    Cache hit yields all results immediately without spawning yt-dlp.

    NOTE: The async route (search.py) runs yt-dlp as an async subprocess
    directly for true non-blocking streaming. This sync version is kept
    for any non-async callers (e.g. tests, CLI use).
    """
    cache_key = f"{query.lower().strip()}:{max_results}"
    cached = _cache_get(cache_key)
    if cached is not None:
        logger.debug(f"Search cache hit: {query!r}")
        yield from cached
        return

    collected = []
    try:
        proc = subprocess.Popen(
            _search_cmd(query, max_results),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            track = _parse_line(line)
            if track:
                collected.append(track)
                yield track
        proc.wait()
    except FileNotFoundError:
        logger.error("yt-dlp not found — install with: pip install yt-dlp")
    except Exception as e:
        logger.error(f"search_stream error: {e}")
    finally:
        if collected:
            _cache_set(cache_key, collected)


# ---------------------------------------------------------------------------
# Thumbnail helpers (used for full metadata after download)
# ---------------------------------------------------------------------------

def _best_thumbnail(data: dict) -> str:
    """
    Pick the best 16:9 thumbnail URL from full yt-dlp metadata.
    Prefers mqdefault (180px height, 320×180, always 16:9, never 404s).
    Falls back to the single `thumbnail` string if no array is present.
    """
    thumbs = data.get("thumbnails")
    if thumbs and isinstance(thumbs, list):
        valid = [t for t in thumbs if isinstance(t, dict) and t.get("url")]
        if valid:
            def _score(t):
                h = t.get("height") or 0
                if h == 180: return 0   # mqdefault — 16:9 ✓
                if h == 480: return 1   # sddefault  — 16:9 on most videos
                if h == 720: return 2   # may 404 on older videos
                if 0 < h < 360: return 3
                if h > 360: return 4
                if h == 360: return 5   # hqdefault — 4:3 letterboxed, last resort
                return 6
            valid.sort(key=_score)
            return valid[0]["url"]

    single = data.get("thumbnail", "")
    return single if isinstance(single, str) else ""


def _parse_upload_date(data: dict) -> int | None:
    """Convert yt-dlp's `upload_date` ("YYYYMMDD") to a unix timestamp."""
    raw = data.get("upload_date") or data.get("release_date")
    if not raw or len(raw) != 8:
        return None
    try:
        import datetime
        d = datetime.date(int(raw[:4]), int(raw[4:6]), int(raw[6:8]))
        return int(datetime.datetime(d.year, d.month, d.day).timestamp())
    except (ValueError, OverflowError):
        return None


# ---------------------------------------------------------------------------
# Full metadata (called after download to populate the library record)
# ---------------------------------------------------------------------------

def get_metadata(track_id: str) -> dict | None:
    """Fetch full per-video metadata: title, artist, duration, thumbnail, date."""
    url = f"https://www.youtube.com/watch?v={track_id}"
    cmd = ["yt-dlp", "--dump-json", "--no-download", "--no-call-home", url]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        data = json.loads(result.stdout.strip())
        return {
            "id":             data.get("id", track_id),
            "title":          data.get("title", "Unknown"),
            "artist":         data.get("artist") or data.get("uploader", ""),
            "duration":       data.get("duration"),
            "thumbnail":      _best_thumbnail(data),
            "channel":        data.get("channel") or data.get("uploader", ""),
            "published_date": _parse_upload_date(data),
        }
    except Exception as e:
        logger.error(f"get_metadata error for {track_id}: {e}")
        return None


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def download(
    track_id: str,
    output_dir: str,
    temp_dir: str,
    audio_format: str = "opus",
    progress_callback: Callable[[int, str], None] = None,
) -> str | None:
    """
    Download at maximum quality using native stream (no re-encode for opus/m4a).
    Returns final file path on success, None on failure.
    Enforces single download at a time via threading lock.
    """
    if audio_format == "wav":
        logger.warning("wav is not a valid download target — falling back to opus.")
        audio_format = "opus"

    is_native = audio_format in _NATIVE_FORMATS

    if not _download_lock.acquire(blocking=False):
        logger.info(f"Download queued (lock busy): {track_id}")
        _download_lock.acquire()

    try:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        Path(temp_dir).mkdir(parents=True, exist_ok=True)

        final_path    = str(Path(output_dir) / f"{track_id}.{audio_format}")
        temp_template = str(Path(temp_dir)   / f"{track_id}.tmp.%(ext)s")
        url           = f"https://www.youtube.com/watch?v={track_id}"

        if progress_callback:
            progress_callback(5, "downloading")

        if is_native:
            fmt_filter = {
                "opus": "bestaudio[ext=webm]/bestaudio[acodec=opus]/bestaudio",
                "webm": "bestaudio[ext=webm]/bestaudio",
                "m4a":  "bestaudio[ext=m4a]/bestaudio[acodec=aac]/bestaudio",
                "aac":  "bestaudio[acodec=aac]/bestaudio[ext=m4a]/bestaudio",
                "ogg":  "bestaudio[ext=ogg]/bestaudio",
            }.get(audio_format, "bestaudio/best")
            cmd = [
                "yt-dlp", "--format", fmt_filter,
                "--output", temp_template, "--no-playlist",
                "--no-call-home", "--progress", "--no-warnings", url,
            ]
        else:
            cmd = [
                "yt-dlp", "--extract-audio",
                "--audio-format", audio_format, "--audio-quality", "0",
                "--format", "bestaudio/best",
                "--output", temp_template, "--no-playlist",
                "--no-call-home", "--progress", "--no-warnings", url,
            ]

        logger.info(f"Downloading {track_id} as {'native' if is_native else 'transcoded'} {audio_format}")

        process = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        for line in process.stdout:
            line = line.strip()
            if "[download]" in line and "%" in line:
                try:
                    pct = int(float(line.split("%")[0].split()[-1]))
                    if progress_callback:
                        progress_callback(pct, "downloading")
                except (ValueError, IndexError):
                    pass

        process.wait()
        if process.returncode != 0:
            logger.error(f"yt-dlp failed for {track_id} (exit {process.returncode})")
            return None

        if progress_callback:
            progress_callback(90, "processing")

        candidates = list(Path(temp_dir).glob(f"{track_id}.tmp.*"))
        if not candidates:
            logger.error(f"Temp file not found for {track_id}")
            return None

        temp_file  = candidates[0]
        actual_ext = temp_file.suffix.lstrip(".")
        if actual_ext and actual_ext != audio_format:
            final_path = str(Path(output_dir) / f"{track_id}.{actual_ext}")
            logger.info(f"Actual extension .{actual_ext} — saving as {final_path}")

        temp_file.rename(final_path)
        if progress_callback:
            progress_callback(100, "complete")
        logger.info(f"Download complete: {final_path}")
        return final_path

    except Exception as e:
        logger.error(f"Download error for {track_id}: {e}")
        if progress_callback:
            progress_callback(0, "failed")
        return None
    finally:
        _download_lock.release()


# ---------------------------------------------------------------------------
# Thumbnail download (saves locally alongside audio file)
# ---------------------------------------------------------------------------

def download_thumbnail(track_id: str, thumbnails_dir: str, thumbnail_url: str) -> str | None:
    """Download and save thumbnail as <thumbnails_dir>/<id>.jpg."""
    import urllib.request
    dest = str(Path(thumbnails_dir) / f"{track_id}.jpg")
    Path(thumbnails_dir).mkdir(parents=True, exist_ok=True)

    if thumbnail_url:
        try:
            urllib.request.urlretrieve(thumbnail_url, dest)
            logger.info(f"Thumbnail saved: {dest}")
            return dest
        except Exception as e:
            logger.warning(f"Direct thumbnail download failed for {track_id}: {e}")

    # Fallback: let yt-dlp fetch and convert it
    try:
        tmp = str(Path(thumbnails_dir) / f"{track_id}.thumb")
        cmd = [
            "yt-dlp", "--write-thumbnail", "--skip-download",
            "--convert-thumbnails", "jpg", "--no-call-home",
            "--output", tmp,
            f"https://www.youtube.com/watch?v={track_id}",
        ]
        subprocess.run(cmd, capture_output=True, timeout=20)
        candidate = Path(thumbnails_dir) / f"{track_id}.thumb.jpg"
        if candidate.exists():
            candidate.rename(dest)
            return dest
    except Exception as e:
        logger.warning(f"yt-dlp thumbnail fallback failed for {track_id}: {e}")

    return None


# ---------------------------------------------------------------------------
# Temp file cleanup (called on startup)
# ---------------------------------------------------------------------------

def cleanup_temp_files(temp_dir: str) -> None:
    """Remove leftover temp files from crashed downloads."""
    temp_path = Path(temp_dir)
    if not temp_path.exists():
        return
    for f in temp_path.glob("*.tmp*"):
        try:
            f.unlink()
            logger.info(f"Cleaned temp file: {f}")
        except Exception as e:
            logger.warning(f"Could not delete {f}: {e}")