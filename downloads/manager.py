"""
Download manager: runs YouTube downloads in a background thread, then hands
the resulting file to the universal MAM pipeline.
"""

import logging
import threading
import time
from pathlib import Path
from typing import Callable

from api.services.pipeline import LibraryManager
from utils.config import get
from utils.path_utils import sanitize_path
from youtube import ytdlp

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
        self._on_progress_callbacks: list[Callable] = []

    def on_complete(self, callback: Callable) -> None:
        self._on_complete_callbacks.append(callback)

    def on_progress(self, callback: Callable) -> None:
        self._on_progress_callbacks.append(callback)

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

    def enqueue(
        self,
        source_ref: str,
        title: str = "",
        thumbnail: str = "",
        target_track_id: str | None = None,
        asset_type: str = "ORIGINAL_MIX",
    ) -> bool:
        from db import database

        conn = self._db_factory()
        try:
            existing = database.get_download(conn, source_ref)
            if existing and existing["status"] in ("queued", "downloading", "processing", "complete"):
                logger.info(f"YouTube source {source_ref} already queued or complete")
                return False

            database.upsert_download(
                conn,
                source_ref,
                "queued",
                0,
                int(time.time()),
                title,
                thumbnail,
            )
            conn.commit()
        finally:
            conn.close()

        with self._lock:
            if any(j["source_ref"] == source_ref for j in self._queue):
                return False
            self._queue.append({
                "source_ref": source_ref,
                "title": title,
                "thumbnail": thumbnail,
                "target_track_id": target_track_id,
                "asset_type": asset_type or "ORIGINAL_MIX",
            })

        logger.info(f"Queued YouTube download: {source_ref} - {title}")
        return True

    def get_status(self, source_ref: str) -> dict | None:
        from db import database

        conn = database.get_connection()
        try:
            return database.get_download(conn, source_ref)
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

        source_ref = job["source_ref"]
        title = job.get("title", "")
        thumbnail = job.get("thumbnail", "")
        target_track_id = job.get("target_track_id")
        asset_type = job.get("asset_type") or "ORIGINAL_MIX"

        self._current = job
        logger.info(f"Starting YouTube download: {source_ref}")

        music_dir = get("music_directory", "./music")
        temp_dir = get("download_temp_directory", "./cache")
        audio_format = get("download_audio_format", "opus")
        download_staging = str(Path(temp_dir).resolve())

        def update_progress(pct: int, status: str):
            conn = database.get_connection()
            try:
                database.update_download_progress(conn, source_ref, pct, status)
                conn.commit()
            finally:
                conn.close()
            for cb in self._on_progress_callbacks:
                try:
                    cb(source_ref, pct, status)
                except Exception as e:
                    logger.error(f"Download progress callback error: {e}")

        def ytdlp_progress(pct: int, status: str):
            if status == "complete":
                update_progress(95, "processing")
            else:
                update_progress(pct, status)

        update_progress(0, "downloading")
        filepath = ytdlp.download(
            track_id=source_ref,
            output_dir=download_staging,
            temp_dir=download_staging,
            audio_format=audio_format,
            progress_callback=ytdlp_progress,
        )

        conn = database.get_connection()
        try:
            if not filepath:
                database.update_download_progress(conn, source_ref, 0, "failed")
                conn.commit()
                logger.error(f"Download failed: {source_ref}")
                return

            filepath = sanitize_path(filepath)
            meta = ytdlp.get_metadata(source_ref) or {}
            remote_thumb = meta.get("thumbnail") or thumbnail
            manager = LibraryManager(music_dir=music_dir, temp_dir=temp_dir)
            ingest_result = manager.ingest_existing_file({
                "temp_path": filepath,
                "filename": meta.get("title") or title or source_ref,
                "source": "YOUTUBE",
                "source_ref": source_ref,
                "target_track_id": target_track_id,
                "asset_type": asset_type,
                "title": meta.get("title") or title,
                "artist": meta.get("artist") or meta.get("channel") or "",
                "thumbnail": remote_thumb,
                "duration": meta.get("duration"),
                "published_date": meta.get("published_date"),
            }, schedule_index=False)

            if not ingest_result:
                database.update_download_progress(conn, source_ref, 0, "failed")
                conn.commit()
                logger.error(f"Pipeline ingest failed for YouTube source {source_ref}")
                return

            database.update_download_resolution(
                conn,
                source_ref,
                ingest_result["track_id"],
                ingest_result["asset_id"],
            )
            database.update_download_progress(conn, source_ref, 100, "complete")
            conn.commit()
            for cb in self._on_progress_callbacks:
                try:
                    cb(source_ref, 100, "complete")
                except Exception as e:
                    logger.error(f"Download progress callback error: {e}")
            logger.info(
                "Download complete: %s -> track %s asset %s",
                source_ref,
                ingest_result["track_id"],
                ingest_result["asset_id"],
            )

            for cb in self._on_complete_callbacks:
                try:
                    cb(source_ref, ingest_result, meta)
                except Exception as e:
                    logger.error(f"Download complete callback error: {e}")
        finally:
            conn.close()
            self._current = None


_manager: DownloadManager | None = None


def get_manager() -> DownloadManager:
    global _manager
    return _manager


def init_manager(db_conn_factory: Callable) -> DownloadManager:
    global _manager
    _manager = DownloadManager(db_conn_factory)
    return _manager
