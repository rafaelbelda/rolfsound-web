# db/database.py
"""
SQLite database setup and helpers for rolfsound-control.
"""

import sqlite3
import logging
from contextlib import contextmanager
from pathlib import Path

logger = logging.getLogger(__name__)

_db_path: str = "./db/library.db"


def init(db_path: str) -> None:
    global _db_path
    _db_path = db_path
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        _create_tables(conn)
    logger.info(f"Database initialized at {db_path}")


@contextmanager
def _connect():
    conn = sqlite3.connect(_db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_connection():
    """Return a persistent connection for use in request handlers."""
    conn = sqlite3.connect(_db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _create_tables(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS tracks (
            id          TEXT PRIMARY KEY,
            title       TEXT,
            artist      TEXT,
            duration    INTEGER,
            thumbnail   TEXT,
            file_path   TEXT,
            date_added  INTEGER,
            streams     INTEGER DEFAULT 0,
            source      TEXT
        );

        CREATE TABLE IF NOT EXISTS history (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            track_id        TEXT,
            played_at       INTEGER,
            duration_played INTEGER
        );

        CREATE TABLE IF NOT EXISTS downloads (
            track_id    TEXT PRIMARY KEY,
            status      TEXT,
            progress    INTEGER DEFAULT 0,
            started_at  INTEGER,
            title       TEXT,
            thumbnail   TEXT
        );
    """)


# ---- Track helpers ----

def get_track(conn, track_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM tracks WHERE id = ?", (track_id,)
    ).fetchone()
    return dict(row) if row else None


def insert_track(conn, track: dict) -> None:
    conn.execute("""
        INSERT OR REPLACE INTO tracks
            (id, title, artist, duration, thumbnail, file_path, date_added, streams, source)
        VALUES
            (:id, :title, :artist, :duration, :thumbnail, :file_path, :date_added, :streams, :source)
    """, track)


def increment_streams(conn, track_id: str) -> None:
    conn.execute(
        "UPDATE tracks SET streams = streams + 1 WHERE id = ?", (track_id,)
    )


def list_tracks(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM tracks ORDER BY date_added DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def delete_track(conn, track_id: str) -> None:
    conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))


# ---- History helpers ----

def add_history(conn, track_id: str, played_at: int, duration_played: int = 0) -> None:
    conn.execute("""
        INSERT INTO history (track_id, played_at, duration_played)
        VALUES (?, ?, ?)
    """, (track_id, played_at, duration_played))


def get_history(conn, limit: int = 50) -> list[dict]:
    rows = conn.execute("""
        SELECT h.*, t.title, t.artist, t.thumbnail, t.duration
        FROM history h
        LEFT JOIN tracks t ON h.track_id = t.id
        ORDER BY h.played_at DESC
        LIMIT ?
    """, (limit,)).fetchall()
    return [dict(r) for r in rows]


# ---- Download helpers ----

def upsert_download(conn, track_id: str, status: str, progress: int = 0,
                    started_at: int = 0, title: str = "", thumbnail: str = "") -> None:
    conn.execute("""
        INSERT OR REPLACE INTO downloads (track_id, status, progress, started_at, title, thumbnail)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (track_id, status, progress, started_at, title, thumbnail))


def get_download(conn, track_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM downloads WHERE track_id = ?", (track_id,)
    ).fetchone()
    return dict(row) if row else None


def list_downloads(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM downloads ORDER BY started_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def update_download_progress(conn, track_id: str, progress: int, status: str) -> None:
    conn.execute(
        "UPDATE downloads SET progress = ?, status = ? WHERE track_id = ?",
        (progress, status, track_id)
    )


# ---- Cleanup ----

def cleanup_unused_tracks(conn, min_streams: int, days: int) -> list[dict]:
    import time
    cutoff = int(time.time()) - (days * 86400)
    rows = conn.execute("""
        SELECT * FROM tracks
        WHERE streams < ? AND date_added < ?
    """, (min_streams, cutoff)).fetchall()
    return [dict(r) for r in rows]