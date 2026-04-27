"""
Combine multiple Evidence rows into a single resolved identity.

Resolution rules:
1. If two or more evidences agree on a strong ID (ISRC, MBID, Spotify ID),
   the highest-priority one wins outright with confidence ≥ 0.95.
2. If a single evidence has a strong ID with priority ≥ 8, it stands alone.
3. Otherwise: cluster evidences by normalized (artist, title) and pick the
   cluster with the highest *combined* confidence, where combined is computed
   as 1 − Π(1 − c_i) capped at 0.99 (probabilistic OR — independent sources
   reinforcing each other).
4. Cover image: prefer cover from the same evidence that won; fall back to
   any other evidence carrying one (CAA → Spotify → Discogs → Shazam → local).
5. Year/label: take from highest-confidence evidence that has the field set.

The result is a flat dict the existing indexer.py callers expect:
    status: "identified" | "low_confidence" | "unidentified"
    title, artist, year, duration, isrc, mb_recording_id, spotify_id,
    discogs_id, label, cover_image, confidence, sources
"""

from __future__ import annotations

from typing import Iterable

from .canonical import VERSION_PRIORITY
from .evidence import Evidence, is_strong_id


def _cluster_key(ev: Evidence) -> str:
    return f"{ev.canonical_artist_key or ''}||{ev.canonical_title_key or ''}"


def _combine_confidence(values: Iterable[float]) -> float:
    """Probabilistic OR — independent evidences boost each other."""
    p_miss = 1.0
    for v in values:
        v = max(0.0, min(1.0, float(v)))
        p_miss *= (1.0 - v)
    return round(min(0.99, 1.0 - p_miss), 4)


def _pick_best_cover(evidences: list[Evidence], winner: Evidence) -> str | None:
    if winner.cover_image:
        return winner.cover_image
    cover_priority = ["mb_by_id", "mb_by_isrc", "spotify_isrc", "spotify_fuzzy", "discogs", "shazam", "local_tags"]
    for src in cover_priority:
        for ev in evidences:
            if ev.source == src and ev.cover_image:
                return ev.cover_image
    return None


def _strong_id_majority(evidences: list[Evidence]) -> tuple[str, str] | None:
    """
    Returns (id_kind, id_value) if two or more evidences agree on the same
    deterministic identifier, else None.
    """
    counts: dict[tuple[str, str], int] = {}
    for ev in evidences:
        if ev.isrc:
            counts[("isrc", ev.isrc)] = counts.get(("isrc", ev.isrc), 0) + 1
        if ev.mb_recording_id:
            counts[("mb", ev.mb_recording_id)] = counts.get(("mb", ev.mb_recording_id), 0) + 1
        if ev.spotify_id:
            counts[("spotify", ev.spotify_id)] = counts.get(("spotify", ev.spotify_id), 0) + 1
    for key, count in counts.items():
        if count >= 2:
            return key
    return None


def resolve(evidences: list[Evidence], *, threshold: float = 0.84) -> dict:
    """
    Pick the best identity from a bag of evidences. Returns a dict ready to
    be merged into the track row. `status` reflects how confident the result is.
    """
    evidences = [
        e for e in evidences
        if e and (e.title or e.canonical_title or e.isrc or e.mb_recording_id or e.spotify_id)
    ]
    if not evidences:
        return {
            "status": "unidentified",
            "confidence": 0.0,
            "sources": [],
            "title": None,
            "artist": None,
        }

    majority = _strong_id_majority(evidences)
    if majority:
        kind, value = majority
        agreeing = [e for e in evidences if (
            (kind == "isrc" and e.isrc == value)
            or (kind == "mb" and e.mb_recording_id == value)
            or (kind == "spotify" and e.spotify_id == value)
        )]
        winner = max(agreeing, key=lambda e: (e.priority, e.confidence))
        confidence = _combine_confidence([e.confidence for e in agreeing])
        confidence = max(confidence, 0.95)
        return _build_result(evidences, winner, agreeing, confidence, "identified")

    strong_solo = [
        e for e in evidences
        if is_strong_id(e) and e.priority >= 8 and e.confidence >= 0.85
    ]
    if strong_solo:
        winner = max(strong_solo, key=lambda e: (e.priority, e.confidence))
        return _build_result(evidences, winner, [winner], winner.confidence, "identified")

    clusters: dict[str, list[Evidence]] = {}
    for ev in evidences:
        key = _cluster_key(ev)
        if not key.strip("|"):
            continue
        clusters.setdefault(key, []).append(ev)

    if not clusters:
        return {
            "status": "unidentified",
            "confidence": 0.0,
            "sources": [e.source for e in evidences],
            "title": None,
            "artist": None,
        }

    best_key, best_group = max(
        clusters.items(),
        key=lambda item: (
            _combine_confidence([e.confidence for e in item[1]]),
            max(e.priority for e in item[1]),
        ),
    )
    confidence = _combine_confidence([e.confidence for e in best_group])
    winner = max(best_group, key=lambda e: (e.priority, e.confidence))

    if confidence >= threshold:
        status = "identified"
    elif confidence >= 0.55:
        status = "low_confidence"
    else:
        status = "unidentified"

    return _build_result(evidences, winner, best_group, confidence, status)


def _first_set(evidences: list[Evidence], attr: str):
    for e in sorted(evidences, key=lambda x: (-x.priority, -x.confidence)):
        v = getattr(e, attr, None)
        if v not in (None, "", 0):
            return v
    return None


def _best_version_type(evidences: list[Evidence]) -> str:
    best = "ORIGINAL_MIX"
    for ev in evidences:
        version_type = ev.version_type or "ORIGINAL_MIX"
        if VERSION_PRIORITY.get(version_type, 0) > VERSION_PRIORITY.get(best, 0):
            best = version_type
    return best


def _build_result(
    all_evidence: list[Evidence],
    winner: Evidence,
    agreeing: list[Evidence],
    confidence: float,
    status: str,
) -> dict:
    return {
        "status": status,
        "confidence": confidence,
        "sources": [e.source for e in agreeing],
        "all_sources": [e.source for e in all_evidence],
        "canonical_title": winner.canonical_title or _first_set(agreeing, "canonical_title"),
        "canonical_artist": winner.canonical_artist or _first_set(agreeing, "canonical_artist"),
        "title": winner.canonical_title or winner.title or _first_set(agreeing, "title"),
        "artist": winner.canonical_artist or winner.artist or _first_set(agreeing, "artist"),
        "version_type": _best_version_type(agreeing),
        "featured_artists": list(dict.fromkeys(
            name for e in agreeing for name in (e.featured_artists or [])
        )),
        "year": _first_set(agreeing, "year"),
        "duration": _first_set(all_evidence, "duration"),
        "isrc": _first_set(agreeing, "isrc"),
        "mb_recording_id": _first_set(agreeing, "mb_recording_id"),
        "spotify_id": _first_set(agreeing, "spotify_id"),
        "discogs_id": _first_set(agreeing, "discogs_id"),
        "label": _first_set(agreeing, "label"),
        "cover_image": _pick_best_cover(all_evidence, winner),
        "reasons": list(dict.fromkeys(r for e in agreeing for r in e.reasons)),
    }
