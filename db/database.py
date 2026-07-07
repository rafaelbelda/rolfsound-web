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
        -- Álbum como entidade de primeira classe. A faixa aponta para um álbum
        -- (tracks.album_id) e herda title/year/genre daqui via JOIN — não há mais
        -- cópia por linha. Faixa avulsa vira o próprio álbum (kind='single',
        -- title='Single'). total_tracks = "número de músicas" (NULL = derivar da
        -- contagem real). cover explícita é opcional (senão deriva das faixas).
        CREATE TABLE IF NOT EXISTS albums (
            id            TEXT PRIMARY KEY,
            title         TEXT NOT NULL,
            artist        TEXT,
            year          INTEGER,
            genre         TEXT,
            total_tracks  INTEGER,
            cover         TEXT,
            kind          TEXT NOT NULL DEFAULT 'album',
            created_at    INTEGER NOT NULL DEFAULT 0
        );

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
            fingerprint     TEXT,
            -- álbum dono da faixa; title/year/genre da faixa vêm daqui (JOIN)
            album_id        TEXT REFERENCES albums(id),
            bpm             REAL,
            key             TEXT,
            -- número da faixa dentro do álbum (tag #/tracknumber); ordena o
            -- painel "Ver álbum". NULL = sem número embutido no arquivo
            track_no        INTEGER,
            version_group_id TEXT,
            version_label    TEXT,
            -- variação "Stem Ready": id da faixa original dona dos sidecars
            -- (NULL = faixa normal). V.id = "{X.id}::stems".
            stem_source_id  TEXT,
            -- tags livres (JSON array de strings); fav = favoritada no Acervo
            tags            TEXT NOT NULL DEFAULT '[]',
            fav             INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS version_groups (
            id               TEXT PRIMARY KEY,
            primary_track_id TEXT,
            created_at       INTEGER NOT NULL DEFAULT 0
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

        CREATE TABLE IF NOT EXISTS track_stems (
            track_id  TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            role      TEXT NOT NULL CHECK (role IN ('vocals','drums','bass','other')),
            file_path TEXT NOT NULL,
            duration  INTEGER,
            size      INTEGER,
            codec     TEXT,
            added_at  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (track_id, role)
        );

        -- Envelope de amplitude da faixa inteira (picos 0..1), calculado uma vez
        -- na importação (ver api/services/audio_analysis/waveform.py) e servido
        -- sob demanda pro Remixer. Tabela própria (não coluna de tracks) pra não
        -- inflar o SELECT * usado pelo Acervo/bootstrap com um blob grande.
        CREATE TABLE IF NOT EXISTS track_waveforms (
            track_id  TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
            peaks     TEXT NOT NULL,
            buckets   INTEGER NOT NULL,
            added_at  INTEGER NOT NULL DEFAULT 0
        );

        -- Pads de sample do Remixer: 6 slots por faixa com trechos (in/out em
        -- segundos da fonte). O áudio NÃO é persistido — o core recaptura do
        -- arquivo da faixa quando a web reempurra os pads no play.
        CREATE TABLE IF NOT EXISTS track_pads (
            track_id  TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            pad_index INTEGER NOT NULL CHECK (pad_index BETWEEN 0 AND 5),
            start_s   REAL NOT NULL,
            end_s     REAL NOT NULL,
            added_at  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (track_id, pad_index)
        );
    """)


# ── Tracks ────────────────────────────────────────────────────────────────────

# A faixa herda title/year/genre do álbum: todo read traz esses campos via JOIN
# (album = a.title, então "Single" para singles). Assim o código a jusante que
# lê track["album"]/["year"]/["genre"] continua funcionando sem cópia por linha.
_TRACK_SELECT = """
    SELECT t.*,
           a.title        AS album,
           a.year         AS year,
           a.genre        AS genre,
           a.total_tracks AS album_total,
           a.kind         AS album_kind,
           a.cover        AS album_cover
    FROM tracks t
    LEFT JOIN albums a ON a.id = t.album_id
"""


def _parse_track(d: dict) -> dict:
    """tags é persistido como JSON (array de strings) na coluna TEXT."""
    import json
    try:
        d["tags"] = json.loads(d.get("tags") or "[]")
    except (TypeError, ValueError):
        d["tags"] = []
    return d


def get_track(conn, track_id):
    row = conn.execute(_TRACK_SELECT + " WHERE t.id = ?", (track_id,)).fetchone()
    return _parse_track(dict(row)) if row else None


def insert_track(conn, track):
    conn.execute("""
        INSERT OR REPLACE INTO tracks
            (id, title, artist, duration, thumbnail, file_path,
             date_added, published_date, streams, source,
             status, mb_recording_id, discogs_id, label, album_id)
        VALUES
            (:id, :title, :artist, :duration, :thumbnail, :file_path,
             :date_added, :published_date, :streams, :source,
             :status, :mb_recording_id, :discogs_id, :label, :album_id)
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
        "album_id":       track.get("album_id"),
    })


def get_all_track_ids(conn):
    rows = conn.execute("SELECT id FROM tracks").fetchall()
    return {row["id"] for row in rows}


def list_tracks(conn):
    rows = conn.execute(_TRACK_SELECT + " ORDER BY t.date_added DESC").fetchall()
    return [_parse_track(dict(r)) for r in rows]


def list_unidentified_tracks(conn) -> list[dict]:
    rows = conn.execute(
        _TRACK_SELECT
        + " WHERE t.status = 'unidentified' OR t.status IS NULL"
        + " ORDER BY t.date_added DESC"
    ).fetchall()
    return [_parse_track(dict(r)) for r in rows]


def update_track_metadata(conn, track_id: str, data: dict) -> None:
    # album/year/genre agora vivem no álbum (ver update_album / set_track_album);
    # aqui ficam só os campos próprios da faixa.
    import json
    allowed = {
        "title", "artist", "duration", "thumbnail",
        "status", "mb_recording_id", "discogs_id", "label", "fingerprint",
        "bpm", "key", "track_no", "version_label", "tags", "fav",
    }
    updates = {k: v for k, v in data.items() if k in allowed and v is not None}
    if "tags" in updates:
        updates["tags"] = json.dumps(updates["tags"])
    if "fav" in updates:
        updates["fav"] = int(bool(updates["fav"]))
    if "bpm" in updates:
        updates["bpm"] = round(updates["bpm"])
    if not updates:
        return
    fields = ", ".join(f'"{k}" = ?' for k in updates)
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
        # sidecars de stems ({id}.stem.{role}.ext) pertencem à faixa master —
        # não são faixas próprias e não entram no cofre
        if ".stem." in f.name.lower():
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
        # Arquivo solto sem tags entra como single (o próprio arquivo é o álbum).
        album_id = create_single_album(conn, f.stem, "")
        seed_album_cover(conn, album_id, thumb)
        conn.execute("""
            INSERT OR IGNORE INTO tracks
                (id, title, artist, duration, thumbnail, file_path,
                 date_added, published_date, streams, source, status, album_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (track_id, f.stem, "", None, thumb, str(f),
              int(_time.time()), None, 0, "local", "unidentified", album_id))
        added += 1
        logger.info(f"Library scan: added {f.name}")
    if added:
        conn.commit()
    return added


def search_tracks(conn, query, limit=50):
    pattern = f"%{query}%"
    rows = conn.execute(
        _TRACK_SELECT
        + " WHERE t.title LIKE ? OR t.artist LIKE ? OR a.title LIKE ?"
        + " ORDER BY t.streams DESC, t.date_added DESC LIMIT ?",
        (pattern, pattern, pattern, limit)
    ).fetchall()
    return [_parse_track(dict(r)) for r in rows]


def increment_streams(conn, track_id):
    conn.execute("UPDATE tracks SET streams = streams + 1 WHERE id = ?", (track_id,))


def delete_track(conn, track_id):
    # Variações Stem Ready caem em cascata: os sidecars pertencem à original,
    # então sem X a variação não tem o que tocar.
    for variant in list_stem_variants(conn, track_id):
        delete_stem_variant(conn, variant["id"])
    # Se a faixa pertence a um grupo de versões, sai dele primeiro (o helper
    # reatribui o primary / dissolve o grupo conforme o caso).
    remove_from_version_group(conn, track_id)
    row = conn.execute(
        "SELECT album_id FROM tracks WHERE id = ?", (track_id,)
    ).fetchone()
    old_album = row["album_id"] if row else None
    conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
    conn.execute("DELETE FROM downloads WHERE track_id = ?", (track_id,))
    conn.execute("DELETE FROM track_stems WHERE track_id = ?", (track_id,))
    conn.execute("DELETE FROM track_waveforms WHERE track_id = ?", (track_id,))
    # Álbum que ficou sem faixas não faz sentido (singles, sobretudo).
    if old_album:
        delete_album_if_empty(conn, old_album)


# ── Albums (entidade de primeira classe; a faixa herda title/year/genre daqui) ─

def get_album(conn, album_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM albums WHERE id = ?", (album_id,)).fetchone()
    return dict(row) if row else None


def list_albums(conn) -> list[dict]:
    rows = conn.execute("SELECT * FROM albums ORDER BY title COLLATE NOCASE").fetchall()
    return [dict(r) for r in rows]


def create_album(conn, title, artist=None, year=None, genre=None,
                 total_tracks=None, kind="album") -> str:
    import secrets, time
    album_id = "al_" + secrets.token_hex(6)
    conn.execute("""
        INSERT INTO albums (id, title, artist, year, genre, total_tracks, kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (album_id, (title or "").strip() or "Álbum", artist or None, year, genre,
          total_tracks, kind, int(time.time())))
    return album_id


def create_single_album(conn, track_title="", artist=None) -> str:
    """Single: cada faixa avulsa é o próprio álbum, com o título da faixa
    (fallback 'Single'). Sempre cria um novo — o single é único da faixa e
    NUNCA é deduplicado por título (senão faixas homônimas dividiriam capa)."""
    title = (track_title or "").strip() or "Single"
    return create_album(conn, title, artist, total_tracks=1, kind="single")


def find_or_create_album(conn, title, artist=None, year=None, genre=None) -> str:
    """Casa um álbum 'de verdade' por (artista, título) case-insensitive; senão
    cria. Sem título ⇒ single. year/genre só semeiam na criação."""
    title = (title or "").strip()
    if not title:
        return create_single_album(conn, "", artist)
    row = conn.execute("""
        SELECT id FROM albums
        WHERE kind = 'album'
          AND lower(title) = lower(?)
          AND lower(COALESCE(artist, '')) = lower(COALESCE(?, ''))
        LIMIT 1
    """, (title, artist)).fetchone()
    if row:
        return row["id"]
    return create_album(conn, title, artist, year, genre, kind="album")


def update_album(conn, album_id: str, data: dict) -> None:
    allowed = {"title", "artist", "year", "genre", "total_tracks", "cover", "kind"}
    updates = {k: v for k, v in data.items() if k in allowed}
    if "title" in updates:
        updates["title"] = (updates["title"] or "").strip() or "Álbum"
    if not updates:
        return
    fields = ", ".join(f'"{k}" = ?' for k in updates)
    values = list(updates.values()) + [album_id]
    conn.execute(f"UPDATE albums SET {fields} WHERE id = ?", values)


def seed_album_cover(conn, album_id: str, cover: str | None) -> None:
    """Semeia a capa do álbum a partir da arte de uma faixa (import/Discogs).
    SÓ preenche se o álbum ainda não tem capa — capa explícita (escolhida no
    editor via POST /albums/{id}/cover) nunca é sobrescrita por reimport."""
    if not album_id or not cover:
        return
    conn.execute(
        "UPDATE albums SET cover = ? WHERE id = ? AND (cover IS NULL OR cover = '')",
        (cover, album_id),
    )


def set_track_album(conn, track_id: str, album_id: str) -> None:
    """Reatribui a faixa a um álbum e faz GC do álbum antigo se ficou vazio."""
    row = conn.execute(
        "SELECT album_id FROM tracks WHERE id = ?", (track_id,)
    ).fetchone()
    old_album = row["album_id"] if row else None
    conn.execute("UPDATE tracks SET album_id = ? WHERE id = ?", (album_id, track_id))
    # A variação Stem Ready segue o master (divide o mesmo álbum).
    conn.execute(
        "UPDATE tracks SET album_id = ? WHERE stem_source_id = ?", (album_id, track_id)
    )
    if old_album and old_album != album_id:
        delete_album_if_empty(conn, old_album)


def delete_album_if_empty(conn, album_id: str) -> None:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM tracks WHERE album_id = ?", (album_id,)
    ).fetchone()
    if not row or row["n"] == 0:
        conn.execute("DELETE FROM albums WHERE id = ?", (album_id,))


def album_ids_in_album(conn, album_id: str) -> list[str]:
    """Faixas do álbum (inclui variações), usado para refletir edições na UI."""
    rows = conn.execute(
        "SELECT id FROM tracks WHERE album_id = ?", (album_id,)
    ).fetchall()
    return [r["id"] for r in rows]


def albums_map(conn) -> dict:
    """{album_id: {…campos do álbum…, track_count}} — usado pelo bootstrap.
    track_count ignora variações Stem Ready (compartilham o álbum do master)."""
    rows = conn.execute("SELECT * FROM albums").fetchall()
    counts = conn.execute("""
        SELECT album_id, COUNT(*) AS n FROM tracks
        WHERE album_id IS NOT NULL AND stem_source_id IS NULL
        GROUP BY album_id
    """).fetchall()
    cmap = {r["album_id"]: r["n"] for r in counts}
    out: dict = {}
    for r in rows:
        d = dict(r)
        d["track_count"] = cmap.get(r["id"], 0)
        out[r["id"]] = d
    return out


def backfill_album_ids(conn) -> int:
    """Boot: faixa sem album_id ganha um single-album (rede de segurança). A
    variação Stem Ready herda o álbum do master. Espelha backfill_stem_variants."""
    created = 0
    rows = conn.execute("""
        SELECT id, title, artist, stem_source_id FROM tracks
        WHERE album_id IS NULL
        ORDER BY (stem_source_id IS NOT NULL) ASC
    """).fetchall()
    for r in rows:
        if r["stem_source_id"]:
            src = conn.execute(
                "SELECT album_id FROM tracks WHERE id = ?", (r["stem_source_id"],)
            ).fetchone()
            if src and src["album_id"]:
                conn.execute("UPDATE tracks SET album_id = ? WHERE id = ?",
                             (src["album_id"], r["id"]))
                continue
        album_id = create_single_album(conn, r["title"] or "", r["artist"] or "")
        conn.execute("UPDATE tracks SET album_id = ? WHERE id = ?", (album_id, r["id"]))
        created += 1
    if created:
        conn.commit()
    return created


# ── Version groups (versões alternativas da mesma música) ─────────────────────

def _members_of(conn, group_id) -> list[str]:
    rows = conn.execute(
        "SELECT id FROM tracks WHERE version_group_id = ? ORDER BY date_added ASC",
        (group_id,)
    ).fetchall()
    return [r["id"] for r in rows]


def create_version_group(conn, primary_track_id: str) -> str:
    import secrets, time
    group_id = "vg_" + secrets.token_hex(6)
    conn.execute(
        "INSERT INTO version_groups (id, primary_track_id, created_at) VALUES (?, ?, ?)",
        (group_id, primary_track_id, int(time.time()))
    )
    conn.execute(
        "UPDATE tracks SET version_group_id = ? WHERE id = ?",
        (group_id, primary_track_id)
    )
    return group_id


def add_to_version_group(conn, group_id: str, track_id: str) -> None:
    conn.execute(
        "UPDATE tracks SET version_group_id = ? WHERE id = ?", (group_id, track_id)
    )


def set_version_primary(conn, group_id: str, track_id: str) -> None:
    conn.execute(
        "UPDATE version_groups SET primary_track_id = ? WHERE id = ?",
        (track_id, group_id)
    )


def _dissolve_if_needed(conn, group_id: str) -> None:
    """Grupo só faz sentido com 2+ membros. Com <2, dissolve e limpa o resto."""
    members = _members_of(conn, group_id)
    if len(members) < 2:
        conn.execute(
            "UPDATE tracks SET version_group_id = NULL, version_label = NULL "
            "WHERE version_group_id = ?", (group_id,)
        )
        conn.execute("DELETE FROM version_groups WHERE id = ?", (group_id,))
        return
    # Garante um primary válido dentro do grupo.
    row = conn.execute(
        "SELECT primary_track_id FROM version_groups WHERE id = ?", (group_id,)
    ).fetchone()
    primary = row["primary_track_id"] if row else None
    if primary not in members:
        set_version_primary(conn, group_id, members[0])


def remove_from_version_group(conn, track_id: str) -> None:
    row = conn.execute(
        "SELECT version_group_id FROM tracks WHERE id = ?", (track_id,)
    ).fetchone()
    group_id = row["version_group_id"] if row else None
    if not group_id:
        return
    conn.execute(
        "UPDATE tracks SET version_group_id = NULL, version_label = NULL WHERE id = ?",
        (track_id,)
    )
    _dissolve_if_needed(conn, group_id)


def get_version_group(conn, group_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM version_groups WHERE id = ?", (group_id,)
    ).fetchone()
    return dict(row) if row else None


def get_group_members(conn, group_id: str) -> list[dict]:
    """Faixas completas do grupo — primary primeiro, depois por date_added."""
    row = conn.execute(
        "SELECT primary_track_id FROM version_groups WHERE id = ?", (group_id,)
    ).fetchone()
    primary = row["primary_track_id"] if row else None
    rows = conn.execute(
        _TRACK_SELECT + " WHERE t.version_group_id = ? ORDER BY t.date_added ASC",
        (group_id,)
    ).fetchall()
    members = [dict(r) for r in rows]
    members.sort(key=lambda t: (0 if t["id"] == primary else 1, t.get("date_added") or 0))
    return members


def groups_map(conn) -> dict:
    """{group_id: {"primary": id, "members": [ids…]}} — usado pelo bootstrap."""
    grows = conn.execute("SELECT id, primary_track_id FROM version_groups").fetchall()
    out: dict = {}
    for g in grows:
        members = _members_of(conn, g["id"])
        out[g["id"]] = {"primary": g["primary_track_id"], "members": members}
    return out


# ── Stems (versão multipista: vocals · drums · bass · other) ─────────────────

def get_stems(conn, track_id) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM track_stems WHERE track_id = ? ORDER BY role", (track_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def get_stem(conn, track_id, role) -> dict | None:
    row = conn.execute(
        "SELECT * FROM track_stems WHERE track_id = ? AND role = ?", (track_id, role)
    ).fetchone()
    return dict(row) if row else None


def upsert_stem(conn, track_id, role, file_path, duration, size, codec, added_at):
    conn.execute("""
        INSERT INTO track_stems (track_id, role, file_path, duration, size, codec, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(track_id, role) DO UPDATE SET
            file_path = excluded.file_path,
            duration  = excluded.duration,
            size      = excluded.size,
            codec     = excluded.codec,
            added_at  = excluded.added_at
    """, (track_id, role, file_path, duration, size, codec, added_at))


def delete_stem(conn, track_id, role):
    conn.execute(
        "DELETE FROM track_stems WHERE track_id = ? AND role = ?", (track_id, role)
    )


def stems_map(conn) -> dict:
    """{track_id: [roles…]} — usado pelo bootstrap para marcar as faixas."""
    rows = conn.execute("SELECT track_id, role FROM track_stems ORDER BY role").fetchall()
    out: dict = {}
    for r in rows:
        out.setdefault(r["track_id"], []).append(r["role"])
    return out


# ── Pads de sample (módulo Loop do Remixer) ───────────────────────────────────

def get_pads(conn, track_id) -> list[dict]:
    rows = conn.execute(
        "SELECT pad_index, start_s, end_s FROM track_pads "
        "WHERE track_id = ? ORDER BY pad_index",
        (track_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def upsert_pad(conn, track_id, pad_index, start_s, end_s, added_at):
    conn.execute("""
        INSERT INTO track_pads (track_id, pad_index, start_s, end_s, added_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(track_id, pad_index) DO UPDATE SET
            start_s  = excluded.start_s,
            end_s    = excluded.end_s,
            added_at = excluded.added_at
    """, (track_id, pad_index, start_s, end_s, added_at))


def delete_pad(conn, track_id, pad_index):
    conn.execute(
        "DELETE FROM track_pads WHERE track_id = ? AND pad_index = ?",
        (track_id, pad_index),
    )


# ── Waveform (envelope de amplitude da faixa inteira) ─────────────────────────

def upsert_waveform(conn, track_id: str, peaks: list[float], added_at: int) -> None:
    import json
    conn.execute("""
        INSERT INTO track_waveforms (track_id, peaks, buckets, added_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(track_id) DO UPDATE SET
            peaks    = excluded.peaks,
            buckets  = excluded.buckets,
            added_at = excluded.added_at
    """, (track_id, json.dumps(peaks), len(peaks), added_at))


def get_waveform(conn, track_id: str) -> dict | None:
    row = conn.execute(
        "SELECT peaks, buckets FROM track_waveforms WHERE track_id = ?", (track_id,)
    ).fetchone()
    if not row:
        return None
    import json
    return {"peaks": json.loads(row["peaks"]), "buckets": row["buckets"]}


def list_tracks_missing_waveform(conn) -> list[dict]:
    """Faixas com arquivo no disco e sem picos calculados ainda — usado pelo
    backfill de boot (faixas importadas antes desse recurso existir)."""
    rows = conn.execute("""
        SELECT t.id, t.file_path FROM tracks t
        LEFT JOIN track_waveforms w ON w.track_id = t.id
        WHERE w.track_id IS NULL AND t.file_path IS NOT NULL
    """).fetchall()
    return [dict(r) for r in rows]


# ── Variação "Stem Ready" (faixa-variação que toca multipista) ───────────────
# A variação V de X nasce automática ao completar 2 camadas na gaveta:
#   id = "{X.id}::stems" (determinístico ⇒ criação idempotente)
#   stem_source_id = X.id, version_label = 'Stems', file_path = X.file_path
#   (fallback: tocá-la "cru" toca o master), demais campos copiados de X.
# Ela entra no grupo de versões de X (criando-o se preciso; primary segue X).

def stem_variant_id(source_id: str) -> str:
    return f"{source_id}::stems"


def get_stem_variant(conn, source_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM tracks WHERE stem_source_id = ?", (source_id,)
    ).fetchone()
    return dict(row) if row else None


def list_stem_variants(conn, source_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM tracks WHERE stem_source_id = ?", (source_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def create_stem_variant(conn, source_track: dict) -> dict:
    """Cria (ou devolve, se já existe) a variação Stem Ready de source_track."""
    import time as _time
    source_id = source_track["id"]
    existing = get_stem_variant(conn, source_id)
    if existing:
        return existing

    vid = stem_variant_id(source_id)
    # A variação divide o álbum com o master (mesmo album_id) — title/year/genre
    # vêm de lá via JOIN, sem cópia.
    conn.execute("""
        INSERT OR REPLACE INTO tracks
            (id, title, artist, album_id, duration, thumbnail, file_path,
             date_added, published_date, streams, source, status,
             bpm, key, label, version_label, stem_source_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'Stems', ?)
    """, (
        vid,
        source_track.get("title"),
        source_track.get("artist"),
        source_track.get("album_id"),
        source_track.get("duration"),
        source_track.get("thumbnail"),
        source_track.get("file_path"),
        int(_time.time()),
        source_track.get("published_date"),
        source_track.get("source"),
        source_track.get("status", "unidentified"),
        source_track.get("bpm"),
        source_track.get("key"),
        source_track.get("label"),
        source_id,
    ))

    group_id = source_track.get("version_group_id")
    if not group_id:
        group_id = create_version_group(conn, source_id)
    add_to_version_group(conn, group_id, vid)
    return get_track(conn, vid)


def delete_stem_variant(conn, variant_id: str) -> None:
    """Remove SÓ a linha da variação (nunca arquivos: file_path é do master)."""
    remove_from_version_group(conn, variant_id)
    conn.execute("DELETE FROM tracks WHERE id = ?", (variant_id,))


def backfill_stem_variants(conn) -> int:
    """Subida do app: faixa com ≥2 stems e sem variação ⇒ cria V (idempotente)."""
    created = 0
    smap = stems_map(conn)
    for track_id, roles in smap.items():
        if len(roles) < 2:
            continue
        track = get_track(conn, track_id)
        if not track or track.get("stem_source_id"):
            continue
        if get_stem_variant(conn, track_id):
            continue
        create_stem_variant(conn, track)
        created += 1
    return created


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


def set_playlist_tracks(conn, playlist_id: int, track_ids: list[str]) -> None:
    """Substitui o conteúdo da playlist pela lista ordenada (reordenar /
    embaralhar / ordenar na UI mandam a ordem completa). Preserva o
    added_at de quem já estava."""
    import time
    rows = conn.execute(
        "SELECT track_id, added_at FROM playlist_tracks WHERE playlist_id = ?",
        (playlist_id,)
    ).fetchall()
    added = {r["track_id"]: r["added_at"] for r in rows}
    now = int(time.time())
    conn.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?", (playlist_id,))
    seen = set()
    position = 0
    for track_id in track_ids:
        if not track_id or track_id in seen:
            continue
        seen.add(track_id)
        conn.execute("""
            INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
            VALUES (?, ?, ?, ?)
        """, (playlist_id, track_id, position, added.get(track_id, now)))
        position += 1
    conn.commit()


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