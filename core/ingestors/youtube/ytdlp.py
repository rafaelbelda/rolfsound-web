"""
yt-dlp wrapper — downloads only.

Search has moved to core/ingestors/youtube/search.py.

AUDIO FORMAT
────────────
Default format is WebM/Opus — the native stream YouTube serves.
No transcoding, no quality loss, smallest possible file size.

PATH HANDLING
─────────────
All paths are resolved to absolute before use. This prevents a Windows-specific
bug where relative paths joined with Path() produce backslash separators
(e.g. "music\btrack.webm"), and some track IDs start with letters that form
escape sequences (\b = backspace, \t = tab, \n = newline). When these strings
are stored in the DB and later logged or passed to av.open(), the escape char
corrupts the path. Absolute paths have no ambiguous escape sequences.

PUBLIC API
──────────
  download(track_id, output_dir, temp_dir, audio_format, progress_callback)
  get_metadata(track_id)
  download_thumbnail(track_id, thumbnails_dir, thumbnail_url)
  cleanup_temp_files(temp_dir)
"""

import json
import logging
import subprocess
import threading
import urllib.request
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)

_download_lock = threading.Lock()

AUDIO_EXTENSIONS = {".webm", ".wav", ".flac", ".opus", ".m4a", ".aac", ".ogg", ".mp3"}
_NATIVE_FORMATS  = {"webm", "opus", "m4a", "aac", "ogg"}


def _best_thumbnail(data: dict) -> str:
    thumbs = data.get("thumbnails")
    if thumbs and isinstance(thumbs, list):
        valid = [t for t in thumbs if isinstance(t, dict) and t.get("url")]
        if valid:
            def _score(t):
                url = str(t.get("url") or "")
                width = int(t.get("width") or 0)
                height = int(t.get("height") or 0)
                area = width * height
                is_maxres = 1 if "maxres" in url else 0
                is_hq_or_sd = 1 if ("hqdefault" in url or "sddefault" in url) else 0
                return (is_maxres, is_hq_or_sd, area, height, width)

            valid.sort(key=_score, reverse=True)
            return valid[0]["url"]
    single = data.get("thumbnail", "")
    return single if isinstance(single, str) else ""


def _parse_upload_date(data: dict) -> int | None:
    raw = data.get("upload_date") or data.get("release_date")
    if not raw or len(raw) != 8:
        return None
    try:
        import datetime
        d = datetime.date(int(raw[:4]), int(raw[4:6]), int(raw[6:8]))
        return int(datetime.datetime(d.year, d.month, d.day).timestamp())
    except (ValueError, OverflowError):
        return None


def get_metadata(track_id: str) -> dict | None:
    url = f"https://www.youtube.com/watch?v={track_id}"
    cmd = ["yt-dlp", "--dump-json", "--no-download", "--no-call-home", url]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        data   = json.loads(result.stdout.strip())
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


def download(
    track_id:          str,
    output_dir:        str,
    temp_dir:          str,
    audio_format:      str = "webm",
    progress_callback: Callable[[int, str], None] | None = None,
) -> str | None:
    """
    Download audio at maximum quality. Default is native WebM/Opus stream.
    Atomic: downloads to temp path, renames to final on success.
    Returns final file path (absolute) or None on failure.
    """
    is_native = audio_format in _NATIVE_FORMATS

    if not _download_lock.acquire(blocking=False):
        logger.info(f"Download queued (lock busy): {track_id}")
        _download_lock.acquire()

    try:
        output_path = Path(output_dir).resolve()
        temp_path   = Path(temp_dir).resolve()
        output_path.mkdir(parents=True, exist_ok=True)
        temp_path.mkdir(parents=True, exist_ok=True)

        temp_template = str(temp_path / f"{track_id}.tmp.%(ext)s")
        url           = f"https://www.youtube.com/watch?v={track_id}"

        if progress_callback:
            progress_callback(5, "downloading")

        if is_native:
            fmt_filter = {
                "webm": "bestaudio[ext=webm]/bestaudio",
                "opus": "bestaudio[ext=webm]/bestaudio[acodec=opus]/bestaudio",
                "m4a":  "bestaudio[ext=m4a]/bestaudio[acodec=aac]/bestaudio",
                "aac":  "bestaudio[acodec=aac]/bestaudio[ext=m4a]/bestaudio",
                "ogg":  "bestaudio[ext=ogg]/bestaudio",
            }.get(audio_format, "bestaudio/best")
            cmd = [
                "yt-dlp",
                "--format",      fmt_filter,
                "--output",      temp_template,
                "--no-playlist", "--no-call-home",
                "--progress",    "--no-warnings",
                url,
            ]
        else:
            cmd = [
                "yt-dlp",
                "--extract-audio",
                "--audio-format",  audio_format,
                "--audio-quality", "0",
                "--format",        "bestaudio/best",
                "--output",        temp_template,
                "--no-playlist",   "--no-call-home",
                "--progress",      "--no-warnings",
                url,
            ]

        logger.info(f"Downloading {track_id} ({'native' if is_native else 'transcoded'} {audio_format})")

        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
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

        candidates = list(temp_path.glob(f"{track_id}.tmp.*"))
        if not candidates:
            logger.error(f"Temp file not found for {track_id}")
            return None

        temp_file  = candidates[0]
        actual_ext = temp_file.suffix.lstrip(".")
        final_file = output_path / f"{track_id}.{actual_ext}"
        final_path = str(final_file)

        if actual_ext != audio_format:
            logger.info(f"Actual ext .{actual_ext} differs from .{audio_format} — saving as {final_path}")

        temp_file.rename(final_file)

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


def download_thumbnail(track_id: str, thumbnails_dir: str, thumbnail_url: str) -> str | None:
    thumb_path = Path(thumbnails_dir).resolve()
    thumb_path.mkdir(parents=True, exist_ok=True)
    dest = str(thumb_path / f"{track_id}.jpg")

    if thumbnail_url:
        try:
            urllib.request.urlretrieve(thumbnail_url, dest)
            logger.info(f"Thumbnail saved: {dest}")
            return dest
        except Exception as e:
            logger.warning(f"Direct thumbnail download failed for {track_id}: {e}")

    try:
        tmp = str(thumb_path / f"{track_id}.thumb")
        cmd = [
            "yt-dlp", "--write-thumbnail", "--skip-download",
            "--convert-thumbnails", "jpg", "--no-call-home",
            "--output", tmp,
            f"https://www.youtube.com/watch?v={track_id}",
        ]
        subprocess.run(cmd, capture_output=True, timeout=20)
        candidate = thumb_path / f"{track_id}.thumb.jpg"
        if candidate.exists():
            candidate.rename(dest)
            return dest
    except Exception as e:
        logger.warning(f"yt-dlp thumbnail fallback failed for {track_id}: {e}")

    return None


def cleanup_temp_files(temp_dir: str) -> None:
    temp_path = Path(temp_dir).resolve()
    if not temp_path.exists():
        return
    for f in temp_path.glob("*.tmp*"):
        try:
            f.unlink()
            logger.info(f"Cleaned temp file: {f}")
        except Exception as e:
            logger.warning(f"Could not delete {f}: {e}")
