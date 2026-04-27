"""
Genius search as a textual cross-validator.

Not a primary identifier — Genius is biased to lyric-heavy genres and gives
no fingerprint. We use it only when we already have a candidate (artist, title)
with mid-range confidence (~0.55-0.83) and want a second textual source to
push us past the acceptance threshold or warn us off.

If `genius_token` is empty in config, lookup_top_match returns None silently
and the caller treats this provider as unavailable.

Cached 14 days.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any

import httpx

from utils import config as cfg

from .cache import TTL_GENIUS, cached_fetch, make_cache_key

logger = logging.getLogger(__name__)

_API = "https://api.genius.com"


def _norm(text: str | None) -> str:
    text = str(text or "")
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


async def _api_get(path: str, params: dict | None = None) -> dict | None:
    token = cfg.get("genius_token", "")
    if not token:
        return None
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{_API}{path}",
                params=params or {},
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as exc:
        logger.debug("Genius request failed %s: %s", path, exc)
        return None
    if resp.status_code != 200:
        logger.debug("Genius %s returned %s", path, resp.status_code)
        return None
    try:
        return resp.json()
    except ValueError:
        return None


async def lookup_top_match(artist: str | None, title: str | None) -> dict | None:
    """
    Search Genius for "{artist} {title}" and return the top hit normalized to:
        {
            "artist": str,
            "title": str,
            "url": str,
            "thumbnail": str | None,
            "match_strength": float,   # 0.0-1.0 — how well it matches the query
        }
    or None if Genius has nothing relevant or the token isn't configured.
    """
    if not title:
        return None
    if not cfg.get("genius_token", ""):
        return None

    query_parts = []
    if artist:
        query_parts.append(artist.strip())
    query_parts.append(title.strip())
    q = " ".join(query_parts)
    key = make_cache_key("search", q)

    async def _fetch() -> dict | None:
        data = await _api_get("/search", {"q": q})
        hits = ((data or {}).get("response") or {}).get("hits") or []
        if not hits:
            return None
        first = (hits[0] or {}).get("result") or {}
        primary_artist = (first.get("primary_artist") or {}).get("name", "")
        result_title = first.get("title") or ""

        title_norm = _norm(title)
        result_title_norm = _norm(result_title)
        title_match = 0.0
        if title_norm and result_title_norm:
            if title_norm == result_title_norm:
                title_match = 1.0
            elif title_norm in result_title_norm or result_title_norm in title_norm:
                title_match = 0.85

        artist_match = 0.0
        if artist:
            artist_norm = _norm(artist)
            primary_norm = _norm(primary_artist)
            if artist_norm and primary_norm:
                if artist_norm == primary_norm:
                    artist_match = 1.0
                elif artist_norm in primary_norm or primary_norm in artist_norm:
                    artist_match = 0.85

        match_strength = title_match * 0.65 + artist_match * 0.35 if artist else title_match * 0.7
        return {
            "artist": primary_artist,
            "title": result_title,
            "url": first.get("url"),
            "thumbnail": first.get("song_art_image_url") or first.get("header_image_url"),
            "match_strength": round(match_strength, 3),
        }

    return await cached_fetch("genius", key, TTL_GENIUS, _fetch)
