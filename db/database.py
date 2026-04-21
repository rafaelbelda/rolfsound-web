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
        # ---> NOVO: Migração segura para bases de dados existentes
        try:
            conn.execute("ALTER TABLE tracks ADD COLUMN bpm INTEGER")
        except sqlite3.OperationalError:
            pass # A coluna já existe
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
            source          TEXT,
            status          TEXT DEFAULT 'unidentified',
            mb_recording_id TEXT,
            discogs_id      TEXT,
            label           TEXT,
            year            INTEGER,
            bpm             INTEGER,
            fingerprint     TEXT
        );

        CREATE TABLE IF NOT EXISTS history (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            track_id        TEXT,
            played_at       INTEGER,
            duration_played INTEGER,
            skipped         INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS downloads (
            track_id    TEXT PRIMARY KEY,
            status      TEXT,
            progress    INTEGER DEFAULT 0,
            started_at  INTEGER,
            title       TEXT,
            thumbnail   TEXT
        );

        CREATE TABLE IF NOT EXISTS discogs_account (
            id            INTEGER PRIMARY KEY CHECK (id = 1),
            access_token  TEXT NOT NULL,
            access_secret TEXT NOT NULL,
            username      TEXT,
            connected_at  INTEGER
        );

        CREATE TABLE IF NOT EXISTS discogs_collection (
            release_id      INTEGER PRIMARY KEY,
            title           TEXT,
            artist          TEXT,
            local_cover_url TEXT,
            spine_color     TEXT,
            year            INTEGER,
            date_added      TEXT
        );

        CREATE TABLE IF NOT EXISTS playlists (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS playlist_tracks (
            playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
            track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            position    INTEGER NOT NULL DEFAULT 0,
            added_at    INTEGER NOT NULL,
            PRIMARY KEY (playlist_id, track_id)
        );

        CREATE TABLE IF NOT EXISTS queue_state (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            tracks_json TEXT NOT NULL DEFAULT '[]',
            current_idx INTEGER NOT NULL DEFAULT -1,
            repeat_mode TEXT NOT NULL DEFAULT 'off',
            shuffle     INTEGER NOT NULL DEFAULT 0,
            saved_at    INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS scheduled_queues (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            name         TEXT NOT NULL,
            tracks_json  TEXT NOT NULL DEFAULT '[]',
            scheduled_at INTEGER NOT NULL,
            status       TEXT NOT NULL DEFAULT 'pending',
            created_at   INTEGER NOT NULL
        );
    """)


# ── Tracks ────────────────────────────────────────────────────────────────────

def get_track(conn, track_id):
    row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    return dict(row) if row else None


def insert_track(conn, track):
    conn.execute("""
        INSERT OR REPLACE INTO tracks
            (id, title, artist, duration, thumbnail, file_path,
             date_added, published_date, streams, source,
             status, mb_recording_id, discogs_id, label, year)
        VALUES
            (:id, :title, :artist, :duration, :thumbnail, :file_path,
             :date_added, :published_date, :streams, :source,
             :status, :mb_recording_id, :discogs_id, :label, :year)
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
        "status":         track.get("status", "unidentified"),
        "mb_recording_id": track.get("mb_recording_id"),
        "discogs_id":     track.get("discogs_id"),
        "label":          track.get("label"),
        "year":           track.get("year"),
    })


def get_all_track_ids(conn):
    rows = conn.execute("SELECT id FROM tracks").fetchall()
    return {row["id"] for row in rows}


def list_tracks(conn):
    rows = conn.execute("SELECT * FROM tracks ORDER BY date_added DESC").fetchall()
    return [dict(r) for r in rows]


def list_unidentified_tracks(conn) -> list[dict]:
    rows = conn.execute("""
        SELECT * FROM tracks
        WHERE status = 'unidentified' OR status IS NULL
        ORDER BY date_added DESC
    """).fetchall()
    return [dict(r) for r in rows]


def update_track_metadata(conn, track_id: str, data: dict) -> None:
    allowed = {
        "title", "artist", "duration", "thumbnail",
        "status", "mb_recording_id", "discogs_id", "label", "year", "bpm", "fingerprint"
    }
    updates = {k: v for k, v in data.items() if k in allowed and v is not None}
    if not updates:
        return
    fields = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [track_id]
    conn.execute(f"UPDATE tracks SET {fields} WHERE id = ?", values)


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
                 date_added, published_date, streams, source, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (track_id, f.stem, "", None, thumb, str(f),
              int(_time.time()), None, 0, "local", "unidentified"))
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
    return [dict(r) for r in rows]


def increment_streams(conn, track_id):
    conn.execute("UPDATE tracks SET streams = streams + 1 WHERE id = ?", (track_id,))


def delete_track(conn, track_id):
    conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
    conn.execute("DELETE FROM downloads WHERE track_id = ?", (track_id,))


# ── History ───────────────────────────────────────────────────────────────────

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


# ── Downloads ─────────────────────────────────────────────────────────────────

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


# ── Discogs account ───────────────────────────────────────────────────────────

def get_discogs_account(conn):
    row = conn.execute("SELECT * FROM discogs_account WHERE id = 1").fetchone()
    return dict(row) if row else None


def save_discogs_account(conn, access_token: str, access_secret: str,
                         username: str | None, connected_at: int) -> None:
    conn.execute("""
        INSERT OR REPLACE INTO discogs_account (id, access_token, access_secret, username, connected_at)
        VALUES (1, ?, ?, ?, ?)
    """, (access_token, access_secret, username, connected_at))


def delete_discogs_account(conn) -> None:
    conn.execute("DELETE FROM discogs_account WHERE id = 1")


# ── Discogs collection ────────────────────────────────────────────────────────

def upsert_discogs_release(conn, release_id: int, title: str, artist: str,
                           local_cover_url: str, spine_color: str,
                           year: int, date_added: str) -> None:
    conn.execute("""
        INSERT OR REPLACE INTO discogs_collection
            (release_id, title, artist, local_cover_url, spine_color, year, date_added)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (release_id, title, artist, local_cover_url, spine_color, year, date_added))


def get_discogs_collection(conn) -> list[dict]:
    rows = conn.execute("""
        SELECT * FROM discogs_collection
        ORDER BY date_added DESC
    """).fetchall()
    return [dict(r) for r in rows]


def get_all_discogs_ids(conn) -> set:
    rows = conn.execute("SELECT release_id FROM discogs_collection").fetchall()
    return {r["release_id"] for r in rows}


def delete_discogs_release(conn, release_id: int) -> None:
    conn.execute("DELETE FROM discogs_collection WHERE release_id = ?", (release_id,))


def clear_discogs_collection(conn) -> None:
    conn.execute("DELETE FROM discogs_collection")


# ── Playlists ─────────────────────────────────────────────────────────────────

def list_playlists(conn) -> list[dict]:
    rows = conn.execute("""
        SELECT p.id, p.name, p.created_at, COUNT(pt.track_id) AS track_count
        FROM playlists p
        LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
        GROUP BY p.id
        ORDER BY p.created_at DESC
    """).fetchall()
    return [dict(r) for r in rows]


def get_playlist(conn, playlist_id: int):
    row = conn.execute("SELECT * FROM playlists WHERE id = ?", (playlist_id,)).fetchone()
    return dict(row) if row else None


def create_playlist(conn, name: str) -> int:
    import time
    cursor = conn.execute(
        "INSERT INTO playlists (name, created_at) VALUES (?, ?)",
        (name.strip(), int(time.time()))
    )
    conn.commit()
    return int(cursor.lastrowid)


def delete_playlist(conn, playlist_id: int) -> None:
    conn.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
    conn.commit()


def add_track_to_playlist(conn, playlist_id: int, track_id: str) -> None:
    import time
    row = conn.execute(
        "SELECT COALESCE(MAX(position), -1) AS max_position FROM playlist_tracks WHERE playlist_id = ?",
        (playlist_id,)
    ).fetchone()
    next_position = (row["max_position"] + 1) if row else 0
    conn.execute("""
        INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at)
        VALUES (?, ?, ?, ?)
    """, (playlist_id, track_id, next_position, int(time.time())))
    conn.commit()


def remove_track_from_playlist(conn, playlist_id: int, track_id: str) -> None:
    conn.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?",
        (playlist_id, track_id)
    )
    conn.commit()


def get_playlist_tracks(conn, playlist_id: int, sort_by: str = "position",
                        sort_order: str = "asc") -> list[dict]:
    _ALLOWED_SORT = {"position", "title", "artist", "duration", "streams", "added_at", "year"}
    col = sort_by if sort_by in _ALLOWED_SORT else "position"
    order = "DESC" if sort_order.lower() == "desc" else "ASC"
    sql_col = f"t.{col}" if col not in ("position", "added_at") else f"pt.{col}"
    rows = conn.execute(f"""
        SELECT t.*, pt.position, pt.added_at,
               (SELECT COUNT(*) FROM history h WHERE h.track_id = t.id) AS play_count,
               (SELECT MAX(played_at) FROM history h WHERE h.track_id = t.id) AS last_played,
               (SELECT COUNT(*) FROM history h WHERE h.track_id = t.id AND h.skipped = 1) AS skip_count
        FROM playlist_tracks pt
        JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = ?
        ORDER BY {sql_col} {order}, pt.added_at ASC
    """, (playlist_id,)).fetchall()
    return [dict(r) for r in rows]


def rename_playlist(conn, playlist_id: int, name: str) -> bool:
    cursor = conn.execute(
        "UPDATE playlists SET name = ? WHERE id = ?",
        (name.strip(), playlist_id)
    )
    conn.commit()
    return cursor.rowcount > 0


def track_already_in_playlist(conn, playlist_id: int, track_id: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?",
        (playlist_id, track_id)
    ).fetchone()
    return row is not None


# ── Queue state persistence ───────────────────────────────────────────────────

def save_queue_state(conn, tracks: list, current_idx: int,
                     repeat_mode: str = "off", shuffle: bool = False) -> None:
    import json, time
    conn.execute("""
        INSERT OR REPLACE INTO queue_state (id, tracks_json, current_idx, repeat_mode, shuffle, saved_at)
        VALUES (1, ?, ?, ?, ?, ?)
    """, (json.dumps(tracks), current_idx, repeat_mode, int(shuffle), int(time.time())))
    conn.commit()


def load_queue_state(conn) -> dict:
    import json
    row = conn.execute("SELECT * FROM queue_state WHERE id = 1").fetchone()
    if not row:
        return {"tracks": [], "current_idx": -1, "repeat_mode": "off", "shuffle": False}
    return {
        "tracks":      json.loads(row["tracks_json"]),
        "current_idx": row["current_idx"],
        "repeat_mode": row["repeat_mode"],
        "shuffle":     bool(row["shuffle"]),
    }


# ── Track statistics ──────────────────────────────────────────────────────────

def get_track_stats(conn, track_id: str) -> dict:
    row = conn.execute("""
        SELECT
            COUNT(*)                                          AS play_count,
            MAX(played_at)                                    AS last_played,
            SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END)     AS skip_count
        FROM history WHERE track_id = ?
    """, (track_id,)).fetchone()
    if not row or row["play_count"] == 0:
        return {"play_count": 0, "last_played": None, "skip_count": 0, "skip_rate": 0.0}
    play_count = row["play_count"] or 0
    skip_count = row["skip_count"] or 0
    return {
        "play_count": play_count,
        "last_played": row["last_played"],
        "skip_count":  skip_count,
        "skip_rate":   round(skip_count / play_count, 2) if play_count else 0.0,
    }


def mark_last_history_skipped(conn, track_id: str) -> None:
    """Mark the most recent history entry for a track as skipped."""
    row = conn.execute(
        "SELECT id FROM history WHERE track_id = ? ORDER BY played_at DESC LIMIT 1",
        (track_id,)
    ).fetchone()
    if row:
        conn.execute("UPDATE history SET skipped = 1 WHERE id = ?", (row["id"],))
        conn.commit()


# ── Duplicate DNA (fingerprint) ───────────────────────────────────────────────

def find_duplicate_fingerprints(conn) -> list[list[dict]]:
    """Return groups of tracks that share the same Chromaprint fingerprint."""
    rows = conn.execute("""
        SELECT t.*,
               (SELECT COUNT(*) FROM history h WHERE h.track_id = t.id) AS play_count
        FROM tracks t
        WHERE fingerprint IS NOT NULL AND fingerprint != ''
        ORDER BY fingerprint, date_added ASC
    """).fetchall()
    groups: dict[str, list[dict]] = {}
    for row in rows:
        fp = row["fingerprint"]
        groups.setdefault(fp, []).append(dict(row))
    return [g for g in groups.values() if len(g) > 1]


# ── Scheduled queues ──────────────────────────────────────────────────────────

def create_scheduled_queue(conn, name: str, tracks: list, scheduled_at: int) -> int:
    import json, time
    cursor = conn.execute("""
        INSERT INTO scheduled_queues (name, tracks_json, scheduled_at, status, created_at)
        VALUES (?, ?, ?, 'pending', ?)
    """, (name.strip(), json.dumps(tracks), scheduled_at, int(time.time())))
    conn.commit()
    return int(cursor.lastrowid)


def list_scheduled_queues(conn) -> list[dict]:
    import json
    rows = conn.execute("""
        SELECT * FROM scheduled_queues ORDER BY scheduled_at ASC
    """).fetchall()
    result = []
    for row in rows:
        d = dict(row)
        d["tracks"] = json.loads(d.pop("tracks_json", "[]"))
        result.append(d)
    return result


def get_pending_scheduled_queues(conn, now: int) -> list[dict]:
    import json
    rows = conn.execute("""
        SELECT * FROM scheduled_queues
        WHERE status = 'pending' AND scheduled_at <= ?
        ORDER BY scheduled_at ASC
    """, (now,)).fetchall()
    result = []
    for row in rows:
        d = dict(row)
        d["tracks"] = json.loads(d.pop("tracks_json", "[]"))
        result.append(d)
    return result


def update_scheduled_queue_status(conn, sq_id: int, status: str) -> None:
    conn.execute(
        "UPDATE scheduled_queues SET status = ? WHERE id = ?",
        (status, sq_id)
    )
    conn.commit()


def cancel_scheduled_queue(conn, sq_id: int) -> bool:
    cursor = conn.execute(
        "UPDATE scheduled_queues SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
        (sq_id,)
    )
    conn.commit()
    return cursor.rowcount > 0