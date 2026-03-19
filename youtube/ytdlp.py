# youtube/ytdlp.py
"""
YouTube search and download using yt-dlp.
Enforces single-download-at-a-time via a threading lock.
"""

import json
import logging
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)

_download_lock = threading.Lock()


def search(query: str, max_results: int = 10) -> list[dict]:
    """
    Search YouTube and return metadata for up to max_results tracks.
    Uses yt-dlp's ytsearch feature.
    """
    cmd = [
        "yt-dlp",
        "--dump-json",
        "--no-download",
        "--flat-playlist",
        f"ytsearch{max_results}:{query}",
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        tracks = []
        for line in result.stdout.strip().splitlines():
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                tracks.append({
                    "id": data.get("id", ""),
                    "title": data.get("title", "Unknown"),
                    "duration": data.get("duration"),
                    "thumbnail": data.get("thumbnail", ""),
                    "channel": data.get("channel") or data.get("uploader", ""),
                    "url": data.get("url") or f"https://www.youtube.com/watch?v={data.get('id', '')}",
                })
            except json.JSONDecodeError:
                continue
        return tracks
    except subprocess.TimeoutExpired:
        logger.error("yt-dlp search timed out")
        return []
    except FileNotFoundError:
        logger.error("yt-dlp not found. Install with: pip install yt-dlp")
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
            "id": data.get("id", track_id),
            "title": data.get("title", "Unknown"),
            "artist": data.get("artist") or data.get("uploader", ""),
            "duration": data.get("duration"),
            "thumbnail": data.get("thumbnail", ""),
            "channel": data.get("channel") or data.get("uploader", ""),
        }
    except Exception as e:
        logger.error(f"Metadata fetch error for {track_id}: {e}")
        return None


def download(
    track_id: str,
    output_dir: str,
    temp_dir: str,
    quality: str = "0",        # "0" = best VBR quality in yt-dlp; ignored for lossless formats
    audio_format: str = "mp3",
    progress_callback: Callable[[int, str], None] = None,
) -> str | None:
    """
    Download a YouTube track as the best available audio quality.

    yt-dlp audio quality flag meaning:
      "0"   = best VBR (variable bitrate) — maximum quality for lossy formats like mp3/aac/opus
      "128" = ~128 kbps CBR (significantly lower quality)
    We always default to "0" (best). The config value is kept for override but
    should almost never be changed from "0".

    Uses atomic rename: downloads to temp_dir/<id>.tmp.*, moves to output_dir/<id>.mp3
    Only one download at a time (enforced by threading lock).
    """
    if not _download_lock.acquire(blocking=False):
        logger.warning(f"Download already in progress, queuing {track_id}")
        _download_lock.acquire()

    try:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        Path(temp_dir).mkdir(parents=True, exist_ok=True)

        final_path = str(Path(output_dir) / f"{track_id}.{audio_format}")
        temp_path = str(Path(temp_dir) / f"{track_id}.tmp.%(ext)s")

        url = f"https://www.youtube.com/watch?v={track_id}"

        if progress_callback:
            progress_callback(5, "downloading")

        cmd = [
            "yt-dlp",
            "--extract-audio",
            "--audio-format", audio_format,
            "--audio-quality", "0",          # always best VBR — ignore config quality value
            "--format", "bestaudio/best",    # select best audio stream before extraction
            "--output", temp_path,
            "--no-playlist",
            "--progress",
            "--no-warnings",
            url,
        ]

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
                    pct_str = line.split("%")[0].split()[-1]
                    pct = int(float(pct_str))
                    if progress_callback:
                        progress_callback(pct, "downloading")
                except (ValueError, IndexError):
                    pass

        process.wait()

        if process.returncode != 0:
            logger.error(f"yt-dlp failed for {track_id}")
            return None

        if progress_callback:
            progress_callback(90, "processing")

        # Find the temp file (yt-dlp fills in %(ext)s)
        temp_dir_path = Path(temp_dir)
        candidates = list(temp_dir_path.glob(f"{track_id}.tmp.*"))
        if not candidates:
            logger.error(f"Temp file not found for {track_id}")
            return None

        temp_file = candidates[0]

        # Atomic rename to final path
        temp_file.rename(final_path)

        if progress_callback:
            progress_callback(100, "complete")

        logger.info(f"Downloaded: {final_path}")
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
    Download and save a thumbnail locally as music/<id>.jpg.
    Returns the local path on success, None on failure.
    Falls back to yt-dlp --write-thumbnail if direct download fails.
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

    # Fallback: use yt-dlp to write thumbnail
    try:
        tmp = str(Path(thumbnails_dir) / f"{track_id}.thumb")
        cmd = [
            "yt-dlp",
            "--write-thumbnail",
            "--skip-download",
            "--convert-thumbnails", "jpg",
            "--output", tmp,
            f"https://www.youtube.com/watch?v={track_id}",
        ]
        subprocess.run(cmd, capture_output=True, timeout=20)
        # yt-dlp appends .jpg
        candidate = Path(thumbnails_dir) / f"{track_id}.thumb.jpg"
        if candidate.exists():
            candidate.rename(dest)
            return dest
    except Exception as e:
        logger.warning(f"yt-dlp thumbnail fallback failed for {track_id}: {e}")

    return None


def cleanup_temp_files(temp_dir: str) -> None:
    """Remove leftover .tmp files from crashed downloads."""
    temp_path = Path(temp_dir)
    if not temp_path.exists():
        return
    for f in temp_path.glob("*.tmp*"):
        try:
            f.unlink()
            logger.info(f"Cleaned temp file: {f}")
        except Exception as e:
            logger.warning(f"Could not delete temp file {f}: {e}")
