"""
MusicBrainz + Cover Art Archive providers.

MusicBrainz is reached either by recording MBID (we usually get this from
AcoustID or from local Picard tags) or by ISRC. Both endpoints return the same
recording shape, which we normalize into a flat dict.

Cover Art Archive is queried per release-group (not release) so we get the
canonical front cover regardless of regional pressings. CAA may 404; we treat
that as "no cover" silently.

Rate limit: MusicBrainz allows 1 req/sec per User-Agent for anonymous use;
the cache (90% hit rate after warm-up) plus the small budget per file keeps us
well under that. We do NOT add an artificial sleep — the system never floods.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from utils import config as cfg

from .cache import (
    TTL_COVERART,
    TTL_MUSICBRAINZ,
    cached_fetch,
    make_cache_key,
)

logger = logging.getLogger(__name__)

_MB_BASE = "https://musicbrainz.org/ws/2"
_CAA_BASE = "https://coverartarchive.org"
_RECORDING_INC = "artist-credits+releases+release-groups+isrcs+genres+tags"


def _ua() -> str:
    return cfg.get(
        "musicbrainz_user_agent",
        "Rolfsound/1.0 ( https://github.com/lucksducks/rolfsound )",
    )


def _headers() -> dict[str, str]:
    return {"User-Agent": _ua(), "Accept": "application/json"}


async def _mb_get(client: httpx.AsyncClient, path: str, params: dict | None = None) -> dict | None:
    try:
        resp = await client.get(f"{_MB_BASE}{path}", params=params or {}, headers=_headers())
    except httpx.HTTPError as exc:
        logger.debug("MB request failed %s: %s", path, exc)
        return None
    if resp.status_code == 503:
        logger.warning("MB rate-limited on %s", path)
        return None
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        logger.debug("MB %s returned %s", path, resp.status_code)
        return None
    try:
        return resp.json()
    except ValueError:
        return None


def _normalize_recording(data: dict) -> dict:
    if not data:
        return {}

    artist_credits = data.get("artist-credit") or []
    artist_names: list[str] = []
    artist_ids: list[str] = []
    for credit in artist_credits:
        if not isinstance(credit, dict):
            continue
        name = credit.get("name") or (credit.get("artist") or {}).get("name")
        if name:
            artist_names.append(name)
        artist_id = (credit.get("artist") or {}).get("id")
        if artist_id:
            artist_ids.append(artist_id)

    releases = data.get("releases") or []
    release_groups: list[dict] = []
    earliest_year: int | None = None
    label_names: list[str] = []
    barcodes: list[str] = []
    for rel in releases:
        if not isinstance(rel, dict):
            continue
        rg = rel.get("release-group") or {}
        if rg.get("id"):
            release_groups.append({
                "id": rg.get("id"),
                "title": rg.get("title"),
                "primary_type": rg.get("primary-type"),
                "first_release_date": rg.get("first-release-date"),
            })
        date = rel.get("date") or rg.get("first-release-date")
        if date and len(date) >= 4 and date[:4].isdigit():
            year = int(date[:4])
            if earliest_year is None or year < earliest_year:
                earliest_year = year
        for label_info in rel.get("label-info", []) or []:
            label = (label_info.get("label") or {}).get("name")
            if label:
                label_names.append(label)
        barcode = rel.get("barcode")
        if barcode:
            barcodes.append(barcode)

    seen_rg = set()
    deduped_rg = []
    for rg in release_groups:
        if rg["id"] in seen_rg:
            continue
        seen_rg.add(rg["id"])
        deduped_rg.append(rg)

    return {
        "mb_recording_id": data.get("id"),
        "title": data.get("title"),
        "artist": " & ".join(artist_names) if artist_names else None,
        "artist_names": artist_names,
        "artist_ids": list(dict.fromkeys(artist_ids)),
        "isrcs": list(data.get("isrcs") or []),
        "duration": (data.get("length") or 0) / 1000.0 if data.get("length") else None,
        "year": earliest_year,
        "release_groups": deduped_rg,
        "labels": list(dict.fromkeys(label_names)),
        "barcodes": list(dict.fromkeys(barcodes)),
        "tags": [t.get("name") for t in (data.get("tags") or []) if isinstance(t, dict) and t.get("name")],
        "genres": [g.get("name") for g in (data.get("genres") or []) if isinstance(g, dict) and g.get("name")],
    }


async def lookup_by_mbid(mb_recording_id: str) -> dict | None:
    """Look up a recording by MBID. Cached 30 days."""
    if not mb_recording_id:
        return None
    key = make_cache_key("recording", mb_recording_id)

    async def _fetch() -> dict | None:
        async with httpx.AsyncClient(timeout=10) as client:
            data = await _mb_get(
                client,
                f"/recording/{mb_recording_id}",
                params={"inc": _RECORDING_INC, "fmt": "json"},
            )
        return _normalize_recording(data) if data else None

    return await cached_fetch("musicbrainz", key, TTL_MUSICBRAINZ, _fetch)


async def lookup_by_isrc(isrc: str) -> dict | None:
    """
    Look up the first recording matching an ISRC. Cached 30 days.
    ISRC is a deterministic identifier — when present, this is the strongest
    single-source evidence we can have.
    """
    if not isrc:
        return None
    isrc = isrc.strip().upper().replace("-", "")
    if len(isrc) != 12:
        return None
    key = make_cache_key("isrc", isrc)

    async def _fetch() -> dict | None:
        async with httpx.AsyncClient(timeout=10) as client:
            data = await _mb_get(
                client,
                f"/isrc/{isrc}",
                params={"inc": _RECORDING_INC, "fmt": "json"},
            )
        if not data:
            return None
        recordings = data.get("recordings") or []
        if not recordings:
            return None
        return _normalize_recording(recordings[0])

    return await cached_fetch("musicbrainz", key, TTL_MUSICBRAINZ, _fetch)


async def coverart_for_release_group(release_group_id: str) -> str | None:
    """
    Return the URL of the front cover for a release group, or None.
    Cached 30 days. CAA returns 307 to a CDN URL — we resolve it once and
    store the resolved URL.
    """
    if not release_group_id:
        return None
    key = make_cache_key("rg_front", release_group_id)

    async def _fetch() -> str | None:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            try:
                resp = await client.get(
                    f"{_CAA_BASE}/release-group/{release_group_id}/front",
                    headers={"User-Agent": _ua()},
                )
            except httpx.HTTPError:
                return None
            if resp.status_code in (301, 302, 307, 308):
                location = resp.headers.get("location")
                return location or None
            if resp.status_code == 200:
                return f"{_CAA_BASE}/release-group/{release_group_id}/front"
            return None

    return await cached_fetch("coverart", key, TTL_COVERART, _fetch)


async def best_cover_from_recording(recording: dict | None) -> str | None:
    """
    Walk the release groups attached to a recording and return the first
    available CAA front cover. Stops at first hit — release groups are sorted
    by appearance order which usually puts the canonical album first.
    """
    if not recording:
        return None
    for rg in recording.get("release_groups") or []:
        rg_id = rg.get("id")
        if not rg_id:
            continue
        cover = await coverart_for_release_group(rg_id)
        if cover:
            return cover
    return None
