"""
Spotify Web API provider — Client Credentials flow.

Two entry points:

- lookup_by_isrc(isrc) — deterministic. ISRC is a code assigned per recording;
  Spotify exposes a search filter `isrc:XXX` that returns the canonical track.
  Strongest single-source evidence available short of an MBID match.

- lookup_fuzzy(artist, title, duration) — soft search filtered by duration.
  Useful when AcoustID/Shazam miss but Discogs/MB also miss; Spotify covers
  modern release catalogs (post-2010 indie, especially) much better.

Cached 7 days. Token cached separately (and refreshed automatically) under
key `__token__`. We never persist the token to disk in plaintext beyond what
the cache table stores.
"""

from __future__ import annotations

import base64
import logging
import time
from typing import Any

import httpx

from utils import config as cfg

from .cache import TTL_SPOTIFY, cached_fetch, make_cache_key

logger = logging.getLogger(__name__)

_TOKEN_URL = "https://accounts.spotify.com/api/token"
_API_BASE = "https://api.spotify.com/v1"

_token_cache: dict = {"value": None, "expires_at": 0}


def _credentials() -> tuple[str, str] | None:
    cid = cfg.get("spotify_client_id", "")
    sec = cfg.get("spotify_client_secret", "")
    if not cid or not sec:
        return None
    return cid, sec


async def _fetch_token() -> str | None:
    creds = _credentials()
    if not creds:
        return None
    cid, sec = creds
    auth = base64.b64encode(f"{cid}:{sec}".encode("utf-8")).decode("ascii")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                _TOKEN_URL,
                headers={
                    "Authorization": f"Basic {auth}",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={"grant_type": "client_credentials"},
            )
    except httpx.HTTPError as exc:
        logger.warning("Spotify token request failed: %s", exc)
        return None
    if resp.status_code != 200:
        logger.warning("Spotify token request returned %s", resp.status_code)
        return None
    payload = resp.json()
    token = payload.get("access_token")
    expires_in = int(payload.get("expires_in", 3600))
    if not token:
        return None
    _token_cache["value"] = token
    _token_cache["expires_at"] = int(time.time()) + max(60, expires_in - 60)
    return token


async def _get_token() -> str | None:
    if _token_cache["value"] and _token_cache["expires_at"] > int(time.time()):
        return _token_cache["value"]
    return await _fetch_token()


async def _api_get(path: str, params: dict | None = None) -> dict | None:
    token = await _get_token()
    if not token:
        return None
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{_API_BASE}{path}",
                params=params or {},
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as exc:
        logger.debug("Spotify request failed %s: %s", path, exc)
        return None
    if resp.status_code == 401:
        # Token expired between get and use; force refresh and retry once.
        _token_cache["value"] = None
        token = await _get_token()
        if not token:
            return None
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{_API_BASE}{path}",
                    params=params or {},
                    headers={"Authorization": f"Bearer {token}"},
                )
        except httpx.HTTPError:
            return None
    if resp.status_code == 429:
        retry_after = resp.headers.get("retry-after", "?")
        logger.warning("Spotify rate-limited (retry-after=%s)", retry_after)
        return None
    if resp.status_code != 200:
        logger.debug("Spotify %s returned %s", path, resp.status_code)
        return None
    try:
        return resp.json()
    except ValueError:
        return None


def _normalize_track(track: dict | None) -> dict | None:
    if not track:
        return None
    artists = [a.get("name") for a in (track.get("artists") or []) if isinstance(a, dict) and a.get("name")]
    album = track.get("album") or {}
    images = album.get("images") or []
    cover = max(images, key=lambda i: int(i.get("width") or 0)).get("url") if images else None
    release_date = album.get("release_date") or ""
    year = None
    if release_date and len(release_date) >= 4 and release_date[:4].isdigit():
        year = int(release_date[:4])
    duration_ms = track.get("duration_ms") or 0
    return {
        "spotify_id": track.get("id"),
        "title": track.get("name"),
        "artist": artists[0] if artists else None,
        "artists": artists,
        "album": album.get("name"),
        "album_id": album.get("id"),
        "cover_image": cover,
        "year": year,
        "release_date": release_date,
        "duration": duration_ms / 1000.0 if duration_ms else None,
        "isrc": ((track.get("external_ids") or {}).get("isrc") or "").upper() or None,
        "popularity": track.get("popularity"),
        "url": (track.get("external_urls") or {}).get("spotify"),
    }


async def lookup_by_isrc(isrc: str) -> dict | None:
    """ISRC search — strongest match Spotify can give us. Cached."""
    if not isrc or not _credentials():
        return None
    isrc = isrc.strip().upper().replace("-", "")
    if len(isrc) != 12:
        return None
    key = make_cache_key("isrc", isrc)

    async def _fetch() -> dict | None:
        data = await _api_get("/search", {"q": f"isrc:{isrc}", "type": "track", "limit": 1})
        items = ((data or {}).get("tracks") or {}).get("items") or []
        return _normalize_track(items[0]) if items else None

    return await cached_fetch("spotify", key, TTL_SPOTIFY, _fetch)


async def lookup_by_track_id(track_id: str) -> dict | None:
    """Direct track lookup when we already have a Spotify URL (e.g. from YT desc)."""
    if not track_id or not _credentials():
        return None
    key = make_cache_key("track", track_id)

    async def _fetch() -> dict | None:
        data = await _api_get(f"/tracks/{track_id}")
        return _normalize_track(data) if data else None

    return await cached_fetch("spotify", key, TTL_SPOTIFY, _fetch)


def _duration_close(a: float | None, b: float | None, slack: float = 8.0) -> bool:
    if not a or not b:
        return True
    return abs(float(a) - float(b)) <= slack


async def lookup_fuzzy(artist: str | None, title: str | None, duration: float | None = None) -> dict | None:
    """
    Fuzzy search by track + artist, filtered by duration when known.

    Returns the top result whose duration is within ±8s of the local file
    duration, or the top result outright if no duration was provided. Use
    confidence cautiously downstream — Spotify's relevance can be off for
    common titles.
    """
    if not title or not _credentials():
        return None
    parts = []
    if title:
        parts.append(f'track:"{title.strip()}"')
    if artist:
        parts.append(f'artist:"{artist.strip()}"')
    query = " ".join(parts)
    key = make_cache_key("fuzzy", artist or "", title, int(duration or 0) // 5 * 5)

    async def _fetch() -> dict | None:
        data = await _api_get("/search", {"q": query, "type": "track", "limit": 5})
        items = ((data or {}).get("tracks") or {}).get("items") or []
        if not items:
            return None
        for item in items:
            normalized = _normalize_track(item)
            if normalized and _duration_close(duration, normalized.get("duration")):
                return normalized
        return _normalize_track(items[0])

    return await cached_fetch("spotify", key, TTL_SPOTIFY, _fetch)
