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

from .canonical import VERSION_PRIORITY, identity_similarity
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

    # ID-anchor: a single strong-ID evidence (priority ≥ 6) confirmed by any
    # corroborating evidence with base similarity ≥ 0.70 can be promoted to
    # identified — fills the gap between strong_solo and majority-consensus.
    for _anchor in evidences:
        if not is_strong_id(_anchor) or _anchor.priority < 6:
            continue
        for _corr in evidences:
            if _corr is _anchor or _corr.source in ("shazam_conflict", "existing_track_row"):
                continue
            _scores = identity_similarity(_anchor.artist, _anchor.title, _corr.artist, _corr.title)
            if _scores["base"] >= 0.70:
                _factor = 0.75 if _corr.source in ("shazam", "shazam_unverified") else 0.60
                _combined = round(1.0 - (1.0 - _anchor.confidence) * (1.0 - _corr.confidence * _factor), 4)
                if _combined >= 0.87:
                    return _build_result(evidences, _anchor, [_anchor, _corr], _combined, "identified")

    clusters: dict[str, list[Evidence]] = {}
    for ev in evidences:
        key = _cluster_key(ev)
        if not key.strip("|"):
            continue
        clusters.setdefault(key, []).append(ev)

    # Featured-artist merge: combine clusters that share the same title_key and
    # have artist-key token sets in a subset/superset relationship (≤ 2 extra
    # tokens). Handles "polyphia" vs "polyphia snot" for feat.-only variants.
    _to_merge: list[tuple[str, str]] = []
    _cluster_keys = list(clusters.keys())
    for _i, _ki in enumerate(_cluster_keys):
        _ai_str, _ti = (_ki.split("||", 1) + [""])[:2] if "||" in _ki else (_ki, "")
        _ai = set(_ai_str.split())
        for _kj in _cluster_keys[_i + 1:]:
            _aj_str, _tj = (_kj.split("||", 1) + [""])[:2] if "||" in _kj else (_kj, "")
            if _ti != _tj or not _ti:
                continue
            _aj = set(_aj_str.split())
            if not _ai or not _aj:
                continue
            _extra = (_ai | _aj) - (_ai & _aj)
            if len(_extra) <= 2 and (_ai <= _aj or _aj <= _ai):
                _keep = _ki if len(_ai) <= len(_aj) else _kj
                _absorb = _kj if _keep == _ki else _ki
                _to_merge.append((_keep, _absorb))
    for _keep, _absorb in _to_merge:
        if _absorb in clusters and _keep in clusters:
            clusters[_keep] = clusters[_keep] + clusters.pop(_absorb)

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

    # Cross-validation: absorb out-of-cluster evidences that carry a strong ID
    # and agree with the winner's identity (base similarity ≥ 0.65). Injects
    # their IDs into the result and boosts combined confidence.
    _absorbed_any = False
    for _e_ext in evidences:
        if _e_ext in best_group or not is_strong_id(_e_ext):
            continue
        if _e_ext.confidence < 0.55 or _e_ext.source in ("shazam_conflict",):
            continue
        _ext_scores = identity_similarity(winner.artist, winner.title, _e_ext.artist, _e_ext.title)
        if _ext_scores["base"] >= 0.65:
            best_group = list(best_group) + [_e_ext]
            _absorbed_any = True
    if _absorbed_any:
        confidence = _combine_confidence([e.confidence for e in best_group])
        winner = max(best_group, key=lambda e: (e.priority, e.confidence))

    # Audio fingerprint override: if the winning cluster title matches a Shazam
    # audio result but the artists are completely disjoint (zero shared tokens),
    # promote Shazam's identity. This corrects the channel-name-as-artist failure
    # mode where two text sources agree on a wrong artist and already pass the
    # threshold. Audio fingerprint is more reliable than stored text metadata.
    _AUDIO_SOURCES = {"shazam", "shazam_unverified", "mb_by_id", "mb_by_isrc",
                      "acoustid", "spotify_isrc", "isrc_lookup"}
    if winner.source not in _AUDIO_SOURCES:
        _sz = next(
            (e for e in evidences if e.source in ("shazam", "shazam_unverified") and e.confidence >= 0.55),
            None,
        )
        if _sz and _sz.canonical_title_key and _sz.canonical_artist_key:
            _best_tokens = set((winner.canonical_title_key or "").split())
            _sz_tokens = set(_sz.canonical_title_key.split())
            if _best_tokens and _sz_tokens:
                _union = _best_tokens | _sz_tokens
                _ovlp = _best_tokens & _sz_tokens
                if _union and len(_ovlp) / len(_union) >= 0.70:
                    _winner_artist = set((winner.canonical_artist_key or "").split())
                    _sz_artist = set(_sz.canonical_artist_key.split())
                    # Only override when artists share zero tokens — unambiguous divergence.
                    if _winner_artist and _sz_artist and not (_winner_artist & _sz_artist):
                        if _sz not in best_group:
                            best_group = list(best_group) + [_sz]
                        winner = _sz
                        confidence = max(confidence, 0.85)

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


def _first_raw(evidences: list[Evidence], key: str):
    for e in sorted(evidences, key=lambda x: (-x.priority, -x.confidence)):
        v = (e.raw or {}).get(key)
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


def _credit_key(credit: dict) -> str:
    for key in ("mb_artist_id", "spotify_id", "discogs_id", "id"):
        if credit.get(key):
            return f"{key}:{credit[key]}"
    return f"name:{str(credit.get('name') or '').strip().lower()}"


def _best_artist_credits(evidences: list[Evidence], winner: Evidence) -> list[dict]:
    candidates = [e for e in evidences if e.artist_credits]
    if not candidates:
        return winner.artist_credits or []
    best = max(
        candidates,
        key=lambda e: (
            len(e.artist_credits or []),
            e.priority,
            e.confidence,
        ),
    )
    seen: set[str] = set()
    out: list[dict] = []
    for credit in sorted(best.artist_credits or [], key=lambda c: int(c.get("position") or 0)):
        key = _credit_key(credit)
        if not credit.get("name") or key in seen:
            continue
        seen.add(key)
        out.append(dict(credit))
    return out


def _best_albums(evidences: list[Evidence]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for ev in sorted(evidences, key=lambda e: (-e.priority, -e.confidence)):
        for raw in ev.albums or ([ev.album] if ev.album else []):
            if not isinstance(raw, dict):
                continue
            title = (raw.get("title") or raw.get("name") or "").strip()
            if not title:
                continue
            key = (
                raw.get("mb_release_id")
                or raw.get("mb_release_group_id")
                or raw.get("spotify_album_id")
                or raw.get("discogs_id")
                or f"{title.lower()}::{str(raw.get('display_artist') or '').lower()}"
            )
            if key in seen:
                continue
            seen.add(key)
            album = dict(raw)
            album["title"] = title
            out.append(album)
    return out


def _display_artist_from_credits(credits: list[dict]) -> str | None:
    if not credits:
        return None
    ordered = sorted(credits, key=lambda c: int(c.get("position") or 0))
    parts: list[str] = []
    for idx, credit in enumerate(ordered):
        name = credit.get("name")
        if not name:
            continue
        if idx > 0:
            parts.append(ordered[idx - 1].get("join_phrase") or ", ")
        parts.append(name)
    return "".join(parts).strip() or None


def _build_result(
    all_evidence: list[Evidence],
    winner: Evidence,
    agreeing: list[Evidence],
    confidence: float,
    status: str,
) -> dict:
    artist_credits = _best_artist_credits(agreeing, winner)
    display_artist = (
        winner.display_artist
        or _display_artist_from_credits(artist_credits)
        or winner.artist
        or _first_set(agreeing, "display_artist")
        or _first_set(agreeing, "artist")
    )
    primary_artist = next((c for c in artist_credits if c.get("is_primary")), None)
    if not primary_artist and artist_credits:
        primary_artist = artist_credits[0]
    primary_artist_out = dict(primary_artist) if primary_artist else None
    albums = _best_albums(agreeing)
    album = albums[0] if albums else None
    return {
        "status": status,
        "confidence": confidence,
        "sources": [e.source for e in agreeing],
        "all_sources": [e.source for e in all_evidence],
        "canonical_title": winner.canonical_title or _first_set(agreeing, "canonical_title"),
        "canonical_artist": winner.canonical_artist or _first_set(agreeing, "canonical_artist"),
        "title": winner.canonical_title or winner.title or _first_set(agreeing, "title"),
        "artist": display_artist,
        "display_artist": display_artist,
        "primary_artist": primary_artist_out,
        "artists": artist_credits,
        "version_type": _best_version_type(agreeing),
        "featured_artists": list(dict.fromkeys(
            name for e in agreeing for name in (e.featured_artists or [])
        )),
        "album": album,
        "albums": albums,
        "track_number": _first_set(agreeing, "track_number"),
        "disc_number": _first_set(agreeing, "disc_number"),
        "year": _first_set(agreeing, "year"),
        "duration": _first_set(all_evidence, "duration"),
        "isrc": _first_set(agreeing, "isrc"),
        "mb_recording_id": _first_set(agreeing, "mb_recording_id"),
        "spotify_id": _first_set(agreeing, "spotify_id"),
        "discogs_id": _first_set(agreeing, "discogs_id"),
        "label": _first_set(agreeing, "label"),
        "cover_image": _pick_best_cover(all_evidence, winner),
        "shazam_key": _first_raw(agreeing, "shazam_key"),
        "shazam_url": _first_raw(agreeing, "url"),
        "reasons": list(dict.fromkeys(r for e in agreeing for r in e.reasons)),
    }
