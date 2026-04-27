"""
Filename / folder structure parser.

Many libraries are organized as:
    /Music/<Artist>/<Album>/<NN> - <Title>.mp3
    /Downloads/<Artist> - <Title>.mp3
    /YT/<Channel>/<Title>.opus

This module produces a low-confidence Hint that downstream providers can use
to seed Discogs / MB / Spotify queries when fingerprinting fails. We never
populate identity directly from filename — too unreliable — but a hint is
strictly better than the bare title we'd otherwise have.
"""

from __future__ import annotations

import re
from pathlib import Path

# Common track-number prefixes: "01", "01.", "01 -", "01_", "(01)", "[01]"
_LEADING_TRACKNUM = re.compile(
    r"^\s*[\(\[]?\d{1,3}[\)\]]?[\.\-_\s]+"
)
_SPLIT = re.compile(r"\s+[-–—]+\s+")
_NOISE_TAIL = re.compile(
    r"\s*[\(\[][^)\]]*?(?:official|audio|video|lyrics?|hd|hq|4k|remaster(?:ed)?|"
    r"explicit|clean|radio edit)[^)\]]*?[\)\]]\s*$",
    re.IGNORECASE,
)
_EXT_NOISE = re.compile(r"\s*-\s*(?:official|audio|video|lyrics?).*$", re.IGNORECASE)
_UNDERSCORES = re.compile(r"[_]+")

# Album folders often have "Artist - Year - Album" or just "Album (Year)"
_FOLDER_YEAR = re.compile(r"\((\d{4})\)|\[(\d{4})\]|^(\d{4})\s*-")

_NOISE_FOLDERS = {
    "music", "musica", "downloads", "download", "audio", "songs",
    "tracks", "library", "biblioteca", "rolfsound", "yt", "youtube",
    "soulseek", "torrents", "albums", "singles", "compilations",
    "various artists", "va", "_unsorted", "unsorted", "new", "incoming",
}


def _clean_segment(text: str) -> str:
    text = _UNDERSCORES.sub(" ", text).strip()
    text = _LEADING_TRACKNUM.sub("", text)
    text = _NOISE_TAIL.sub("", text)
    text = _EXT_NOISE.sub("", text)
    return re.sub(r"\s+", " ", text).strip(" -|:")


def _looks_like_artist_folder(name: str) -> bool:
    if not name:
        return False
    norm = name.strip().lower()
    return norm not in _NOISE_FOLDERS and not norm.startswith(".")


def _extract_year(text: str) -> tuple[str, int | None]:
    m = _FOLDER_YEAR.search(text)
    if not m:
        return text, None
    year_str = next((g for g in m.groups() if g), None)
    if not year_str:
        return text, None
    cleaned = _FOLDER_YEAR.sub("", text).strip(" -[]()")
    try:
        return cleaned, int(year_str)
    except ValueError:
        return text, None


def parse_path_hint(file_path: str) -> dict:
    """
    Returns a hint dict; any field may be None.
        {
            "artist": str | None,
            "title": str | None,
            "album": str | None,
            "year": int | None,
            "track_number": int | None,
            "confidence": float,   # 0.0-1.0, how strongly we trust this
        }

    Confidence ranges:
        0.30 — only a title-like stem with no separator
        0.55 — "Artist - Title" stem, no folder context
        0.70 — folder structure adds artist/album corroboration
        0.80 — track number + parent album folder + grandparent artist folder
    """
    hint: dict = {
        "artist": None,
        "title": None,
        "album": None,
        "year": None,
        "track_number": None,
        "confidence": 0.0,
    }

    p = Path(file_path)
    stem = p.stem
    parent = p.parent.name if p.parent and p.parent.name else ""
    grandparent = p.parent.parent.name if p.parent and p.parent.parent and p.parent.parent.name else ""

    track_match = re.match(r"^\s*[\(\[]?(\d{1,3})[\)\]]?[\.\-_\s]+", stem)
    if track_match:
        try:
            hint["track_number"] = int(track_match.group(1))
        except ValueError:
            pass

    cleaned_stem = _clean_segment(stem)
    parts = _SPLIT.split(cleaned_stem, maxsplit=1)

    confidence = 0.0
    if len(parts) == 2:
        left, right = parts[0].strip(), parts[1].strip()
        if left and right:
            hint["artist"] = left
            hint["title"] = right
            confidence = 0.55
    elif cleaned_stem:
        hint["title"] = cleaned_stem
        confidence = 0.30

    if parent and _looks_like_artist_folder(parent):
        album_clean, album_year = _extract_year(parent)
        if album_clean:
            hint["album"] = _clean_segment(album_clean)
        if album_year and 1900 <= album_year <= 2100:
            hint["year"] = album_year
        if hint["title"]:
            confidence = max(confidence, 0.65)

    if grandparent and _looks_like_artist_folder(grandparent):
        if not hint["artist"]:
            hint["artist"] = _clean_segment(grandparent)
            if hint["title"]:
                confidence = max(confidence, 0.70)
        else:
            confidence = max(confidence, 0.75)

    if hint["track_number"] and hint["album"] and hint["artist"]:
        confidence = max(confidence, 0.80)

    hint["confidence"] = round(confidence, 2)
    return hint
