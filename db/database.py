# db/database.py
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
    conn = sqlite3.connect(_db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _create_tables(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS tracks (
            id              TEXT PRIMARY KEY,
            title           TEXT,
            artist          TEXT,
            duration        INTEGER,
            thumbnail       TEXT,
            file_path       TEXT,
            date_added      INTEGER,
            published_date  INTEGER,
            streams         INTEGER DEFAULT 0,
            source          TEXT
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
    try:
        conn.execute("ALTER TABLE tracks ADD COLUMN published_date INTEGER")
        logger.info("Migrated tracks table: added published_date column")
    except sqlite3.OperationalError:
        pass


def get_track(conn, track_id):
    row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    return dict(row) if row else None


def insert_track(conn, track):
    conn.execute("""
        INSERT OR REPLACE INTO tracks
            (id, title, artist, duration, thumbnail, file_path,
             date_added, published_date, streams, source)
        VALUES
            (:id, :title, :artist, :duration, :thumbnail, :file_path,
             :date_added, :published_date, :streams, :source)
    """, {
        "id":             track.get("id"),
        "title":          track.get("title"),
        "artist":         track.get("artist"),
        "duration":       track.get("duration"),
        "thumbnail":      track.get("thumbnail"),
        "file_path":      track.get("file_path"),
        "date_added":     track.get("date_added"),
        "published_date": track.get("published_date"),
        "streams":        track.get("streams", 0),
        "source":         track.get("source"),
    })


def get_all_track_ids(conn):
    rows = conn.execute("SELECT id FROM tracks").fetchall()
    return {row["id"] for row in rows}


def scan_and_reconcile(conn, music_dir):
    import time as _time
    from youtube.ytdlp import AUDIO_EXTENSIONS
    music_path = Path(music_dir)
    if not music_path.exists():
        return 0
    added = 0
    for f in music_path.iterdir():
        if f.suffix.lower() not in AUDIO_EXTENSIONS:
            continue
        if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"):
            continue
        track_id = f.stem
        existing = conn.execute(
            "SELECT id FROM tracks WHERE id = ? OR file_path = ?", (track_id, str(f))
        ).fetchone()
        if existing:
            continue
        thumb = None
        for ext in (".jpg", ".jpeg", ".png"):
            candidate = music_path / f"{f.stem}{ext}"
            if candidate.exists():
                thumb = str(candidate)
                break
        conn.execute("""
            INSERT OR IGNORE INTO tracks
                (id, title, artist, duration, thumbnail, file_path,
                 date_added, published_date, streams, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (track_id, f.stem, "", None, thumb, str(f), int(_time.time()), None, 0, "local"))
        added += 1
        logger.info(f"Library scan: added {f.name}")
    if added:
        conn.commit()
    return added


def search_tracks(conn, query, limit=50):
    pattern = f"%{query}%"
    rows = conn.execute("""
        SELECT * FROM tracks
        WHERE title LIKE ? OR artist LIKE ?
        ORDER BY streams DESC, date_added DESC
        LIMIT ?
    """, (pattern, pattern, limit)).fetchall()
    results = [dict(r) for r in rows]
    if not results:
        q_lower = query.lower()
        all_rows = conn.execute(
            "SELECT * FROM tracks ORDER BY streams DESC, date_added DESC"
        ).fetchall()
        results = [
            dict(r) for r in all_rows
            if q_lower in (r["title"] or "").lower()
            or q_lower in (r["artist"] or "").lower()
        ][:limit]
    return results


def increment_streams(conn, track_id):
    conn.execute("UPDATE tracks SET streams = streams + 1 WHERE id = ?", (track_id,))


def list_tracks(conn):
    rows = conn.execute("SELECT * FROM tracks ORDER BY date_added DESC").fetchall()
    return [dict(r) for r in rows]


def delete_track(conn, track_id):
    """
    Remove a track from the library and purge its download record.
    Without purging downloads, enqueue() finds status='complete' and
    refuses to re-download after deletion.
    """
    conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
    conn.execute("DELETE FROM downloads WHERE track_id = ?", (track_id,))


def add_history(conn, track_id, played_at, duration_played=0):
    conn.execute(
        "INSERT INTO history (track_id, played_at, duration_played) VALUES (?, ?, ?)",
        (track_id, played_at, duration_played)
    )


def get_history(conn, limit=50):
    rows = conn.execute("""
        SELECT h.*, t.title, t.artist, t.thumbnail, t.duration
        FROM history h
        LEFT JOIN tracks t ON h.track_id = t.id
        ORDER BY h.played_at DESC
        LIMIT ?
    """, (limit,)).fetchall()
    return [dict(r) for r in rows]


def upsert_download(conn, track_id, status, progress=0, started_at=0, title="", thumbnail=""):
    conn.execute("""
        INSERT OR REPLACE INTO downloads (track_id, status, progress, started_at, title, thumbnail)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (track_id, status, progress, started_at, title, thumbnail))


def get_download(conn, track_id):
    row = conn.execute("SELECT * FROM downloads WHERE track_id = ?", (track_id,)).fetchone()
    return dict(row) if row else None


def list_downloads(conn):
    rows = conn.execute("SELECT * FROM downloads ORDER BY started_at DESC").fetchall()
    return [dict(r) for r in rows]


def update_download_progress(conn, track_id, progress, status):
    conn.execute(
        "UPDATE downloads SET progress = ?, status = ? WHERE track_id = ?",
        (progress, status, track_id)
    )


def cleanup_unused_tracks(conn, min_streams, days):
    import time
    cutoff = int(time.time()) - (days * 86400)
    rows = conn.execute("""
        SELECT * FROM tracks WHERE streams < ? AND date_added < ?
    """, (min_streams, cutoff)).fetchall()
    return [dict(r) for r in rows]