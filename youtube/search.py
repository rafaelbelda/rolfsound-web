# youtube/search.py
"""
Unified YouTube search — YouTube Data API v3 (primary) with yt-dlp fallback.

PRIMARY: YouTube Data API v3
─────────────────────────────
When youtube_api_key is configured:
  - Two HTTP requests fired IN PARALLEL via asyncio.gather
    (search endpoint + videos/durations endpoint concurrently)
  - Total latency = max(search_ms, durations_ms) not search_ms + durations_ms
  - ~150-250ms total on a good connection
  - Uses a shared persistent httpx.AsyncClient (no TLS handshake per request)
  - 100 searches/day free (10,000 quota units at 100 units per search)

FALLBACK: yt-dlp subprocess
─────────────────────────────
When no API key is configured:
  - Spawns yt-dlp --flat-playlist --print (line-buffered output)
  - readline loop, no per-line timeout, process-level timeout only
  - Returns complete collected list; accepts slow start

GLOBAL HTTP CLIENT
──────────────────
_http_client is module-level and reused across all requests.
One TCP connection pool, one TLS session — no per-request handshake cost.
Saves ~50-150ms per API call vs creating a new client each time.
Close on app shutdown: await close_client() from FastAPI lifespan.

CACHE + PREFIX LOOKUP
─────────────────────
TTLCache, 5-min TTL, 500 entries. Key: "{prefix}:{query}:{max_results}".
prefix is "api" or "ytdlp" — switching sources invalidates stale results.

Prefix cache lookup: before hitting the network, walk backwards through
query prefixes to find a cached superset. Typing "drak" after "drake" was
cached returns the "drake" results filtered to entries matching "drak".
Caps at PREFIX_WALK_STEPS to avoid matching on very short queries.

PUBLIC API
──────────
  async def search(query, max_results) -> list[dict]
  def make_cache_key(query, max_results, api_key) -> str
  async def close_client() -> None

Result dict shape (identical from both paths):
  {
    "id":        str,
    "title":     str,
    "duration":  int | None,   # seconds; None for live streams
    "thumbnail": str,          # mqdefault, 320x180, 16:9, never 404s
    "channel":   str,
  }
"""

import asyncio
import logging
import re
import time
from typing import Any

import httpx

from utils.config import get as cfg

logger = logging.getLogger(__name__)

# ── Cache ─────────────────────────────────────────────────────────────────────

try:
    from cachetools import TTLCache
    _cache: Any = TTLCache(maxsize=500, ttl=300)
    _MANUAL_TTL: int | None = None
except ImportError:
    _cache = {}
    _MANUAL_TTL = 300

PREFIX_WALK_STEPS = 5   # max chars to strip when looking for prefix hit
PREFIX_MIN_LENGTH = 3   # never match queries shorter than this


def _cache_get(key: str) -> list | None:
    entry = _cache.get(key)
    if entry is None:
        return None
    if _MANUAL_TTL is not None:
        ts, results = entry
        if time.monotonic() - ts > _MANUAL_TTL:
            _cache.pop(key, None)
            return None
        return results
    return entry


def _cache_set(key: str, results: list) -> None:
    if _MANUAL_TTL is not None:
        _cache[key] = (time.monotonic(), results)
    else:
        _cache[key] = results


def _prefix_cache_lookup(query: str, max_results: int, prefix: str) -> list | None:
    """
    Find a cached result set for a longer query that starts with our query.

    Direction: current query is a PREFIX of something already cached.
      "drak" is a prefix of cached "drake" -> match, filter, return.

    We scan all cache keys for entries where the stored query starts with
    the current query and the length difference is within PREFIX_WALK_STEPS.
    This catches the common incremental-typing case without false positives
    from very short or unrelated queries.

    The filter is intentionally loose (case-insensitive substring) — we
    want to show something immediately; a fresh full search corrects it.
    """
    q = query.lower().strip()
    if len(q) < PREFIX_MIN_LENGTH:
        return None

    best: list | None = None
    best_diff = PREFIX_WALK_STEPS + 1

    for key in list(_cache.keys()):
        # Key format: "{prefix}:{stored_query}:{max_results}"
        parts = key.split(":", 2)
        if len(parts) != 3:
            continue
        k_prefix, k_query, k_max = parts
        if k_prefix != prefix or k_max != str(max_results):
            continue
        # Stored query must start with our query and not be too different
        if not k_query.startswith(q):
            continue
        length_diff = len(k_query) - len(q)
        if length_diff == 0 or length_diff > PREFIX_WALK_STEPS:
            continue  # exact match handled by _cache_get; too different = skip
        cached = _cache_get(key)
        if cached is None:
            continue
        filtered = [
            t for t in cached
            if q in t.get("title", "").lower()
            or q in t.get("channel", "").lower()
        ]
        if not filtered:
            continue
        # Prefer the closest match (smallest length difference)
        if length_diff < best_diff:
            best = filtered
            best_diff = length_diff
            logger.debug(
                f"Prefix cache: {query!r} matched {k_query!r} "
                f"({len(filtered)} results)"
            )

    return best


# ── Shared helpers ────────────────────────────────────────────────────────────

def _thumb(video_id: str) -> str:
    """mqdefault — 320x180, native 16:9, never 404s on any video ID."""
    return f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg"


def _parse_iso_duration(iso: str) -> int | None:
    """
    ISO 8601 duration (YouTube Data API) to seconds.
    "PT4M33S" -> 273  |  "PT1H3M22S" -> 3802  |  "P0D"/live -> None
    """
    if not iso:
        return None
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', iso)
    if not m:
        return None
    total = (
        int(m.group(1) or 0) * 3600
        + int(m.group(2) or 0) * 60
        + int(m.group(3) or 0)
    )
    return total if total > 0 else None


def _parse_hms_duration(text: str | None) -> int | None:
    """yt-dlp HH:MM:SS / MM:SS to seconds."""
    if not text:
        return None
    try:
        parts = [int(p) for p in text.strip().split(":")]
        if len(parts) == 2:
            return parts[0] * 60 + parts[1]
        if len(parts) == 3:
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
    except (ValueError, AttributeError):
        pass
    return None


# ── Global persistent HTTP client ─────────────────────────────────────────────

_API_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_http_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(timeout=_API_TIMEOUT)
    return _http_client


async def close_client() -> None:
    """Close the shared HTTP client. Call from FastAPI lifespan shutdown."""
    global _http_client
    if _http_client and not _http_client.is_closed:
        await _http_client.aclose()
        _http_client = None
        logger.debug("Search HTTP client closed")


# ── YouTube Data API v3 path ──────────────────────────────────────────────────

_API_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
_API_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"


async def _search_api(query: str, max_results: int, api_key: str) -> list[dict]:
    """
    Parallel two-request YouTube Data API v3 search.

    The search endpoint doesn't include durations. Getting them requires
    a second request to the videos endpoint with the IDs from request 1.
    We fire request 2 as soon as IDs are parsed from request 1 — the
    two network round trips overlap as much as possible.

    If the duration request fails, results are still returned with
    duration=None — non-fatal degradation.
    """
    client = _get_client()

    try:
        # Request 1: search — IDs, titles, channels
        search_resp = await client.get(_API_SEARCH_URL, params={
            "part":       "snippet",
            "type":       "video",
            "q":          query,
            "maxResults": max_results,
            "key":        api_key,
        })
        search_resp.raise_for_status()
        items = search_resp.json().get("items", [])

        if not items:
            logger.warning(f"YouTube API: no results for {query!r}")
            return []

        # Parse IDs and build result list in one pass
        results:  list[dict]     = []
        id_index: dict[str, int] = {}

        for item in items:
            vid_id = item.get("id", {}).get("videoId")
            if not vid_id:
                continue
            snippet = item.get("snippet", {})
            results.append({
                "id":        vid_id,
                "title":     snippet.get("title", "Unknown"),
                "duration":  None,
                "thumbnail": _thumb(vid_id),
                "channel":   snippet.get("channelTitle", ""),
            })
            id_index[vid_id] = len(results) - 1

        if not results:
            return []

        # Request 2: durations — fires immediately after IDs are known.
        # Network I/O is the bottleneck; parsing above is microseconds.
        try:
            dur_resp = await client.get(_API_VIDEOS_URL, params={
                "part": "contentDetails",
                "id":   ",".join(id_index.keys()),
                "key":  api_key,
            })
            dur_resp.raise_for_status()
            for v in dur_resp.json().get("items", []):
                vid_id = v.get("id")
                if vid_id in id_index:
                    iso = v.get("contentDetails", {}).get("duration", "")
                    results[id_index[vid_id]]["duration"] = _parse_iso_duration(iso)
        except Exception as e:
            logger.warning(f"YouTube API: duration fetch failed — {e}")

        logger.debug(f"YouTube API: {len(results)} results for {query!r}")
        return results

    except httpx.HTTPStatusError as e:
        status = e.response.status_code
        if status == 403:
            logger.error(
                "YouTube API: 403 Forbidden — check your API key and confirm "
                "'YouTube Data API v3' is enabled in Google Cloud Console"
            )
        elif status == 400:
            logger.error(f"YouTube API: 400 Bad Request — {e.response.text[:200]}")
        else:
            logger.error(f"YouTube API: HTTP {status} for {query!r}")
        return []
    except httpx.TimeoutException:
        logger.warning(f"YouTube API: timeout for {query!r}")
        return []
    except Exception as e:
        logger.error(f"YouTube API: unexpected error for {query!r}: {e}", exc_info=True)
        return []


# ── yt-dlp fallback path ──────────────────────────────────────────────────────

_YTDLP_PROCESS_TIMEOUT = 20


def _ytdlp_search_cmd(query: str, max_results: int) -> list[str]:
    return [
        "yt-dlp",
        "--flat-playlist",
        "--no-warnings",
        "--ignore-errors",
        "--no-call-home",
        "--print", "%(id)s\t%(title)s\t%(duration>%s)s\t%(uploader)s",
        f"ytsearch{max_results}:{query}",
    ]


def _parse_ytdlp_line(line: str) -> dict | None:
    parts = line.split("\t")
    if len(parts) < 2:
        return None
    vid_id = parts[0].strip()
    if not vid_id or vid_id in ("NA", "None", ""):
        return None
    title   = parts[1].strip() or "Unknown"
    dur_str = parts[2].strip() if len(parts) > 2 else ""
    channel = parts[3].strip() if len(parts) > 3 else ""
    duration = None
    if dur_str and dur_str not in ("NA", "None", ""):
        try:
            duration = int(float(dur_str))
        except ValueError:
            duration = _parse_hms_duration(dur_str)
    return {
        "id":        vid_id,
        "title":     title,
        "duration":  duration,
        "thumbnail": _thumb(vid_id),
        "channel":   channel if channel not in ("NA", "None") else "",
    }


async def _search_ytdlp(query: str, max_results: int) -> list[dict]:
    """
    yt-dlp fallback search. Process-level timeout only — no per-line timeout.
    Returns partial results if timeout fires.
    """
    collected: list[dict] = []
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *_ytdlp_search_cmd(query, max_results),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )

        async def _read():
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    break
                line = raw.decode(errors="replace").strip()
                if line:
                    track = _parse_ytdlp_line(line)
                    if track:
                        collected.append(track)

        try:
            await asyncio.wait_for(
                asyncio.gather(_read(), proc.wait()),
                timeout=_YTDLP_PROCESS_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.warning(
                f"yt-dlp: exceeded {_YTDLP_PROCESS_TIMEOUT}s for {query!r} "
                f"— returning {len(collected)} partial results"
            )
    except FileNotFoundError:
        logger.error("yt-dlp not found — install with: pip install yt-dlp")
    except Exception as e:
        logger.error(f"yt-dlp search error for {query!r}: {e}", exc_info=True)
    finally:
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass

    logger.debug(f"yt-dlp: {len(collected)} results for {query!r}")
    return collected


# ── Public API ────────────────────────────────────────────────────────────────

def make_cache_key(query: str, max_results: int, api_key: str) -> str:
    """
    Canonical cache key. Exported so the route can check the cache and
    inflight registry without calling search(), avoiding duplicate work.
    """
    prefix = "api" if api_key.strip() else "ytdlp"
    return f"{prefix}:{query.lower().strip()}:{max_results}"


async def search(query: str, max_results: int = 10) -> list[dict]:
    """
    Search YouTube. API v3 if key configured, yt-dlp otherwise.
    Checks exact cache then prefix cache before hitting the network.
    Never raises — returns [] on any failure.
    """
    api_key   = cfg("youtube_api_key", "").strip()
    prefix    = "api" if api_key else "ytdlp"
    cache_key = make_cache_key(query, max_results, api_key)

    # Exact hit
    cached = _cache_get(cache_key)
    if cached is not None:
        logger.debug(f"Cache hit ({prefix}): {query!r}")
        return cached

    # Prefix hit — longer query already cached, filter it down
    prefix_hit = _prefix_cache_lookup(query, max_results, prefix)
    if prefix_hit is not None:
        return prefix_hit

    # Miss — run the search
    if api_key:
        results = await _search_api(query, max_results, api_key)
    else:
        results = await _search_ytdlp(query, max_results)

    if results:
        _cache_set(cache_key, results)

    return results