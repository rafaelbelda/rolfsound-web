# api/status_enricher.py
"""
Reshapes core's /status payload for the dashboard.
Shared by the HTTP /api/status route and the WS state broadcaster.
"""

import logging
import os
import time

from db import database

logger = logging.getLogger(__name__)

_track_cache: dict = {"path": None, "data": None}


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

    if current_filepath:
        if current_filepath == _track_cache["path"]:
            cached = _track_cache["data"]
            track_id  = cached["track_id"]  or track_id
            title     = cached["title"]     or title
            artist    = cached["artist"]    or ""
            thumbnail = cached["thumbnail"] or ""
            bpm       = cached.get("bpm")
        else:
            try:
                conn = database.get_connection()
                try:
                    # --- CORREÇÃO APLICADA AQUI: JOIN e adição do BPM no SELECT ---
                    row = conn.execute("""
                        SELECT t.id, t.title, t.artist, t.thumbnail, COALESCE(a.bpm, t.bpm) AS bpm
                        FROM tracks t
                        JOIN assets a ON t.id = a.track_id
                        WHERE a.file_path = ?
                    """, (current_filepath,)).fetchone()
                    
                    if row:
                        track_id  = row["id"]        or track_id
                        title     = row["title"]     or title
                        artist    = row["artist"]    or ""
                        thumbnail = row["thumbnail"] or ""
                        bpm       = row["bpm"]
                        
                    _track_cache["path"] = current_filepath
                    _track_cache["data"] = {
                        "track_id": track_id, "title": title,
                        "artist": artist,     "thumbnail": thumbnail,
                        "bpm": bpm,
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
        if not thumbnail:
            thumbnail = np.get("thumbnail") or ""

    queue_tracks = []
    for t in q.get("tracks", []):
        queue_tracks.append({
            "track_id":  t.get("track_id",  ""),
            "title":     t.get("title",     ""),
            "thumbnail": t.get("thumbnail", ""),
            "artist":    t.get("artist",    ""),
            "filepath":  t.get("filepath",  ""),
        })

    raw["state"]                = state
    raw["paused"]               = pb.get("paused", False)
    raw["track_id"]             = track_id
    raw["title"]                = title
    raw["artist"]               = artist
    raw["thumbnail"]            = thumbnail
    raw["bpm"]                  = bpm
    raw["position"]             = pb.get("position_s",          0)
    raw["duration"]             = pb.get("duration_s",          0)
    raw["position_updated_at"]  = int(pb.get("position_updated_at", time.time()) * 1000)
    raw["volume"]               = pb.get("volume",              1.0)
    raw["queue"]                = queue_tracks
    raw["queue_current_index"]  = q.get("current_index", -1)
    raw["repeat_mode"]          = q.get("repeat_mode", "off")
    raw["shuffle"]              = q.get("shuffle", False)

    return raw
