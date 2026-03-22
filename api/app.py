# api/app.py
"""
FastAPI application for rolfsound-control.
Mounts all API routes and serves the dashboard.
"""

import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from utils import config as cfg
from db import database
from downloads.manager import init_manager, get_manager
from utils.event_poller import get_poller
from library.cleanup import start_cleanup_scheduler
from youtube.ytdlp import cleanup_temp_files
from youtube.search import close_client as close_search_client

from api.routes import search, library, queue, playback, history, settings, downloads, monitor, recordings

logger = logging.getLogger(__name__)

DASHBOARD_DIR = Path(__file__).parent.parent / "dashboard"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ───────────────────────────────────────────────────────
    logger.info("rolfsound-control starting up")

    cfg.load()
    database.init(cfg.get("database_path", "./db/library.db"))

    music_dir = cfg.get("music_directory", "./music")
    conn = database.get_connection()
    try:
        added = database.scan_and_reconcile(conn, music_dir)
        if added:
            logger.info(f"Library scan: added {added} previously untracked files")
    finally:
        conn.close()

    cleanup_temp_files(cfg.get("download_temp_directory", "./cache"))

    manager = init_manager(database.get_connection)
    manager.start()

    poller = get_poller()
    _register_event_handlers(poller)
    poller.start()

    start_cleanup_scheduler(database.get_connection)

    yield

    # ── Shutdown ──────────────────────────────────────────────────────
    poller.stop()
    manager.stop()
    await close_search_client()
    logger.info("rolfsound-control stopped")


def _register_event_handlers(poller):
    from db import database as db

    def on_track_changed(data):
        track_id = data.get("track_id")
        if not track_id:
            return
        conn = db.get_connection()
        try:
            db.increment_streams(conn, track_id)
            db.add_history(conn, track_id, int(time.time()))
            conn.commit()
        finally:
            conn.close()

    def on_track_finished(data):
        filepath = data.get("filepath", "")
        track_id = data.get("track_id", "")
        if not filepath or not track_id:
            return
        conn = db.get_connection()
        try:
            existing = db.get_track(conn, track_id)
            if not existing and os.path.exists(filepath):
                db.insert_track(conn, {
                    "id":             track_id,
                    "title":          os.path.basename(filepath),
                    "artist":         "",
                    "duration":       None,
                    "thumbnail":      None,
                    "file_path":      filepath,
                    "date_added":     int(time.time()),
                    "published_date": None,
                    "streams":        0,
                    "source":         "recording",
                })
                conn.commit()
                logger.info(f"Auto-inserted recording into library: {track_id}")
        except Exception as e:
            logger.error(f"on_track_finished insert error: {e}")
        finally:
            conn.close()

    poller.on("track_changed", on_track_changed)
    poller.on("track_finished", on_track_finished)


def _enrich_status(raw: dict) -> dict:
    """
    Reshape core's /status for the dashboard.

    Core returns nested playback/queue dicts. The dashboard JS reads
    flat top-level keys: state, track_id, title, artist, thumbnail,
    position, duration, position_updated_at, queue (flat array).

    Metadata resolution order for now-playing track:
      1. DB lookup by file_path (most authoritative — has artist etc.)
      2. now_playing block from core (has thumbnail from queue dict)
      3. Filename fallback

    This layering means recordings and edge cases always get something
    reasonable, and DB-tracked tracks get full metadata.
    """
    pb = raw.get("playback", {})
    q  = raw.get("queue",    {})

    # ── Playback state ────────────────────────────────────────────────
    if pb.get("playing"):
        state = "playing"
    elif pb.get("paused"):
        state = "paused"
    else:
        state = "idle"

    current_filepath = pb.get("current_track", "")

    # ── Metadata: start with filename defaults ────────────────────────
    title     = os.path.basename(current_filepath) if current_filepath else ""
    artist    = ""
    thumbnail = ""
    track_id  = os.path.basename(current_filepath) if current_filepath else ""

    # ── Layer 1: DB lookup by filepath (most authoritative) ───────────
    if current_filepath:
        try:
            conn = database.get_connection()
            try:
                row = conn.execute(
                    "SELECT id, title, artist, thumbnail FROM tracks WHERE file_path = ?",
                    (current_filepath,)
                ).fetchone()
                if row:
                    track_id  = row["id"]        or track_id
                    title     = row["title"]      or title
                    artist    = row["artist"]     or ""
                    thumbnail = row["thumbnail"]  or ""
            finally:
                conn.close()
        except Exception as e:
            logger.debug(f"Status enrichment DB lookup failed: {e}")

    # ── Layer 2: now_playing from core (queue metadata fallback) ──────
    # Used when the DB lookup misses — e.g. recordings not in the DB,
    # or a track whose file_path stored in the DB doesn't match exactly.
    # Core's now_playing block is built from the queue dict which always
    # has the thumbnail that was passed in at queue-add time.
    np = pb.get("now_playing", {})
    if np:
        if not track_id or track_id == os.path.basename(current_filepath):
            track_id = np.get("track_id") or track_id
        if not title or title == os.path.basename(current_filepath):
            title    = np.get("title")    or title
        if not thumbnail:
            thumbnail = np.get("thumbnail") or ""

    # ── Queue: reshape to flat array, preserve current_index ──────────
    # Dashboard updateQueue() receives the flat array.
    # current_index is preserved so the web layer can highlight
    # the active track and resolve metadata if needed.
    queue_tracks = []
    for t in q.get("tracks", []):
        queue_tracks.append({
            "track_id":  t.get("track_id",  ""),
            "title":     t.get("title",     ""),
            "thumbnail": t.get("thumbnail", ""),
            "artist":    t.get("artist",    ""),
            "filepath":  t.get("filepath",  ""),
        })

    # ── Write flat keys the dashboard reads ───────────────────────────
    raw["state"]                = state
    raw["track_id"]             = track_id
    raw["title"]                = title
    raw["artist"]               = artist
    raw["thumbnail"]            = thumbnail
    raw["position"]             = pb.get("position_s",          0)
    raw["duration"]             = pb.get("duration_s",          0)
    # Forward position_updated_at so the dashboard can dead-reckon
    # the progress slider between polls without server round-trips.
    # Formula: display_pos = position + (Date.now()/1000 - position_updated_at)
    raw["position_updated_at"]  = pb.get("position_updated_at", time.time())
    raw["volume"]               = pb.get("volume",              1.0)
    raw["queue"]                = queue_tracks
    raw["queue_current_index"]  = q.get("current_index", -1)

    return raw


def create_app() -> FastAPI:
    app = FastAPI(
        title="rolfsound-control",
        version="1.0.0",
        lifespan=lifespan,
    )

    app.include_router(search.router,     prefix="/api")
    app.include_router(library.router,    prefix="/api")
    app.include_router(queue.router,      prefix="/api")
    app.include_router(playback.router,   prefix="/api")
    app.include_router(history.router,    prefix="/api")
    app.include_router(settings.router,   prefix="/api")
    app.include_router(downloads.router,  prefix="/api")
    app.include_router(monitor.router,    prefix="/api")
    app.include_router(recordings.router, prefix="/api")

    music_dir = cfg.get("music_directory", "./music")
    Path(music_dir).mkdir(parents=True, exist_ok=True)
    app.mount("/thumbs", StaticFiles(directory=music_dir), name="thumbs")

    @app.get("/api/status")
    async def get_status():
        from utils import core_client
        raw = await core_client.get_status()
        if raw is None:
            return JSONResponse(
                status_code=503,
                content={"error": "core_unavailable", "message": "rolfsound-core is not reachable"},
            )
        return _enrich_status(raw)

    static_dir = DASHBOARD_DIR / "static"
    if static_dir.exists():
        app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    @app.get("/{full_path:path}", response_class=HTMLResponse)
    async def serve_dashboard(full_path: str):
        index = DASHBOARD_DIR / "index.html"
        if index.exists():
            return HTMLResponse(content=index.read_text(encoding="utf-8"))
        return HTMLResponse(content="<h1>Dashboard not found</h1>", status_code=404)

    return app