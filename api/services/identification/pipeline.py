"""
Identification pipeline orchestrator.

Runs providers in order of cost vs. value, short-circuits when a strong
deterministic ID is confirmed by two sources, and feeds everything into
consensus.resolve() at the end.

Public entry point: `identify(file_path, track_id, hints)`.

Existing AcoustID + Discogs implementations live in api/services/indexer.py
and are imported here to avoid duplicating fingerprinting logic. Shazam
calls the new adaptive implementation in shazam.py.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .cache import TTL_ACOUSTID, cached_fetch, make_cache_key
from .canonical import identity_similarity
from .consensus import resolve as consensus_resolve
from .evidence import Evidence
from .filename import parse_path_hint
from .genius_search import lookup_top_match as genius_top_match
from .local_tags import extract_local_tags
from .musicbrainz import (
    best_cover_from_recording,
    lookup_by_isrc as mb_by_isrc,
    lookup_by_mbid as mb_by_mbid,
)
from .shazam import lookup_shazam
from .spotify import (
    lookup_by_isrc as sp_by_isrc,
    lookup_by_track_id as sp_by_track_id,
    lookup_fuzzy as sp_fuzzy,
)
from .youtube_meta import parse_for_youtube_id, parse_video_title

logger = logging.getLogger(__name__)


_DESCRIPTIVE_BRACKETS_RE = __import__("re").compile(
    r"[\(\[][^)\]]*?\b(?:live|acoustic|demo|unplugged|session|remix|rework|"
    r"rmx|edit|cover|orchestral|symphonic|piano|solo|jam)\b[^)\]]*?[\)\]]",
    __import__("re").IGNORECASE,
)


def _has_descriptive_brackets(text: str | None) -> bool:
    """True when text has brackets with words that often appear in canonical
    Discogs/Spotify titles (live recordings, acoustic versions, named remixes).
    Used to decide whether the 2-pass retry is worth the extra API call."""
    if not text:
        return False
    return bool(_DESCRIPTIVE_BRACKETS_RE.search(text))


def _channel_artist_mismatch(parsed: str | None, channel: str | None) -> bool:
    """True when the artist parsed from a 'Artist - Title' video title is
    clearly NOT the channel uploader (classic fan-upload case)."""
    if not parsed or not channel:
        return False
    from api.services.indexer import _text_score, _tokens
    if _text_score(parsed, channel) >= 0.55:
        return False
    pt, ct = _tokens(parsed), _tokens(channel)
    if not pt or not ct:
        return True
    return not (pt <= ct or ct <= pt)


_SHAZAM_CONTEXT_SOURCES = {
    "youtube_title",
    "youtube_meta",
    "local_tags",
    "existing_track_row",
    "filename",
    "acoustid",
    "mb_by_id",
    "mb_by_isrc",
    "spotify_isrc",
    "spotify_fuzzy",
    "discogs",
}
_STRONG_SHAZAM_CONTEXT_SOURCES = {
    "youtube_title",
    "youtube_meta",
    "local_tags",
    "acoustid",
    "mb_by_id",
    "mb_by_isrc",
    "spotify_isrc",
    "spotify_fuzzy",
    "discogs",
}
_GENERIC_CONTEXT_TITLE_KEYS = {
    "audio",
    "mix",
    "mp3",
    "music",
    "original",
    "original mix",
    "song",
    "track",
    "unknown",
    "untitled",
    "webm",
}


def _f(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _album_from_tags(tags: dict) -> dict | None:
    if not tags.get("album"):
        return None
    return {
        "title": tags.get("album"),
        "display_artist": tags.get("albumartist") or tags.get("artist"),
        "mb_release_id": tags.get("mb_release_id"),
        "mb_release_group_id": tags.get("mb_release_group_id"),
        "year": tags.get("year"),
        "cover": tags.get("thumbnail"),
        "source": "local_tags",
    }


def _credits_from_acoustid_recording(recording: dict | None) -> list[dict]:
    credits: list[dict] = []
    for idx, artist in enumerate((recording or {}).get("artists", []) or []):
        if not isinstance(artist, dict):
            continue
        name = artist.get("name")
        if not name:
            continue
        credits.append({
            "name": name,
            "mb_artist_id": artist.get("id"),
            "role": "main",
            "position": idx,
            "is_primary": idx == 0,
            "source": "acoustid",
        })
    return credits


def _seed_artist_from_result(result: dict) -> str | None:
    primary = result.get("primary_artist")
    if isinstance(primary, dict) and primary.get("name"):
        return primary.get("name")
    return result.get("canonical_artist") or result.get("display_artist") or result.get("artist")


async def _gather_local_evidence(
    file_path: str,
    track_id: str,
    hints: dict,
) -> tuple[list[Evidence], dict]:
    """Local tags + filename hint + (optional) YouTube description."""
    tags = await asyncio.to_thread(extract_local_tags, file_path, track_id)
    evidences: list[Evidence] = []

    if tags.get("title") or tags.get("artist") or tags.get("isrc") or tags.get("mb_recording_id"):
        confidence = 0.55
        if tags.get("isrc") or tags.get("mb_recording_id"):
            confidence = 0.78
        evidences.append(Evidence(
            source="local_tags",
            confidence=confidence,
            artist=tags.get("artist"),
            title=tags.get("title"),
            year=tags.get("year"),
            duration=tags.get("duration"),
            isrc=tags.get("isrc"),
            mb_recording_id=tags.get("mb_recording_id"),
            cover_image=tags.get("thumbnail"),
            label=tags.get("publisher"),
            album=_album_from_tags(tags),
            track_number=tags.get("track_number"),
            disc_number=tags.get("disc_number"),
            raw=tags,
            reasons=["mutagen_tags"],
        ))

    file_hint = parse_path_hint(file_path)
    if file_hint.get("title") or file_hint.get("artist"):
        evidences.append(Evidence(
            source="filename",
            confidence=float(file_hint.get("confidence") or 0.0),
            artist=file_hint.get("artist"),
            title=file_hint.get("title"),
            year=file_hint.get("year"),
            album={"title": file_hint.get("album"), "year": file_hint.get("year"), "source": "filename"} if file_hint.get("album") else None,
            track_number=file_hint.get("track_number"),
            raw=file_hint,
            reasons=["path_pattern"],
        ))

    if hints.get("existing_title") or hints.get("existing_artist"):
        existing_title = hints.get("existing_title")
        existing_artist = hints.get("existing_artist")
        existing_thumb = hints.get("existing_thumbnail")
        youtube_title = hints.get("youtube_title") or existing_title
        if hints.get("youtube_id") and youtube_title:
            yt_title = parse_video_title(youtube_title, existing_artist)
            if yt_title.get("title") or yt_title.get("artist"):
                base_conf = float(yt_title.get("confidence") or 0.0)
                # Boost when the parsed artist is clearly different from the
                # channel name (classic "real artist embedded in title" case),
                # so this evidence outweighs other weak hints in consensus.
                parsed_artist = yt_title.get("artist")
                if (
                    base_conf >= 0.78
                    and parsed_artist
                    and existing_artist
                    and _channel_artist_mismatch(parsed_artist, existing_artist)
                ):
                    base_conf = max(base_conf, 0.85)
                evidences.append(Evidence(
                    source="youtube_title",
                    confidence=base_conf,
                    artist=parsed_artist,
                    title=yt_title.get("title"),
                    year=hints.get("existing_year"),
                    cover_image=existing_thumb,
                    raw={**yt_title, "raw_youtube_title": youtube_title},
                    reasons=["yt_dlp_title"],
                ))
        # Skip existing_track_row for YouTube tracks: existing_artist is the
        # channel name, not the real artist. youtube_title evidence (above)
        # already covers the title hint without the poisoned artist field.
        if existing_title and (existing_artist or "").strip() and not hints.get("youtube_id"):
            evidences.append(Evidence(
                source="existing_track_row",
                confidence=0.45,
                artist=existing_artist,
                title=existing_title,
                year=hints.get("existing_year"),
                cover_image=existing_thumb,
                reasons=["existing_track_row"],
            ))

    youtube_id = hints.get("youtube_id")
    if youtube_id:
        yt = await parse_for_youtube_id(youtube_id)
        if yt and (yt.get("artist") or yt.get("title") or yt.get("isrc") or yt.get("spotify_track_id")):
            evidences.append(Evidence(
                source="youtube_meta",
                confidence=0.65 if (yt.get("artist") and yt.get("title")) else 0.45,
                artist=yt.get("artist"),
                title=yt.get("title"),
                isrc=yt.get("isrc"),
                spotify_id=yt.get("spotify_track_id"),
                mb_recording_id=yt.get("mb_recording_id"),
                raw=yt,
                reasons=["yt_description"],
            ))

    return evidences, tags


async def _isrc_lookups(isrc: str) -> list[Evidence]:
    """Fan out ISRC lookups to MB + Spotify in parallel. Strongest evidence."""
    if not isrc:
        return []
    mb_task = asyncio.create_task(mb_by_isrc(isrc))
    sp_task = asyncio.create_task(sp_by_isrc(isrc))
    mb_data, sp_data = await asyncio.gather(mb_task, sp_task)

    out: list[Evidence] = []
    if mb_data and mb_data.get("title"):
        logger.info("MusicBrainz: ISRC %s -> %s - %s", isrc, mb_data.get("artist"), mb_data.get("title"))
        cover = await best_cover_from_recording(mb_data)
        out.append(Evidence(
            source="mb_by_isrc",
            confidence=0.95,
            artist=mb_data.get("artist"),
            title=mb_data.get("title"),
            year=mb_data.get("year"),
            duration=mb_data.get("duration"),
            isrc=isrc,
            mb_recording_id=mb_data.get("mb_recording_id"),
            label=(mb_data.get("labels") or [None])[0],
            cover_image=cover,
            display_artist=mb_data.get("display_artist"),
            artist_credits=mb_data.get("artist_credits") or [],
            album=mb_data.get("album_data"),
            albums=mb_data.get("albums") or [],
            raw=mb_data,
            reasons=["isrc_match", "musicbrainz"],
        ))
    else:
        logger.info("MusicBrainz: no recording for ISRC %s", isrc)
    if sp_data and sp_data.get("title"):
        logger.info("Spotify: ISRC %s -> %s - %s", isrc, sp_data.get("artist"), sp_data.get("title"))
        out.append(Evidence(
            source="spotify_isrc",
            confidence=0.95,
            artist=sp_data.get("artist"),
            title=sp_data.get("title"),
            year=sp_data.get("year"),
            duration=sp_data.get("duration"),
            isrc=isrc,
            spotify_id=sp_data.get("spotify_id"),
            cover_image=sp_data.get("cover_image"),
            display_artist=sp_data.get("display_artist"),
            artist_credits=sp_data.get("artist_credits") or [],
            album=sp_data.get("album_data"),
            albums=sp_data.get("albums") or [],
            raw=sp_data,
            reasons=["isrc_match", "spotify"],
        ))
    else:
        logger.info("Spotify: no ISRC match for %s", isrc)
    return out


async def _acoustid_lookup(file_path: str) -> tuple[Evidence | None, dict | None, str | None]:
    """
    Run AcoustID + (cached) MB enrichment when an MBID is returned.
    Returns: (evidence_or_none, raw_acoustid_recording, raw_fingerprint).
    """
    from api.services import indexer  # late import to avoid cycle

    fp = await indexer.fingerprint(file_path)
    if not fp:
        return None, None, None

    raw_fp = fp.get("fingerprint")
    cache_key = make_cache_key("recording", raw_fp[:64] if raw_fp else "", int(fp.get("duration") or 0))

    async def _fetcher() -> dict | None:
        return await indexer.lookup_acoustid(fp)

    recording = await cached_fetch("acoustid", cache_key, TTL_ACOUSTID, _fetcher)
    if not recording:
        return None, None, raw_fp

    mb_recording_id = recording.get("id")
    artist_credits = _credits_from_acoustid_recording(recording)
    artist_name = ", ".join(c.get("name") for c in artist_credits if c.get("name")) or None
    title = recording.get("title")

    evidence = Evidence(
        source="acoustid",
        confidence=0.92,
        artist=artist_name,
        title=title,
        mb_recording_id=mb_recording_id,
        duration=fp.get("duration"),
        display_artist=artist_name,
        artist_credits=artist_credits,
        raw=recording,
        reasons=["chromaprint_match"],
    )
    return evidence, recording, raw_fp


async def _mb_enrichment(mbid: str) -> Evidence | None:
    if not mbid:
        return None
    data = await mb_by_mbid(mbid)
    if not data or not data.get("title"):
        return None
    cover = await best_cover_from_recording(data)
    return Evidence(
        source="mb_by_id",
        confidence=0.94,
        artist=data.get("artist"),
        title=data.get("title"),
        year=data.get("year"),
        duration=data.get("duration"),
        mb_recording_id=mbid,
        isrc=(data.get("isrcs") or [None])[0],
        label=(data.get("labels") or [None])[0],
        cover_image=cover,
        display_artist=data.get("display_artist"),
        artist_credits=data.get("artist_credits") or [],
        album=data.get("album_data"),
        albums=data.get("albums") or [],
        raw=data,
        reasons=["acoustid_mbid", "musicbrainz_enriched"],
    )


def _has_strong_consensus(evidences: list[Evidence]) -> bool:
    """True when two evidences already agree on a strong ID — skip extra calls."""
    seen: dict[tuple[str, str], int] = {}
    for ev in evidences:
        for kind, val in (("isrc", ev.isrc), ("mb", ev.mb_recording_id), ("spotify", ev.spotify_id)):
            if not val:
                continue
            seen[(kind, val)] = seen.get((kind, val), 0) + 1
            if seen[(kind, val)] >= 2:
                return True
    return False


def _finalize(evidences: list[Evidence], raw_fp: str | None = None) -> dict:
    result = consensus_resolve(evidences)
    result["raw_fp"] = raw_fp
    result["evidence"] = [ev.to_dict() for ev in evidences]
    return result


def _context_summary(ev: Evidence) -> dict:
    return {
        "source": ev.source,
        "confidence": ev.confidence,
        "artist": ev.artist,
        "title": ev.title,
        "canonical_artist": ev.canonical_artist,
        "canonical_title": ev.canonical_title,
    }


def _useful_shazam_contexts(evidences: list[Evidence]) -> list[Evidence]:
    contexts: list[Evidence] = []
    for ev in evidences:
        if not ev or ev.source not in _SHAZAM_CONTEXT_SOURCES:
            continue
        if ev.confidence < 0.40:
            continue
        if not ev.canonical_title_key or ev.canonical_title_key in _GENERIC_CONTEXT_TITLE_KEYS:
            continue
        contexts.append(ev)
    return contexts


def _shazam_evidence_from_result(
    sz: dict,
    *,
    source: str,
    confidence: float,
    reasons: list[str],
    raw_extra: dict | None = None,
) -> Evidence:
    raw = dict(sz)
    if raw_extra:
        raw.update(raw_extra)
    return Evidence(
        source=source,
        confidence=confidence,
        artist=sz.get("artist"),
        title=sz.get("title"),
        cover_image=sz.get("thumbnail") or None,
        raw=raw,
        reasons=reasons,
    )


def _guard_shazam_result(sz: dict, contexts: list[Evidence]) -> Evidence:
    candidate = _shazam_evidence_from_result(
        sz,
        source="shazam",
        confidence=0.90,
        reasons=["shazam_audio_match"],
    )
    if not contexts:
        return candidate

    scored: list[tuple[float, Evidence, dict[str, float]]] = []
    for ctx in contexts:
        scores = identity_similarity(candidate.artist, candidate.title, ctx.artist, ctx.title)
        scored.append((scores["base"], ctx, scores))

    best_base, best_context, best_scores = max(scored, key=lambda item: item[0])
    raw_extra = {
        "context_gate": {
            "best_context": _context_summary(best_context),
            "scores": best_scores,
        }
    }
    has_strong_context = any(
        ev.source in _STRONG_SHAZAM_CONTEXT_SOURCES or ev.confidence >= 0.70
        for ev in contexts
    )
    artist_known_on_both = bool(candidate.canonical_artist_key and best_context.canonical_artist_key)
    artist_ok = (
        not artist_known_on_both
        or best_scores["artist"] >= 0.35
    )
    long_exact_title = (
        best_scores["title"] >= 0.96
        and len((candidate.canonical_title_key or "").split()) >= 3
    )

    if best_scores["title"] >= 0.82 and (artist_ok or long_exact_title):
        candidate.raw.update(raw_extra)
        candidate.reasons.append("shazam_agrees_with_context")
        logger.info(
            "Shazam accepted after context gate: %s - %s agrees with %s",
            candidate.artist,
            candidate.title,
            best_context.source,
        )
        return candidate

    if has_strong_context and (best_scores["title"] < 0.45 or best_base < 0.50):
        logger.warning(
            "Shazam rejected by context gate: %s - %s conflicts with %s - %s (%s, scores=%s)",
            candidate.artist,
            candidate.title,
            best_context.artist,
            best_context.title,
            best_context.source,
            best_scores,
        )
        return _shazam_evidence_from_result(
            sz,
            source="shazam_conflict",
            confidence=0.05,
            reasons=["shazam_conflicts_with_text_context"],
            raw_extra=raw_extra,
        )

    logger.info(
        "Shazam downgraded by context gate: %s - %s partial context match with %s (scores=%s)",
        candidate.artist,
        candidate.title,
        best_context.source,
        best_scores,
    )
    return _shazam_evidence_from_result(
        sz,
        source="shazam_unverified",
        confidence=0.55,
        reasons=["shazam_audio_match", "shazam_partial_context_match"],
        raw_extra=raw_extra,
    )


async def _shazam_evidence(file_path: str, contexts: list[Evidence] | None = None) -> Evidence | None:
    sz = await lookup_shazam(file_path)
    if not sz or not sz.get("title"):
        return None
    return _guard_shazam_result(sz, _useful_shazam_contexts(contexts or []))


async def _discogs_evidence(artist: str | None, title: str | None, year, duration) -> Evidence | None:
    """Wrap the existing lookup_discogs and add caching."""
    from api.services import indexer

    if not title:
        return None
    cache_key = make_cache_key("track", artist or "", title, year, int(duration or 0) // 5 * 5)

    async def _fetcher() -> dict | None:
        return await indexer.lookup_discogs(artist or "", title, year=year, duration=duration)

    discogs = await cached_fetch("discogs", cache_key, 14 * 86400, _fetcher)
    if not discogs:
        return None

    confidence = float(discogs.get("_rolfsound_confidence") or 0.0)
    track_title = discogs.get("_rolfsound_track_title") or discogs.get("title")
    artist_part = (discogs.get("title") or "").split(" - ")[0] if " - " in (discogs.get("title") or "") else None
    return Evidence(
        source="discogs",
        confidence=min(0.93, confidence),
        artist=discogs.get("_rolfsound_display_artist") or artist_part or artist,
        title=track_title,
        year=discogs.get("year"),
        discogs_id=discogs.get("id"),
        label=(discogs.get("label") or [None])[0] if isinstance(discogs.get("label"), list) else discogs.get("label"),
        cover_image=discogs.get("cover_image"),
        display_artist=discogs.get("_rolfsound_display_artist") or artist_part or artist,
        artist_credits=discogs.get("_rolfsound_artist_credits") or [],
        album=discogs.get("_rolfsound_album"),
        albums=[discogs.get("_rolfsound_album")] if discogs.get("_rolfsound_album") else [],
        raw=discogs,
        reasons=discogs.get("_rolfsound_reasons") or [],
    )


async def _discogs_evidence_two_pass(
    artist: str | None,
    title: str | None,
    fallback_title: str | None,
    year,
    duration,
) -> Evidence | None:
    """Try Discogs with the cleaned title first; if nothing comes back (or
    confidence is too low), retry with a less-cleaned fallback title that
    preserves descriptive brackets like '(Live at X)'."""
    primary = await _discogs_evidence(artist, title, year, duration)
    if primary and primary.confidence >= 0.84:
        return primary
    if fallback_title and fallback_title.strip().lower() != (title or "").strip().lower():
        retry = await _discogs_evidence(artist, fallback_title, year, duration)
        if retry and (not primary or retry.confidence > primary.confidence):
            return retry
    return primary


async def _spotify_fuzzy_evidence(artist, title, duration) -> Evidence | None:
    if not title:
        return None
    sp = await sp_fuzzy(artist, title, duration)
    if not sp or not sp.get("title"):
        logger.info("Spotify: no fuzzy match for artist=%r title=%r", artist, title)
        return None
    logger.info("Spotify: fuzzy match -> %s - %s", sp.get("artist"), sp.get("title"))
    return Evidence(
        source="spotify_fuzzy",
        confidence=0.78,
        artist=sp.get("artist"),
        title=sp.get("title"),
        year=sp.get("year"),
        duration=sp.get("duration"),
        spotify_id=sp.get("spotify_id"),
        isrc=sp.get("isrc"),
        cover_image=sp.get("cover_image"),
        display_artist=sp.get("display_artist"),
        artist_credits=sp.get("artist_credits") or [],
        album=sp.get("album_data"),
        albums=sp.get("albums") or [],
        raw=sp,
        reasons=["spotify_fuzzy_search"],
    )


async def _spotify_fuzzy_two_pass(
    artist,
    title,
    fallback_title,
    duration,
) -> Evidence | None:
    """Same 2-pass strategy as _discogs_evidence_two_pass for Spotify."""
    primary = await _spotify_fuzzy_evidence(artist, title, duration)
    if primary and primary.confidence >= 0.78 and primary.spotify_id:
        return primary
    if fallback_title and fallback_title.strip().lower() != (title or "").strip().lower():
        retry = await _spotify_fuzzy_evidence(artist, fallback_title, duration)
        if retry and (not primary or retry.confidence >= (primary.confidence if primary else 0)):
            return retry
    return primary


async def _genius_evidence(artist, title) -> Evidence | None:
    if not title:
        return None
    g = await genius_top_match(artist, title)
    if not g:
        logger.info("Genius: no text match for artist=%r title=%r", artist, title)
        return None
    strength = float(g.get("match_strength") or 0.0)
    if strength < 0.55:
        logger.info("Genius: weak text match %.2f for artist=%r title=%r", strength, artist, title)
        return None
    logger.info("Genius: text match -> %s - %s", g.get("artist"), g.get("title"))
    return Evidence(
        source="genius",
        confidence=min(0.78, 0.40 + strength * 0.40),
        artist=g.get("artist"),
        title=g.get("title"),
        cover_image=g.get("thumbnail"),
        raw=g,
        reasons=["genius_text_match"],
    )


async def identify(
    file_path: str,
    track_id: str,
    *,
    hints: dict | None = None,
) -> dict:
    """
    Run the full identification pipeline. `hints` may carry:
        youtube_id:  the YouTube video ID this asset was sourced from
        existing_*:  fields from the current track row to use as fallbacks

    Returns a dict consumable by indexer.index_asset (status + identity fields
    + cover, plus diagnostic 'sources' / 'reasons' / 'confidence').
    """
    hints = hints or {}
    evidences, tags = await _gather_local_evidence(file_path, track_id, hints)

    isrc_candidates = {
        ev.isrc for ev in evidences if ev.isrc
    }
    if isrc_candidates:
        for isrc in list(isrc_candidates)[:2]:
            evidences.extend(await _isrc_lookups(isrc))

    yt_spotify_id = next((ev.spotify_id for ev in evidences if ev.source == "youtube_meta" and ev.spotify_id), None)
    if yt_spotify_id:
        sp = await sp_by_track_id(yt_spotify_id)
        if sp:
            evidences.append(Evidence(
                source="spotify_isrc",
                confidence=0.95,
                artist=sp.get("artist"),
                title=sp.get("title"),
                year=sp.get("year"),
                duration=sp.get("duration"),
                spotify_id=sp.get("spotify_id"),
                isrc=sp.get("isrc"),
                cover_image=sp.get("cover_image"),
                display_artist=sp.get("display_artist"),
                artist_credits=sp.get("artist_credits") or [],
                album=sp.get("album_data"),
                albums=sp.get("albums") or [],
                raw=sp,
                reasons=["spotify_track_url_in_yt_desc"],
            ))

    if _has_strong_consensus(evidences):
        return _finalize(evidences)

    raw_fp: str | None = None
    if not _has_strong_consensus(evidences):
        ac_evidence, ac_raw, raw_fp = await _acoustid_lookup(file_path)
        if ac_evidence:
            evidences.append(ac_evidence)
            if ac_evidence.mb_recording_id:
                mb_ev = await _mb_enrichment(ac_evidence.mb_recording_id)
                if mb_ev:
                    evidences.append(mb_ev)
                    if mb_ev.isrc and mb_ev.isrc not in isrc_candidates:
                        evidences.extend(await _isrc_lookups(mb_ev.isrc))

    if not _has_strong_consensus(evidences):
        sz_ev = await _shazam_evidence(file_path, evidences)
        if sz_ev:
            evidences.append(sz_ev)

    # P9: Downweight filename/existing_track_row evidence that shares the title
    # but has a completely different artist than a Shazam audio result — the
    # characteristic signature of a YouTube channel name being used as artist.
    _sz_for_check = next(
        (ev for ev in evidences if ev.source in ("shazam", "shazam_unverified") and ev.confidence >= 0.55),
        None,
    )
    if _sz_for_check:
        for _ev in evidences:
            if _ev.source not in ("filename", "existing_track_row") or not _ev.canonical_artist_key:
                continue
            _sim = identity_similarity(_sz_for_check.artist, _sz_for_check.title, _ev.artist, _ev.title)
            if _sim["title"] >= 0.70 and _sim["artist"] < 0.20:
                _ev.confidence = round(_ev.confidence * 0.3, 4)
                _ev.reasons.append("downweighted_by_audio_conflict")

    # Seed selection for Discogs/Spotify queries.
    # Run a provisional consensus first; if the gathered evidence already agrees
    # on an identity with confidence ≥ 0.50 AND the winning cluster contains at
    # least one reliable (non-filename, non-existing_track_row) source, use that
    # as the seed. This avoids single-source heuristic evidence (e.g. a temp-dir
    # name parsed as artist) from poisoning the search queries.
    _RELIABLE_SEED_SOURCES = {
        "acoustid", "mb_by_id", "mb_by_isrc", "shazam", "shazam_unverified",
        "spotify_isrc", "spotify_fuzzy", "discogs", "youtube_title", "local_tags",
        "isrc_lookup",
    }
    _provisional = consensus_resolve(evidences)
    _provisional_reliable = bool(set(_provisional.get("sources", [])) & _RELIABLE_SEED_SOURCES)
    yt_title_ev = next(
        (ev for ev in evidences if ev.source == "youtube_title" and ev.confidence >= 0.78 and ev.artist and ev.title),
        None,
    )
    if (_provisional.get("artist") and _provisional.get("title")
            and _provisional.get("confidence", 0) >= 0.50
            and _provisional_reliable):
        seed_artist = _seed_artist_from_result(_provisional)
        seed_title = _provisional["title"]
    else:
        shazam_ev = next(
            (ev for ev in evidences if ev.source in ("shazam", "shazam_unverified") and ev.artist and ev.title),
            None,
        )
        if shazam_ev:
            seed_artist = shazam_ev.canonical_artist or shazam_ev.artist
            seed_title = shazam_ev.canonical_title or shazam_ev.title
        elif yt_title_ev:
            seed_artist = yt_title_ev.canonical_artist or yt_title_ev.artist
            seed_title = yt_title_ev.canonical_title or yt_title_ev.title
        else:
            seed_artist = next(
                (ev.canonical_artist or ev.artist for ev in sorted(evidences, key=lambda e: -e.priority) if ev.canonical_artist or ev.artist),
                None,
            )
            seed_title = next(
                (ev.canonical_title or ev.title for ev in sorted(evidences, key=lambda e: -e.priority) if ev.canonical_title or ev.title),
                None,
            )

    # Late safety net: if the seed pair still looks like "channel + 'Real Artist - Title'"
    # (e.g. yt_title_ev was missing or weak), apply the recovery before querying.
    if seed_artist and seed_title:
        from api.services.indexer import _recover_artist_from_yt_title
        seed_artist, seed_title = _recover_artist_from_yt_title(seed_artist, seed_title)

    seed_year = next((ev.year for ev in sorted(evidences, key=lambda e: -e.priority) if ev.year), None)
    seed_duration = tags.get("duration") or next((ev.duration for ev in evidences if ev.duration), None)

    # Pass-2 fallback title for Discogs/Spotify retry: the raw youtube title with
    # only the "Artist - " prefix removed (so brackets like "(Live at X)" survive).
    # Only enabled when the raw brackets contain DESCRIPTIVE keywords that may
    # be part of canonical titles — never for noise like "(Official Video)".
    fallback_title: str | None = None
    if yt_title_ev:
        raw_yt = (yt_title_ev.raw or {}).get("raw_youtube_title")
        if raw_yt and " - " in raw_yt:
            candidate = raw_yt.split(" - ", 1)[1].strip()
            if _has_descriptive_brackets(candidate):
                fallback_title = candidate

    if seed_title:
        dg_ev = await _discogs_evidence_two_pass(seed_artist, seed_title, fallback_title, seed_year, seed_duration)
        if dg_ev:
            evidences.append(dg_ev)
        sp_ev = await _spotify_fuzzy_two_pass(seed_artist, seed_title, fallback_title, seed_duration)
        if sp_ev:
            evidences.append(sp_ev)
            if sp_ev.isrc and sp_ev.isrc not in isrc_candidates:
                isrc_candidates.add(sp_ev.isrc)
                evidences.extend(await _isrc_lookups(sp_ev.isrc))

    # P6: Re-evaluate any shazam_unverified against updated contexts (Discogs/Spotify
    # are now in evidences). If the new high-confidence evidence validates what was
    # previously only partially confirmed, promote it to full shazam. Only promote,
    # never downgrade — avoids bouncing.
    _sz_unverified = next(
        (ev for ev in evidences if ev.source == "shazam_unverified" and ev.raw),
        None,
    )
    if _sz_unverified:
        _updated_contexts = _useful_shazam_contexts(evidences)
        _re_guarded = _guard_shazam_result(_sz_unverified.raw, _updated_contexts)
        if _re_guarded.source == "shazam":
            evidences.remove(_sz_unverified)
            evidences.append(_re_guarded)
            logger.info(
                "Shazam promoted from shazam_unverified after second guard pass: %s - %s",
                _re_guarded.artist,
                _re_guarded.title,
            )

    interim = consensus_resolve(evidences)
    if interim["status"] == "low_confidence" and interim.get("title"):
        gn = await _genius_evidence(interim.get("artist"), interim.get("title"))
        if gn:
            evidences.append(gn)
            interim = consensus_resolve(evidences)

    interim["raw_fp"] = raw_fp
    interim["evidence"] = [ev.to_dict() for ev in evidences]
    return interim
