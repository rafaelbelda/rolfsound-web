"""
Scheduled queue daemon.
Checks every 30 seconds for pending scheduled queues whose fire time has passed,
then sends the tracks to rolfsound-core and marks the entry as fired.
"""

import asyncio
import logging
import threading
import time

logger = logging.getLogger(__name__)

_db_conn_factory = None
_loop: asyncio.AbstractEventLoop | None = None


def start_scheduler(db_conn_factory) -> None:
    global _db_conn_factory, _loop
    _db_conn_factory = db_conn_factory
    try:
        _loop = asyncio.get_event_loop()
    except RuntimeError:
        _loop = asyncio.new_event_loop()

    t = threading.Thread(target=_run, name="scheduled-queue", daemon=True)
    t.start()
    logger.info("Scheduled queue daemon started")


def _run() -> None:
    while True:
        time.sleep(30)
        try:
            _check_and_fire()
        except Exception as e:
            logger.error(f"Scheduled queue daemon error: {e}")


def _check_and_fire() -> None:
    from core.database import database
    from utils.core import core

    conn = _db_conn_factory()
    try:
        pending = database.get_pending_scheduled_queues(conn, int(time.time()))
    finally:
        conn.close()

    if not pending:
        return

    for sq in pending:
        sq_id  = sq["id"]
        name   = sq["name"]
        tracks = sq.get("tracks", [])
        logger.info(f"Firing scheduled queue #{sq_id} '{name}' with {len(tracks)} tracks")

        async def _fire():
            await core.queue_clear()
            for track in tracks:
                await core.queue_add(
                    track.get("track_id", ""),
                    track.get("filepath", ""),
                    track.get("title", ""),
                    thumbnail=track.get("thumbnail", ""),
                    artist=track.get("artist", ""),
                )
            if tracks:
                from utils.core import core as cc
                await cc.play(filepath=tracks[0].get("filepath", ""))

        if _loop and not _loop.is_closed():
            future = asyncio.run_coroutine_threadsafe(_fire(), _loop)
            try:
                future.result(timeout=10)
            except Exception as e:
                logger.error(f"Scheduled queue fire error for #{sq_id}: {e}")
                continue

        conn2 = _db_conn_factory()
        try:
            database.update_scheduled_queue_status(conn2, sq_id, "fired")
        finally:
            conn2.close()
        logger.info(f"Scheduled queue #{sq_id} fired successfully")
