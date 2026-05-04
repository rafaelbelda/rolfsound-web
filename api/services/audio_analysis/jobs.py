from __future__ import annotations

import asyncio
import logging
import time

from core.database import database
from utils import config as cfg

logger = logging.getLogger(__name__)

_worker_tasks: list[asyncio.Task] = []
_shutdown_event = asyncio.Event()
_pending_signal = asyncio.Event()
_event_loop: asyncio.AbstractEventLoop | None = None


def _notify_pending() -> None:
    if _event_loop and _event_loop.is_running():
        _event_loop.call_soon_threadsafe(_pending_signal.set)
        return
    _pending_signal.set()


def enqueue(asset_id: str) -> None:
    if not asset_id:
        return
    conn = database.get_connection()
    try:
        database.upsert_audio_analysis_job(conn, asset_id, status="pending", next_retry_at=0)
    finally:
        conn.close()
    _notify_pending()


async def analyze_asset(asset_id: str) -> dict:
    from api.services.status_enricher import clear_track_cache
    from api.ws.endpoint import get_manager as get_ws_manager

    from .essentia import analyze_file

    conn = database.get_connection()
    try:
        asset = database.get_asset(conn, asset_id)
        if not asset:
            return {"status": "failed", "reason": "asset_not_found"}
        track_id = asset["track_id"]
        file_path = asset["file_path"]
    finally:
        conn.close()

    analysis = await analyze_file(file_path)

    conn = database.get_connection()
    try:
        database.update_asset_audio_analysis(conn, asset_id, analysis)
        database.update_track_audio_analysis_from_asset(conn, asset_id, analysis)
        conn.commit()
        track = database.get_track(conn, track_id)
    finally:
        conn.close()

    if track:
        clear_track_cache(track_id=track_id, filepath=track.get("file_path") or track.get("filepath"))
        ws_manager = get_ws_manager()
        if ws_manager:
            await ws_manager.broadcast({
                "type": "event.track_updated",
                "payload": {
                    **track,
                    "_changed_fields": ["bpm", "musical_key", "camelot_key"],
                },
                "ts": int(time.time() * 1000),
            })

    return {"status": "done", "asset_id": asset_id, "track_id": track_id, **analysis}


async def _process_one(job: dict) -> None:
    from .essentia import AudioAnalysisError

    asset_id = job["asset_id"]
    try:
        result = await analyze_asset(asset_id)
    except Exception as exc:
        if isinstance(exc, AudioAnalysisError):
            logger.warning("audio analysis job %s failed: %s", asset_id, exc)
        else:
            logger.exception("audio analysis job %s crashed", asset_id)
        conn = database.get_connection()
        try:
            database.complete_audio_analysis_job(conn, asset_id, success=False, error=str(exc))
        finally:
            conn.close()
        return

    success = (result or {}).get("status") == "done"
    error = None if success else f"audio analysis returned {(result or {}).get('reason', 'unknown')}"

    conn = database.get_connection()
    try:
        database.complete_audio_analysis_job(conn, asset_id, success=success, error=error)
    finally:
        conn.close()


async def _worker_loop(worker_id: int) -> None:
    logger.info("audio analysis worker %d started", worker_id)
    try:
        while not _shutdown_event.is_set():
            _pending_signal.clear()
            try:
                conn = database.get_connection()
                try:
                    jobs = database.claim_audio_analysis_jobs(conn, limit=1)
                finally:
                    conn.close()
            except Exception:
                logger.exception("audio analysis worker %d: claim failed", worker_id)
                await asyncio.sleep(5)
                continue

            if not jobs:
                try:
                    await asyncio.wait_for(_pending_signal.wait(), timeout=30)
                except asyncio.TimeoutError:
                    pass
                continue

            for job in jobs:
                if _shutdown_event.is_set():
                    break
                await _process_one(job)
    finally:
        logger.info("audio analysis worker %d stopped", worker_id)


async def start_worker_loop() -> None:
    global _event_loop
    if _worker_tasks:
        return
    _event_loop = asyncio.get_running_loop()
    _shutdown_event.clear()
    n = max(1, int(cfg.get("audio_analysis_workers", 1)))
    for i in range(n):
        _worker_tasks.append(asyncio.create_task(_worker_loop(i)))
    logger.info("started %d audio analysis worker(s)", n)
    _notify_pending()


async def stop_worker_loop() -> None:
    global _event_loop
    if not _worker_tasks:
        return
    _shutdown_event.set()
    _notify_pending()
    for task in _worker_tasks:
        task.cancel()
    for task in _worker_tasks:
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
    _worker_tasks.clear()
    _event_loop = None


def queue_stats() -> dict:
    conn = database.get_connection()
    try:
        rows = conn.execute(
            "SELECT status, COUNT(*) as c FROM audio_analysis_jobs GROUP BY status"
        ).fetchall()
        return {row["status"]: row["c"] for row in rows}
    finally:
        conn.close()
