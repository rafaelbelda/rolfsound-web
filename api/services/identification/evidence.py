"""
Evidence model — what each provider returns to the consensus engine.

A piece of evidence is a candidate identification with a confidence in [0, 1]
and a stated source. The consensus engine merges all evidences for one file
into a single best identity, optionally lifting confidence when independent
sources agree.

Key insight: evidence is *additive*, not replacing. A weak filename hint
(0.4) plus a weak Shazam result (0.5) plus a weak Discogs match (0.6) that
all agree on the same artist+title is stronger than any of them alone.

Provider priority (used as tiebreaker, not as gate):
    isrc_lookup        9   determinístico
    mb_by_id           8   AcoustID-derived MBID
    acoustid           7
    spotify_isrc       7
    shazam             6
    youtube_title      5   parsed original yt-dlp/search title
    spotify_fuzzy      5
    discogs            5
    mb_by_isrc         5
    existing_track_row 4   download/search metadata already stored on track
    youtube_meta       4
    local_tags         3   (text only — ISRC tags get promoted to isrc_lookup)
    genius             2   (validator, never a primary identifier)
    shazam_unverified  2   audio hit that only partially agrees with context
    filename           1   (hint only)
    shazam_conflict    0   diagnostic only; never drives identity
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

from .canonical import canonicalize, artist_identity_key

PROVIDER_PRIORITY: dict[str, int] = {
    "isrc_lookup": 9,
    "mb_by_id": 8,
    "acoustid": 7,
    "spotify_isrc": 7,
    "shazam": 6,
    "youtube_title": 5,
    "spotify_fuzzy": 5,
    "discogs": 5,
    "mb_by_isrc": 5,
    "existing_track_row": 4,
    "youtube_meta": 4,
    "local_tags": 3,
    "genius": 2,
    "shazam_unverified": 2,
    "filename": 1,
    "shazam_conflict": 0,
}


@dataclass
class Evidence:
    source: str
    confidence: float
    artist: str | None = None
    title: str | None = None
    year: int | None = None
    duration: float | None = None
    isrc: str | None = None
    mb_recording_id: str | None = None
    spotify_id: str | None = None
    discogs_id: int | None = None
    label: str | None = None
    cover_image: str | None = None
    display_artist: str | None = None
    primary_artist: dict | None = None
    artist_credits: list[dict] = field(default_factory=list)
    album: dict | None = None
    albums: list[dict] = field(default_factory=list)
    track_number: int | None = None
    disc_number: int | None = None
    canonical_artist: str | None = None
    canonical_title: str | None = None
    canonical_artist_key: str = ""
    canonical_title_key: str = ""
    version_type: str | None = None
    featured_artists: list[str] = field(default_factory=list)
    raw: dict = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.artist_credits = _normalize_credits(
            self.artist_credits,
            self.artist,
            self.title,
        )
        if not self.display_artist:
            self.display_artist = _display_from_credits(self.artist_credits) or self.artist
        if not self.primary_artist and self.artist_credits:
            first = next((c for c in self.artist_credits if c.get("is_primary")), self.artist_credits[0])
            self.primary_artist = {
                "name": first.get("name"),
                "id": first.get("id"),
                "mb_artist_id": first.get("mb_artist_id"),
                "spotify_id": first.get("spotify_id"),
                "discogs_id": first.get("discogs_id"),
            }
        identity_artist = (self.primary_artist or {}).get("name") or self.artist
        canonical = canonicalize(identity_artist, self.title)
        if not self.canonical_artist:
            self.canonical_artist = canonical.canonical_artist
        if not self.canonical_title:
            self.canonical_title = canonical.canonical_title
        if not self.canonical_artist_key:
            self.canonical_artist_key = canonical.artist_key
        if not self.canonical_title_key:
            self.canonical_title_key = canonical.title_key
        if not self.version_type:
            self.version_type = canonical.version_type
        if not self.featured_artists:
            self.featured_artists = canonical.featured_artists
        if self.album and not self.albums:
            self.albums = [self.album]
        elif self.albums and not self.album:
            self.album = self.albums[0]

    @property
    def priority(self) -> int:
        return PROVIDER_PRIORITY.get(self.source, 0)

    def to_dict(self) -> dict:
        return asdict(self)


def is_strong_id(evidence: Evidence) -> bool:
    """True if evidence carries a deterministic identifier worth locking on."""
    return bool(evidence.isrc or evidence.mb_recording_id or evidence.spotify_id)


def _as_credit(value, *, role: str = "main", position: int = 0, is_primary: bool = False) -> dict | None:
    if isinstance(value, str):
        name = value.strip()
        return {
            "name": name,
            "role": role,
            "position": position,
            "is_primary": is_primary,
        } if name else None
    if not isinstance(value, dict):
        return None
    name = (value.get("name") or value.get("artist") or "").strip()
    if not name:
        return None
    return {
        "id": value.get("id"),
        "name": name,
        "sort_name": value.get("sort_name") or value.get("sort-name"),
        "role": value.get("role") or role,
        "position": int(value.get("position") if value.get("position") is not None else position),
        "is_primary": bool(value.get("is_primary") if value.get("is_primary") is not None else is_primary),
        "join_phrase": value.get("join_phrase") or value.get("joinphrase") or value.get("joinphrase_") or "",
        "mb_artist_id": value.get("mb_artist_id"),
        "spotify_id": value.get("spotify_id"),
        "discogs_id": value.get("discogs_id"),
        "source": value.get("source"),
    }


def _normalize_credits(credits: list[dict] | None, artist: str | None, title: str | None) -> list[dict]:
    normalized: list[dict] = []
    for idx, raw in enumerate(credits or []):
        credit = _as_credit(raw, position=idx, is_primary=(idx == 0))
        if credit:
            normalized.append(credit)

    if not normalized and artist:
        canonical = canonicalize(artist, title)
        primary_name = canonical.canonical_artist or artist
        primary = _as_credit(primary_name, position=0, is_primary=True)
        if primary:
            normalized.append(primary)
        existing_keys = {artist_identity_key((c or {}).get("name")) for c in normalized}
        for feat_idx, name in enumerate(canonical.featured_artists, start=1):
            key = artist_identity_key(name)
            if key and key not in existing_keys:
                featured = _as_credit(name, role="featured", position=feat_idx, is_primary=False)
                if featured:
                    normalized.append(featured)
                    existing_keys.add(key)

    if normalized and not any(c.get("is_primary") for c in normalized):
        normalized[0]["is_primary"] = True
    return normalized


def _display_from_credits(credits: list[dict]) -> str | None:
    if not credits:
        return None
    parts: list[str] = []
    for idx, credit in enumerate(sorted(credits, key=lambda c: int(c.get("position") or 0))):
        name = credit.get("name")
        if not name:
            continue
        if idx > 0:
            prev = sorted(credits, key=lambda c: int(c.get("position") or 0))[idx - 1]
            parts.append(prev.get("join_phrase") or ", ")
        parts.append(name)
    return "".join(parts).strip() or None
