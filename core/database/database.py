import json
import logging
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

logger = logging.getLogger(__name__)
_db_path: str = "./db/library.db"

DEFAULT_FAST_PLAY_ASSET_TYPES = (
    "ORIGINAL_MIX",
    "FLAC",
    "ALT_VERSION",
    "REMIX",
    "LIVE",
    "DEMO",
)


def init(db_path: str) -> None:
    global _db_path
    _db_path = db_path
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        _create_tables(conn)
    logger.info(f"Database initialized at {db_path} with universal MAM architecture")


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
            id                  TEXT PRIMARY KEY,
            title               TEXT,
            artist              TEXT,
            duration            REAL,
            thumbnail           TEXT,
            date_added          INTEGER,
            published_date      INTEGER,
            streams             INTEGER DEFAULT 0,
            status              TEXT DEFAULT 'pending_identity',
            mb_recording_id     TEXT,
            discogs_id          TEXT,
            label               TEXT,
            year                INTEGER,
            bpm                 INTEGER,
            fingerprint         TEXT,
            preferred_asset_id  TEXT
        );

        CREATE TABLE IF NOT EXISTS assets (
            id              TEXT PRIMARY KEY,
            track_id        TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            asset_type      TEXT NOT NULL DEFAULT 'ORIGINAL_MIX',
            source          TEXT,
            source_ref      TEXT,
            file_format     TEXT,
            file_path       TEXT NOT NULL UNIQUE,
            is_primary      INTEGER NOT NULL DEFAULT 0,
            duration        REAL,
            bpm             INTEGER,
            fingerprint     TEXT,
            analysis_status TEXT NOT NULL DEFAULT 'pending',
            date_added      INTEGER
        );

        CREATE TABLE IF NOT EXISTS tags (
            id              TEXT PRIMARY KEY,
            category        TEXT NOT NULL,
            name            TEXT NOT NULL,
            UNIQUE(category, name)
        );

        CREATE TABLE IF NOT EXISTS track_tags (
            track_id        TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            tag_id          TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (track_id, tag_id)
        );

        CREATE TABLE IF NOT EXISTS asset_tags (
            asset_id        TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            tag_id          TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (asset_id, tag_id)
        );

        CREATE TABLE IF NOT EXISTS identity_candidates (
            id                  TEXT PRIMARY KEY,
            asset_id            TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            candidate_track_id  TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            score               REAL NOT NULL,
            reasons_json        TEXT NOT NULL DEFAULT '[]',
            status              TEXT NOT NULL DEFAULT 'pending',
            created_at          INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS history (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            track_id        TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            played_at       INTEGER,
            duration_played INTEGER,
            skipped         INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS downloads (
            source_ref        TEXT PRIMARY KEY,
            status            TEXT,
            progress          INTEGER DEFAULT 0,
            started_at        INTEGER,
            title             TEXT,
            thumbnail         TEXT,
            resolved_track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
            asset_id          TEXT REFERENCES assets(id) ON DELETE SET NULL
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

        CREATE INDEX IF NOT EXISTS idx_assets_track_id ON assets(track_id);
        CREATE INDEX IF NOT EXISTS idx_assets_source ON assets(source, source_ref);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_one_primary
            ON assets(track_id) WHERE is_primary = 1;
        CREATE INDEX IF NOT EXISTS idx_identity_candidates_asset
            ON identity_candidates(asset_id);
    """)


# Tracks and assets

def _dict(row):
    return dict(row) if row else None


def _file_format(path: str) -> str:
    return Path(path).suffix.replace(".", "").upper() or "UNKNOWN"


def _normal_asset_type(value: str | None) -> str:
    cleaned = (value or "ORIGINAL_MIX").strip().upper().replace("-", "_").replace(" ", "_")
    return cleaned or "ORIGINAL_MIX"


def add_track(conn, track: dict) -> str:
    track_id = track.get("id") or str(uuid.uuid4())
    conn.execute("""
        INSERT INTO tracks
            (id, title, artist, duration, thumbnail, date_added, published_date,
             streams, status, mb_recording_id, discogs_id, label, year, bpm,
             fingerprint, preferred_asset_id)
        VALUES
            (:id, :title, :artist, :duration, :thumbnail, :date_added, :published_date,
             :streams, :status, :mb_recording_id, :discogs_id, :label, :year, :bpm,
             :fingerprint, :preferred_asset_id)
    """, {
        "id": track_id,
        "title": track.get("title"),
        "artist": track.get("artist", ""),
        "duration": track.get("duration"),
        "thumbnail": track.get("thumbnail"),
        "date_added": track.get("date_added", int(time.time())),
        "published_date": track.get("published_date"),
        "streams": track.get("streams", 0),
        "status": track.get("status", "pending_identity"),
        "mb_recording_id": track.get("mb_recording_id"),
        "discogs_id": track.get("discogs_id"),
        "label": track.get("label"),
        "year": track.get("year"),
        "bpm": track.get("bpm"),
        "fingerprint": track.get("fingerprint"),
        "preferred_asset_id": track.get("preferred_asset_id"),
    })
    return track_id


def add_asset(
    conn,
    track_id: str,
    file_path: str,
    asset_type: str = "ORIGINAL_MIX",
    source: str = "UNKNOWN",
    source_ref: str | None = None,
    file_format: str | None = None,
    asset_id: str | None = None,
    is_primary: bool | None = None,
    duration: float | None = None,
    bpm: int | None = None,
    fingerprint: str | None = None,
    analysis_status: str = "pending",
) -> str:
    if not get_track_row(conn, track_id):
        raise ValueError(f"Track not found: {track_id}")

    asset_id = asset_id or str(uuid.uuid4())
    asset_type = _normal_asset_type(asset_type)
    if is_primary is None:
        existing = conn.execute(
            "SELECT 1 FROM assets WHERE track_id = ? LIMIT 1", (track_id,)
        ).fetchone()
        is_primary = existing is None

    if is_primary:
        conn.execute("UPDATE assets SET is_primary = 0 WHERE track_id = ?", (track_id,))

    conn.execute("""
        INSERT INTO assets
            (id, track_id, asset_type, source, source_ref, file_format, file_path,
             is_primary, duration, bpm, fingerprint, analysis_status, date_added)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        asset_id,
        track_id,
        asset_type,
        source,
        source_ref,
        file_format or _file_format(file_path),
        file_path,
        1 if is_primary else 0,
        duration,
        bpm,
        fingerprint,
        analysis_status,
        int(time.time()),
    ))
    tag_asset(conn, asset_id, "asset_type", asset_type)
    if source:
        tag_asset(conn, asset_id, "source", source.upper())
    if file_format or file_path:
        tag_asset(conn, asset_id, "format", (file_format or _file_format(file_path)).upper())
    return asset_id


def get_track_row(conn, track_id: str):
    return conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()


def get_asset(conn, asset_id: str) -> dict | None:
    return _dict(conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone())


def get_asset_by_path(conn, file_path: str) -> dict | None:
    return _dict(conn.execute("SELECT * FROM assets WHERE file_path = ?", (file_path,)).fetchone())


def get_asset_by_source_ref(conn, source: str, source_ref: str) -> dict | None:
    return _dict(conn.execute("""
        SELECT * FROM assets
        WHERE source = ? AND source_ref = ?
        ORDER BY date_added DESC
        LIMIT 1
    """, (source, source_ref)).fetchone())


def get_assets_for_track(conn, track_id: str) -> list[dict]:
    rows = conn.execute("""
        SELECT * FROM assets
        WHERE track_id = ?
        ORDER BY is_primary DESC, date_added ASC
    """, (track_id,)).fetchall()
    return [dict(r) for r in rows]


def list_assets(conn) -> list[dict]:
    rows = conn.execute("""
        SELECT * FROM assets
        ORDER BY date_added DESC
    """).fetchall()
    return [dict(r) for r in rows]


def list_pending_assets(conn) -> list[dict]:
    rows = conn.execute("""
        SELECT a.*
        FROM assets a
        JOIN tracks t ON t.id = a.track_id
        WHERE a.analysis_status IN ('pending', 'failed')
           OR t.status IN ('pending_identity', 'unidentified')
           OR t.status IS NULL
        ORDER BY a.date_added DESC
    """).fetchall()
    return [dict(r) for r in rows]


def get_fast_play_asset(conn, track_id: str) -> dict | None:
    track = get_track_row(conn, track_id)
    if not track:
        return None

    preferred_id = track["preferred_asset_id"]
    if preferred_id:
        preferred = get_asset(conn, preferred_id)
        if preferred and preferred["track_id"] == track_id:
            return preferred

    for asset_type in DEFAULT_FAST_PLAY_ASSET_TYPES:
        row = conn.execute("""
            SELECT * FROM assets
            WHERE track_id = ? AND (asset_type = ? OR file_format = ?)
            ORDER BY is_primary DESC, date_added ASC
            LIMIT 1
        """, (track_id, asset_type, asset_type)).fetchone()
        if row:
            return dict(row)

    row = conn.execute("""
        SELECT * FROM assets
        WHERE track_id = ? AND is_primary = 1
        ORDER BY date_added ASC
        LIMIT 1
    """, (track_id,)).fetchone()
    if row:
        return dict(row)

    row = conn.execute("""
        SELECT * FROM assets
        WHERE track_id = ?
        ORDER BY date_added ASC
        LIMIT 1
    """, (track_id,)).fetchone()
    return dict(row) if row else None


def set_preferred_asset(conn, track_id: str, asset_id: str | None) -> bool:
    if asset_id:
        asset = get_asset(conn, asset_id)
        if not asset or asset["track_id"] != track_id:
            return False
    conn.execute(
        "UPDATE tracks SET preferred_asset_id = ? WHERE id = ?",
        (asset_id, track_id),
    )
    return True


def mark_asset_primary(conn, asset_id: str) -> bool:
    asset = get_asset(conn, asset_id)
    if not asset:
        return False
    conn.execute("UPDATE assets SET is_primary = 0 WHERE track_id = ?", (asset["track_id"],))
    conn.execute("UPDATE assets SET is_primary = 1 WHERE id = ?", (asset_id,))
    return True


def _attach_fast_asset(conn, track: dict) -> dict:
    assets = get_assets_for_track(conn, track["id"])
    track["assets"] = assets
    fast_asset = get_fast_play_asset(conn, track["id"])
    if fast_asset:
        track["asset_id"] = fast_asset["id"]
        track["asset_type"] = fast_asset["asset_type"]
        track["file_path"] = fast_asset["file_path"]
        track["source"] = fast_asset["source"]
        track["source_ref"] = fast_asset["source_ref"]
    return track


def get_track(conn, track_id):
    row = get_track_row(conn, track_id)
    if not row:
        return None
    return _attach_fast_asset(conn, dict(row))


def get_all_track_ids(conn):
    rows = conn.execute("SELECT id FROM tracks").fetchall()
    return {row["id"] for row in rows}


def list_tracks(conn):
    rows = conn.execute("""
        SELECT t.*,
            (SELECT COUNT(*) FROM history h WHERE h.track_id = t.id) AS play_count
        FROM tracks t
        ORDER BY t.date_added DESC
    """).fetchall()
    return [_attach_fast_asset(conn, dict(r)) for r in rows]


def list_unidentified_tracks(conn) -> list[dict]:
    rows = conn.execute("""
        SELECT DISTINCT t.*
        FROM tracks t
        LEFT JOIN assets a ON a.track_id = t.id
        WHERE t.status IN ('pending_identity', 'unidentified')
           OR t.status IS NULL
           OR a.analysis_status IN ('pending', 'failed')
        ORDER BY t.date_added DESC
    """).fetchall()
    return [_attach_fast_asset(conn, dict(r)) for r in rows]


def update_track_metadata(conn, track_id: str, data: dict) -> None:
    allowed = {
        "title", "artist", "duration", "thumbnail", "status",
        "mb_recording_id", "discogs_id", "label", "year", "bpm",
        "fingerprint", "preferred_asset_id", "published_date",
    }
    updates = {k: v for k, v in data.items() if k in allowed and v is not None}
    if not updates:
        return
    fields = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [track_id]
    conn.execute(f"UPDATE tracks SET {fields} WHERE id = ?", values)


def update_asset_analysis(conn, asset_id: str, data: dict) -> None:
    allowed = {"duration", "bpm", "fingerprint", "analysis_status", "asset_type"}
    updates = {k: v for k, v in data.items() if k in allowed and v is not None}
    if not updates:
        return
    if "asset_type" in updates:
        updates["asset_type"] = _normal_asset_type(updates["asset_type"])
    fields = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [asset_id]
    conn.execute(f"UPDATE assets SET {fields} WHERE id = ?", values)
    if "asset_type" in updates:
        tag_asset(conn, asset_id, "asset_type", updates["asset_type"])


def update_asset_path(conn, asset_id: str, file_path: str) -> None:
    conn.execute("""
        UPDATE assets
        SET file_path = ?, file_format = ?
        WHERE id = ?
    """, (file_path, _file_format(file_path), asset_id))


def reassign_asset(
    conn,
    asset_id: str,
    target_track_id: str,
    asset_type: str | None = None,
    set_primary: bool = False,
) -> str | None:
    asset = get_asset(conn, asset_id)
    if not asset:
        return None
    if not get_track_row(conn, target_track_id):
        raise ValueError(f"Target track not found: {target_track_id}")

    source_track_id = asset["track_id"]
    if source_track_id == target_track_id:
        if asset_type:
            update_asset_analysis(conn, asset_id, {"asset_type": asset_type})
        return source_track_id

    has_primary = conn.execute("""
        SELECT 1 FROM assets
        WHERE track_id = ? AND is_primary = 1
        LIMIT 1
    """, (target_track_id,)).fetchone()
    make_primary = set_primary or has_primary is None
    if make_primary:
        conn.execute("UPDATE assets SET is_primary = 0 WHERE track_id = ?", (target_track_id,))

    conn.execute("""
        UPDATE assets
        SET track_id = ?, asset_type = COALESCE(?, asset_type), is_primary = ?
        WHERE id = ?
    """, (
        target_track_id,
        _normal_asset_type(asset_type) if asset_type else None,
        1 if make_primary else 0,
        asset_id,
    ))
    if asset_type:
        tag_asset(conn, asset_id, "asset_type", asset_type)

    conn.execute("""
        UPDATE tracks
        SET preferred_asset_id = NULL
        WHERE id = ? AND preferred_asset_id = ?
    """, (source_track_id, asset_id))
    update_download_resolution_by_asset(conn, asset_id, target_track_id)

    remaining = conn.execute("""
        SELECT 1 FROM assets
        WHERE track_id = ?
        LIMIT 1
    """, (source_track_id,)).fetchone()
    if not remaining:
        conn.execute("DELETE FROM tracks WHERE id = ?", (source_track_id,))
    return source_track_id


def search_tracks(conn, query, limit=50):
    pattern = f"%{query}%"
    rows = conn.execute("""
        SELECT DISTINCT t.*
        FROM tracks t
        LEFT JOIN assets a ON a.track_id = t.id
        WHERE t.title LIKE ?
           OR t.artist LIKE ?
           OR a.asset_type LIKE ?
           OR a.source_ref LIKE ?
        ORDER BY t.streams DESC, t.date_added DESC
        LIMIT ?
    """, (pattern, pattern, pattern, pattern, limit)).fetchall()
    return [_attach_fast_asset(conn, dict(r)) for r in rows]


def increment_streams(conn, track_id):
    conn.execute("UPDATE tracks SET streams = streams + 1 WHERE id = ?", (track_id,))


def delete_track(conn, track_id):
    conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
    conn.execute("DELETE FROM downloads WHERE resolved_track_id = ?", (track_id,))


def scan_and_reconcile(conn, music_dir, return_asset_ids: bool = False):
    from core.ingestors.youtube.ytdlp import AUDIO_EXTENSIONS

    music_path = Path(music_dir)
    if not music_path.exists():
        return [] if return_asset_ids else 0

    added_assets: list[str] = []
    for f in music_path.rglob("*"):
        if not f.is_file() or f.suffix.lower() not in AUDIO_EXTENSIONS:
            continue

        file_path = str(f)
        if get_asset_by_path(conn, file_path):
            continue

        thumb = None
        for ext in (".jpg", ".jpeg", ".png"):
            candidate = f.with_suffix(ext)
            if candidate.exists():
                thumb = str(candidate)
                break

        track_id = add_track(conn, {
            "title": f.stem,
            "artist": "",
            "thumbnail": thumb,
            "date_added": int(time.time()),
            "status": "pending_identity",
        })
        asset_id = add_asset(
            conn,
            track_id=track_id,
            file_path=file_path,
            asset_type="ORIGINAL_MIX",
            source="LOCAL_SCAN",
            source_ref=file_path,
            file_format=_file_format(file_path),
            analysis_status="pending",
        )
        added_assets.append(asset_id)
        logger.info(f"Library scan: added {f.name} as asset {asset_id} on track {track_id}")

    if added_assets:
        conn.commit()
    return added_assets if return_asset_ids else len(added_assets)


# Tags

def add_tag(conn, category: str, name: str) -> str:
    category = (category or "general").strip().lower()
    name = (name or "").strip()
    if not name:
        raise ValueError("Tag name cannot be empty")
    existing = conn.execute(
        "SELECT id FROM tags WHERE category = ? AND name = ?",
        (category, name),
    ).fetchone()
    if existing:
        return existing["id"]
    tag_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO tags (id, category, name) VALUES (?, ?, ?)",
        (tag_id, category, name),
    )
    return tag_id


def tag_track(conn, track_id: str, category: str, name: str) -> None:
    tag_id = add_tag(conn, category, name)
    conn.execute(
        "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?, ?)",
        (track_id, tag_id),
    )


def tag_asset(conn, asset_id: str, category: str, name: str) -> None:
    tag_id = add_tag(conn, category, name)
    conn.execute(
        "INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) VALUES (?, ?)",
        (asset_id, tag_id),
    )


def get_track_tags(conn, track_id: str) -> list[dict]:
    rows = conn.execute("""
        SELECT tags.* FROM tags
        JOIN track_tags ON track_tags.tag_id = tags.id
        WHERE track_tags.track_id = ?
        ORDER BY tags.category, tags.name
    """, (track_id,)).fetchall()
    return [dict(r) for r in rows]


def get_asset_tags(conn, asset_id: str) -> list[dict]:
    rows = conn.execute("""
        SELECT tags.* FROM tags
        JOIN asset_tags ON asset_tags.tag_id = tags.id
        WHERE asset_tags.asset_id = ?
        ORDER BY tags.category, tags.name
    """, (asset_id,)).fetchall()
    return [dict(r) for r in rows]


# Identity candidates

def add_identity_candidate(
    conn,
    asset_id: str,
    candidate_track_id: str,
    score: float,
    reasons: list[str] | None = None,
    status: str = "pending",
) -> str:
    existing = conn.execute("""
        SELECT id FROM identity_candidates
        WHERE asset_id = ? AND candidate_track_id = ? AND status = ?
    """, (asset_id, candidate_track_id, status)).fetchone()
    if existing:
        return existing["id"]

    candidate_id = str(uuid.uuid4())
    conn.execute("""
        INSERT INTO identity_candidates
            (id, asset_id, candidate_track_id, score, reasons_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (
        candidate_id,
        asset_id,
        candidate_track_id,
        float(score),
        json.dumps(reasons or []),
        status,
        int(time.time()),
    ))
    return candidate_id


def list_identity_candidates(conn, asset_id: str | None = None) -> list[dict]:
    if asset_id:
        rows = conn.execute("""
            SELECT * FROM identity_candidates
            WHERE asset_id = ?
            ORDER BY score DESC, created_at DESC
        """, (asset_id,)).fetchall()
    else:
        rows = conn.execute("""
            SELECT * FROM identity_candidates
            ORDER BY score DESC, created_at DESC
        """).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        try:
            item["reasons"] = json.loads(item.pop("reasons_json") or "[]")
        except json.JSONDecodeError:
            item["reasons"] = []
        result.append(item)
    return result


def find_identity_matches(conn, meta: dict, exclude_track_id: str | None = None) -> list[dict]:
    matches: dict[str, dict] = {}

    def add(track_id: str, score: float, reason: str):
        if exclude_track_id and track_id == exclude_track_id:
            return
        current = matches.get(track_id)
        if current:
            current["score"] = max(current["score"], score)
            current["reasons"].append(reason)
        else:
            matches[track_id] = {"track_id": track_id, "score": score, "reasons": [reason]}

    fingerprint = meta.get("fingerprint") or meta.get("raw_fp")
    if fingerprint:
        rows = conn.execute("""
            SELECT DISTINCT track_id FROM assets
            WHERE fingerprint = ? AND track_id != COALESCE(?, '')
        """, (fingerprint, exclude_track_id)).fetchall()
        for row in rows:
            add(row["track_id"], 0.98, "exact_fingerprint")

    mb_recording_id = meta.get("mb_recording_id")
    if mb_recording_id:
        rows = conn.execute("""
            SELECT id FROM tracks
            WHERE mb_recording_id = ? AND id != COALESCE(?, '')
        """, (mb_recording_id, exclude_track_id)).fetchall()
        for row in rows:
            add(row["id"], 0.96, "musicbrainz_recording")

    title = _identity_text(meta.get("title") or "")
    artist = _identity_text(meta.get("artist") or "")
    identity_source = meta.get("identity_source")
    if title and artist:
        rows = conn.execute("""
            SELECT id, title, artist, duration FROM tracks
            WHERE id != COALESCE(?, '')
        """, (exclude_track_id,)).fetchall()
        for row in rows:
            if _identity_text(row["title"] or "") != title:
                continue
            if _identity_text(row["artist"] or "") != artist:
                continue
            score = 0.94 if identity_source in {"acoustid", "shazam"} else 0.86
            duration = meta.get("duration")
            existing_duration = row["duration"]
            if duration and existing_duration:
                ratio = abs(float(duration) - float(existing_duration)) / max(float(duration), float(existing_duration))
                if ratio <= 0.08:
                    score += 0.02
                elif ratio >= 0.45:
                    score -= 0.005
            add(row["id"], score, f"title_artist_{identity_source or 'unknown'}")

    return sorted(matches.values(), key=lambda item: item["score"], reverse=True)


def _identity_text(value: str) -> str:
    text = value.lower()
    text = re.sub(r"\b(remix|rework|live|demo|instrumental|karaoke|radio edit|single edit)\b", "", text)
    text = re.sub(r"\b(alt|alternate|alternative|version|take|unreleased|leak|official|video|lyrics?)\b", "", text)
    text = re.sub(r"\s*[\(\[].*?[\)\]]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(text.split())


# Downloads

def upsert_download(
    conn,
    source_ref: str,
    status: str,
    progress: int = 0,
    started_at: int = 0,
    title: str = "",
    thumbnail: str = "",
    resolved_track_id: str | None = None,
    asset_id: str | None = None,
):
    conn.execute("""
        INSERT INTO downloads
            (source_ref, status, progress, started_at, title, thumbnail,
             resolved_track_id, asset_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_ref) DO UPDATE SET
            status = excluded.status,
            progress = excluded.progress,
            started_at = excluded.started_at,
            title = excluded.title,
            thumbnail = excluded.thumbnail,
            resolved_track_id = COALESCE(excluded.resolved_track_id, downloads.resolved_track_id),
            asset_id = COALESCE(excluded.asset_id, downloads.asset_id)
    """, (
        source_ref,
        status,
        progress,
        started_at,
        title,
        thumbnail,
        resolved_track_id,
        asset_id,
    ))


def get_download(conn, source_ref):
    row = conn.execute("SELECT * FROM downloads WHERE source_ref = ?", (source_ref,)).fetchone()
    return dict(row) if row else None


def list_downloads(conn):
    rows = conn.execute("SELECT * FROM downloads ORDER BY started_at DESC").fetchall()
    return [dict(r) for r in rows]


def update_download_progress(conn, source_ref, progress, status):
    conn.execute(
        "UPDATE downloads SET progress = ?, status = ? WHERE source_ref = ?",
        (progress, status, source_ref),
    )


def update_download_resolution(conn, source_ref: str, track_id: str, asset_id: str) -> None:
    conn.execute("""
        UPDATE downloads
        SET resolved_track_id = ?, asset_id = ?
        WHERE source_ref = ?
    """, (track_id, asset_id, source_ref))


def update_download_resolution_by_asset(conn, asset_id: str, track_id: str) -> None:
    conn.execute(
        "UPDATE downloads SET resolved_track_id = ? WHERE asset_id = ?",
        (track_id, asset_id),
    )


def cleanup_unused_tracks(conn, min_streams, days):
    cutoff = int(time.time()) - (days * 86400)
    rows = conn.execute("""
        SELECT * FROM tracks
        WHERE streams < ? AND date_added < ?
    """, (min_streams, cutoff)).fetchall()
    return [_attach_fast_asset(conn, dict(r)) for r in rows]


# History

def add_history(conn, track_id, played_at, duration_played=0):
    conn.execute(
        "INSERT INTO history (track_id, played_at, duration_played) VALUES (?, ?, ?)",
        (track_id, played_at, duration_played),
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


# Discogs account

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


# Discogs collection

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


# Playlists

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
    cursor = conn.execute(
        "INSERT INTO playlists (name, created_at) VALUES (?, ?)",
        (name.strip(), int(time.time())),
    )
    conn.commit()
    return int(cursor.lastrowid)


def delete_playlist(conn, playlist_id: int) -> None:
    conn.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
    conn.commit()


def add_track_to_playlist(conn, playlist_id: int, track_id: str) -> None:
    row = conn.execute(
        "SELECT COALESCE(MAX(position), -1) AS max_position FROM playlist_tracks WHERE playlist_id = ?",
        (playlist_id,),
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
        (playlist_id, track_id),
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
    return [_attach_fast_asset(conn, dict(r)) for r in rows]


def rename_playlist(conn, playlist_id: int, name: str) -> bool:
    cursor = conn.execute(
        "UPDATE playlists SET name = ? WHERE id = ?",
        (name.strip(), playlist_id),
    )
    conn.commit()
    return cursor.rowcount > 0


def track_already_in_playlist(conn, playlist_id: int, track_id: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?",
        (playlist_id, track_id),
    ).fetchone()
    return row is not None


# Queue state persistence

def save_queue_state(conn, tracks: list, current_idx: int,
                     repeat_mode: str = "off", shuffle: bool = False) -> None:
    conn.execute("""
        INSERT OR REPLACE INTO queue_state (id, tracks_json, current_idx, repeat_mode, shuffle, saved_at)
        VALUES (1, ?, ?, ?, ?, ?)
    """, (json.dumps(tracks), current_idx, repeat_mode, int(shuffle), int(time.time())))
    conn.commit()


def load_queue_state(conn) -> dict:
    row = conn.execute("SELECT * FROM queue_state WHERE id = 1").fetchone()
    if not row:
        return {"tracks": [], "current_idx": -1, "repeat_mode": "off", "shuffle": False}
    return {
        "tracks": json.loads(row["tracks_json"]),
        "current_idx": row["current_idx"],
        "repeat_mode": row["repeat_mode"],
        "shuffle": bool(row["shuffle"]),
    }


# Track statistics

def get_track_stats(conn, track_id: str) -> dict:
    row = conn.execute("""
        SELECT
            COUNT(*)                                      AS play_count,
            MAX(played_at)                                AS last_played,
            SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END)  AS skip_count
        FROM history WHERE track_id = ?
    """, (track_id,)).fetchone()
    if not row or row["play_count"] == 0:
        return {"play_count": 0, "last_played": None, "skip_count": 0, "skip_rate": 0.0}
    play_count = row["play_count"] or 0
    skip_count = row["skip_count"] or 0
    return {
        "play_count": play_count,
        "last_played": row["last_played"],
        "skip_count": skip_count,
        "skip_rate": round(skip_count / play_count, 2) if play_count else 0.0,
    }


def mark_last_history_skipped(conn, track_id: str) -> None:
    row = conn.execute(
        "SELECT id FROM history WHERE track_id = ? ORDER BY played_at DESC LIMIT 1",
        (track_id,),
    ).fetchone()
    if row:
        conn.execute("UPDATE history SET skipped = 1 WHERE id = ?", (row["id"],))
        conn.commit()


def find_duplicate_fingerprints(conn) -> list[list[dict]]:
    rows = conn.execute("""
        SELECT t.*, a.fingerprint AS asset_fingerprint
        FROM assets a
        JOIN tracks t ON t.id = a.track_id
        WHERE a.fingerprint IS NOT NULL AND a.fingerprint != ''
        ORDER BY a.fingerprint, t.date_added ASC
    """).fetchall()
    groups: dict[str, list[dict]] = {}
    for row in rows:
        fp = row["asset_fingerprint"]
        groups.setdefault(fp, []).append(_attach_fast_asset(conn, dict(row)))
    return [g for g in groups.values() if len(g) > 1]


# Scheduled queues

def create_scheduled_queue(conn, name: str, tracks: list, scheduled_at: int) -> int:
    cursor = conn.execute("""
        INSERT INTO scheduled_queues (name, tracks_json, scheduled_at, status, created_at)
        VALUES (?, ?, ?, 'pending', ?)
    """, (name.strip(), json.dumps(tracks), scheduled_at, int(time.time())))
    conn.commit()
    return int(cursor.lastrowid)


def list_scheduled_queues(conn) -> list[dict]:
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
        (status, sq_id),
    )
    conn.commit()


def cancel_scheduled_queue(conn, sq_id: int) -> bool:
    cursor = conn.execute(
        "UPDATE scheduled_queues SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
        (sq_id,),
    )
    conn.commit()
    return cursor.rowcount > 0
