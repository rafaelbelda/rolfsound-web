from __future__ import annotations

import asyncio
import re
from typing import Any

from core.database import database


_SPOTIFY_TRACK_RE = re.compile(r"(?:open\.spotify\.com/(?:intl-[a-z]{2}/)?track/)?([A-Za-z0-9]{22})")
_ISRC_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}\d{7}$", re.IGNORECASE)


def _clean(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def split_identity_query(query: str | None, fallback_track: dict | None = None) -> tuple[str | None, str | None]:
    text = _clean(query)
    if text and " - " in text:
        left, right = text.split(" - ", 1)
        return _clean(left), _clean(right)
    for separator in (" \u2014 ", " \u2013 "):
        if text and separator in text:
            left, right = text.split(separator, 1)
            return _clean(left), _clean(right)

    fallback_artist = _clean((fallback_track or {}).get("display_artist") or (fallback_track or {}).get("artist"))
    fallback_title = _clean((fallback_track or {}).get("title"))
    if text:
        return fallback_artist, text
    return fallback_artist, fallback_title


def _artist_credits_from_names(names: list[str], source: str) -> list[dict]:
    return [
        {
            "name": name,
            "role": "main",
            "position": idx,
            "is_primary": idx == 0,
            "source": source,
        }
        for idx, name in enumerate(names)
        if _clean(name)
    ]


def _local_candidate(track: dict) -> dict:
    artists = track.get("artists") or []
    if not artists and (track.get("display_artist") or track.get("artist")):
        artists = _artist_credits_from_names([track.get("display_artist") or track.get("artist")], "local")
    albums = track.get("albums") or ([track.get("album")] if track.get("album") else [])
    return {
        "provider": "local",
        "id": track.get("id"),
        "track_id": track.get("id"),
        "title": track.get("title"),
        "display_artist": track.get("display_artist") or track.get("artist"),
        "artists": artists,
        "albums": albums,
        "album": albums[0] if albums else None,
        "year": track.get("year"),
        "duration": track.get("duration"),
        "thumbnail": track.get("thumbnail"),
        "cover_image": track.get("thumbnail"),
        "mb_recording_id": track.get("mb_recording_id"),
        "isrc": track.get("isrc"),
        "spotify_id": track.get("spotify_id"),
        "discogs_id": track.get("discogs_id"),
        "label": track.get("label"),
        "confidence": 1.0,
    }


def _spotify_candidate(raw: dict, *, reason: str) -> dict:
    albums = raw.get("albums") or ([raw.get("album_data")] if raw.get("album_data") else [])
    return {
        "provider": "spotify",
        "id": raw.get("spotify_id"),
        "title": raw.get("title"),
        "display_artist": raw.get("display_artist") or raw.get("artist"),
        "artists": raw.get("artist_credits") or _artist_credits_from_names(raw.get("artists") or [], "spotify"),
        "albums": albums,
        "album": albums[0] if albums else None,
        "year": raw.get("year"),
        "duration": raw.get("duration"),
        "thumbnail": raw.get("cover_image"),
        "cover_image": raw.get("cover_image"),
        "isrc": raw.get("isrc"),
        "spotify_id": raw.get("spotify_id"),
        "confidence": 0.92 if reason in {"spotify_track_id", "spotify_isrc"} else 0.78,
        "reason": reason,
        "url": raw.get("url"),
    }


def _musicbrainz_candidate(raw: dict, *, reason: str) -> dict:
    albums = raw.get("albums") or ([raw.get("album_data")] if raw.get("album_data") else [])
    return {
        "provider": "musicbrainz",
        "id": raw.get("mb_recording_id"),
        "title": raw.get("title"),
        "display_artist": raw.get("display_artist") or raw.get("artist"),
        "artists": raw.get("artist_credits") or _artist_credits_from_names(raw.get("artist_names") or [], "musicbrainz"),
        "albums": albums,
        "album": albums[0] if albums else None,
        "year": raw.get("year"),
        "duration": raw.get("duration"),
        "thumbnail": raw.get("cover_image"),
        "cover_image": raw.get("cover_image"),
        "isrc": (raw.get("isrcs") or [None])[0],
        "mb_recording_id": raw.get("mb_recording_id"),
        "label": (raw.get("labels") or [None])[0],
        "confidence": 0.95,
        "reason": reason,
    }


def _discogs_candidate(raw: dict) -> dict:
    album = raw.get("_rolfsound_album")
    albums = [album] if album else []
    artist = raw.get("_rolfsound_display_artist")
    if not artist and " - " in str(raw.get("title") or ""):
        artist = str(raw.get("title")).split(" - ", 1)[0]
    label = raw.get("label")
    if isinstance(label, list):
        label = label[0] if label else None
    return {
        "provider": "discogs",
        "id": raw.get("id"),
        "title": raw.get("_rolfsound_track_title") or raw.get("title"),
        "display_artist": artist,
        "artists": raw.get("_rolfsound_artist_credits") or _artist_credits_from_names([artist], "discogs"),
        "albums": albums,
        "album": album,
        "year": raw.get("year"),
        "thumbnail": raw.get("cover_image"),
        "cover_image": raw.get("cover_image"),
        "discogs_id": raw.get("id"),
        "label": label,
        "confidence": raw.get("_rolfsound_confidence"),
        "reason": "discogs_search",
    }


def _dedupe_candidates(candidates: list[dict]) -> list[dict]:
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    for candidate in candidates:
        title = _clean(candidate.get("title"))
        artist = _clean(candidate.get("display_artist"))
        if not title:
            continue
        key = (str(candidate.get("provider") or ""), str(candidate.get("id") or f"{artist}|{title}").lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(candidate)
    return out


async def search_identity_candidates(track: dict, query: str | None, local_tracks: list[dict]) -> list[dict]:
    artist, title = split_identity_query(query, track)
    candidates: list[dict] = []

    current_id = track.get("id")
    candidates.extend(_local_candidate(t) for t in local_tracks if t.get("id") != current_id)

    query_text = _clean(query) or ""
    spotify_match = _SPOTIFY_TRACK_RE.search(query_text)
    isrc = query_text.replace("-", "").strip().upper()

    from api.services.identification.spotify import (
        lookup_by_isrc as spotify_by_isrc,
        lookup_by_track_id as spotify_by_track_id,
        lookup_fuzzy as spotify_fuzzy,
    )
    from api.services.identification.musicbrainz import lookup_by_isrc as musicbrainz_by_isrc
    from api.services.indexer import lookup_discogs

    tasks: list[tuple[str, asyncio.Task]] = []
    if spotify_match:
        tasks.append(("spotify_track_id", asyncio.create_task(spotify_by_track_id(spotify_match.group(1)))))
    if _ISRC_RE.match(isrc):
        tasks.append(("spotify_isrc", asyncio.create_task(spotify_by_isrc(isrc))))
        tasks.append(("musicbrainz_isrc", asyncio.create_task(musicbrainz_by_isrc(isrc))))
    if title:
        tasks.append(("spotify_fuzzy", asyncio.create_task(spotify_fuzzy(artist, title, None))))
        tasks.append(("discogs", asyncio.create_task(lookup_discogs(artist or "", title, year=None, duration=None))))

    if tasks:
        results = await asyncio.gather(*(task for _, task in tasks), return_exceptions=True)
        for (kind, _task), result in zip(tasks, results):
            if isinstance(result, Exception) or not result:
                continue
            if kind.startswith("spotify"):
                candidates.append(_spotify_candidate(result, reason=kind))
            elif kind.startswith("musicbrainz"):
                candidates.append(_musicbrainz_candidate(result, reason=kind))
            elif kind == "discogs":
                candidates.append(_discogs_candidate(result))

    return _dedupe_candidates(candidates)[:12]


def build_override_payload(raw: dict, existing_track: dict | None = None) -> dict:
    raw = dict(raw or {})
    candidate = raw.get("candidate") if isinstance(raw.get("candidate"), dict) else {}
    merged = dict(candidate)
    for key, value in raw.items():
        if key == "candidate":
            continue
        if value is not None:
            merged[key] = value

    title = _clean(merged.get("title"))
    display_artist = _clean(
        merged.get("display_artist")
        or merged.get("artist")
        or (existing_track or {}).get("display_artist")
        or (existing_track or {}).get("artist")
    )
    if not title or not display_artist:
        raise ValueError("title and display_artist are required")

    candidate_artist = _clean(candidate.get("display_artist") or candidate.get("artist"))
    form_artist = _clean(raw.get("display_artist") or raw.get("artist"))
    artist_overridden = bool(candidate and form_artist and form_artist != candidate_artist)

    artists = merged.get("artists") if isinstance(merged.get("artists"), list) else []
    if artist_overridden:
        artists = _artist_credits_from_names([display_artist], merged.get("provider") or "manual")
    elif not artists:
        artists = _artist_credits_from_names([display_artist], merged.get("provider") or "manual")

    albums = merged.get("albums") if isinstance(merged.get("albums"), list) else []
    album = merged.get("album") if isinstance(merged.get("album"), dict) else None
    album_title = _clean(merged.get("album_title"))
    album_title_present = "album_title" in raw and raw.get("album_title") is not None
    if album_title_present:
        albums = []
    if not albums and album and not album_title_present:
        albums = [album]
    if album_title:
        albums = [{
            "title": album_title,
            "display_artist": _clean(merged.get("album_artist")) or display_artist,
            "year": _clean_int(merged.get("album_year")) or _clean_int(merged.get("year")),
            "cover": _clean(merged.get("cover_image") or merged.get("thumbnail")),
            "source": merged.get("provider") or "manual",
        }]

    return {
        "title": title,
        "display_artist": display_artist,
        "artists": artists,
        "albums": albums,
        "album": albums[0] if albums else None,
        "year": _clean_int(merged.get("year")),
        "duration": _clean_float(merged.get("duration")),
        "thumbnail": _clean(merged.get("thumbnail") or merged.get("cover_image")),
        "cover_image": _clean(merged.get("cover_image") or merged.get("thumbnail")),
        "mb_recording_id": _clean(merged.get("mb_recording_id")),
        "isrc": _clean(merged.get("isrc")),
        "spotify_id": _clean(merged.get("spotify_id")),
        "discogs_id": _clean_int(merged.get("discogs_id")),
        "label": _clean(merged.get("label")),
        "track_number": _clean_int(merged.get("track_number")),
        "disc_number": _clean_int(merged.get("disc_number")),
        "source": merged.get("provider") or merged.get("source") or "manual",
    }


def _clean_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _clean_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
