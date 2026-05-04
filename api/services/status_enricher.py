"""
Reshapes core's /status payload for the dashboard.
Shared by the HTTP /api/status route and the WS state broadcaster.
"""

import logging
import os
import time
from pathlib import Path

from core.database import database
from utils.config import get as cfg_get

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_track_cache: dict = {"key": None, "data": None}


def clear_track_cache(track_id: str | None = None, filepath: str | None = None) -> None:
    """Clear cached now-playing metadata.

    When track_id/filepath are provided, only clear a matching cached entry.
    """
    cached = _track_cache.get("data") or {}
    if not cached:
        return
    if track_id and cached.get("track_id") == track_id:
        _track_cache.update({"key": None, "data": None})
        return
    if filepath and cached.get("path_key") == _cache_key(filepath):
        _track_cache.update({"key": None, "data": None})
        return
    if not track_id and not filepath:
        _track_cache.update({"key": None, "data": None})


def _add_variant(items: list[str], value) -> None:
    if value is None:
        return
    text = str(value).strip()
    if not text:
        return
    items.extend((text, text.replace("\\", "/"), text.replace("/", "\\")))


def _dedupe(items: list[str]) -> list[str]:
    seen = set()
    out = []
    for item in items:
        if not item or item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def _music_dir() -> Path:
    music_dir = Path(cfg_get("music_directory", "./music"))
    if not music_dir.is_absolute():
        music_dir = _PROJECT_ROOT / music_dir
    return music_dir.resolve(strict=False)


def _path_variants(filepath: str) -> list[str]:
    raw = str(filepath or "").strip()
    if not raw:
        return []

    items: list[str] = []
    _add_variant(items, raw)
    _add_variant(items, raw.lstrip("./\\"))

    try:
        path = Path(raw)
        abs_path = path if path.is_absolute() else (_PROJECT_ROOT / path)
        abs_path = abs_path.resolve(strict=False)
        _add_variant(items, abs_path)

        music_dir = _music_dir()
        for base in (_PROJECT_ROOT.resolve(strict=False), music_dir):
            try:
                rel = abs_path.relative_to(base)
            except ValueError:
                continue
            _add_variant(items, rel)
            if base == music_dir:
                _add_variant(items, Path(music_dir.name) / rel)
                _add_variant(items, Path("music") / rel)
    except Exception:
        pass

    return _dedupe(items)


def _normalized_path(filepath: str) -> str:
    return str(filepath or "").replace("\\", "/").lower()


def _cache_key(filepath: str) -> tuple[str, ...]:
    return tuple(sorted(set(_normalized_path(v) for v in _path_variants(filepath))))


def _lookup_track_by_filepath(conn, filepath: str):
    variants = _path_variants(filepath)
    if not variants:
        return None

    placeholders = ",".join("?" for _ in variants)
    row = conn.execute(f"""
        SELECT t.id, t.title, COALESCE(t.display_artist, t.artist) AS display_artist,
               t.thumbnail,
               COALESCE(a.bpm, t.bpm) AS bpm,
               COALESCE(a.musical_key, t.musical_key) AS musical_key,
               COALESCE(a.camelot_key, t.camelot_key) AS camelot_key
        FROM tracks t
        JOIN assets a ON t.id = a.track_id
        WHERE a.file_path IN ({placeholders})
        LIMIT 1
    """, variants).fetchone()
    if row:
        return row

    normalized = _dedupe([_normalized_path(v) for v in variants])
    placeholders = ",".join("?" for _ in normalized)
    return conn.execute(f"""
        SELECT t.id, t.title, COALESCE(t.display_artist, t.artist) AS display_artist,
               t.thumbnail,
               COALESCE(a.bpm, t.bpm) AS bpm,
               COALESCE(a.musical_key, t.musical_key) AS musical_key,
               COALESCE(a.camelot_key, t.camelot_key) AS camelot_key
        FROM tracks t
        JOIN assets a ON t.id = a.track_id
        WHERE lower(replace(a.file_path, char(92), '/')) IN ({placeholders})
        LIMIT 1
    """, normalized).fetchone()


def enrich_status(raw: dict) -> dict:
    pb = raw.get("playback", {})
    q  = raw.get("queue",    {})

    if pb.get("paused"):
        state = "paused"
    elif pb.get("playing"):
        state = "playing"
    else:
        state = "idle"

    current_filepath = pb.get("current_track", "")

    title     = os.path.basename(current_filepath) if current_filepath else ""
    artist    = ""
    thumbnail = ""
    track_id  = os.path.basename(current_filepath) if current_filepath else ""
    bpm       = None
    musical_key = None
    camelot_key = None

    if current_filepath:
        path_key = _cache_key(current_filepath)
        if path_key == _track_cache["key"]:
            cached = _track_cache["data"]
            track_id  = cached["track_id"]  or track_id
            title     = cached["title"]     or title
            artist    = cached["artist"]    or ""
            thumbnail = cached["thumbnail"] or ""
            bpm       = cached.get("bpm")
            musical_key = cached.get("musical_key")
            camelot_key = cached.get("camelot_key")
        else:
            try:
                conn = database.get_connection()
                try:
                    row = _lookup_track_by_filepath(conn, current_filepath)

                    if row:
                        track_id  = row["id"]        or track_id
                        title     = row["title"]     or title
                        artist    = row["display_artist"] or ""
                        thumbnail = row["thumbnail"] or ""
                        bpm       = row["bpm"]
                        musical_key = row["musical_key"]
                        camelot_key = row["camelot_key"]
                        _track_cache["key"] = path_key
                        _track_cache["data"] = {
                            "track_id": track_id, "title": title,
                            "artist": artist,     "display_artist": artist,
                            "thumbnail": thumbnail,
                            "bpm": bpm,           "musical_key": musical_key,
                            "camelot_key": camelot_key, "path_key": path_key,
                        }
                finally:
                    conn.close()
            except Exception as e:
                logger.debug(f"Status enrichment DB lookup failed: {e}")

    np = pb.get("now_playing", {})
    if np:
        if not track_id or track_id == os.path.basename(current_filepath):
            track_id  = np.get("track_id")  or track_id
        if not title or title == os.path.basename(current_filepath):
            title     = np.get("title")     or title
        if not artist:
            artist    = np.get("display_artist") or np.get("artist") or ""
        if not thumbnail:
            thumbnail = np.get("thumbnail") or ""

    queue_tracks = []
    for t in q.get("tracks", []):
        queue_tracks.append({
            "track_id":  t.get("track_id",  ""),
            "title":     t.get("title",     ""),
            "thumbnail": t.get("thumbnail", ""),
            "artist":    t.get("display_artist", t.get("artist", "")),
            "display_artist": t.get("display_artist", t.get("artist", "")),
            "filepath":  t.get("filepath",  ""),
            "bpm":       t.get("bpm"),
            "musical_key": t.get("musical_key"),
            "camelot_key": t.get("camelot_key"),
        })

    raw["state"]                = state
    raw["paused"]               = pb.get("paused", False)
    raw["track_id"]             = track_id
    raw["title"]                = title
    raw["artist"]               = artist
    raw["display_artist"]       = artist
    raw["thumbnail"]            = thumbnail
    raw["bpm"]                  = bpm
    raw["musical_key"]          = musical_key
    raw["camelot_key"]          = camelot_key
    raw["position"]             = pb.get("position_s",          0)
    raw["duration"]             = pb.get("duration_s",          0)
    raw["position_updated_at"]  = int(pb.get("position_updated_at", time.time()) * 1000)
    raw["volume"]               = pb.get("volume",              1.0)
    raw["queue"]                = queue_tracks
    raw["queue_current_index"]  = q.get("current_index", -1)
    raw["repeat_mode"]          = q.get("repeat_mode", "off")
    raw["shuffle"]              = q.get("shuffle", False)

    return raw
