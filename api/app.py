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

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from utils import config as cfg
from db import database
from downloads.manager import init_manager, get_manager
from utils.event_poller import get_poller
from utils.event_stream_client import get_client as get_event_stream_client
from library.cleanup import start_cleanup_scheduler
from youtube.ytdlp import cleanup_temp_files
from youtube.search import close_client as close_search_client
from utils import core_client
from utils.monitor_accumulator import get_accumulator
from api.status_enricher import enrich_status
from api.ws.endpoint import get_manager as get_ws_manager, ws_endpoint
from api.ws import state_broadcaster

from api.routes import search, library, queue, playback, history, settings, downloads, monitor, recordings, discogs, playlists, scheduled_queues

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

    import asyncio
    _loop = asyncio.get_event_loop()

    def _on_download_complete(track_id: str, filepath: str, meta: dict):
        from api.services.indexer import index_file
        asyncio.run_coroutine_threadsafe(index_file(track_id, filepath), _loop)
        logger.info(f"Indexer scheduled for {track_id}")

    manager.on_complete(_on_download_complete)

    # Broadcast download progress to all connected WS clients.
    # Runs from the download worker thread — bridge back via run_coroutine_threadsafe.
    def _on_download_progress(track_id: str, pct: int, status: str):
        ws_manager = get_ws_manager()
        asyncio.run_coroutine_threadsafe(
            ws_manager.broadcast({
                "type":    "event.download_progress",
                "payload": {"track_id": track_id, "percent": pct, "status": status},
                "ts":      int(time.time() * 1000),
            }),
            _loop,
        )

    manager.on_progress(_on_download_progress)
    manager.start()

    # Choose the Core → Web event transport (push vs. pull).
    transport = cfg.get("core_events_transport", "sse")
    if transport == "sse":
        event_source = get_event_stream_client()
        logger.info("Core event transport: SSE (push)")
    else:
        event_source = get_poller()
        logger.info("Core event transport: polling (pull)")

    _register_event_handlers(event_source)

    ws_manager = get_ws_manager()
    state_broadcaster.init(ws_manager, asyncio.get_event_loop(), event_source)

    start_cleanup_scheduler(database.get_connection)

    # Initialise persistent HTTP client for core communication.
    # This eliminates ~400-500ms TCP setup overhead on every API call.
    core_client.init_client()

    # Start the event transport *after* handlers are registered AND the shared
    # http client exists — handlers hit core_client.get_status() via state_broadcaster.
    event_source.start()

    # Start the monitor accumulator — polls core's /monitor/samples and fans
    # out to connected SSE clients via /api/monitor/stream.
    get_accumulator().start()

    # ── Restore persisted queue state ─────────────────────────────────
    await _restore_queue_state()

    # ── Start scheduled queue daemon ──────────────────────────────────
    from library.scheduled_queue import start_scheduler as start_sq_scheduler
    start_sq_scheduler(database.get_connection)

    yield

    # ── Shutdown ──────────────────────────────────────────────────────
    get_accumulator().stop()
    event_source.stop()
    manager.stop()
    await close_search_client()
    # Save queue state before closing the core connection.
    await _save_queue_state()
    await core_client.close_client()
    logger.info("rolfsound-control stopped")


async def _restore_queue_state() -> None:
    """Restore previously persisted queue into core on startup."""
    conn = database.get_connection()
    try:
        state = database.load_queue_state(conn)
    finally:
        conn.close()

    tracks = state.get("tracks", [])
    if not tracks:
        return

    logger.info(f"Restoring {len(tracks)} queued tracks from last session")
    for i, track in enumerate(tracks):
        await core_client.queue_add(
            track.get("track_id", ""),
            track.get("filepath", ""),
            track.get("title", ""),
            thumbnail=track.get("thumbnail", ""),
            artist=track.get("artist", ""),
        )

    repeat_mode = state.get("repeat_mode", "off")
    shuffle = state.get("shuffle", False)
    if repeat_mode != "off":
        await core_client.queue_repeat(repeat_mode)
    if shuffle:
        await core_client.queue_shuffle(True)


async def _save_queue_state() -> None:
    """Persist current core queue state to SQLite before shutdown."""
    try:
        status = await core_client.get_status()
        if status is None:
            return
        q = status.get("queue", {})
        tracks = q.get("tracks", [])
        current_idx = q.get("current_index", -1)
        repeat_mode = q.get("repeat_mode", "off")
        shuffle = q.get("shuffle", False)
        conn = database.get_connection()
        try:
            database.save_queue_state(conn, tracks, current_idx, repeat_mode, shuffle)
            logger.info(f"Queue state saved: {len(tracks)} tracks")
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"Failed to save queue state: {e}")


def _register_event_handlers(source):
    from db import database as db

    # Track the last played track_id and when it started, for skip detection.
    _last_play: dict = {"track_id": None, "started_at": 0.0, "duration": 0}

    def on_track_changed(data):
        track_id = data.get("track_id")
        if not track_id:
            return
        conn = db.get_connection()
        try:
            # Skip detection: if previous track changed before 30% of duration, mark as skipped.
            prev_id = _last_play.get("track_id")
            if prev_id and prev_id != track_id:
                elapsed = time.time() - _last_play.get("started_at", time.time())
                duration = _last_play.get("duration", 0)
                if duration > 0 and elapsed < duration * 0.30:
                    db.mark_last_history_skipped(conn, prev_id)

            db.increment_streams(conn, track_id)
            db.add_history(conn, track_id, int(time.time()))
            conn.commit()

            # Update last play tracking.
            track_row = db.get_track(conn, track_id)
            _last_play["track_id"]  = track_id
            _last_play["started_at"] = time.time()
            _last_play["duration"]  = (track_row or {}).get("duration", 0) or 0
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

    source.on("track_changed", on_track_changed)
    source.on("track_finished", on_track_finished)



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
    app.include_router(discogs.router,    prefix="/api")
    app.include_router(playlists.router,        prefix="/api")
    app.include_router(scheduled_queues.router, prefix="/api")

    music_dir = cfg.get("music_directory", "./music")
    Path(music_dir).mkdir(parents=True, exist_ok=True)
    app.mount("/thumbs", StaticFiles(directory=music_dir), name="thumbs")

    static_dir = Path(__file__).parent.parent / "static"
    static_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    @app.websocket("/api/ws")
    async def websocket_route(ws: WebSocket):
        await ws_endpoint(ws)

    @app.get("/api/status")
    async def get_status():
        raw = await core_client.get_status()
        if raw is None:
            return JSONResponse(
                status_code=503,
                content={"error": "core_unavailable", "message": "rolfsound-core is not reachable"},
            )
        return enrich_status(raw)

    # ─── INICIALIZA O MOTOR JINJA2 ───
    templates = Jinja2Templates(directory=str(DASHBOARD_DIR))

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    async def api_not_found(rest: str):
        raise HTTPException(status_code=404, detail=f"API endpoint '/api/{rest}' not found")

    @app.get("/{full_path:path}", response_class=HTMLResponse)
    async def serve_dashboard(request: Request, full_path: str): 
        path = full_path.strip("/")

        # ─── ROTEAMENTO DA SPA (APP SHELL) ───
        # Qualquer path que não seja um arquivo real existente é tratado como rota
        # da SPA e devolve sempre o index.html, deixando o roteamento client-side
        # (history API) cuidar da UI. Isso evita 404 em hard-refresh de qualquer view.
        filename = f"{path}.html"
        filepath = DASHBOARD_DIR / filename

        if filepath.exists():
            return HTMLResponse(content=filepath.read_text(encoding="utf-8"))

        return templates.TemplateResponse(request=request, name="index.html")

    return app 