"""
Persistent identification job queue.

Wraps `index_asset` so identification work survives process restarts and
flaky external APIs auto-retry with backoff. Records live in the
`identification_jobs` table.

Lifecycle:
    pending  -> in_progress  -> done            (success)
                             \-> retry          (transient failure; re-queued)
                             \-> failed         (max attempts hit)

Usage:
    enqueue(asset_id)              # called from upload / download / scan
    await start_worker_loop()      # called once at FastAPI startup
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

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
    """Synchronous; safe to call from any thread."""
    if not asset_id:
        return
    conn = database.get_connection()
    try:
        database.upsert_identification_job(conn, asset_id, status="pending", next_retry_at=0)
    finally:
        conn.close()
    _notify_pending()


async def _process_one(job: dict) -> None:
    from api.services.indexer import index_asset

    asset_id = job["asset_id"]
    try:
        result = await index_asset(asset_id, allow_identity_resolution=True)
    except Exception as exc:
        logger.exception("identification job %s crashed", asset_id)
        conn = database.get_connection()
        try:
            database.complete_identification_job(conn, asset_id, success=False, error=str(exc))
        finally:
            conn.close()
        return

    status = (result or {}).get("status", "unknown")
    success = status in ("identified", "low_confidence", "unidentified")
    error = None if success else f"index_asset returned {status}: {(result or {}).get('reason', '?')}"

    if status == "unidentified" and (result or {}).get("evidence"):
        success = True

    conn = database.get_connection()
    try:
        database.complete_identification_job(conn, asset_id, success=success, error=error)
    finally:
        conn.close()


async def _worker_loop(worker_id: int) -> None:
    logger.info("identification worker %d started", worker_id)
    try:
        while not _shutdown_event.is_set():
            _pending_signal.clear()
            try:
                conn = database.get_connection()
                try:
                    jobs = database.claim_identification_jobs(conn, limit=1)
                finally:
                    conn.close()
            except Exception:
                logger.exception("identification worker %d: claim failed", worker_id)
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
        logger.info("identification worker %d stopped", worker_id)


async def start_worker_loop() -> None:
    """Spawn N worker tasks; idempotent."""
    global _event_loop
    if _worker_tasks:
        return
    _event_loop = asyncio.get_running_loop()
    _shutdown_event.clear()
    n = max(1, int(cfg.get("identification_workers", 2)))
    for i in range(n):
        _worker_tasks.append(asyncio.create_task(_worker_loop(i)))
    logger.info("started %d identification workers", n)
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
    """Return counts by status — useful for /api/library/identification-stats."""
    conn = database.get_connection()
    try:
        rows = conn.execute(
            "SELECT status, COUNT(*) as c FROM identification_jobs GROUP BY status"
        ).fetchall()
        return {row["status"]: row["c"] for row in rows}
    finally:
        conn.close()
