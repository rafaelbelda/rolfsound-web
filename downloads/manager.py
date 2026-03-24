# downloads/manager.py
"""
Download manager: runs downloads in a background thread,
updates database progress, and notifies on completion.
"""

import logging
import threading
import time
from pathlib import Path
from typing import Callable

from youtube import ytdlp
from utils.config import get
from utils.path_utils import sanitize_path

logger = logging.getLogger(__name__)


class DownloadManager:
    def __init__(self, db_conn_factory: Callable):
        self._db_factory = db_conn_factory
        self._queue: list[dict] = []
        self._current: dict | None = None
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._on_complete_callbacks: list[Callable] = []

    def on_complete(self, callback: Callable) -> None:
        """Register a callback to be called when a download completes."""
        self._on_complete_callbacks.append(callback)

    def start(self) -> None:
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._worker,
            name="download-worker",
            daemon=True,
        )
        self._thread.start()
        logger.info("DownloadManager started")

    def stop(self) -> None:
        self._stop_event.set()

    def enqueue(self, track_id: str, title: str = "", thumbnail: str = "") -> bool:
        """Add a track to the download queue. Returns False if already queued/downloading."""
        from db import database

        with self._db_factory() as conn_ctx:
            conn = conn_ctx
            existing = database.get_download(conn, track_id)
            if existing and existing["status"] in ("queued", "downloading", "complete"):
                logger.info(f"Track {track_id} already in download queue or library")
                return False

            database.upsert_download(
                conn, track_id, "queued", 0, int(time.time()), title, thumbnail
            )

        with self._lock:
            if any(j["track_id"] == track_id for j in self._queue):
                return False
            self._queue.append({
                "track_id": track_id,
                "title": title,
                "thumbnail": thumbnail,
            })

        logger.info(f"Queued download: {track_id} - {title}")
        return True

    def get_status(self, track_id: str) -> dict | None:
        from db import database
        conn = database.get_connection()
        try:
            return database.get_download(conn, track_id)
        finally:
            conn.close()

    def list_all(self) -> list[dict]:
        from db import database
        conn = database.get_connection()
        try:
            return database.list_downloads(conn)
        finally:
            conn.close()

    def _worker(self) -> None:
        while not self._stop_event.is_set():
            job = None
            with self._lock:
                if self._queue:
                    job = self._queue.pop(0)

            if job:
                self._run_download(job)
            else:
                time.sleep(1.0)

    def _run_download(self, job: dict) -> None:
        from db import database

        track_id  = job["track_id"]
        title     = job.get("title", "")
        thumbnail = job.get("thumbnail", "")

        self._current = job
        logger.info(f"Starting download: {track_id}")

        output_dir   = get("music_directory", "./music")
        temp_dir     = get("download_temp_directory", "./cache")
        audio_format = get("download_audio_format", "opus")

        def update_progress(pct: int, status: str):
            conn = database.get_connection()
            try:
                database.update_download_progress(conn, track_id, pct, status)
                conn.commit()
            finally:
                conn.close()

        update_progress(0, "downloading")

        filepath = ytdlp.download(
            track_id=track_id,
            output_dir=output_dir,
            temp_dir=temp_dir,
            audio_format=audio_format,
            progress_callback=update_progress,
        )

        conn = database.get_connection()
        try:
            if filepath:
                # FIX: sanitize the path before it ever touches the DB.
                # ytdlp.download() returns an absolute path via Path.resolve(),
                # but on Windows the backslashes in that string can be
                # misinterpreted as escape sequences (\r, \U, \D, \G …) at
                # any subsequent string boundary (json, logging, SQLite).
                # Storing forward slashes eliminates the corruption at source.
                filepath = sanitize_path(filepath)

                meta         = ytdlp.get_metadata(track_id) or {}
                remote_thumb = meta.get("thumbnail") or thumbnail

                local_thumb = ytdlp.download_thumbnail(
                    track_id=track_id,
                    thumbnails_dir=output_dir,
                    thumbnail_url=remote_thumb,
                )
                # Sanitize thumbnail path for the same reason.
                if local_thumb:
                    local_thumb = sanitize_path(local_thumb)

                database.insert_track(conn, {
                    "id":             track_id,
                    "title":          meta.get("title") or title,
                    "artist":         meta.get("artist") or meta.get("channel") or "",
                    "duration":       meta.get("duration"),
                    "thumbnail":      local_thumb or remote_thumb,
                    "file_path":      filepath,
                    "date_added":     int(time.time()),
                    "published_date": meta.get("published_date"),
                    "streams":        0,
                    "source":         "youtube",
                })
                database.update_download_progress(conn, track_id, 100, "complete")
                conn.commit()
                logger.info(f"Download complete: {track_id} -> {filepath}")

                for cb in self._on_complete_callbacks:
                    try:
                        cb(track_id, filepath, meta)
                    except Exception as e:
                        logger.error(f"Download complete callback error: {e}")
            else:
                database.update_download_progress(conn, track_id, 0, "failed")
                conn.commit()
                logger.error(f"Download failed: {track_id}")
        finally:
            conn.close()
            self._current = None


# Module-level singleton
_manager: DownloadManager | None = None


def get_manager() -> DownloadManager:
    global _manager
    return _manager


def init_manager(db_conn_factory: Callable) -> DownloadManager:
    global _manager
    _manager = DownloadManager(db_conn_factory)
    return _manager