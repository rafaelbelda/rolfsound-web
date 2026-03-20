# youtube/ytdlp.py
"""
YouTube search and download using yt-dlp.

SEARCH PERFORMANCE
------------------
yt-dlp search is run via asyncio.create_subprocess_exec so it never blocks
the FastAPI event loop. The caller (search route) awaits it properly.

THUMBNAIL RESOLUTION
--------------------
yt-dlp flat-playlist mode returns a `thumbnails` list (array of dicts with
url + resolution) rather than a single `thumbnail` string. We pick the
best available thumbnail — preferring medium quality (hqdefault ~480x360)
over the tiny default (120x90) or the maxres which may 404.

DATE FIELDS
-----------
`upload_date` is returned by yt-dlp as "YYYYMMDD" string in full metadata.
We convert it to a unix timestamp and store it as `published_date`.
Flat-playlist mode does NOT return upload_date — it only comes from full
per-video metadata fetched during download.

AUDIO QUALITY
-------------
See module docstring — native stream (opus/m4a) preferred over re-encode.
"""

import asyncio
import json
import logging
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)

_download_lock = threading.Lock()

AUDIO_EXTENSIONS = {".wav", ".flac", ".opus", ".webm", ".m4a", ".aac", ".ogg", ".mp3"}
_NATIVE_FORMATS  = {"opus", "webm", "m4a", "aac", "ogg"}


# ---------------------------------------------------------------------------
# Thumbnail helpers
# ---------------------------------------------------------------------------

def _best_thumbnail(data: dict) -> str:
    """
    Pick the best thumbnail URL from yt-dlp metadata.

    yt-dlp can return:
      - `thumbnail`  : single string (full metadata mode)
      - `thumbnails` : list of {"url": ..., "width": ..., "height": ...}
                       (both flat and full mode)

    Preference order by height: 360 (hqdefault) > 480 > 720 > any > smallest.
    We avoid maxresdefault (1280px) because it 404s on many videos.
    """
    # Prefer the explicit single `thumbnail` field when present and non-empty
    single = data.get("thumbnail", "")
    if single and isinstance(single, str):
        return single

    thumbs = data.get("thumbnails")
    if not thumbs or not isinstance(thumbs, list):
        return ""

    # Filter to entries that have a URL
    valid = [t for t in thumbs if isinstance(t, dict) and t.get("url")]
    if not valid:
        return ""

    # Score by preference: height 360 = best, then 480, then 720, then any
    def _score(t):
        h = t.get("height") or 0
        if h == 360: return 0
        if h == 480: return 1
        if h == 720: return 2
        if h > 0:    return 3
        return 4

    valid.sort(key=_score)
    return valid[0]["url"]


def _parse_upload_date(data: dict) -> int | None:
    """
    Convert yt-dlp's `upload_date` ("YYYYMMDD") to a unix timestamp.
    Returns None if not available (flat-playlist mode, live streams, etc.)
    """
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
# Async search
# ---------------------------------------------------------------------------

async def search_async(query: str, max_results: int = 10) -> list[dict]:
    """
    Non-blocking YouTube search using asyncio subprocess.
    Must be called from an async context (FastAPI route handler).
    """
    cmd = [
        "yt-dlp",
        "--dump-json",
        "--no-download",
        "--flat-playlist",
        f"ytsearch{max_results}:{query}",
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=25.0)
        tracks = []
        for line in stdout.decode(errors="replace").strip().splitlines():
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                tracks.append({
                    "id":        data.get("id", ""),
                    "title":     data.get("title", "Unknown"),
                    "duration":  data.get("duration"),
                    "thumbnail": _best_thumbnail(data),
                    "channel":   data.get("channel") or data.get("uploader", ""),
                    "url":       data.get("url") or f"https://www.youtube.com/watch?v={data.get('id','')}",
                    # upload_date not available in flat mode — populated after download
                    "published_date": None,
                })
            except json.JSONDecodeError:
                continue
        return tracks
    except asyncio.TimeoutError:
        logger.error("yt-dlp search timed out")
        return []
    except FileNotFoundError:
        logger.error("yt-dlp not found — install with: pip install yt-dlp")
        return []
    except Exception as e:
        logger.error(f"Search error: {e}")
        return []


# Sync wrapper for contexts that can't be async (download manager thread)
def search(query: str, max_results: int = 10) -> list[dict]:
    cmd = [
        "yt-dlp",
        "--dump-json",
        "--no-download",
        "--flat-playlist",
        f"ytsearch{max_results}:{query}",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
        tracks = []
        for line in result.stdout.strip().splitlines():
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                tracks.append({
                    "id":             data.get("id", ""),
                    "title":          data.get("title", "Unknown"),
                    "duration":       data.get("duration"),
                    "thumbnail":      _best_thumbnail(data),
                    "channel":        data.get("channel") or data.get("uploader", ""),
                    "published_date": None,
                })
            except json.JSONDecodeError:
                continue
        return tracks
    except Exception as e:
        logger.error(f"Search error: {e}")
        return []


# ---------------------------------------------------------------------------
# Full metadata (used after download)
# ---------------------------------------------------------------------------

def get_metadata(track_id: str) -> dict | None:
    """Fetch full per-video metadata including upload_date and best thumbnail."""
    url = f"https://www.youtube.com/watch?v={track_id}"
    cmd = ["yt-dlp", "--dump-json", "--no-download", url]
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
        logger.error(f"Metadata fetch error for {track_id}: {e}")
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
    Download at maximum quality. See module docstring for format strategy.
    Returns final file path on success, None on failure.
    Single download at a time enforced by threading lock.
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
                "--progress", "--no-warnings", url,
            ]
        else:
            cmd = [
                "yt-dlp", "--extract-audio",
                "--audio-format", audio_format, "--audio-quality", "0",
                "--format", "bestaudio/best",
                "--output", temp_template, "--no-playlist",
                "--progress", "--no-warnings", url,
            ]

        logger.info(f"Downloading {track_id} as {'native ' if is_native else 'transcoded '}{audio_format}")

        process = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        for line in process.stdout:
            line = line.strip()
            if "[download]" in line and "%" in line:
                try:
                    pct = int(float(line.split("%")[0].split()[-1]))
                    if progress_callback: progress_callback(pct, "downloading")
                except (ValueError, IndexError):
                    pass

        process.wait()
        if process.returncode != 0:
            logger.error(f"yt-dlp failed for {track_id} (exit {process.returncode})")
            return None

        if progress_callback: progress_callback(90, "processing")

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
        if progress_callback: progress_callback(100, "complete")
        logger.info(f"Download complete: {final_path}")
        return final_path

    except Exception as e:
        logger.error(f"Download error for {track_id}: {e}")
        if progress_callback: progress_callback(0, "failed")
        return None
    finally:
        _download_lock.release()


# ---------------------------------------------------------------------------
# Thumbnail download
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

    # Fallback: yt-dlp --write-thumbnail
    try:
        tmp = str(Path(thumbnails_dir) / f"{track_id}.thumb")
        cmd = [
            "yt-dlp", "--write-thumbnail", "--skip-download",
            "--convert-thumbnails", "jpg", "--output", tmp,
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