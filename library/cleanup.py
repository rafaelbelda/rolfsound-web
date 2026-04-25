# library/cleanup.py
"""
Automatic library cleanup.
Removes tracks that have low stream counts and are old.
"""

import logging
import os
import threading
import time

from utils.config import get

logger = logging.getLogger(__name__)


def run_cleanup(conn) -> int:
    """
    Delete tracks with streams < cleanup_min_streams and older than cleanup_days.
    Returns number of tracks deleted.
    """
    from db import database

    if not get("cleanup_enabled", False):
        return 0

    min_streams = get("cleanup_min_streams", 3)
    days = get("cleanup_days", 30)

    candidates = database.cleanup_unused_tracks(conn, min_streams, days)
    deleted = 0

    for track in candidates:
        for asset in track.get("assets", []):
            filepath = asset.get("file_path")
            if filepath and os.path.exists(filepath):
                try:
                    os.remove(filepath)
                    logger.info(f"Cleanup: deleted file {filepath}")
                except OSError as e:
                    logger.warning(f"Cleanup: could not delete {filepath}: {e}")

        database.delete_track(conn, track["id"])
        deleted += 1
        logger.info(f"Cleanup: removed track {track['id']} ({track.get('title')})")

    conn.commit()
    return deleted


def start_cleanup_scheduler(db_conn_factory) -> None:
    """Start a background thread that runs cleanup daily."""

    def _loop():
        while True:
            time.sleep(86400)  # 24 hours
            try:
                conn = db_conn_factory()
                count = run_cleanup(conn)
                conn.close()
                if count:
                    logger.info(f"Scheduled cleanup removed {count} tracks")
            except Exception as e:
                logger.error(f"Cleanup scheduler error: {e}")

    t = threading.Thread(target=_loop, name="cleanup-scheduler", daemon=True)
    t.start()
    logger.info("Cleanup scheduler started")
