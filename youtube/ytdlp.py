# youtube/ytdlp.py
"""
YouTube search and download using yt-dlp.

AUDIO QUALITY STRATEGY
-----------------------
YouTube sources are already lossy (AAC ~128-256 kbps or Opus ~160 kbps).
Re-encoding them to MP3 (lossy→lossy) always degrades quality further,
even at VBR best. The correct approach is:

  1. Download the native audio stream without re-encoding (no --extract-audio).
     This preserves the original codec and bitrate exactly.
     Typical result: .webm (Opus) or .m4a (AAC) — both play fine in
     sounddevice/soundfile/VLC/browsers.

  2. Only transcode if the user explicitly sets a target format in config.
     Default: "opus" — keeps the native Opus stream (zero quality loss on
     most tracks). "m4a" keeps native AAC. "mp3" re-encodes (accepted loss).

  3. WAV files added manually to the music directory are handled naturally:
     the playback service reads them with soundfile which supports WAV natively.
     No conversion is done on WAV files — they are always stored as-is.

SUPPORTED FILE TYPES (for library scan / playback)
---------------------------------------------------
  .wav  .flac  .opus  .webm  .m4a  .aac  .ogg  .mp3

Enforces single-download-at-a-time via a threading lock.
"""

import json
import logging
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)

_download_lock = threading.Lock()

# Extensions the system treats as audio (for library scan and playback routing)
AUDIO_EXTENSIONS = {".wav", ".flac", ".opus", ".webm", ".m4a", ".aac", ".ogg", ".mp3"}

# Formats that are kept as-is from YouTube (no re-encode).
# Any other value triggers --extract-audio --audio-format <fmt> (lossy transcode).
_NATIVE_FORMATS = {"opus", "webm", "m4a", "aac", "ogg"}


def search(query: str, max_results: int = 10) -> list[dict]:
    """Search YouTube via yt-dlp ytsearch and return metadata."""
    cmd = [
        "yt-dlp",
        "--dump-json",
        "--no-download",
        "--flat-playlist",
        f"ytsearch{max_results}:{query}",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        tracks = []
        for line in result.stdout.strip().splitlines():
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                tracks.append({
                    "id":        data.get("id", ""),
                    "title":     data.get("title", "Unknown"),
                    "duration":  data.get("duration"),
                    "thumbnail": data.get("thumbnail", ""),
                    "channel":   data.get("channel") or data.get("uploader", ""),
                    "url":       data.get("url") or f"https://www.youtube.com/watch?v={data.get('id','')}",
                })
            except json.JSONDecodeError:
                continue
        return tracks
    except subprocess.TimeoutExpired:
        logger.error("yt-dlp search timed out")
        return []
    except FileNotFoundError:
        logger.error("yt-dlp not found — install with: pip install yt-dlp")
        return []
    except Exception as e:
        logger.error(f"Search error: {e}")
        return []


def get_metadata(track_id: str) -> dict | None:
    """Fetch full metadata for a single YouTube track."""
    url = f"https://www.youtube.com/watch?v={track_id}"
    cmd = ["yt-dlp", "--dump-json", "--no-download", url]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        data = json.loads(result.stdout.strip())
        return {
            "id":        data.get("id", track_id),
            "title":     data.get("title", "Unknown"),
            "artist":    data.get("artist") or data.get("uploader", ""),
            "duration":  data.get("duration"),
            "thumbnail": data.get("thumbnail", ""),
            "channel":   data.get("channel") or data.get("uploader", ""),
        }
    except Exception as e:
        logger.error(f"Metadata fetch error for {track_id}: {e}")
        return None


def download(
    track_id: str,
    output_dir: str,
    temp_dir: str,
    audio_format: str = "opus",
    progress_callback: Callable[[int, str], None] = None,
) -> str | None:
    """
    Download a YouTube track at maximum quality.

    Quality strategy:
    - "opus" / "webm" / "m4a" / "aac" / "ogg":
        Downloads the best native audio stream with NO re-encoding.
        yt-dlp selects the highest-bitrate stream matching the container.
        This is always the highest possible quality — zero generation loss.

    - "mp3" or any other format:
        Downloads best audio stream then re-encodes with --audio-quality 0
        (VBR best). Accepted quality loss — only use if the downstream
        player doesn't support Opus/AAC.

    - "wav" is NOT a valid download target (lossless storage of a lossy
        source is wasteful). WAV files are for manual additions only.

    Returns the final file path on success, None on failure.
    Only one download runs at a time (threading lock).
    """
    if audio_format == "wav":
        logger.warning(
            "wav is not a valid download format — YouTube sources are lossy. "
            "Falling back to opus (no quality loss)."
        )
        audio_format = "opus"

    is_native = audio_format in _NATIVE_FORMATS

    if not _download_lock.acquire(blocking=False):
        logger.info(f"Download queued (lock busy): {track_id}")
        _download_lock.acquire()

    try:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        Path(temp_dir).mkdir(parents=True, exist_ok=True)

        final_path = str(Path(output_dir) / f"{track_id}.{audio_format}")
        temp_template = str(Path(temp_dir) / f"{track_id}.tmp.%(ext)s")
        url = f"https://www.youtube.com/watch?v={track_id}"

        if progress_callback:
            progress_callback(5, "downloading")

        if is_native:
            # ---- Native stream: no re-encode, zero quality loss ----
            # Pick bestaudio matching the target container.
            # For opus: prefer webm/opus; for m4a: prefer m4a/mp4.
            fmt_filter = {
                "opus":  "bestaudio[ext=webm]/bestaudio[acodec=opus]/bestaudio",
                "webm":  "bestaudio[ext=webm]/bestaudio",
                "m4a":   "bestaudio[ext=m4a]/bestaudio[acodec=aac]/bestaudio",
                "aac":   "bestaudio[acodec=aac]/bestaudio[ext=m4a]/bestaudio",
                "ogg":   "bestaudio[ext=ogg]/bestaudio",
            }.get(audio_format, "bestaudio/best")

            cmd = [
                "yt-dlp",
                "--format", fmt_filter,
                "--output", temp_template,
                "--no-playlist",
                "--progress",
                "--no-warnings",
                url,
            ]
        else:
            # ---- Transcode path (mp3 or explicit user override) ----
            cmd = [
                "yt-dlp",
                "--extract-audio",
                "--audio-format", audio_format,
                "--audio-quality", "0",          # VBR best for the target codec
                "--format", "bestaudio/best",
                "--output", temp_template,
                "--no-playlist",
                "--progress",
                "--no-warnings",
                url,
            ]

        logger.info(
            f"Downloading {track_id} as {'native ' if is_native else 'transcoded '}{audio_format}"
        )

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
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

        # Find temp file — yt-dlp fills in %(ext)s
        temp_dir_path = Path(temp_dir)
        candidates = list(temp_dir_path.glob(f"{track_id}.tmp.*"))
        if not candidates:
            logger.error(f"Temp file not found for {track_id}")
            return None

        temp_file = candidates[0]

        # The actual extension may differ from the requested format
        # (e.g. opus stream lands as .webm). Update final_path accordingly.
        actual_ext = temp_file.suffix.lstrip(".")
        if actual_ext and actual_ext != audio_format:
            final_path = str(Path(output_dir) / f"{track_id}.{actual_ext}")
            logger.info(f"Actual extension is .{actual_ext} — saving as {final_path}")

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


def download_thumbnail(track_id: str, thumbnails_dir: str, thumbnail_url: str) -> str | None:
    """
    Download and save a thumbnail locally as <thumbnails_dir>/<id>.jpg.
    Falls back to yt-dlp --write-thumbnail if direct download fails.
    Returns the local path on success, None on failure.
    """
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
            "yt-dlp",
            "--write-thumbnail", "--skip-download",
            "--convert-thumbnails", "jpg",
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
            logger.warning(f"Could not delete temp file {f}: {e}")