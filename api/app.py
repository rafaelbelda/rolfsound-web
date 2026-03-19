# api/app.py
"""
FastAPI application for rolfsound-control.
Mounts all API routes and serves the dashboard.
"""

import logging
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

from api.routes import search, library, queue, playback, history, settings, downloads, monitor, recordings

logger = logging.getLogger(__name__)

DASHBOARD_DIR = Path(__file__).parent.parent / "dashboard"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ---- Startup ----
    logger.info("rolfsound-control starting up")

    cfg.load()
    database.init(cfg.get("database_path", "./db/library.db"))

    # Clean up temp files from any previous crashed downloads
    cleanup_temp_files(cfg.get("download_temp_directory", "./cache"))

    # Init download manager
    manager = init_manager(database.get_connection)
    manager.start()

    # Start event poller
    poller = get_poller()
    _register_event_handlers(poller)
    poller.start()

    # Start cleanup scheduler
    start_cleanup_scheduler(database.get_connection)

    yield

    # ---- Shutdown ----
    poller.stop()
    manager.stop()
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

    poller.on("track_changed", on_track_changed)
    poller.on("track_finished", lambda d: logger.debug(f"track_finished: {d}"))


def create_app() -> FastAPI:
    app = FastAPI(
        title="rolfsound-control",
        version="1.0.0",
        lifespan=lifespan,
    )

    # API routes
    app.include_router(search.router, prefix="/api")
    app.include_router(library.router, prefix="/api")
    app.include_router(queue.router, prefix="/api")
    app.include_router(playback.router, prefix="/api")
    app.include_router(history.router, prefix="/api")
    app.include_router(settings.router, prefix="/api")
    app.include_router(downloads.router, prefix="/api")
    app.include_router(monitor.router, prefix="/api")
    app.include_router(recordings.router, prefix="/api")

    # Serve local thumbnails stored alongside music files
    music_dir = cfg.get("music_directory", "./music")
    Path(music_dir).mkdir(parents=True, exist_ok=True)
    app.mount("/thumbs", StaticFiles(directory=music_dir), name="thumbs")

    # Status endpoint
    @app.get("/api/status")
    async def get_status():
        from utils import core_client
        status = core_client.get_status()
        if status is None:
            return JSONResponse(
                status_code=503,
                content={"error": "core_unavailable", "message": "rolfsound-core is not reachable"},
            )
        return status

    # Serve dashboard static files
    static_dir = DASHBOARD_DIR / "static"
    if static_dir.exists():
        app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    # Serve dashboard SPA for all non-API routes
    @app.get("/{full_path:path}", response_class=HTMLResponse)
    async def serve_dashboard(full_path: str):
        index = DASHBOARD_DIR / "index.html"
        if index.exists():
            return HTMLResponse(content=index.read_text(encoding="utf-8"))
        return HTMLResponse(content="<h1>Dashboard not found</h1>", status_code=404)

    return app