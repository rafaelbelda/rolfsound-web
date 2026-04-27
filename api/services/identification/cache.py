"""
TTL-backed cache for external API lookups.

Wraps async fetchers so repeated lookups for the same key skip the network.
Backed by the `external_lookup_cache` table in the main library SQLite.

TTL conventions (seconds):
- AcoustID:       90 days  (fingerprints are stable)
- MusicBrainz:    30 days
- Cover Art Arch: 30 days
- Discogs:        14 days
- Shazam:         30 days
- Spotify:         7 days  (catalog churns more)
- Genius:         14 days
- YouTube desc:   30 days
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable

from core.database import database

logger = logging.getLogger(__name__)

TTL_ACOUSTID = 90 * 86400
TTL_MUSICBRAINZ = 30 * 86400
TTL_COVERART = 30 * 86400
TTL_DISCOGS = 14 * 86400
TTL_SHAZAM = 30 * 86400
TTL_SPOTIFY = 7 * 86400
TTL_GENIUS = 14 * 86400
TTL_YOUTUBE = 30 * 86400


def _read(provider: str, key: str) -> Any | None:
    conn = database.get_connection()
    try:
        raw = database.cache_get_external(conn, provider, key)
    finally:
        conn.close()
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def _write(provider: str, key: str, value: Any, ttl: int) -> None:
    try:
        encoded = json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError) as exc:
        logger.debug("cache: refused non-JSON-able value for %s/%s: %s", provider, key, exc)
        return
    conn = database.get_connection()
    try:
        database.cache_put_external(conn, provider, key, encoded, ttl)
    finally:
        conn.close()


async def cached_fetch(
    provider: str,
    key: str,
    ttl: int,
    fetcher: Callable[[], Awaitable[Any]],
    *,
    cache_negative: bool = True,
) -> Any | None:
    """
    Return cached value for (provider, key) if fresh; otherwise call fetcher,
    store result (including None when cache_negative is True), and return it.

    Negative caching is on by default to protect against repeated misses (e.g.
    Discogs returning no candidates) — reset by calling cache_purge_external.
    """
    cached = await asyncio.to_thread(_read, provider, key)
    if cached is not None:
        return cached.get("v") if isinstance(cached, dict) and "v" in cached else cached

    value = await fetcher()
    if value is None and not cache_negative:
        return None
    payload = {"v": value}
    await asyncio.to_thread(_write, provider, key, payload, ttl)
    return value


def make_cache_key(*parts: Any) -> str:
    """Stable key from heterogeneous parts (lowercased, normalized)."""
    flat = []
    for p in parts:
        if p is None:
            flat.append("")
        elif isinstance(p, (dict, list, tuple)):
            flat.append(json.dumps(p, sort_keys=True, ensure_ascii=False, default=str))
        else:
            flat.append(str(p).strip().lower())
    return "|".join(flat)
