import asyncio
import difflib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import uuid
from pathlib import Path

import httpx
from tinytag import TinyTag

from core.database import database
from api.services.identification.canonical import canonicalize
from utils.image_processor import cache_remote_cover_candidates_sync
from utils import config as cfg

logger = logging.getLogger(__name__)

ACOUSTID_KEY = "inv3qSYC56"
_ROOT = Path(__file__).parent.parent.parent
_FPCALC = str(_ROOT / ("fpcalc.exe" if sys.platform == "win32" else "fpcalc"))
_USER_AGENT = "Rolfsound/1.0"
_SHAZAM_WORKER = str(Path(__file__).parent / "_shazam_worker.py")
_SHAZAM_TIMEOUT = 30
BPM_SEMAPHORE = asyncio.Semaphore(2)
DISCOGS_MIN_CONFIDENCE = 0.84
DISCOGS_COVER_REPLACE_CONFIDENCE = 0.93


def _ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def extract_local_tags(file_path: str, track_id: str) -> dict:
    result = {
        "title": None,
        "artist": None,
        "album": None,
        "year": None,
        "duration": None,
        "thumbnail": None,
    }
    try:
        tag = TinyTag.get(file_path, image=True)
        result["title"] = tag.title
        result["artist"] = tag.artist or tag.albumartist
        result["album"] = tag.album
        result["year"] = int(tag.year[:4]) if tag.year else None
        result["duration"] = tag.duration

        image_data = tag.get_image()
        if image_data:
            music_dir = Path(cfg.get("music_directory", "./music"))
            cover_path = music_dir / track_id / "cover.jpg"
            cover_path.parent.mkdir(parents=True, exist_ok=True)
            with open(cover_path, "wb") as f:
                f.write(image_data)
            result["thumbnail"] = str(cover_path)
    except Exception as e:
        if "No tag reader found" not in str(e):
            logger.debug(f"Could not read local tags from {file_path}: {e}")
    return result


def _discogs_auth_header() -> str | None:
    import urllib.parse
    import uuid

    conn = database.get_connection()
    try:
        account = database.get_discogs_account(conn)
    finally:
        conn.close()

    if not account:
        return None

    ck = cfg.get("discogs_consumer_key", "")
    cs = cfg.get("discogs_consumer_secret", "")
    at = account["access_token"]
    as_ = account["access_secret"]

    params = {
        "oauth_consumer_key": ck,
        "oauth_nonce": uuid.uuid4().hex,
        "oauth_signature_method": "PLAINTEXT",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": at,
        "oauth_version": "1.0",
        "oauth_signature": f"{urllib.parse.quote(cs, safe='')}&{urllib.parse.quote(as_, safe='')}",
    }
    parts = ", ".join(f'{k}="{urllib.parse.quote(v, safe="")}"' for k, v in sorted(params.items()))
    return f"OAuth {parts}"


async def fingerprint(path: str) -> dict | None:
    try:
        import acoustid
        import av
        import numpy as np
        import chromaprint  # noqa: F401

        target_sr = 44100
        n_channels = 2
        max_seconds = 120
        frames: list[np.ndarray] = []
        collected = 0
        duration = 0.0

        with av.open(path) as container:
            if container.duration:
                duration = container.duration / 1_000_000
            resampler = av.audio.resampler.AudioResampler(
                format="s16", layout="stereo", rate=target_sr
            )
            max_samples = target_sr * n_channels * max_seconds
            for packet in container.demux(audio=0):
                for frame in packet.decode():
                    resampled = resampler.resample(frame)
                    for rf in (resampled if isinstance(resampled, list) else [resampled]):
                        arr = rf.to_ndarray().flatten()
                        remaining = max_samples - collected
                        frames.append(arr[:remaining])
                        collected += min(len(arr), remaining)
                    if collected >= max_samples:
                        break
                if collected >= max_samples:
                    break

        if not frames:
            raise RuntimeError("no audio frames decoded")
        if duration <= 0:
            duration = collected / (target_sr * n_channels)

        pcm = np.concatenate(frames).astype(np.int16).tobytes()
        fp_str = acoustid.fingerprint(target_sr, n_channels, [pcm])
        return {"duration": duration, "fingerprint": fp_str}
    except ImportError:
        logger.debug("libchromaprint not available, falling back to fpcalc")
    except Exception as e:
        logger.debug(f"native fingerprint failed, falling back to fpcalc: {e}")

    result = subprocess.run([_FPCALC, "-json", path], capture_output=True, text=True)
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


async def lookup_acoustid(fp: dict) -> dict | None:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                "https://api.acoustid.org/v2/lookup",
                params={
                    "client": ACOUSTID_KEY,
                    "duration": int(fp["duration"]),
                    "fingerprint": fp["fingerprint"],
                    "meta": "recordings+releasegroups+compress",
                },
            )
        data = r.json()
    except Exception as e:
        logger.debug(f"AcoustID lookup failed: {e}")
        return None

    results = data.get("results", [])
    if not results:
        return None
    best = max(results, key=lambda x: x.get("score", 0))
    if best.get("score", 0) < 0.8:
        return None
    recordings = best.get("recordings", [])
    return recordings[0] if recordings else None


async def lookup_shazam(file_path: str) -> dict | None:
    import tempfile
    import wave

    import numpy as np

    def _prepare_snippets() -> tuple[str, list[str]]:
        import av

        target_sr = 16000
        max_seconds = 120
        max_samples = target_sr * max_seconds
        frames: list[np.ndarray] = []
        collected = 0

        with av.open(file_path) as container:
            resampler = av.audio.resampler.AudioResampler(
                format="s16", layout="mono", rate=target_sr
            )
            for packet in container.demux(audio=0):
                for frame in packet.decode():
                    resampled = resampler.resample(frame)
                    for rf in (resampled if isinstance(resampled, list) else [resampled]):
                        arr = rf.to_ndarray().reshape(-1)
                        remaining = max_samples - collected
                        if remaining <= 0:
                            break
                        frames.append(arr[:remaining])
                        collected += min(len(arr), remaining)
                    if collected >= max_samples:
                        break
                if collected >= max_samples:
                    break

        if not frames:
            return "", []

        pcm = np.concatenate(frames).astype(np.int16)
        total_seconds = len(pcm) / target_sr
        if total_seconds < 6:
            return "", []

        snippet_seconds = min(20, max(8, int(total_seconds)))
        snippet_samples = int(snippet_seconds * target_sr)
        max_start = max(0, len(pcm) - snippet_samples)
        starts = [0]
        if max_start:
            starts.extend([
                int(min(max_start, target_sr * 12)),
                int(max_start * 0.38),
                int(max_start * 0.68),
            ])

        unique_starts: list[int] = []
        for start in starts:
            start = max(0, min(max_start, int(start)))
            if all(abs(start - existing) > target_sr * 5 for existing in unique_starts):
                unique_starts.append(start)

        tmp_dir = tempfile.mkdtemp(prefix="rolfsound_shazam_")
        paths: list[str] = []
        try:
            for idx, start in enumerate(unique_starts[:4]):
                segment = pcm[start:start + snippet_samples]
                if len(segment) < target_sr * 6:
                    continue
                tmp_wav = os.path.join(tmp_dir, f"snippet_{idx}.wav")
                with wave.open(tmp_wav, "wb") as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(target_sr)
                    wf.writeframes(segment.tobytes())
                paths.append(tmp_wav)
            return tmp_dir, paths
        except Exception:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise

    async def _recognize_snippet(path: str) -> dict | None:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            _SHAZAM_WORKER,
            path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=_SHAZAM_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return None

        if proc.returncode != 0:
            message = (stderr or b"").decode("utf-8", errors="replace").strip()
            if message:
                logger.debug("Shazamio worker failed: %s", message)
            return None

        lines = (stdout or b"").decode("utf-8", errors="replace").strip().splitlines()
        payload = lines[-1] if lines else "null"
        data = json.loads(payload)
        if not data or not data.get("title"):
            return None
        return {
            "artist": data.get("artist", "") or "",
            "title": data.get("title", "") or "",
            "thumbnail": data.get("thumbnail", "") or "",
            "shazam_key": data.get("shazam_key", "") or "",
            "url": data.get("url", "") or "",
        }

    tmp_dir = ""
    try:
        tmp_dir, snippets = await asyncio.to_thread(_prepare_snippets)
        for snippet in snippets:
            result = await _recognize_snippet(snippet)
            if result:
                logger.info("Shazamio recognized: %s - %s", result.get("artist"), result.get("title"))
                return result
        if snippets:
            logger.info("Shazamio: no match from %d snippet(s)", len(snippets))
        else:
            logger.warning("Shazamio: no snippets generated (format/decode issue?)")
        return None
    except Exception as exc:
        logger.debug("Shazamio lookup failed: %s", exc)
        return None
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)


_BRACKET_NOISE_RE = re.compile(
    r"\b("
    r"official|audio|video|visuali[sz]er|lyrics?|lyric video|remaster(?:ed)?|"
    r"explicit|uncensored|censored|clean|radio edit|single edit|album version|full album|hd|hq|4k|"
    r"provided to youtube|topic|official music video|feat\.?|ft\.?|featuring|"
    r"remix|rework|live|demo|instrumental|karaoke|acapella|a cappella|"
    r"alt|alternate|alternative|version|slowed|reverb|sped up|nightcore"
    r")\b",
    re.IGNORECASE,
)
_TITLE_NOISE_RE = re.compile(
    r"\b("
    r"official|audio|video|visuali[sz]er|lyrics?|remaster(?:ed)?|explicit|clean|"
    r"radio edit|single edit|album version|provided to youtube by|topic|hd|hq|4k|"
    r"remix|rework|live|demo|instrumental|karaoke|acapella|a cappella|"
    r"alt|alternate|alternative|version|slowed|reverb|sped up|nightcore"
    r")\b",
    re.IGNORECASE,
)
_FEAT_RE = re.compile(r"\s+(?:feat\.?|ft\.?|featuring)\s+.+$", re.IGNORECASE)
_STOP_TOKENS = {"a", "an", "and", "the", "of", "to", "by", "de", "da", "do", "dos", "das", "e"}


def _strip_bracket_noise(text: str) -> str:
    def repl(match: re.Match) -> str:
        chunk = match.group(0)
        return " " if _BRACKET_NOISE_RE.search(chunk) else chunk

    return re.sub(r"[\(\[].*?[\)\]]", repl, text)


def _normalize_match_text(value: str | None) -> str:
    text = str(value or "")
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower().replace("&", " and ")
    text = re.sub(r"\bf[\W_]*(?:u|[*x])[\W_]*(?:c|[*x])[\W_]*k\b", "fuck", text, flags=re.IGNORECASE)
    text = _strip_bracket_noise(text)
    text = re.sub(r"\s+[-|:]\s+(?:official|audio|video|visuali[sz]er|lyrics?).*$", " ", text)
    text = _FEAT_RE.sub(" ", text)
    text = _TITLE_NOISE_RE.sub(" ", text)
    text = re.sub(r"\b\d{4}\s+remaster(?:ed)?\b", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _clean_display_title(value: str | None) -> str:
    original = str(value or "").strip()
    if not original:
        return ""
    text = _strip_bracket_noise(original)
    text = re.sub(r"\bf[\W_]*(?:u|[*x])[\W_]*(?:c|[*x])[\W_]*k\b", "Fuck", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+[-|:]\s+(?:official|audio|video|visuali[sz]er|lyrics?).*$", "", text, flags=re.IGNORECASE)
    text = _FEAT_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip(" -|:")
    return text or original


def _clean_display_artist(value: str | None) -> str:
    text = str(value or "").strip()
    text = re.sub(r"\s+-\s+topic$", "", text, flags=re.IGNORECASE)
    text = _FEAT_RE.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def _is_generic_title(value: str | None) -> bool:
    text = _normalize_match_text(value)
    if not text:
        return True
    return bool(re.fullmatch(r"(track|audio|unknown title|untitled|original mix)(?: \d+)?", text))


def _is_generic_artist(value: str | None) -> bool:
    text = _normalize_match_text(value)
    if not text:
        return True
    return text in {"unknown", "unknown artist", "track", "audio", "no artist"}


def _needs_shazam_lookup(title: str | None, artist: str | None, identity_source: str | None) -> bool:
    return (
        not title or
        not artist or
        _is_generic_title(title) or
        _is_generic_artist(artist) or
        identity_source in {"local_tags", "filename", "existing_metadata", None}
    )


def _tokens(value: str | None) -> set[str]:
    normalized = _normalize_match_text(value)
    return {token for token in normalized.split() if token and token not in _STOP_TOKENS}


def _text_score(expected: str | None, candidate: str | None) -> float:
    a = _normalize_match_text(expected)
    b = _normalize_match_text(candidate)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if len(a) >= 4 and len(b) >= 4 and (a in b or b in a):
        return 0.88

    ratio = difflib.SequenceMatcher(None, a, b).ratio()
    at = _tokens(a)
    bt = _tokens(b)
    jaccard = len(at & bt) / len(at | bt) if at and bt else 0.0
    return max(ratio * 0.92, jaccard)


_ARTIST_TITLE_SEPARATOR_RE = re.compile(r"\s+[-|:–—]+\s+|\s*:\s+")


def _split_discogs_title(value: str | None) -> tuple[str, str]:
    text = str(value or "").strip()
    match = _ARTIST_TITLE_SEPARATOR_RE.search(text)
    if not match:
        return "", text
    left = text[:match.start()].strip()
    right = text[match.end():].strip()
    return left, right


def _split_embedded_artist_title(artist: str | None, title: str | None) -> tuple[str, str]:
    clean_artist = _clean_display_artist(artist)
    clean_title = _clean_display_title(title)
    if clean_artist or " - " not in clean_title:
        return clean_artist, clean_title
    inferred_artist, inferred_title = _split_discogs_title(clean_title)
    return _clean_display_artist(inferred_artist or clean_artist), _clean_display_title(inferred_title or clean_title)


_GENERIC_ARTIST_NOISE = {"song", "track", "music", "audio", "video", "version", "mix", "remix"}


def _recover_artist_from_yt_title(artist: str | None, title: str | None) -> tuple[str | None, str | None]:
    """
    YouTube downloads (and some local imports) embed the real artist in the
    title ("Artist - Song") while the artist field holds a channel name or a
    truncated form. Detect that and extract the real pair.

    Two recovery patterns:
      1. Declared is a STRICT SUBSET of embedded — channel/source has only
         the first name (e.g. "Caê") while the title carries the full name
         ("Caê Rolfsen - Do Avesso"). Upgrade to the longer form, but only
         when the extra tokens are real names (not "Song"/"Track"/...).
      2. Declared and embedded are DISJOINT — channel is wrong (e.g. fan
         channel "XOXOXO" with title "Frank Ocean - Nights"). Replace.
    """
    if not title:
        return artist, title

    embedded_artist_raw, embedded_title_raw = _split_discogs_title(title)
    if not embedded_artist_raw or not embedded_title_raw:
        return artist, title

    declared_tokens = _tokens(artist)
    embedded_tokens = _tokens(embedded_artist_raw)
    if not declared_tokens or not embedded_tokens:
        return artist, title

    # Equal sets, or embedded is subset of declared — declared is already
    # at-least-as-specific. No recovery needed.
    if embedded_tokens <= declared_tokens:
        return artist, title

    # Pattern 1: subset upgrade.
    if declared_tokens < embedded_tokens:
        delta = len(embedded_tokens) - len(declared_tokens)
        extra = embedded_tokens - declared_tokens
        if delta <= 2 and not (extra & _GENERIC_ARTIST_NOISE):
            return _clean_display_artist(embedded_artist_raw), _clean_display_title(embedded_title_raw)
        # Subset but unsafe (delta too large or generic noise) — keep declared.
        return artist, title

    # Pattern 2: disjoint sets — declared and embedded are unrelated names.
    # Apply similarity and "declared mentioned in title" guards before swapping.
    if _text_score(artist, embedded_artist_raw) >= 0.7:
        return artist, title

    title_tokens = _tokens(title)
    if declared_tokens <= title_tokens:
        return artist, title

    if not _tokens(embedded_title_raw):
        return artist, title

    return _clean_display_artist(embedded_artist_raw), _clean_display_title(embedded_title_raw)


def _parse_discogs_duration(value: str | None) -> float | None:
    text = str(value or "").strip()
    if not text:
        return None
    parts = text.split(":")
    if not all(part.isdigit() for part in parts):
        return None
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + int(part)
    return float(seconds)


def _duration_score(expected: float | None, candidate: float | None) -> float | None:
    if not expected or not candidate:
        return None
    diff = abs(float(expected) - float(candidate))
    if diff <= 3:
        return 1.0
    if diff <= 8:
        return 0.86
    if diff <= 15:
        return 0.62
    if diff <= 30:
        return 0.35
    # Candidate is a short excerpt of a longer file (e.g. Shazam snippet vs DJ set).
    # Treat as neutral rather than a hard zero so the rest of the score can still win.
    if float(candidate) > 0 and float(expected) / float(candidate) >= 1.8:
        return None
    return 0.0


def _year_score(expected: int | None, candidate: int | None) -> float | None:
    if not expected or not candidate:
        return None
    diff = abs(int(expected) - int(candidate))
    if diff == 0:
        return 1.0
    if diff == 1:
        return 0.82
    if diff <= 3:
        return 0.50
    return 0.0


def _candidate_artist_names(candidate: dict, detail: dict | None) -> list[str]:
    names: list[str] = []
    artist_part, _release_title = _split_discogs_title(candidate.get("title"))
    if artist_part:
        names.append(artist_part)
    for key in ("artist", "artists_sort"):
        if candidate.get(key):
            names.append(str(candidate[key]))
        if detail and detail.get(key):
            names.append(str(detail[key]))
    for item in (detail or {}).get("artists", []) or []:
        name = item.get("name") if isinstance(item, dict) else str(item)
        if name:
            names.append(re.sub(r"\s+\(\d+\)$", "", name))
    return list(dict.fromkeys(names))


def _candidate_label_names(candidate: dict, detail: dict | None) -> list[str]:
    labels: list[str] = []
    raw_labels = (detail or {}).get("labels") or candidate.get("label") or []
    for item in raw_labels:
        if isinstance(item, dict):
            name = item.get("name")
        else:
            name = str(item)
        if name:
            labels.append(name)
    return list(dict.fromkeys(labels))


def _discogs_artist_credits(candidate: dict, detail: dict | None) -> list[dict]:
    credits: list[dict] = []
    for idx, item in enumerate((detail or {}).get("artists", []) or []):
        if not isinstance(item, dict):
            continue
        name = re.sub(r"\s+\(\d+\)$", "", item.get("name") or "").strip()
        if not name:
            continue
        credits.append({
            "name": name,
            "discogs_id": item.get("id"),
            "role": "main",
            "position": idx,
            "is_primary": idx == 0,
            "join_phrase": item.get("join") or "",
            "source": "discogs",
        })
    if credits:
        return credits
    artist_part, _release_title = _split_discogs_title(candidate.get("title"))
    if artist_part:
        return [{
            "name": artist_part,
            "role": "main",
            "position": 0,
            "is_primary": True,
            "source": "discogs_title",
        }]
    return []


def _discogs_display_artist(credits: list[dict]) -> str | None:
    if not credits:
        return None
    ordered = sorted(credits, key=lambda c: int(c.get("position") or 0))
    parts: list[str] = []
    for idx, credit in enumerate(ordered):
        if idx > 0:
            parts.append(ordered[idx - 1].get("join_phrase") or ", ")
        parts.append(credit.get("name") or "")
    return "".join(parts).strip() or None


def _best_track_match(title: str, candidate: dict, detail: dict | None) -> tuple[float, dict | None]:
    best_score = 0.0
    best_track = None
    for track in (detail or {}).get("tracklist", []) or []:
        if not isinstance(track, dict):
            continue
        track_type = str(track.get("type_") or "track").lower()
        if track_type and track_type != "track":
            continue
        score = _text_score(title, track.get("title"))
        if score > best_score:
            best_score = score
            best_track = track

    _artist_part, release_title = _split_discogs_title(candidate.get("title"))
    for release_name in (release_title, candidate.get("title"), (detail or {}).get("title")):
        score = _text_score(title, release_name) * 0.86
        if score > best_score:
            best_score = score
            best_track = None

    return best_score, best_track


def _score_discogs_candidate(
    candidate: dict,
    detail: dict | None,
    *,
    artist: str,
    title: str,
    year: int | None,
    duration: float | None,
) -> tuple[float, list[str]]:
    reasons: list[str] = []
    artist_names = _candidate_artist_names(candidate, detail)
    artist_score = max((_text_score(artist, name) for name in artist_names), default=0.0)
    track_score, best_track = _best_track_match(title, candidate, detail)

    candidate_year = (detail or {}).get("year") or candidate.get("year")
    y_score = _year_score(year, candidate_year)
    track_duration = _parse_discogs_duration((best_track or {}).get("duration"))
    d_score = _duration_score(duration, track_duration)

    has_cover = bool(candidate.get("cover_image") or (detail or {}).get("images"))
    is_master = (candidate.get("_rolfsound_kind") == "master") or bool(candidate.get("master_id"))
    _artist_part, release_title = _split_discogs_title(candidate.get("title"))
    query_version = canonicalize(artist, title).version_type
    release_version = canonicalize(artist, release_title or (detail or {}).get("title")).version_type

    score = (
        artist_score * 0.34 +
        track_score * 0.42 +
        (0.60 if y_score is None else y_score) * 0.08 +
        (0.60 if d_score is None else d_score) * 0.08 +
        (1.0 if has_cover else 0.0) * 0.05 +
        (1.0 if is_master else 0.0) * 0.03
    )

    # Structural corroboration: year + duration match + cover art strongly suggests
    # a correct release even when text scores are weak (e.g. remix title variance).
    strong_corroboration = (
        y_score is not None and y_score >= 0.82
        and d_score is not None and d_score >= 0.86
        and has_cover
    )

    if artist:
        if artist_score >= 0.92:
            reasons.append("artist_exact")
        elif artist_score >= 0.70:
            reasons.append("artist_close")
        else:
            score = min(score, 0.76 if strong_corroboration else 0.58)
            reasons.append("artist_weak_corroborated" if strong_corroboration else "artist_weak")

    if track_score >= 0.92:
        reasons.append("track_exact")
    elif track_score >= 0.72:
        reasons.append("track_close")
    else:
        score = min(score, 0.78 if strong_corroboration else 0.60)
        reasons.append("track_weak_corroborated" if strong_corroboration else "track_weak")

    if y_score is not None:
        reasons.append(f"year_{'match' if y_score >= 0.82 else 'weak'}")
    if d_score is not None:
        reasons.append(f"duration_{'match' if d_score >= 0.86 else 'weak'}")
    if has_cover:
        reasons.append("has_cover")

    if query_version == "ORIGINAL_MIX" and release_version != "ORIGINAL_MIX":
        score = min(score, 0.78)
        reasons.append(f"release_version_mismatch_{release_version.lower()}")

    return round(max(0.0, min(1.0, score)), 4), reasons


def _discogs_primary_image(detail: dict | None) -> str | None:
    images = (detail or {}).get("images") or []
    primary = next((img for img in images if img.get("type") == "primary"), None)
    best = primary or (images[0] if images else None)
    return (best or {}).get("uri") or (best or {}).get("resource_url")


async def _discogs_get_json(
    client: httpx.AsyncClient,
    url: str,
    *,
    headers: dict,
    params: dict | None = None,
) -> dict | None:
    try:
        resp = await client.get(url, params=params or {}, headers=headers)
        if resp.status_code == 429:
            logger.warning("Discogs rate limit hit for %s", url)
            return None
        if resp.status_code != 200:
            logger.debug("Discogs request failed %s for %s", resp.status_code, url)
            return None
        return resp.json()
    except Exception as exc:
        logger.debug("Discogs request failed for %s: %s", url, exc)
        return None


async def _enrich_discogs_candidate(
    client: httpx.AsyncClient,
    candidate: dict,
    *,
    headers: dict,
    auth_params: dict,
) -> tuple[dict, dict | None]:
    kind = candidate.get("_rolfsound_kind") or candidate.get("type") or "release"
    candidate_id = candidate.get("id")
    detail = None
    if candidate_id:
        endpoint = "masters" if kind == "master" else "releases"
        detail = await _discogs_get_json(
            client,
            f"https://api.discogs.com/{endpoint}/{candidate_id}",
            headers=headers,
            params=auth_params,
        )

    cover = _discogs_primary_image(detail) or candidate.get("cover_image")
    if cover:
        candidate["cover_image"] = cover

    labels = _candidate_label_names(candidate, detail)
    if labels:
        candidate["label"] = labels
    if detail and detail.get("year"):
        candidate["year"] = detail.get("year")

    credits = _discogs_artist_credits(candidate, detail)
    if credits:
        candidate["_rolfsound_artist_credits"] = credits
        candidate["_rolfsound_display_artist"] = _discogs_display_artist(credits)

    artist_part, release_title = _split_discogs_title(candidate.get("title"))
    album_title = (detail or {}).get("title") or release_title
    if album_title:
        candidate["_rolfsound_album"] = {
            "title": album_title,
            "display_artist": candidate.get("_rolfsound_display_artist") or artist_part,
            "discogs_id": candidate_id,
            "year": candidate.get("year"),
            "cover": candidate.get("cover_image"),
            "source": "discogs",
        }

    return candidate, detail


async def lookup_discogs(
    artist: str,
    title: str,
    *,
    year: int | None = None,
    duration: float | None = None,
) -> dict | None:
    artist, title = _split_embedded_artist_title(artist, title)
    artist_query = _normalize_match_text(artist)
    title_query = _normalize_match_text(title)
    if not title_query:
        return None

    headers = {"User-Agent": _USER_AGENT}
    auth_params: dict = {}
    auth = _discogs_auth_header()
    if auth:
        headers["Authorization"] = auth
    else:
        ck = cfg.get("discogs_consumer_key", "")
        cs = cfg.get("discogs_consumer_secret", "")
        if ck and cs:
            auth_params["key"] = ck
            auth_params["secret"] = cs

    search_plan = []
    if artist_query:
        search_plan.extend([
            ("master", {"type": "master", "artist": artist_query, "track": title_query}),
            ("release", {"type": "release", "artist": artist_query, "track": title_query}),
        ])
    q = f"{artist_query} {title_query}".strip()
    search_plan.extend([
        ("master", {"type": "master", "q": q}),
        ("release", {"type": "release", "q": q}),
    ])

    seen: set[tuple[str, int]] = set()
    candidates: list[dict] = []
    async with httpx.AsyncClient(timeout=10) as client:
        for kind, params in search_plan:
            data = await _discogs_get_json(
                client,
                "https://api.discogs.com/database/search",
                headers=headers,
                params={**auth_params, **params},
            )
            for raw in (data or {}).get("results", [])[:5]:
                candidate = dict(raw)
                candidate["_rolfsound_kind"] = kind
                key = (kind, int(candidate.get("id") or 0))
                if key in seen or not key[1]:
                    continue
                seen.add(key)
                candidates.append(candidate)

        scored: list[dict] = []
        for candidate in candidates[:8]:
            enriched, detail = await _enrich_discogs_candidate(
                client,
                candidate,
                headers=headers,
                auth_params=auth_params,
            )
            score, reasons = _score_discogs_candidate(
                enriched,
                detail,
                artist=artist,
                title=title,
                year=year,
                duration=duration,
            )
            enriched["_rolfsound_confidence"] = score
            enriched["_rolfsound_reasons"] = reasons
            _, best_track = _best_track_match(title, enriched, detail)
            if best_track and best_track.get("title"):
                enriched["_rolfsound_track_title"] = best_track["title"]
            scored.append(enriched)

    if not scored:
        logger.info("Discogs: no candidates for artist=%r title=%r", artist, title)
        return None

    scored.sort(key=lambda item: item.get("_rolfsound_confidence", 0), reverse=True)
    best = scored[0]
    if best["_rolfsound_confidence"] < DISCOGS_MIN_CONFIDENCE:
        logger.info(
            "Discogs: rejected weak match artist=%r title=%r best=%r confidence=%.2f reasons=%s",
            artist,
            title,
            best.get("title"),
            best["_rolfsound_confidence"],
            ",".join(best.get("_rolfsound_reasons", [])),
        )
        return None

    logger.info(
        "Discogs: accepted %r confidence=%.2f reasons=%s",
        best.get("title"),
        best["_rolfsound_confidence"],
        ",".join(best.get("_rolfsound_reasons", [])),
    )
    return best


def _thumbnail_kind(thumbnail: str | None) -> str:
    raw = str(thumbnail or "").strip().replace("\\", "/").lower()
    if not raw:
        return "none"
    if "i.ytimg.com/" in raw or "/static/covers/youtube_" in raw:
        return "youtube"
    if "discogs.com/" in raw or "/static/covers/identified_" in raw:
        return "discogs"
    if raw.startswith("music/") or "/music/" in raw or raw.startswith("/thumbs/"):
        return "local"
    if raw.startswith("/static/"):
        return "static"
    if raw.startswith(("http://", "https://")):
        return "remote"
    return "local"


def _should_use_discogs_cover(
    current_thumbnail: str | None,
    local_tag_thumbnail: str | None,
    discogs: dict | None,
) -> bool:
    if not discogs or not discogs.get("cover_image"):
        return False

    confidence = float(discogs.get("_rolfsound_confidence") or 0)
    if not current_thumbnail:
        return confidence >= DISCOGS_MIN_CONFIDENCE

    if local_tag_thumbnail and str(current_thumbnail) == str(local_tag_thumbnail):
        return False

    kind = _thumbnail_kind(current_thumbnail)
    if kind == "local":
        return False
    if kind in {"youtube", "none"}:
        return confidence >= DISCOGS_MIN_CONFIDENCE
    if kind == "discogs":
        return confidence >= DISCOGS_MIN_CONFIDENCE
    return confidence >= DISCOGS_COVER_REPLACE_CONFIDENCE


async def detect_bpm(file_path: str) -> int | None:
    async with BPM_SEMAPHORE:
        try:
            proc = await asyncio.create_subprocess_exec(
                _ffmpeg_exe(),
                "-i",
                file_path,
                "-af",
                "bpm",
                "-f",
                "null",
                "-",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=45.0)
            output = stderr.decode("utf-8", errors="ignore")
            match = re.search(r"BPM:\s*([\d.]+)", output)
            if match:
                return int(round(float(match.group(1))))
        except asyncio.TimeoutError:
            proc.kill()
            logger.warning(f"Timeout detecting BPM for {file_path}")
        except Exception as e:
            logger.warning(f"Could not detect BPM for {file_path}: {e}")
    return None


async def identify_track(
    file_path: str,
    track_id: str,
    fallback_title: str = "",
    existing_title: str | None = None,
    existing_artist: str | None = None,
    existing_year: int | None = None,
    existing_thumbnail: str | None = None,
    youtube_id: str | None = None,
    youtube_title: str | None = None,
) -> dict:
    """
    Run the multi-provider identification pipeline.

    Delegates to api.services.identification.pipeline.identify and translates
    the consensus result to the shape index_asset expects (`thumbnail`,
    `identity_source`, etc.). Falls back to filename-derived title when no
    provider produces one and `fallback_title` is given.
    """
    from api.services.identification.pipeline import identify as pipeline_identify

    hints = {
        "existing_title": existing_title,
        "existing_artist": existing_artist,
        "existing_year": existing_year,
        "existing_thumbnail": existing_thumbnail,
        "youtube_id": youtube_id,
        "youtube_title": youtube_title,
    }
    result = await pipeline_identify(file_path, track_id, hints=hints)

    title = (result.get("title") or "").strip() or None
    display_artist = (result.get("display_artist") or result.get("artist") or "").strip() or None
    artist = display_artist

    if (not title or _is_generic_title(title)) and fallback_title:
        cleaned = re.sub(
            r"\s*[\(\[].*[\)\]]|\s+-\s+(?:official.*|lyric.*)|\s+\|\s+.*$",
            "",
            fallback_title,
            flags=re.IGNORECASE,
        ).strip(" -")
        title = cleaned or fallback_title
        result["sources"] = (result.get("sources") or []) + ["filename_fallback"]

    if _is_generic_title(title):
        title = None
    if _is_generic_artist(artist):
        artist = None

    if title and artist:
        artist, title = _recover_artist_from_yt_title(artist, title)
        display_artist = artist

    if not title:
        return {
            "status": "unidentified",
            "reason": "generic_or_missing_metadata",
            "raw_fp": result.get("raw_fp"),
            "identity_source": (result.get("sources") or ["unknown"])[0],
            "confidence": result.get("confidence", 0.0),
            "evidence": result.get("evidence"),
        }

    sources = result.get("sources") or []
    primary_source = sources[0] if sources else "unknown"

    return {
        "status": result.get("status", "identified"),
        "title": title,
        "artist": display_artist or artist or "",
        "display_artist": display_artist or artist or "",
        "primary_artist": result.get("primary_artist"),
        "artists": result.get("artists") or [],
        "album": result.get("album"),
        "albums": result.get("albums") or [],
        "track_number": result.get("track_number"),
        "disc_number": result.get("disc_number"),
        "duration": result.get("duration"),
        "mb_recording_id": result.get("mb_recording_id"),
        "discogs_id": result.get("discogs_id"),
        "spotify_id": result.get("spotify_id"),
        "isrc": result.get("isrc"),
        "canonical_title": result.get("canonical_title"),
        "canonical_artist": result.get("canonical_artist"),
        "version_type": result.get("version_type"),
        "featured_artists": result.get("featured_artists"),
        "thumbnail": result.get("cover_image"),
        "label": result.get("label"),
        "year": result.get("year"),
        "raw_fp": result.get("raw_fp"),
        "identity_source": primary_source,
        "confidence": result.get("confidence"),
        "all_sources": result.get("all_sources"),
        "discogs_confidence": result.get("confidence") if "discogs" in sources else None,
        "discogs_reasons": result.get("reasons"),
        "shazam_key": result.get("shazam_key"),
        "shazam_url": result.get("shazam_url"),
        "evidence": result.get("evidence"),
    }


async def index_asset(
    asset_id: str,
    allow_identity_resolution: bool = True,
    overwrite_manual: bool = False,
) -> dict:
    from api.ws.endpoint import get_manager as get_ws_manager
    from api.services.status_enricher import clear_track_cache

    conn = database.get_connection()
    try:
        asset = database.get_asset(conn, asset_id)
        if not asset:
            return {"status": "failed", "reason": "asset_not_found"}
        track = database.get_track(conn, asset["track_id"])
        if not track:
            return {"status": "failed", "reason": "track_not_found"}
        track_id = track["id"]
        file_path = asset["file_path"]
        fallback_title = track.get("title") or Path(file_path).stem
        source = str(asset.get("source") or "").strip().lower()
        youtube_id = asset.get("source_ref") if source == "youtube" else None
        youtube_title = None
        if youtube_id:
            download = database.get_download(conn, youtube_id)
            youtube_title = (download or {}).get("title")
        manual_override = database.get_track_identity_override(conn, track_id)
        manual_locked = bool(manual_override and manual_override.get("locked") and not overwrite_manual)
    finally:
        conn.close()

    meta = await identify_track(
        file_path,
        track_id,
        fallback_title=fallback_title,
        existing_title=track.get("title"),
        existing_artist=track.get("artist"),
        existing_year=track.get("year"),
        existing_thumbnail=track.get("thumbnail"),
        youtube_id=youtube_id,
        youtube_title=youtube_title,
    )
    logger.info(
        "index_asset %s: status=%s confidence=%s sources=%s",
        asset_id, meta.get("status"), meta.get("confidence"), meta.get("all_sources"),
    )
    if manual_locked:
        logger.info(
            "index_asset %s: preserving manual identity override for track %s",
            asset_id,
            track_id,
        )

    track_update: dict = {"status": meta["status"]}
    if meta["status"] in ("identified", "low_confidence"):
        track_update.update({
            "title": meta.get("title"),
            "display_artist": meta.get("display_artist") or meta.get("artist"),
            "artist": meta.get("display_artist") or meta.get("artist"),
            "duration": meta.get("duration"),
            "mb_recording_id": meta.get("mb_recording_id"),
            "isrc": meta.get("isrc"),
            "spotify_id": meta.get("spotify_id"),
            "discogs_id": meta.get("discogs_id"),
            "label": meta.get("label"),
            "year": meta.get("year"),
        })
        if meta.get("thumbnail"):
            cached_thumbnail = await asyncio.to_thread(
                cache_remote_cover_candidates_sync,
                track_id,
                [meta.get("thumbnail")],
                "identified",
            )
            track_update["thumbnail"] = cached_thumbnail or meta["thumbnail"]

    bpm = await detect_bpm(file_path)
    if bpm:
        track_update["bpm"] = bpm
    if meta.get("raw_fp"):
        track_update["fingerprint"] = meta["raw_fp"]

    current_track_id = track_id
    conn = database.get_connection()
    try:
        asset = database.get_asset(conn, asset_id)
        if not asset:
            return {"status": "failed", "reason": "asset_not_found"}
        track = database.get_track(conn, asset["track_id"])
        if not track:
            return {"status": "failed", "reason": "track_not_found"}

        database.record_asset_identification_result(conn, asset_id, meta)
        database.update_asset_analysis(conn, asset_id, {
            "analysis_status": meta["status"],
            "duration": track_update.get("duration"),
            "bpm": track_update.get("bpm"),
            "fingerprint": track_update.get("fingerprint"),
            "asset_type": meta.get("version_type") if meta.get("version_type") != "ORIGINAL_MIX" else None,
        })

        if not manual_locked:
            if overwrite_manual and manual_override:
                database.delete_track_identity_override(conn, track["id"])
            can_update_track = (
                overwrite_manual
                or track.get("status") in (None, "", "pending_identity", "unidentified")
                or not track.get("title")
                or not track.get("artist")
            )
            if can_update_track:
                database.update_track_metadata(conn, track["id"], track_update)
            else:
                partial_update = {}
                for field in ("thumbnail", "discogs_id", "label", "year", "duration", "mb_recording_id", "isrc", "spotify_id"):
                    if track_update.get(field) and not track.get(field):
                        partial_update[field] = track_update[field]
                partial_update.update(_canonical_display_update(track, meta))
                if partial_update:
                    database.update_track_metadata(conn, track["id"], partial_update)
            if meta["status"] in ("identified", "low_confidence"):
                database.set_track_artist_credits(
                    conn,
                    track["id"],
                    meta.get("artists") or [],
                    display_artist=meta.get("display_artist") or meta.get("artist"),
                    source=meta.get("identity_source"),
                )
                albums = meta.get("albums") or ([meta.get("album")] if meta.get("album") else [])
                database.set_track_albums(
                    conn,
                    track["id"],
                    albums,
                    track_number=meta.get("track_number"),
                    disc_number=meta.get("disc_number"),
                    source=meta.get("identity_source"),
                )
        conn.commit()
        current_track_id = track["id"]
    except Exception as e:
        conn.rollback()
        logger.error(f"Error saving analysis for asset {asset_id}: {e}")
    finally:
        conn.close()

    resolved_track_id = current_track_id
    if allow_identity_resolution and meta.get("status") == "identified" and not manual_locked:
        resolved_track_id = await asyncio.to_thread(_resolve_identity, asset_id, meta) or current_track_id

    conn = database.get_connection()
    try:
        full_track = database.get_track(conn, resolved_track_id)
    finally:
        conn.close()

    ws_manager = get_ws_manager()
    if full_track:
        clear_track_cache(
            track_id=resolved_track_id,
            filepath=full_track.get("file_path") or full_track.get("filepath"),
        )

    if ws_manager and full_track:
        await ws_manager.broadcast({
            "type": "event.track_updated",
            "payload": full_track,
            "ts": int(time.time() * 1000),
        })
        logger.info(f"UI notified via WebSocket for Track {resolved_track_id}")

    meta["track_id"] = resolved_track_id
    meta["asset_id"] = asset_id
    if manual_override:
        meta["manual_override"] = manual_override
    return meta


async def index_file(track_id: str, file_path: str) -> dict:
    conn = database.get_connection()
    try:
        asset = database.get_asset_by_path(conn, file_path)
        if not asset:
            fast_asset = database.get_fast_play_asset(conn, track_id)
            asset = fast_asset if fast_asset and fast_asset.get("file_path") == file_path else None
    finally:
        conn.close()

    if not asset:
        return {"status": "failed", "reason": "asset_not_found"}
    return await index_asset(asset["id"], allow_identity_resolution=False)


def _canonical_display_update(track: dict, meta: dict) -> dict:
    canonical_title = meta.get("canonical_title") or meta.get("title")
    identity_artist = (
        (meta.get("primary_artist") or {}).get("name")
        if isinstance(meta.get("primary_artist"), dict)
        else None
    ) or meta.get("canonical_artist") or meta.get("display_artist") or meta.get("artist")
    display_artist = meta.get("display_artist") or meta.get("artist") or identity_artist
    if not canonical_title or not identity_artist:
        return {}

    existing = canonicalize(track.get("artist"), track.get("title"))
    incoming = canonicalize(identity_artist, canonical_title)
    if not incoming.artist_key or not incoming.title_key:
        return {}

    same_identity = (
        existing.artist_key == incoming.artist_key
        and existing.title_key == incoming.title_key
    )
    generic_existing = _is_generic_title(track.get("title")) or _is_generic_artist(track.get("artist"))
    if not same_identity and not generic_existing:
        return {}

    update: dict = {}
    if track.get("title") != incoming.canonical_title:
        update["title"] = incoming.canonical_title
    if display_artist and track.get("display_artist", track.get("artist")) != display_artist:
        update["display_artist"] = display_artist
        update["artist"] = display_artist
    return update


def _resolve_identity(asset_id: str, meta: dict) -> str | None:
    conn = database.get_connection()
    try:
        asset = database.get_asset(conn, asset_id)
        if not asset:
            return None

        source_track_id = asset["track_id"]
        match_meta = dict(meta)
        if meta.get("raw_fp"):
            match_meta["fingerprint"] = meta["raw_fp"]

        matches = database.find_identity_matches(conn, match_meta, exclude_track_id=source_track_id)
        if not matches:
            return source_track_id

        best = matches[0]
        inferred_asset_type = _infer_asset_type(
            meta.get("title") or "",
            asset.get("asset_type"),
            meta.get("version_type"),
        )

        if best["score"] >= 0.93:
            target_track = database.get_track(conn, best["track_id"])
            new_path = _move_asset_to_track_bundle(asset, best["track_id"], inferred_asset_type)
            if new_path and new_path != asset["file_path"]:
                database.update_asset_path(conn, asset_id, new_path)
            database.reassign_asset(
                conn,
                asset_id=asset_id,
                target_track_id=best["track_id"],
                asset_type=inferred_asset_type,
                set_primary=False,
            )
            if target_track:
                display_update = _canonical_display_update(target_track, meta)
                if display_update:
                    database.update_track_metadata(conn, best["track_id"], display_update)
            database.add_identity_candidate(
                conn,
                asset_id,
                best["track_id"],
                best["score"],
                best["reasons"],
                status="auto_merged",
            )
            conn.commit()
            logger.info(
                "IdentityResolver: auto-merged asset %s into track %s (score %.2f)",
                asset_id,
                best["track_id"],
                best["score"],
            )
            return best["track_id"]

        for match in matches:
            if match["score"] >= 0.72:
                database.add_identity_candidate(
                    conn,
                    asset_id,
                    match["track_id"],
                    match["score"],
                    match["reasons"],
                    status="pending",
                )
                logger.info(
                    "IdentityResolver: candidate asset %s -> track %s (score %.2f)",
                    asset_id,
                    match["track_id"],
                    match["score"],
                )
        conn.commit()
        return source_track_id
    except Exception as e:
        conn.rollback()
        logger.error(f"IdentityResolver failed for asset {asset_id}: {e}")
        return None
    finally:
        conn.close()


def _infer_asset_type(title: str, current_type: str | None, version_type: str | None = None) -> str:
    current = (current_type or "ORIGINAL_MIX").upper()
    if version_type and version_type != "ORIGINAL_MIX":
        return version_type
    text = title.lower()
    rules = [
        ("REMIX", r"\bremix\b|rework|edit mix"),
        ("LIVE", r"\blive\b|ao vivo|concert"),
        ("DEMO", r"\bdemo\b|rough|sketch"),
        ("INSTRUMENTAL", r"instrumental|karaoke"),
        ("RADIO_EDIT", r"radio edit|single edit"),
        ("ALT_VERSION", r"\balt\b|alternate|alternative|version|take|unreleased|leak"),
    ]
    for asset_type, pattern in rules:
        if re.search(pattern, text):
            return asset_type
    return "ALT_VERSION" if current == "ORIGINAL_MIX" else current


def _move_asset_to_track_bundle(asset: dict, target_track_id: str, asset_type: str) -> str | None:
    source_path = Path(asset["file_path"])
    if not source_path.exists():
        return None

    music_dir = Path(cfg.get("music_directory", "./music"))
    target_dir = music_dir / target_track_id
    target_dir.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^a-zA-Z0-9_]+", "_", asset_type.lower()).strip("_") or "asset"
    target_path = target_dir / f"{stem}{source_path.suffix.lower()}"
    while target_path.exists():
        target_path = target_dir / f"{stem}_{uuid.uuid4().hex[:8]}{source_path.suffix.lower()}"

    if source_path.resolve() == target_path.resolve():
        return str(source_path)

    shutil.move(str(source_path), str(target_path))
    return str(target_path)
