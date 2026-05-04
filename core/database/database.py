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
            display_artist      TEXT,
            duration            REAL,
            thumbnail           TEXT,
            date_added          INTEGER,
            published_date      INTEGER,
            streams             INTEGER DEFAULT 0,
            status              TEXT DEFAULT 'pending_identity',
            mb_recording_id     TEXT,
            isrc                TEXT,
            spotify_id          TEXT,
            discogs_id          TEXT,
            label               TEXT,
            year                INTEGER,
            bpm                 REAL,
            musical_key         TEXT,
            camelot_key         TEXT,
            fingerprint         TEXT,
            preferred_asset_id  TEXT,
            primary_artist_id   TEXT,
            primary_album_id    TEXT,
            canonical_title_key TEXT,
            primary_artist_key  TEXT,
            recording_key       TEXT
        );

        CREATE TABLE IF NOT EXISTS artists (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            sort_name       TEXT,
            canonical_key   TEXT NOT NULL UNIQUE,
            mb_artist_id    TEXT,
            spotify_id      TEXT,
            discogs_id      TEXT,
            source          TEXT,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS artist_aliases (
            id              TEXT PRIMARY KEY,
            artist_id       TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
            alias           TEXT NOT NULL,
            canonical_key   TEXT NOT NULL,
            source          TEXT,
            created_at      INTEGER NOT NULL,
            UNIQUE(artist_id, canonical_key)
        );

        CREATE TABLE IF NOT EXISTS track_artists (
            track_id        TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            artist_id       TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
            role            TEXT NOT NULL DEFAULT 'main',
            position        INTEGER NOT NULL DEFAULT 0,
            is_primary      INTEGER NOT NULL DEFAULT 0,
            join_phrase     TEXT NOT NULL DEFAULT '',
            source          TEXT,
            PRIMARY KEY (track_id, artist_id, role)
        );

        CREATE TABLE IF NOT EXISTS albums (
            id                   TEXT PRIMARY KEY,
            title                TEXT NOT NULL,
            display_artist       TEXT,
            canonical_key        TEXT NOT NULL UNIQUE,
            release_type         TEXT,
            year                 INTEGER,
            cover                TEXT,
            mb_release_id        TEXT,
            mb_release_group_id  TEXT,
            spotify_album_id     TEXT,
            discogs_id           TEXT,
            source               TEXT,
            created_at           INTEGER NOT NULL,
            updated_at           INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS album_tracks (
            album_id        TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
            track_id        TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            disc_number     INTEGER NOT NULL DEFAULT 1,
            track_number    INTEGER,
            position        INTEGER NOT NULL DEFAULT 0,
            source          TEXT,
            PRIMARY KEY (album_id, track_id)
        );

        CREATE TABLE IF NOT EXISTS catalog_releases (
            id              TEXT PRIMARY KEY,
            provider        TEXT NOT NULL,
            provider_id     TEXT NOT NULL,
            artist_id       TEXT REFERENCES artists(id) ON DELETE SET NULL,
            album_id        TEXT REFERENCES albums(id) ON DELETE SET NULL,
            title           TEXT NOT NULL,
            release_type    TEXT,
            year            INTEGER,
            cover           TEXT,
            raw_json        TEXT,
            fetched_at      INTEGER NOT NULL,
            UNIQUE(provider, provider_id)
        );

        CREATE TABLE IF NOT EXISTS catalog_recordings (
            id                  TEXT PRIMARY KEY,
            provider            TEXT NOT NULL,
            provider_id         TEXT NOT NULL,
            catalog_release_id  TEXT REFERENCES catalog_releases(id) ON DELETE CASCADE,
            album_id            TEXT REFERENCES albums(id) ON DELETE SET NULL,
            title               TEXT NOT NULL,
            display_artist      TEXT,
            isrc                TEXT,
            duration            REAL,
            disc_number         INTEGER,
            track_number        INTEGER,
            available_track_id  TEXT REFERENCES tracks(id) ON DELETE SET NULL,
            raw_json            TEXT,
            fetched_at          INTEGER NOT NULL,
            UNIQUE(provider, provider_id)
        );

        CREATE TABLE IF NOT EXISTS catalog_artist_credits (
            catalog_recording_id TEXT NOT NULL REFERENCES catalog_recordings(id) ON DELETE CASCADE,
            artist_id            TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
            role                 TEXT NOT NULL DEFAULT 'main',
            position             INTEGER NOT NULL DEFAULT 0,
            is_primary           INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (catalog_recording_id, artist_id, role)
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
            bpm             REAL,
            musical_key     TEXT,
            camelot_key     TEXT,
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

        CREATE TABLE IF NOT EXISTS external_lookup_cache (
            provider     TEXT NOT NULL,
            cache_key    TEXT NOT NULL,
            response     TEXT,
            fetched_at   INTEGER NOT NULL,
            ttl_seconds  INTEGER NOT NULL,
            PRIMARY KEY (provider, cache_key)
        );

        CREATE TABLE IF NOT EXISTS identification_jobs (
            asset_id      TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
            status        TEXT NOT NULL DEFAULT 'pending',
            attempts      INTEGER NOT NULL DEFAULT 0,
            last_error    TEXT,
            next_retry_at INTEGER NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audio_analysis_jobs (
            asset_id      TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
            status        TEXT NOT NULL DEFAULT 'pending',
            attempts      INTEGER NOT NULL DEFAULT 0,
            last_error    TEXT,
            next_retry_at INTEGER NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS asset_identification_results (
            asset_id      TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
            status        TEXT,
            confidence    REAL,
            sources_json  TEXT NOT NULL DEFAULT '[]',
            reasons_json  TEXT NOT NULL DEFAULT '[]',
            evidence_json TEXT NOT NULL DEFAULT '[]',
            updated_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS track_identity_overrides (
            track_id      TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
            payload_json  TEXT NOT NULL,
            source        TEXT NOT NULL DEFAULT 'manual',
            locked        INTEGER NOT NULL DEFAULT 1,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_preferences (
            key          TEXT PRIMARY KEY,
            value_json   TEXT NOT NULL,
            updated_at   INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_assets_track_id ON assets(track_id);
        CREATE INDEX IF NOT EXISTS idx_assets_source ON assets(source, source_ref);
        CREATE INDEX IF NOT EXISTS idx_tracks_primary_artist ON tracks(primary_artist_id);
        CREATE INDEX IF NOT EXISTS idx_tracks_primary_album ON tracks(primary_album_id);
        CREATE INDEX IF NOT EXISTS idx_tracks_recording_key ON tracks(recording_key);
        CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_mb
            ON artists(mb_artist_id) WHERE mb_artist_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_spotify
            ON artists(spotify_id) WHERE spotify_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_discogs
            ON artists(discogs_id) WHERE discogs_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_track_artists_artist ON track_artists(artist_id);
        CREATE INDEX IF NOT EXISTS idx_album_tracks_track ON album_tracks(track_id);
        CREATE INDEX IF NOT EXISTS idx_catalog_recordings_album ON catalog_recordings(album_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_one_primary
            ON assets(track_id) WHERE is_primary = 1;
        CREATE INDEX IF NOT EXISTS idx_identity_candidates_asset
            ON identity_candidates(asset_id);
        CREATE INDEX IF NOT EXISTS idx_external_lookup_fetched
            ON external_lookup_cache(fetched_at);
        CREATE INDEX IF NOT EXISTS idx_identification_jobs_status
            ON identification_jobs(status, next_retry_at);
        CREATE INDEX IF NOT EXISTS idx_audio_analysis_jobs_status
            ON audio_analysis_jobs(status, next_retry_at);
        CREATE INDEX IF NOT EXISTS idx_track_identity_overrides_locked
            ON track_identity_overrides(locked, updated_at);
    """)
    _ensure_column(conn, "albums", "release_type", "TEXT")


def _ensure_column(conn, table: str, column: str, definition: str) -> None:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    if column in {row["name"] for row in rows}:
        return
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


# Tracks and assets

def _dict(row):
    return dict(row) if row else None


def _file_format(path: str) -> str:
    return Path(path).suffix.replace(".", "").upper() or "UNKNOWN"


def _normal_asset_type(value: str | None) -> str:
    cleaned = (value or "ORIGINAL_MIX").strip().upper().replace("-", "_").replace(" ", "_")
    return cleaned or "ORIGINAL_MIX"


def _artist_entity_key(value: str | None) -> str:
    try:
        from api.services.identification.canonical import artist_identity_key
        return artist_identity_key(value)
    except Exception:
        return _identity_text(value or "")


def _title_entity_key(value: str | None) -> str:
    try:
        from api.services.identification.canonical import canonicalize
        return canonicalize(None, value).title_key
    except Exception:
        return _identity_text(value or "")


def _track_recording_key(title: str | None, artist_key: str | None) -> str | None:
    title_key = _title_entity_key(title)
    if not title_key:
        return None
    return f"{artist_key or ''}||{title_key}"


def _track_primary_artist_key(artist: str | None, title: str | None) -> str:
    identity = _canonical_identity(artist, title)
    return identity.get("artist_key") or _artist_entity_key(artist)


def _clean_int(value, default: int | None = None) -> int | None:
    if value in (None, ""):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def add_track(conn, track: dict) -> str:
    track_id = track.get("id") or str(uuid.uuid4())
    display_artist = track.get("display_artist") or track.get("artist", "")
    primary_artist_key = track.get("primary_artist_key") or _track_primary_artist_key(display_artist, track.get("title"))
    canonical_title_key = track.get("canonical_title_key") or _title_entity_key(track.get("title"))
    conn.execute("""
        INSERT INTO tracks
            (id, title, artist, display_artist, duration, thumbnail, date_added, published_date,
             streams, status, mb_recording_id, isrc, spotify_id, discogs_id, label, year, bpm,
             musical_key, camelot_key, fingerprint, preferred_asset_id, primary_artist_id, primary_album_id,
             canonical_title_key, primary_artist_key, recording_key)
        VALUES
            (:id, :title, :artist, :display_artist, :duration, :thumbnail, :date_added, :published_date,
             :streams, :status, :mb_recording_id, :isrc, :spotify_id, :discogs_id, :label, :year, :bpm,
             :musical_key, :camelot_key, :fingerprint, :preferred_asset_id, :primary_artist_id, :primary_album_id,
             :canonical_title_key, :primary_artist_key, :recording_key)
    """, {
        "id": track_id,
        "title": track.get("title"),
        "artist": display_artist,
        "display_artist": display_artist,
        "duration": track.get("duration"),
        "thumbnail": track.get("thumbnail"),
        "date_added": track.get("date_added", int(time.time())),
        "published_date": track.get("published_date"),
        "streams": track.get("streams", 0),
        "status": track.get("status", "pending_identity"),
        "mb_recording_id": track.get("mb_recording_id"),
        "isrc": track.get("isrc"),
        "spotify_id": track.get("spotify_id"),
        "discogs_id": track.get("discogs_id"),
        "label": track.get("label"),
        "year": track.get("year"),
        "bpm": track.get("bpm"),
        "musical_key": track.get("musical_key"),
        "camelot_key": track.get("camelot_key"),
        "fingerprint": track.get("fingerprint"),
        "preferred_asset_id": track.get("preferred_asset_id"),
        "primary_artist_id": track.get("primary_artist_id"),
        "primary_album_id": track.get("primary_album_id"),
        "canonical_title_key": canonical_title_key,
        "primary_artist_key": primary_artist_key,
        "recording_key": track.get("recording_key") or _track_recording_key(track.get("title"), primary_artist_key),
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
    bpm: float | None = None,
    musical_key: str | None = None,
    camelot_key: str | None = None,
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
             is_primary, duration, bpm, musical_key, camelot_key, fingerprint, analysis_status, date_added)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        musical_key,
        camelot_key,
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


def _find_artist_by_external_id(conn, credit: dict):
    for column in ("mb_artist_id", "spotify_id", "discogs_id"):
        value = credit.get(column)
        if not value:
            continue
        row = conn.execute(f"SELECT * FROM artists WHERE {column} = ? LIMIT 1", (str(value),)).fetchone()
        if row:
            return row
    return None


def upsert_artist(conn, credit: dict | str) -> str | None:
    if isinstance(credit, str):
        credit = {"name": credit}
    if not isinstance(credit, dict):
        return None
    name = (credit.get("name") or "").strip()
    if not name:
        return None
    canonical_key = _artist_entity_key(name)
    if not canonical_key:
        return None

    row = _find_artist_by_external_id(conn, credit)
    if not row:
        row = conn.execute("SELECT * FROM artists WHERE canonical_key = ? LIMIT 1", (canonical_key,)).fetchone()

    now = int(time.time())
    if row:
        artist_id = row["id"]
        updates = {
            "sort_name": credit.get("sort_name") or credit.get("sort-name") or row["sort_name"],
            "mb_artist_id": credit.get("mb_artist_id") or row["mb_artist_id"],
            "spotify_id": credit.get("spotify_id") or row["spotify_id"],
            "discogs_id": credit.get("discogs_id") or row["discogs_id"],
            "source": credit.get("source") or row["source"],
            "updated_at": now,
        }
        conn.execute("""
            UPDATE artists
            SET sort_name = ?, mb_artist_id = ?, spotify_id = ?, discogs_id = ?,
                source = ?, updated_at = ?
            WHERE id = ?
        """, (
            updates["sort_name"], updates["mb_artist_id"], updates["spotify_id"],
            updates["discogs_id"], updates["source"], updates["updated_at"], artist_id,
        ))
        if name != row["name"]:
            add_artist_alias(conn, artist_id, name, credit.get("source"))
        return artist_id

    artist_id = credit.get("id") if credit.get("id") and len(str(credit.get("id"))) >= 8 else str(uuid.uuid4())
    conn.execute("""
        INSERT INTO artists
            (id, name, sort_name, canonical_key, mb_artist_id, spotify_id, discogs_id,
             source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        artist_id,
        name,
        credit.get("sort_name") or credit.get("sort-name"),
        canonical_key,
        credit.get("mb_artist_id"),
        credit.get("spotify_id"),
        credit.get("discogs_id"),
        credit.get("source"),
        now,
        now,
    ))
    return artist_id


def add_artist_alias(conn, artist_id: str, alias: str, source: str | None = None) -> str | None:
    alias = (alias or "").strip()
    if not alias:
        return None
    canonical_key = _artist_entity_key(alias)
    if not canonical_key:
        return None
    existing = conn.execute("""
        SELECT id FROM artist_aliases
        WHERE artist_id = ? AND canonical_key = ?
    """, (artist_id, canonical_key)).fetchone()
    if existing:
        return existing["id"]
    alias_id = str(uuid.uuid4())
    conn.execute("""
        INSERT INTO artist_aliases (id, artist_id, alias, canonical_key, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (alias_id, artist_id, alias, canonical_key, source, int(time.time())))
    return alias_id


def _normalize_credit(credit: dict | str, position: int) -> dict | None:
    if isinstance(credit, str):
        name = credit.strip()
        return {"name": name, "role": "main", "position": position, "is_primary": position == 0} if name else None
    if not isinstance(credit, dict):
        return None
    name = (credit.get("name") or "").strip()
    if not name:
        return None
    out = dict(credit)
    out["name"] = name
    out["role"] = out.get("role") or "main"
    out["position"] = _clean_int(out.get("position"), position) or 0
    out["is_primary"] = bool(out.get("is_primary")) if out.get("is_primary") is not None else position == 0
    out["join_phrase"] = out.get("join_phrase") or ""
    return out


def _display_from_artist_credits(credits: list[dict]) -> str:
    ordered = sorted(credits, key=lambda c: int(c.get("position") or 0))
    parts: list[str] = []
    for idx, credit in enumerate(ordered):
        if idx > 0:
            parts.append(ordered[idx - 1].get("join_phrase") or ", ")
        parts.append(credit.get("name") or "")
    return "".join(parts).strip()


def set_track_artist_credits(
    conn,
    track_id: str,
    credits: list[dict] | None,
    *,
    display_artist: str | None = None,
    source: str | None = None,
) -> None:
    normalized = [
        c for idx, raw in enumerate(credits or [])
        if (c := _normalize_credit(raw, idx))
    ]
    if not normalized and display_artist:
        normalized = [{
            "name": display_artist,
            "role": "main",
            "position": 0,
            "is_primary": True,
            "source": source,
        }]
    if not normalized:
        return

    conn.execute("DELETE FROM track_artists WHERE track_id = ?", (track_id,))
    primary_artist_id = None
    primary_artist_key = None
    for idx, credit in enumerate(normalized):
        credit.setdefault("source", source)
        artist_id = upsert_artist(conn, credit)
        if not artist_id:
            continue
        is_primary = bool(credit.get("is_primary")) or (primary_artist_id is None and idx == 0)
        if is_primary and primary_artist_id is None:
            primary_artist_id = artist_id
            primary_artist_key = _artist_entity_key(credit.get("name"))
        conn.execute("""
            INSERT OR REPLACE INTO track_artists
                (track_id, artist_id, role, position, is_primary, join_phrase, source)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            track_id,
            artist_id,
            credit.get("role") or "main",
            _clean_int(credit.get("position"), idx) or 0,
            1 if is_primary else 0,
            credit.get("join_phrase") or "",
            credit.get("source") or source,
        ))

    final_display = display_artist or _display_from_artist_credits(normalized)
    if final_display or primary_artist_id:
        row = get_track_row(conn, track_id)
        title = row["title"] if row else None
        update_track_metadata(conn, track_id, {
            "display_artist": final_display,
            "primary_artist_id": primary_artist_id,
            "primary_artist_key": primary_artist_key,
            "recording_key": _track_recording_key(title, primary_artist_key),
        })


def get_track_artists(conn, track_id: str) -> list[dict]:
    rows = conn.execute("""
        SELECT ar.id, ar.name, ar.sort_name, ar.canonical_key, ar.mb_artist_id,
               ar.spotify_id, ar.discogs_id, ta.role, ta.position,
               ta.is_primary, ta.join_phrase, ta.source
        FROM track_artists ta
        JOIN artists ar ON ar.id = ta.artist_id
        WHERE ta.track_id = ?
        ORDER BY ta.position ASC, ar.name ASC
    """, (track_id,)).fetchall()
    return [
        {**dict(r), "is_primary": bool(r["is_primary"])}
        for r in rows
    ]


def _album_key(album: dict) -> str:
    title = (album.get("title") or album.get("name") or "").strip()
    display_artist = (album.get("display_artist") or "").strip()
    return f"{_title_entity_key(title)}||{_artist_entity_key(display_artist)}"


def _normalize_release_type(album: dict) -> str | None:
    value = (
        album.get("release_type")
        or album.get("album_type")
        or album.get("primary_type")
        or album.get("type")
    )
    text = str(value or "").strip().lower()
    return text or None


def _find_album_by_external_id(conn, album: dict):
    for column in ("mb_release_id", "mb_release_group_id", "spotify_album_id", "discogs_id"):
        value = album.get(column)
        if value in (None, ""):
            continue
        row = conn.execute(f"SELECT * FROM albums WHERE {column} = ? LIMIT 1", (str(value),)).fetchone()
        if row:
            return row
    return None


def upsert_album(conn, album: dict | str) -> str | None:
    if isinstance(album, str):
        album = {"title": album}
    if not isinstance(album, dict):
        return None
    title = (album.get("title") or album.get("name") or "").strip()
    if not title:
        return None
    album = dict(album)
    album["title"] = title
    album["release_type"] = _normalize_release_type(album)
    canonical_key = album.get("canonical_key") or _album_key(album)
    if not canonical_key.strip("|"):
        return None
    row = _find_album_by_external_id(conn, album)
    if not row:
        row = conn.execute("SELECT * FROM albums WHERE canonical_key = ? LIMIT 1", (canonical_key,)).fetchone()

    now = int(time.time())
    if row:
        album_id = row["id"]
        conn.execute("""
            UPDATE albums
            SET display_artist = COALESCE(?, display_artist),
                release_type = COALESCE(?, release_type),
                year = COALESCE(?, year),
                cover = COALESCE(?, cover),
                mb_release_id = COALESCE(?, mb_release_id),
                mb_release_group_id = COALESCE(?, mb_release_group_id),
                spotify_album_id = COALESCE(?, spotify_album_id),
                discogs_id = COALESCE(?, discogs_id),
                source = COALESCE(?, source),
                updated_at = ?
            WHERE id = ?
        """, (
            album.get("display_artist"),
            album.get("release_type"),
            album.get("year"),
            album.get("cover"),
            album.get("mb_release_id"),
            album.get("mb_release_group_id"),
            album.get("spotify_album_id"),
            album.get("discogs_id"),
            album.get("source"),
            now,
            album_id,
        ))
        return album_id

    album_id = album.get("id") if album.get("id") and len(str(album.get("id"))) >= 8 else str(uuid.uuid4())
    conn.execute("""
        INSERT INTO albums
            (id, title, display_artist, canonical_key, year, cover, mb_release_id,
             mb_release_group_id, spotify_album_id, discogs_id, source, created_at, updated_at,
             release_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        album_id,
        title,
        album.get("display_artist"),
        canonical_key,
        album.get("year"),
        album.get("cover"),
        album.get("mb_release_id"),
        album.get("mb_release_group_id"),
        album.get("spotify_album_id"),
        album.get("discogs_id"),
        album.get("source"),
        now,
        now,
        album.get("release_type"),
    ))
    return album_id


def set_track_albums(
    conn,
    track_id: str,
    albums: list[dict] | None,
    *,
    track_number: int | None = None,
    disc_number: int | None = None,
    source: str | None = None,
) -> None:
    normalized = [a for a in (albums or []) if isinstance(a, dict) and (a.get("title") or a.get("name"))]
    if not normalized:
        return
    conn.execute("DELETE FROM album_tracks WHERE track_id = ?", (track_id,))
    primary_album_id = None
    for idx, album in enumerate(normalized):
        album = dict(album)
        album.setdefault("source", source)
        album_id = upsert_album(conn, album)
        if not album_id:
            continue
        if primary_album_id is None:
            primary_album_id = album_id
        conn.execute("""
            INSERT OR REPLACE INTO album_tracks
                (album_id, track_id, disc_number, track_number, position, source)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (
            album_id,
            track_id,
            _clean_int(album.get("disc_number"), disc_number or 1) or 1,
            _clean_int(album.get("track_number"), track_number),
            idx,
            album.get("source") or source,
        ))
    if primary_album_id:
        update_track_metadata(conn, track_id, {"primary_album_id": primary_album_id})


def clear_track_albums(conn, track_id: str) -> None:
    conn.execute("DELETE FROM album_tracks WHERE track_id = ?", (track_id,))
    replace_track_identity_metadata(conn, track_id, {"primary_album_id": None})


def get_track_albums(conn, track_id: str) -> list[dict]:
    rows = conn.execute("""
        SELECT al.*, at.disc_number, at.track_number, at.position, at.source AS link_source
        FROM album_tracks at
        JOIN albums al ON al.id = at.album_id
        WHERE at.track_id = ?
        ORDER BY at.position ASC, al.year ASC, al.title ASC
    """, (track_id,)).fetchall()
    return [dict(r) for r in rows]


def record_asset_identification_result(conn, asset_id: str, meta: dict) -> None:
    now = int(time.time())
    sources = meta.get("all_sources") or meta.get("sources") or []
    reasons = meta.get("discogs_reasons") or meta.get("reasons") or []
    evidence = meta.get("evidence") or []
    conn.execute("""
        INSERT INTO asset_identification_results
            (asset_id, status, confidence, sources_json, reasons_json, evidence_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET
            status = excluded.status,
            confidence = excluded.confidence,
            sources_json = excluded.sources_json,
            reasons_json = excluded.reasons_json,
            evidence_json = excluded.evidence_json,
            updated_at = excluded.updated_at
    """, (
        asset_id,
        meta.get("status"),
        meta.get("confidence"),
        json.dumps(sources, default=str),
        json.dumps(reasons, default=str),
        json.dumps(evidence, default=str),
        now,
    ))


def get_asset_identification_result(conn, asset_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM asset_identification_results WHERE asset_id = ?",
        (asset_id,),
    ).fetchone()
    if not row:
        return None
    item = dict(row)
    for src_key, out_key in (
        ("sources_json", "sources"),
        ("reasons_json", "reasons"),
        ("evidence_json", "evidence"),
    ):
        try:
            item[out_key] = json.loads(item.pop(src_key) or "[]")
        except json.JSONDecodeError:
            item[out_key] = []
    return item


def get_track_identity_override(conn, track_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM track_identity_overrides WHERE track_id = ?",
        (track_id,),
    ).fetchone()
    if not row:
        return None
    item = dict(row)
    try:
        item["payload"] = json.loads(item.pop("payload_json") or "{}")
    except json.JSONDecodeError:
        item["payload"] = {}
    item["locked"] = bool(item.get("locked"))
    return item


def set_track_identity_override(
    conn,
    track_id: str,
    payload: dict,
    *,
    source: str = "manual",
    locked: bool = True,
) -> None:
    now = int(time.time())
    existing = conn.execute(
        "SELECT created_at FROM track_identity_overrides WHERE track_id = ?",
        (track_id,),
    ).fetchone()
    created_at = existing["created_at"] if existing else now
    conn.execute("""
        INSERT INTO track_identity_overrides
            (track_id, payload_json, source, locked, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(track_id) DO UPDATE SET
            payload_json = excluded.payload_json,
            source = excluded.source,
            locked = excluded.locked,
            updated_at = excluded.updated_at
    """, (
        track_id,
        json.dumps(payload, default=str),
        source or "manual",
        1 if locked else 0,
        created_at,
        now,
    ))


def delete_track_identity_override(conn, track_id: str) -> bool:
    cursor = conn.execute(
        "DELETE FROM track_identity_overrides WHERE track_id = ?",
        (track_id,),
    )
    return cursor.rowcount > 0


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
        for field in ("bpm", "musical_key", "camelot_key"):
            if fast_asset.get(field) is not None:
                track[field] = fast_asset.get(field)
    track["display_artist"] = track.get("display_artist") or track.get("artist") or ""
    track["artist"] = track["display_artist"]
    artists = get_track_artists(conn, track["id"])
    track["artists"] = artists
    primary = next((a for a in artists if a.get("is_primary")), artists[0] if artists else None)
    track["primary_artist"] = {"id": primary["id"], "name": primary["name"]} if primary else None
    albums = get_track_albums(conn, track["id"])
    track["albums"] = albums
    track["album"] = albums[0] if albums else None
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
        "title", "artist", "display_artist", "duration", "thumbnail", "status",
        "mb_recording_id", "isrc", "spotify_id", "discogs_id", "label", "year", "bpm",
        "musical_key", "camelot_key", "fingerprint", "preferred_asset_id", "published_date", "primary_artist_id",
        "primary_album_id", "canonical_title_key", "primary_artist_key", "recording_key",
    }
    incoming = dict(data)
    if incoming.get("display_artist") is not None and incoming.get("artist") is None:
        incoming["artist"] = incoming.get("display_artist")
    if incoming.get("artist") is not None and incoming.get("display_artist") is None:
        incoming["display_artist"] = incoming.get("artist")
    if incoming.get("title") is not None and incoming.get("canonical_title_key") is None:
        incoming["canonical_title_key"] = _title_entity_key(incoming.get("title"))
    if incoming.get("display_artist") is not None and incoming.get("primary_artist_key") is None:
        title_for_key = incoming.get("title")
        if title_for_key is None:
            existing = get_track_row(conn, track_id)
            title_for_key = existing["title"] if existing else None
        incoming["primary_artist_key"] = _track_primary_artist_key(incoming.get("display_artist"), title_for_key)
    if (incoming.get("title") is not None or incoming.get("primary_artist_key") is not None) and incoming.get("recording_key") is None:
        existing = get_track_row(conn, track_id)
        title = incoming.get("title") if incoming.get("title") is not None else (existing["title"] if existing else None)
        artist_key = incoming.get("primary_artist_key") if incoming.get("primary_artist_key") is not None else (existing["primary_artist_key"] if existing and "primary_artist_key" in existing.keys() else None)
        incoming["recording_key"] = _track_recording_key(title, artist_key)
    updates = {k: v for k, v in incoming.items() if k in allowed and v is not None}
    if not updates:
        return
    fields = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [track_id]
    conn.execute(f"UPDATE tracks SET {fields} WHERE id = ?", values)


def replace_track_identity_metadata(conn, track_id: str, data: dict) -> None:
    """Replace identity fields, allowing NULL to clear stale provider IDs."""
    allowed = {
        "title", "artist", "display_artist", "duration", "thumbnail", "status",
        "mb_recording_id", "isrc", "spotify_id", "discogs_id", "label", "year",
        "primary_artist_id", "primary_album_id", "canonical_title_key",
        "primary_artist_key", "recording_key",
    }
    incoming = {k: v for k, v in dict(data or {}).items() if k in allowed}
    if not incoming:
        return

    if "display_artist" in incoming and "artist" not in incoming:
        incoming["artist"] = incoming.get("display_artist")
    if "artist" in incoming and "display_artist" not in incoming:
        incoming["display_artist"] = incoming.get("artist")

    existing = get_track_row(conn, track_id)
    title = incoming.get("title") if "title" in incoming else (existing["title"] if existing else None)
    display_artist = (
        incoming.get("display_artist")
        if "display_artist" in incoming
        else (existing["display_artist"] if existing and "display_artist" in existing.keys() else None)
    )

    if "title" in incoming and "canonical_title_key" not in incoming:
        incoming["canonical_title_key"] = _title_entity_key(title)
    if "display_artist" in incoming and "primary_artist_key" not in incoming:
        incoming["primary_artist_key"] = _track_primary_artist_key(display_artist, title)
    if (
        ("title" in incoming or "display_artist" in incoming or "primary_artist_key" in incoming)
        and "recording_key" not in incoming
    ):
        artist_key = (
            incoming.get("primary_artist_key")
            if "primary_artist_key" in incoming
            else (existing["primary_artist_key"] if existing and "primary_artist_key" in existing.keys() else None)
        )
        incoming["recording_key"] = _track_recording_key(title, artist_key)

    fields = ", ".join(f"{k} = ?" for k in incoming)
    values = list(incoming.values()) + [track_id]
    conn.execute(f"UPDATE tracks SET {fields} WHERE id = ?", values)


def update_asset_analysis(conn, asset_id: str, data: dict) -> None:
    allowed = {
        "duration", "bpm", "musical_key", "camelot_key",
        "fingerprint", "analysis_status", "asset_type",
    }
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


def update_asset_audio_analysis(conn, asset_id: str, data: dict) -> None:
    update_asset_analysis(conn, asset_id, {
        "bpm": data.get("bpm"),
        "musical_key": data.get("musical_key"),
        "camelot_key": data.get("camelot_key"),
    })


def update_track_audio_analysis_from_asset(conn, asset_id: str, data: dict) -> None:
    asset = get_asset(conn, asset_id)
    if not asset:
        return
    update_track_metadata(conn, asset["track_id"], {
        "bpm": data.get("bpm"),
        "musical_key": data.get("musical_key"),
        "camelot_key": data.get("camelot_key"),
    })


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
        LEFT JOIN track_artists ta ON ta.track_id = t.id
        LEFT JOIN artists ar ON ar.id = ta.artist_id
        LEFT JOIN artist_aliases aa ON aa.artist_id = ar.id
        LEFT JOIN album_tracks alt ON alt.track_id = t.id
        LEFT JOIN albums al ON al.id = alt.album_id
        WHERE t.title LIKE ?
           OR t.artist LIKE ?
           OR t.display_artist LIKE ?
           OR ar.name LIKE ?
           OR aa.alias LIKE ?
           OR al.title LIKE ?
           OR al.display_artist LIKE ?
           OR a.asset_type LIKE ?
           OR a.source_ref LIKE ?
        ORDER BY t.streams DESC, t.date_added DESC
        LIMIT ?
    """, (pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, limit)).fetchall()
    return [_attach_fast_asset(conn, dict(r)) for r in rows]


def increment_streams(conn, track_id):
    conn.execute("UPDATE tracks SET streams = streams + 1 WHERE id = ?", (track_id,))


def delete_track(conn, track_id):
    conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
    conn.execute("DELETE FROM downloads WHERE resolved_track_id = ?", (track_id,))


def get_app_preference(conn, key: str, default=None):
    row = conn.execute(
        "SELECT value_json FROM app_preferences WHERE key = ?",
        (key,),
    ).fetchone()
    if not row:
        return default
    try:
        return json.loads(row["value_json"])
    except (TypeError, json.JSONDecodeError):
        logger.warning("Invalid JSON stored in app_preferences for key %s", key)
        return default


def set_app_preference(conn, key: str, value) -> None:
    conn.execute("""
        INSERT INTO app_preferences (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
    """, (key, json.dumps(value), int(time.time())))


def delete_app_preference(conn, key: str) -> None:
    conn.execute("DELETE FROM app_preferences WHERE key = ?", (key,))


def list_artists(conn) -> list[dict]:
    rows = conn.execute("""
        SELECT ar.*,
               COUNT(DISTINCT ta.track_id) AS track_count,
               COUNT(DISTINCT alt.album_id) AS album_count
        FROM artists ar
        LEFT JOIN track_artists ta ON ta.artist_id = ar.id
        LEFT JOIN album_tracks alt ON alt.track_id = ta.track_id
        GROUP BY ar.id
        ORDER BY ar.sort_name COLLATE NOCASE, ar.name COLLATE NOCASE
    """).fetchall()
    return [dict(r) for r in rows]


def get_artist(conn, artist_id: str) -> dict | None:
    row = conn.execute("""
        SELECT ar.*,
               COUNT(DISTINCT ta.track_id) AS track_count,
               COUNT(DISTINCT alt.album_id) AS album_count
        FROM artists ar
        LEFT JOIN track_artists ta ON ta.artist_id = ar.id
        LEFT JOIN album_tracks alt ON alt.track_id = ta.track_id
        WHERE ar.id = ?
        GROUP BY ar.id
    """, (artist_id,)).fetchone()
    return dict(row) if row else None


def get_artist_tracks(conn, artist_id: str) -> list[dict]:
    rows = conn.execute("""
        SELECT DISTINCT t.*, ta.role AS artist_role, ta.position AS artist_position
        FROM track_artists ta
        JOIN tracks t ON t.id = ta.track_id
        WHERE ta.artist_id = ?
        ORDER BY t.year IS NULL, t.year ASC, t.title COLLATE NOCASE
    """, (artist_id,)).fetchall()
    return [_attach_fast_asset(conn, dict(r)) for r in rows]


def get_artist_albums(conn, artist_id: str, include_singles: bool = False) -> list[dict]:
    having = ""
    if not include_singles:
        having = """
        HAVING LOWER(COALESCE(al.release_type, '')) NOT IN ('single', 'track')
        """
    rows = conn.execute("""
        SELECT al.*,
               COUNT(DISTINCT at.track_id) AS local_track_count,
               MIN(at.disc_number) AS first_disc,
               MIN(at.track_number) AS first_track
        FROM track_artists ta
        JOIN album_tracks at ON at.track_id = ta.track_id
        JOIN albums al ON al.id = at.album_id
        WHERE ta.artist_id = ?
        GROUP BY al.id
        """ + having + """
        ORDER BY al.year IS NULL, al.year ASC, al.title COLLATE NOCASE
    """, (artist_id,)).fetchall()
    return [dict(r) for r in rows]


def list_albums(conn, include_singles: bool = False) -> list[dict]:
    having = """
        HAVING COUNT(DISTINCT at.track_id) > 0
    """
    if not include_singles:
        having += """
           AND LOWER(COALESCE(al.release_type, '')) NOT IN ('single', 'track')
        """
    rows = conn.execute("""
        SELECT al.*, COUNT(DISTINCT at.track_id) AS local_track_count
        FROM albums al
        LEFT JOIN album_tracks at ON at.album_id = al.id
        GROUP BY al.id
        """ + having + """
        ORDER BY al.year IS NULL, al.year ASC, al.title COLLATE NOCASE
    """).fetchall()
    return [dict(r) for r in rows]


def get_album(conn, album_id: str) -> dict | None:
    row = conn.execute("""
        SELECT al.*, COUNT(DISTINCT at.track_id) AS local_track_count
        FROM albums al
        LEFT JOIN album_tracks at ON at.album_id = al.id
        WHERE al.id = ?
        GROUP BY al.id
    """, (album_id,)).fetchone()
    return dict(row) if row else None


def get_album_tracks(conn, album_id: str) -> list[dict]:
    rows = conn.execute("""
        SELECT t.*, at.disc_number, at.track_number, at.position AS album_position
        FROM album_tracks at
        JOIN tracks t ON t.id = at.track_id
        WHERE at.album_id = ?
        ORDER BY at.disc_number ASC, at.track_number IS NULL, at.track_number ASC,
                 at.position ASC, t.title COLLATE NOCASE
    """, (album_id,)).fetchall()
    return [_attach_fast_asset(conn, dict(r)) for r in rows]


def get_artist_discography(conn, artist_id: str, scope: str = "local") -> dict:
    scope = scope if scope in {"local", "catalog", "all"} else "local"
    local_albums = get_artist_albums(conn, artist_id) if scope in {"local", "all"} else []
    local_tracks = get_artist_tracks(conn, artist_id) if scope in {"local", "all"} else []
    catalog_rows = []
    if scope in {"catalog", "all"}:
        catalog_rows = conn.execute("""
            SELECT cr.*, al.title AS album_title, al.cover AS album_cover
            FROM catalog_artist_credits cac
            JOIN catalog_recordings cr ON cr.id = cac.catalog_recording_id
            LEFT JOIN albums al ON al.id = cr.album_id
            WHERE cac.artist_id = ?
            ORDER BY cr.track_number IS NULL, cr.track_number ASC, cr.title COLLATE NOCASE
        """, (artist_id,)).fetchall()
    catalog = []
    for row in catalog_rows:
        item = dict(row)
        item["available"] = bool(item.get("available_track_id"))
        catalog.append(item)
    return {
        "scope": scope,
        "albums": local_albums,
        "tracks": local_tracks,
        "catalog": catalog,
    }


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


def list_identity_candidates(conn, asset_id: str | None = None, status: str | None = None) -> list[dict]:
    clauses = []
    params: list = []
    if asset_id:
        clauses.append("asset_id = ?")
        params.append(asset_id)
    if status:
        clauses.append("status = ?")
        params.append(status)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM identity_candidates{where} ORDER BY score DESC, created_at DESC",
        params,
    ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        try:
            item["reasons"] = json.loads(item.pop("reasons_json") or "[]")
        except json.JSONDecodeError:
            item["reasons"] = []
        result.append(item)
    return result


def get_identity_candidate(conn, candidate_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM identity_candidates WHERE id = ?", (candidate_id,)
    ).fetchone()
    if not row:
        return None
    item = dict(row)
    try:
        item["reasons"] = json.loads(item.pop("reasons_json") or "[]")
    except json.JSONDecodeError:
        item["reasons"] = []
    return item


def set_identity_candidate_status(conn, candidate_id: str, status: str) -> bool:
    cursor = conn.execute(
        "UPDATE identity_candidates SET status = ? WHERE id = ?",
        (status, candidate_id),
    )
    conn.commit()
    return cursor.rowcount > 0


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

    primary_artist = meta.get("primary_artist") or {}
    incoming_artist_value = (
        primary_artist.get("name") if isinstance(primary_artist, dict) else None
    ) or meta.get("canonical_artist") or meta.get("display_artist") or meta.get("artist")
    incoming = _canonical_identity(incoming_artist_value, meta.get("title"))
    title = incoming.get("title_key") or _identity_text(meta.get("title") or "")
    artist = incoming.get("artist_key") or _artist_entity_key(incoming_artist_value or "")
    incoming_version = meta.get("version_type") or incoming.get("version_type") or "ORIGINAL_MIX"
    identity_source = meta.get("identity_source")
    if title and artist:
        rows = conn.execute("""
            SELECT id, title, artist, display_artist, canonical_title_key, primary_artist_key, duration FROM tracks
            WHERE id != COALESCE(?, '')
        """, (exclude_track_id,)).fetchall()
        for row in rows:
            existing = _canonical_identity(row["display_artist"] or row["artist"], row["title"])
            existing_artist_key = row["primary_artist_key"] or _canonical_identity(row["display_artist"] or row["artist"], row["title"]).get("artist_key")
            if (row["canonical_title_key"] or existing.get("title_key") or _identity_text(row["title"] or "")) != title:
                continue
            if (existing_artist_key or _artist_entity_key(row["display_artist"] or row["artist"] or "")) != artist:
                continue
            sources = set(meta.get("all_sources") or [])
            if identity_source:
                sources.add(identity_source)
            trusted = bool(sources & {
                "acoustid", "shazam", "spotify_isrc", "spotify_fuzzy",
                "discogs", "mb_by_id", "mb_by_isrc", "youtube_title",
            })
            score = 0.94 if trusted else 0.86
            duration = meta.get("duration")
            existing_duration = row["duration"]
            if duration and existing_duration:
                ratio = abs(float(duration) - float(existing_duration)) / max(float(duration), float(existing_duration))
                if ratio <= 0.08:
                    score += 0.02
                elif ratio >= 0.45 and incoming_version == "ORIGINAL_MIX":
                    score -= 0.005
            add(row["id"], score, f"canonical_title_artist_{identity_source or 'unknown'}")

    return sorted(matches.values(), key=lambda item: item["score"], reverse=True)


def _identity_text(value: str) -> str:
    text = value.lower()
    text = re.sub(r"\b(remix|rework|live|demo|instrumental|karaoke|radio edit|single edit)\b", "", text)
    text = re.sub(r"\b(alt|alternate|alternative|version|take|unreleased|leak|official|video|lyrics?)\b", "", text)
    text = re.sub(r"\s*[\(\[].*?[\)\]]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(text.split())


def _canonical_identity(artist: str | None, title: str | None) -> dict:
    try:
        from api.services.identification.canonical import canonicalize
        identity = canonicalize(artist, title)
        return {
            "artist_key": identity.artist_key,
            "title_key": identity.title_key,
            "version_type": identity.version_type,
        }
    except Exception:
        return {"artist_key": "", "title_key": "", "version_type": "ORIGINAL_MIX"}


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
        SELECT h.*, t.title, COALESCE(t.display_artist, t.artist) AS artist,
               COALESCE(t.display_artist, t.artist) AS display_artist,
               t.thumbnail, t.duration
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


# External lookup cache (AcoustID, MusicBrainz, Discogs, Shazam, Spotify, Genius...)

def cache_get_external(conn, provider: str, key: str) -> str | None:
    row = conn.execute(
        "SELECT response, fetched_at, ttl_seconds FROM external_lookup_cache "
        "WHERE provider = ? AND cache_key = ?",
        (provider, key),
    ).fetchone()
    if not row:
        return None
    if row["ttl_seconds"] > 0 and (int(time.time()) - int(row["fetched_at"])) > int(row["ttl_seconds"]):
        return None
    return row["response"]


def cache_put_external(conn, provider: str, key: str, response: str, ttl_seconds: int) -> None:
    conn.execute(
        "INSERT INTO external_lookup_cache (provider, cache_key, response, fetched_at, ttl_seconds) "
        "VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(provider, cache_key) DO UPDATE SET "
        "response = excluded.response, fetched_at = excluded.fetched_at, ttl_seconds = excluded.ttl_seconds",
        (provider, key, response, int(time.time()), int(ttl_seconds)),
    )
    conn.commit()


def cache_purge_external(conn, provider: str | None = None, older_than_seconds: int | None = None) -> int:
    clauses = []
    params: list = []
    if provider:
        clauses.append("provider = ?")
        params.append(provider)
    if older_than_seconds:
        clauses.append("fetched_at < ?")
        params.append(int(time.time()) - older_than_seconds)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    cursor = conn.execute(f"DELETE FROM external_lookup_cache{where}", params)
    conn.commit()
    return cursor.rowcount


# Identification jobs (persistent retry queue for indexer)

def upsert_identification_job(conn, asset_id: str, *, status: str = "pending", next_retry_at: int = 0) -> None:
    now = int(time.time())
    conn.execute(
        "INSERT INTO identification_jobs (asset_id, status, attempts, next_retry_at, created_at, updated_at) "
        "VALUES (?, ?, 0, ?, ?, ?) "
        "ON CONFLICT(asset_id) DO UPDATE SET "
        "status = excluded.status, next_retry_at = excluded.next_retry_at, updated_at = excluded.updated_at",
        (asset_id, status, next_retry_at, now, now),
    )
    conn.commit()


def claim_identification_jobs(conn, limit: int = 5) -> list[dict]:
    now = int(time.time())
    rows = conn.execute(
        "SELECT asset_id, status, attempts, last_error, next_retry_at FROM identification_jobs "
        "WHERE status IN ('pending', 'retry') AND next_retry_at <= ? "
        "ORDER BY next_retry_at ASC LIMIT ?",
        (now, limit),
    ).fetchall()
    claimed = []
    for row in rows:
        cursor = conn.execute(
            "UPDATE identification_jobs SET status = 'in_progress', updated_at = ? "
            "WHERE asset_id = ? AND status IN ('pending', 'retry')",
            (now, row["asset_id"]),
        )
        if cursor.rowcount:
            claimed.append(dict(row))
    conn.commit()
    return claimed


def complete_identification_job(conn, asset_id: str, *, success: bool, error: str | None = None) -> None:
    now = int(time.time())
    if success:
        conn.execute(
            "UPDATE identification_jobs SET status = 'done', last_error = NULL, updated_at = ? "
            "WHERE asset_id = ?",
            (now, asset_id),
        )
    else:
        row = conn.execute(
            "SELECT attempts FROM identification_jobs WHERE asset_id = ?", (asset_id,)
        ).fetchone()
        attempts = (int(row["attempts"]) if row else 0) + 1
        backoff_table = [60, 300, 1800, 7200, 43200, 86400]
        delay = backoff_table[min(attempts - 1, len(backoff_table) - 1)]
        new_status = "failed" if attempts >= 8 else "retry"
        conn.execute(
            "UPDATE identification_jobs SET status = ?, attempts = ?, last_error = ?, "
            "next_retry_at = ?, updated_at = ? WHERE asset_id = ?",
            (new_status, attempts, (error or "")[:500], now + delay, now, asset_id),
        )
    conn.commit()


def get_identification_job(conn, asset_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM identification_jobs WHERE asset_id = ?", (asset_id,)
    ).fetchone()
    return _dict(row)


# Audio analysis jobs (persistent retry queue for MIR metadata)

def upsert_audio_analysis_job(conn, asset_id: str, *, status: str = "pending", next_retry_at: int = 0) -> None:
    now = int(time.time())
    conn.execute(
        "INSERT INTO audio_analysis_jobs (asset_id, status, attempts, next_retry_at, created_at, updated_at) "
        "VALUES (?, ?, 0, ?, ?, ?) "
        "ON CONFLICT(asset_id) DO UPDATE SET "
        "status = excluded.status, next_retry_at = excluded.next_retry_at, updated_at = excluded.updated_at",
        (asset_id, status, next_retry_at, now, now),
    )
    conn.commit()


def claim_audio_analysis_jobs(conn, limit: int = 1) -> list[dict]:
    now = int(time.time())
    rows = conn.execute(
        "SELECT asset_id, status, attempts, last_error, next_retry_at FROM audio_analysis_jobs "
        "WHERE status IN ('pending', 'retry') AND next_retry_at <= ? "
        "ORDER BY next_retry_at ASC LIMIT ?",
        (now, limit),
    ).fetchall()
    claimed = []
    for row in rows:
        cursor = conn.execute(
            "UPDATE audio_analysis_jobs SET status = 'in_progress', updated_at = ? "
            "WHERE asset_id = ? AND status IN ('pending', 'retry')",
            (now, row["asset_id"]),
        )
        if cursor.rowcount:
            claimed.append(dict(row))
    conn.commit()
    return claimed


def complete_audio_analysis_job(conn, asset_id: str, *, success: bool, error: str | None = None) -> None:
    now = int(time.time())
    if success:
        conn.execute(
            "UPDATE audio_analysis_jobs SET status = 'done', last_error = NULL, updated_at = ? "
            "WHERE asset_id = ?",
            (now, asset_id),
        )
    else:
        row = conn.execute(
            "SELECT attempts FROM audio_analysis_jobs WHERE asset_id = ?", (asset_id,)
        ).fetchone()
        attempts = (int(row["attempts"]) if row else 0) + 1
        backoff_table = [60, 300, 1800, 7200, 43200]
        delay = backoff_table[min(attempts - 1, len(backoff_table) - 1)]
        try:
            from utils import config as cfg
            max_attempts = int(cfg.get("audio_analysis_max_attempts", 5))
        except Exception:
            max_attempts = 5
        new_status = "failed" if attempts >= max_attempts else "retry"
        conn.execute(
            "UPDATE audio_analysis_jobs SET status = ?, attempts = ?, last_error = ?, "
            "next_retry_at = ?, updated_at = ? WHERE asset_id = ?",
            (new_status, attempts, (error or "")[:500], now + delay, now, asset_id),
        )
    conn.commit()


def get_audio_analysis_job(conn, asset_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM audio_analysis_jobs WHERE asset_id = ?", (asset_id,)
    ).fetchone()
    return _dict(row)
