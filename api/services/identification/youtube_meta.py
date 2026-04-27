"""
YouTube description / chapters parser.

Extracts identification hints from the metadata of the source video. Many
videos that AcoustID/Shazam can't recognize (live performances, mixtapes,
indie label uploads) have the artist/title spelled out in the description,
or have an explicit chapter list with timestamps. We mine that.

Hints produced (any may be None):
- artist, title:    parsed from a leading "Artist - Title" line or `♪ Artist — Title`
- spotify_track_id: pulled from `open.spotify.com/track/<id>` URLs
- isrc:             pulled from a literal `ISRC: XX-XXX-NN-NNNNN` line
- mb_recording_id:  pulled from `musicbrainz.org/recording/<uuid>` URLs
- chapters:         list of {start_seconds, title} extracted from `0:00 Title` / `00:00 - Title`
                    timestamps in description text. Useful for mixtape ingest.

Cached 30 days per youtube_id.
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import re
import subprocess
from typing import Any

from .cache import TTL_YOUTUBE, cached_fetch, make_cache_key

logger = logging.getLogger(__name__)

_SPOTIFY_RE = re.compile(r"open\.spotify\.com/(?:intl-[a-z]{2}/)?track/([A-Za-z0-9]{22})")
_MB_RE = re.compile(r"musicbrainz\.org/recording/([0-9a-f-]{36})", re.IGNORECASE)
_ISRC_RE = re.compile(r"\bISRC[:\s]+([A-Z]{2}[A-Z0-9]{3}\d{7})\b", re.IGNORECASE)
_TIMESTAMP_RE = re.compile(
    r"^(?:\d+\.?\s*)?\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*[\-–—:]?\s*(.+?)\s*$",
    re.MULTILINE,
)
# A leading "Artist - Title" or "Artist — Title" or "♪ Artist - Title"
_LEADING_PAIR_RE = re.compile(
    r"^[\s♪♫]*([^\n\-–—|:]{2,80})\s*[\-–—|:]\s*([^\n]{2,120})$",
    re.MULTILINE,
)

# Phrases the uploader uses to label what's playing — "Track:", "Song:", "Title:".
_LABELED_TITLE_RE = re.compile(
    r"^(?:track|song|title|música|musica|cançao|canção|titulo|título)\s*[:\-–—]\s*(.+)$",
    re.IGNORECASE | re.MULTILINE,
)
_LABELED_ARTIST_RE = re.compile(
    r"^(?:artist|artista|by|por)\s*[:\-–—]\s*(.+)$",
    re.IGNORECASE | re.MULTILINE,
)
_TITLE_SPLIT_RE = re.compile(r"\s+[-\u2010\u2011\u2012\u2013\u2014\u2212]+\s+|\s+\|\s+")
_BRACKET_NOISE_RE = re.compile(
    r"\s*[\(\[][^)\]]*?(?:official|video|videoclipe?|clip|lyrics?|audio|visualizer|"
    r"remix|slowed|reverb|sped\s*up|speed\s*up|nightcore|instrumental|acoustic|live|"
    r"demo|alt(?:ernative)?\s*version|edit|remaster(?:ed)?|explicit|clean|hd|hq|4k|og\s*bear)"
    r"[^)\]]*?[\)\]]\s*",
    re.IGNORECASE,
)
# Featuring brackets ALWAYS get stripped — Discogs/Spotify canonical titles
# never include them. Matches "(feat. X)", "[ft. X]", "(with X)", "(w/ X)".
_FEATURE_NOISE_RE = re.compile(
    r"\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring|with|w/)\s+[^)\]]+[\)\]]\s*",
    re.IGNORECASE,
)
# Version/edit/mix descriptors that aren't on the canonical release
# (e.g. "[Mixed Version]", "(Studio Version)", "[Bootleg]", "(Mashup)").
_VERSION_NOISE_RE = re.compile(
    r"\s*[\(\[][^)\]]*?\b(?:bootleg|mashup|mixed|extended|short|long|"
    r"radio|studio|club|dirty|original|main|"
    r"vip|hard|soft|deep|tech)\b\s*"
    r"(?:version|edit|mix|cut|rework)?[^)\]]*?[\)\]]\s*",
    re.IGNORECASE,
)
_TRAILING_NOISE_RE = re.compile(
    r"\s*(?:[-\u2010\u2011\u2012\u2013\u2014\u2212|:]\s*)?"
    r"(?:official\s*)?(?:music\s*)?(?:video|videoclipe?|clip|lyrics?|lyric\s*video|audio|visualizer)"
    r"(?:\s*(?:hd|hq|4k))?\s*$",
    re.IGNORECASE,
)
_PIPE_CHANNEL_NOISE_RE = re.compile(
    r"\s+\|\s+.*?(?:official|records?|music|tv|channel|og\s*bear|lyrics?|video|audio).*$",
    re.IGNORECASE,
)
_FEAT_NORMALIZE_RE = re.compile(r"\b(?:feat\.?|ft\.?|featuring)\b", re.IGNORECASE)

_GENERIC_CHANNEL_PARTS = {
    "topic", "official", "official audio", "official video", "records", "recordings",
    "music", "channel", "vevo", "youtube", "yt",
}
_GENERIC_TITLE_PARTS = {
    "official video", "official audio", "music video", "audio", "video",
    "lyrics", "lyric video", "visualizer", "original mix", "unknown",
}


def _parse_timestamp(text: str) -> int | None:
    parts = text.split(":")
    if not all(p.isdigit() for p in parts):
        return None
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + int(part)
    return seconds


def _extract_chapters(description: str) -> list[dict]:
    chapters: list[dict] = []
    for match in _TIMESTAMP_RE.finditer(description or ""):
        ts_text, title = match.group(1), match.group(2).strip(" -–—|:.")
        seconds = _parse_timestamp(ts_text)
        if seconds is None or not title:
            continue
        if len(title) < 2 or len(title) > 200:
            continue
        chapters.append({"start_seconds": seconds, "title": title})
    if len(chapters) < 2:
        return []
    chapters.sort(key=lambda c: c["start_seconds"])
    seen_starts = set()
    deduped = []
    for c in chapters:
        if c["start_seconds"] in seen_starts:
            continue
        seen_starts.add(c["start_seconds"])
        deduped.append(c)
    return deduped


def _extract_leading_pair(description: str) -> tuple[str | None, str | None]:
    if not description:
        return None, None
    for line in description.splitlines()[:6]:
        line = line.strip()
        if not line or line.startswith(("http", "www.", "#", "@")):
            continue
        m = _LEADING_PAIR_RE.match(line)
        if m:
            artist, title = m.group(1).strip(), m.group(2).strip()
            if (
                len(artist) >= 2 and len(title) >= 2
                and not artist.lower().startswith(("subscribe", "follow", "like", "stream"))
                and not title.lower().startswith(("subscribe", "follow", "like", "stream"))
            ):
                return artist, title
    return None, None


def _extract_labeled(description: str) -> tuple[str | None, str | None]:
    artist = None
    title = None
    m_artist = _LABELED_ARTIST_RE.search(description or "")
    if m_artist:
        artist = m_artist.group(1).strip()[:120] or None
    m_title = _LABELED_TITLE_RE.search(description or "")
    if m_title:
        title = m_title.group(1).strip()[:120] or None
    return artist, title


def _squash(text: str | None) -> str:
    text = html.unescape(str(text or "")).replace("_", " ")
    return re.sub(r"\s+", " ", text).strip(" -|:")


def _clean_youtube_piece(text: str | None) -> str | None:
    text = _squash(text)
    if not text:
        return None
    text = _PIPE_CHANNEL_NOISE_RE.sub("", text)
    prev = None
    while prev != text:
        prev = text
        text = _FEATURE_NOISE_RE.sub(" ", text)
        text = _BRACKET_NOISE_RE.sub(" ", text)
        text = _VERSION_NOISE_RE.sub(" ", text)
        text = _TRAILING_NOISE_RE.sub("", text)
    text = _FEAT_NORMALIZE_RE.sub("feat.", text)
    text = _squash(text)
    return text or None


def _is_generic_piece(text: str | None, *, channel: bool = False) -> bool:
    norm = re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()
    if not norm:
        return True
    if channel and (norm in _GENERIC_CHANNEL_PARTS or norm.endswith(" topic")):
        return True
    return norm in _GENERIC_TITLE_PARTS


def parse_video_title(video_title: str | None, channel: str | None = None) -> dict:
    """
    Parse the original YouTube title into an artist/title hint.

    This is a hint, not final identity. It preserves `raw_title` and strips
    upload noise such as "Official Video", "Slowed + Reverb", "Instrumental",
    and channel tags after pipes. The common "Artist - Song" form gets higher
    confidence than a bare title plus channel.
    """
    raw = _squash(video_title)
    hint = {
        "artist": None,
        "title": None,
        "raw_title": raw or None,
        "channel": _squash(channel) or None,
        "confidence": 0.0,
    }
    if not raw:
        return hint

    without_noise = _clean_youtube_piece(raw) or raw
    parts = _TITLE_SPLIT_RE.split(without_noise, maxsplit=1)
    if len(parts) == 2:
        artist = _clean_youtube_piece(parts[0])
        title = _clean_youtube_piece(parts[1])
        if artist and title and not _is_generic_piece(artist, channel=True) and not _is_generic_piece(title):
            hint.update({"artist": artist, "title": title, "confidence": 0.78})
            return hint

    title = _clean_youtube_piece(without_noise)
    channel_name = _clean_youtube_piece(channel)
    if title and not _is_generic_piece(title):
        hint["title"] = title
        hint["confidence"] = 0.48
        if channel_name and not _is_generic_piece(channel_name, channel=True):
            hint["artist"] = channel_name
            hint["confidence"] = 0.58
    return hint


def parse_description(description: str | None, video_title: str | None = None) -> dict:
    """
    Extract hints from raw description text. Returns flat dict; missing fields None.
    `video_title` is used as a fallback for splitting "Artist - Title" patterns.
    """
    hint: dict = {
        "artist": None,
        "title": None,
        "spotify_track_id": None,
        "mb_recording_id": None,
        "isrc": None,
        "chapters": [],
    }
    description = description or ""

    artist, title = _extract_leading_pair(description)
    if not artist or not title:
        labeled_artist, labeled_title = _extract_labeled(description)
        artist = artist or labeled_artist
        title = title or labeled_title
    if (not artist or not title) and video_title:
        from_title = parse_video_title(video_title)
        artist = artist or from_title.get("artist")
        title = title or from_title.get("title")
    hint["artist"] = artist
    hint["title"] = title

    spotify_match = _SPOTIFY_RE.search(description)
    if spotify_match:
        hint["spotify_track_id"] = spotify_match.group(1)

    mb_match = _MB_RE.search(description)
    if mb_match:
        hint["mb_recording_id"] = mb_match.group(1).lower()

    isrc_match = _ISRC_RE.search(description)
    if isrc_match:
        hint["isrc"] = isrc_match.group(1).upper().replace("-", "")

    hint["chapters"] = _extract_chapters(description)

    return hint


def _fetch_video_info_blocking(youtube_id: str) -> dict | None:
    """Synchronous subprocess call — must be wrapped in to_thread."""
    cmd = [
        "yt-dlp", "--dump-json", "--no-download",
        "--no-call-home", "--skip-download", "--no-warnings",
        f"https://www.youtube.com/watch?v={youtube_id}",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.debug("yt-dlp metadata fetch failed for %s: %s", youtube_id, exc)
        return None
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout.strip())
    except json.JSONDecodeError:
        return None
    return {
        "id": data.get("id", youtube_id),
        "title": data.get("title"),
        "description": data.get("description"),
        "channel": data.get("channel") or data.get("uploader"),
        "duration": data.get("duration"),
        "tags": data.get("tags") or [],
        "categories": data.get("categories") or [],
    }


async def fetch_video_info(youtube_id: str) -> dict | None:
    """Cached fetch of full video metadata (including description and tags)."""
    if not youtube_id:
        return None
    key = make_cache_key("video", youtube_id)

    async def _fetch() -> dict | None:
        return await asyncio.to_thread(_fetch_video_info_blocking, youtube_id)

    return await cached_fetch("youtube", key, TTL_YOUTUBE, _fetch)


async def parse_for_youtube_id(youtube_id: str) -> dict:
    """
    Convenience wrapper: fetch + parse for a single video. Returns the parse_description
    shape augmented with `channel` and `video_title` for downstream use.
    """
    info = await fetch_video_info(youtube_id)
    if not info:
        return {**parse_description(""), "channel": None, "video_title": None}
    hint = parse_description(info.get("description"), info.get("title"))
    hint["channel"] = info.get("channel")
    hint["video_title"] = info.get("title")
    return hint
