"""Canonical identity helpers for cross-provider track matching.

Provider display strings are noisy: one source may say
"Song (feat. Guest)" while another says "Song", and YouTube uploads often
append "Official Video", "Instrumental", "Slowed", etc. Matching should use
the base recording identity, while those suffixes become version metadata.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, asdict, field


VERSION_PRIORITY = {
    "REMIX": 80,
    "LIVE": 70,
    "DEMO": 60,
    "INSTRUMENTAL": 55,
    "RADIO_EDIT": 50,
    "ALT_VERSION": 40,
    "ORIGINAL_MIX": 0,
}

_FEAT_RE = re.compile(r"\b(?:feat\.?|ft\.?|featuring|with)\b\.?\s+([^)\]\-|,;]+)", re.IGNORECASE)
_ARTIST_FEAT_RE = re.compile(r"\s+(?:feat\.?|ft\.?|featuring|with)\s+.+$", re.IGNORECASE)
_ARTIST_SPLIT_RE = re.compile(r"\s*(?:,|;|\s+x\s+|\s+with\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+)\s+", re.IGNORECASE)
_BRACKET_RE = re.compile(r"[\(\[][^\)\]]+[\)\]]")
_TRAILING_NOISE_RE = re.compile(
    r"\s*(?:[-|:]\s*)?"
    r"(?:official\s*)?(?:music\s*)?(?:video|videoclipe?|clip|lyrics?|lyric\s*video|audio|visualizer)"
    r"(?:\s*(?:hd|hq|4k))?\s*$",
    re.IGNORECASE,
)
_YEAR_REMASTER_RE = re.compile(r"\b\d{4}\s+remaster(?:ed)?\b", re.IGNORECASE)

_VERSION_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("REMIX", re.compile(r"\b(remix|rework|edit mix|club mix|dub mix)\b", re.IGNORECASE)),
    ("LIVE", re.compile(r"\b(live|ao vivo|concert|session)\b", re.IGNORECASE)),
    ("DEMO", re.compile(r"\b(demo|rough|sketch)\b", re.IGNORECASE)),
    ("INSTRUMENTAL", re.compile(r"\b(instrumental|karaoke|acapella|a cappella)\b", re.IGNORECASE)),
    ("RADIO_EDIT", re.compile(r"\b(radio edit|single edit)\b", re.IGNORECASE)),
    (
        "ALT_VERSION",
        re.compile(
            r"\b(alt|alternate|alternative|version|take|unreleased|leak|"
            r"slowed|reverb|sped\s*up|speed\s*up|nightcore|acoustic)\b",
            re.IGNORECASE,
        ),
    ),
]
_DISPLAY_NOISE_RE = re.compile(
    r"\b(official|audio|video|videoclipe?|clip|lyrics?|lyric video|visuali[sz]er|"
    r"remaster(?:ed)?|explicit|uncensored|censored|clean|hd|hq|4k|topic|"
    r"provided to youtube)\b",
    re.IGNORECASE,
)
_STOP_WORDS = {"a", "an", "and", "the", "of", "to", "by", "de", "da", "do", "dos", "das", "e"}


@dataclass
class CanonicalIdentity:
    canonical_artist: str | None
    canonical_title: str | None
    artist_key: str
    title_key: str
    version_type: str = "ORIGINAL_MIX"
    featured_artists: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _squash(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip(" -|:[]()")


def _ascii_key(value: str | None) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower().replace("&", " and ").replace("$", "s")
    text = re.sub(r"\bf[\W_]*(?:u|[*x])[\W_]*(?:c|[*x])[\W_]*k\b", "fuck", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    tokens = [t for t in text.split() if t and t not in _STOP_WORDS]
    return " ".join(tokens)


def _version_type_from_text(*values: str | None) -> str:
    best = "ORIGINAL_MIX"
    for value in values:
        text = str(value or "")
        for version_type, pattern in _VERSION_PATTERNS:
            if pattern.search(text) and VERSION_PRIORITY[version_type] > VERSION_PRIORITY[best]:
                best = version_type
    return best


def _extract_featured(*values: str | None) -> list[str]:
    featured: list[str] = []
    for value in values:
        for match in _FEAT_RE.finditer(str(value or "")):
            candidate = _squash(match.group(1))
            if candidate:
                featured.append(candidate)
    return list(dict.fromkeys(featured))


def _clean_artist(value: str | None) -> str | None:
    text = _squash(value)
    if not text:
        return None
    text = re.sub(r"\s+-\s+topic$", "", text, flags=re.IGNORECASE)
    text = _ARTIST_FEAT_RE.sub("", text)
    parts = [p for p in _ARTIST_SPLIT_RE.split(text, maxsplit=1) if p.strip()]
    text = parts[0] if parts else text
    text = _DISPLAY_NOISE_RE.sub(" ", text)
    text = _squash(text)
    return text or None


def _clean_title(value: str | None) -> str | None:
    text = _squash(value)
    if not text:
        return None

    def bracket_repl(match: re.Match) -> str:
        chunk = match.group(0)
        if _FEAT_RE.search(chunk) or _version_type_from_text(chunk) != "ORIGINAL_MIX" or _DISPLAY_NOISE_RE.search(chunk):
            return " "
        return chunk

    text = _BRACKET_RE.sub(bracket_repl, text)
    text = _FEAT_RE.sub(" ", text)
    text = _YEAR_REMASTER_RE.sub(" ", text)
    for _version_type, pattern in _VERSION_PATTERNS:
        text = pattern.sub(" ", text)
    text = _TRAILING_NOISE_RE.sub(" ", text)
    text = _DISPLAY_NOISE_RE.sub(" ", text)
    text = re.sub(r"\s+[-|:]\s*$", " ", text)
    text = _squash(text)
    return text or None


def canonicalize(artist: str | None, title: str | None) -> CanonicalIdentity:
    canonical_artist = _clean_artist(artist)
    canonical_title = _clean_title(title)
    version_type = _version_type_from_text(artist, title)
    featured_artists = _extract_featured(artist, title)
    return CanonicalIdentity(
        canonical_artist=canonical_artist,
        canonical_title=canonical_title,
        artist_key=_ascii_key(canonical_artist),
        title_key=_ascii_key(canonical_title),
        version_type=version_type,
        featured_artists=featured_artists,
    )


def canonical_keys(artist: str | None, title: str | None) -> tuple[str, str]:
    ident = canonicalize(artist, title)
    return ident.artist_key, ident.title_key


def key_token_similarity(key_a: str | None, key_b: str | None) -> float:
    """Overlap score for already-normalized canonical keys."""
    tokens_a = {token for token in str(key_a or "").split() if token}
    tokens_b = {token for token in str(key_b or "").split() if token}
    if not tokens_a or not tokens_b:
        return 0.0
    if tokens_a == tokens_b:
        return 1.0
    overlap = len(tokens_a & tokens_b)
    if overlap == 0:
        return 0.0
    precision = overlap / len(tokens_a)
    recall = overlap / len(tokens_b)
    return round((2 * precision * recall) / (precision + recall), 4)


def identity_similarity(
    artist_a: str | None,
    title_a: str | None,
    artist_b: str | None,
    title_b: str | None,
) -> dict[str, float]:
    """Return title/artist/base similarity using canonicalized identity fields."""
    a = canonicalize(artist_a, title_a)
    b = canonicalize(artist_b, title_b)
    title_score = key_token_similarity(a.title_key, b.title_key)
    artist_score = key_token_similarity(a.artist_key, b.artist_key)
    if not a.artist_key or not b.artist_key:
        base_score = title_score
    else:
        base_score = (title_score * 0.72) + (artist_score * 0.28)
    return {
        "title": round(title_score, 4),
        "artist": round(artist_score, 4),
        "base": round(base_score, 4),
    }


def compatible_base_identity(
    artist_a: str | None,
    title_a: str | None,
    artist_b: str | None,
    title_b: str | None,
) -> bool:
    a_artist, a_title = canonical_keys(artist_a, title_a)
    b_artist, b_title = canonical_keys(artist_b, title_b)
    return bool(a_artist and a_title and a_artist == b_artist and a_title == b_title)
