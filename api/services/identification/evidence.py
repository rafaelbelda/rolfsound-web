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

from .canonical import canonicalize

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
    canonical_artist: str | None = None
    canonical_title: str | None = None
    canonical_artist_key: str = ""
    canonical_title_key: str = ""
    version_type: str | None = None
    featured_artists: list[str] = field(default_factory=list)
    raw: dict = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        canonical = canonicalize(self.artist, self.title)
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

    @property
    def priority(self) -> int:
        return PROVIDER_PRIORITY.get(self.source, 0)

    def to_dict(self) -> dict:
        return asdict(self)


def is_strong_id(evidence: Evidence) -> bool:
    """True if evidence carries a deterministic identifier worth locking on."""
    return bool(evidence.isrc or evidence.mb_recording_id or evidence.spotify_id)
