"""
Shazam recognizer with adaptive snippet selection.

Two improvements over the original lookup_shazam:

1. Loudness-aware snippet picking. We compute RMS over 1-second windows and
   choose snippets centered on the loudest regions. This avoids submitting
   silent intros / quiet outros that Shazam reliably fails on.

2. Two-pass strategy. If the first batch of (up to) 4 snippets all miss, we
   try a second batch with different offsets — same loud regions but shifted
   by half a snippet so we cover the boundaries. Total cost is bounded
   (max 8 snippets per file) and the per-snippet timeout is unchanged.

Subprocess isolation, output format, and the WAV-on-disk handoff are kept
identical to indexer.py so we can keep using `_shazam_worker.py`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

logger = logging.getLogger(__name__)

_SHAZAM_WORKER = str(Path(__file__).parent.parent / "_shazam_worker.py")
_SHAZAM_TIMEOUT = 30
_TARGET_SR = 16000
_MAX_SECONDS = 120


def _decode_mono_pcm(file_path: str) -> "tuple[np.ndarray, int]":
    """Decode up to _MAX_SECONDS of audio to int16 mono @ 16 kHz, post-loudnorm."""
    import av
    import numpy as np

    target_pre = "loudnorm=I=-16:TP=-1.5:LRA=11"
    pcm_chunks: list[np.ndarray] = []
    collected = 0
    max_samples = _TARGET_SR * _MAX_SECONDS

    try:
        proc = subprocess.Popen(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-i", file_path,
                "-af", target_pre,
                "-ac", "1", "-ar", str(_TARGET_SR),
                "-f", "s16le", "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if proc.stdout is None:
            raise RuntimeError("ffmpeg has no stdout")
        chunk_size = _TARGET_SR * 2 * 2
        while collected < max_samples:
            buf = proc.stdout.read(chunk_size)
            if not buf:
                break
            arr = np.frombuffer(buf, dtype=np.int16)
            remaining = max_samples - collected
            if len(arr) > remaining:
                arr = arr[:remaining]
            pcm_chunks.append(arr)
            collected += len(arr)
        proc.stdout.close()
        proc.wait(timeout=5)
    except Exception as exc:
        logger.debug("ffmpeg loudnorm decode failed (%s); falling back to PyAV", exc)
        pcm_chunks = []
        collected = 0
        with av.open(file_path) as container:
            resampler = av.audio.resampler.AudioResampler(
                format="s16", layout="mono", rate=_TARGET_SR
            )
            for packet in container.demux(audio=0):
                for frame in packet.decode():
                    resampled = resampler.resample(frame)
                    for rf in (resampled if isinstance(resampled, list) else [resampled]):
                        arr = rf.to_ndarray().reshape(-1)
                        remaining = max_samples - collected
                        if remaining <= 0:
                            break
                        pcm_chunks.append(arr[:remaining].astype(np.int16))
                        collected += min(len(arr), remaining)
                    if collected >= max_samples:
                        break
                if collected >= max_samples:
                    break

    if not pcm_chunks:
        return np.zeros(0, dtype=np.int16), _TARGET_SR
    return np.concatenate(pcm_chunks), _TARGET_SR


def _pick_loud_centers(pcm, sr: int, snippet_seconds: int, k: int) -> list[int]:
    """
    Return up to k window-start indices (in samples) centered on the loudest
    1-second-RMS regions, with minimum spacing of half a snippet between picks.
    """
    import numpy as np

    snippet_samples = int(snippet_seconds * sr)
    if len(pcm) <= snippet_samples:
        return [0]

    win = sr
    n_windows = len(pcm) // win
    if n_windows < 2:
        return [0]

    truncated = pcm[: n_windows * win].astype(np.float32)
    grid = truncated.reshape(n_windows, win)
    rms = np.sqrt(np.mean(grid * grid, axis=1) + 1.0)
    order = np.argsort(rms)[::-1]

    min_spacing = snippet_samples // 2
    picks: list[int] = []
    for idx in order:
        start = max(0, int(idx) * win - snippet_samples // 2)
        start = min(start, len(pcm) - snippet_samples)
        if all(abs(start - existing) >= min_spacing for existing in picks):
            picks.append(start)
        if len(picks) >= k:
            break

    return picks or [0]


def _write_snippets(pcm, sr: int, starts: list[int], snippet_seconds: int) -> tuple[str, list[str]]:
    snippet_samples = int(snippet_seconds * sr)
    tmp_dir = tempfile.mkdtemp(prefix="rolfsound_shazam_")
    paths: list[str] = []
    try:
        for idx, start in enumerate(starts):
            segment = pcm[start:start + snippet_samples]
            if len(segment) < sr * 6:
                continue
            tmp_wav = os.path.join(tmp_dir, f"snippet_{idx}.wav")
            with wave.open(tmp_wav, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sr)
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
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return None
    if not data or not data.get("title"):
        return None
    return {
        "artist": data.get("artist", "") or "",
        "title": data.get("title", "") or "",
        "thumbnail": data.get("thumbnail", "") or "",
        "shazam_key": data.get("shazam_key", "") or "",
        "url": data.get("url", "") or "",
    }


async def lookup_shazam(file_path: str) -> dict | None:
    """
    Two-pass loudness-aware Shazam recognition.

    Pass 1: 4 snippets centered on the loudest regions.
    Pass 2 (only if pass 1 misses): 4 more snippets shifted by half a snippet.

    Returns the first successful recognition or None.
    """
    import numpy as np  # noqa: F401  (used inside worker functions)

    tmp_dir = ""
    try:
        pcm, sr = await asyncio.to_thread(_decode_mono_pcm, file_path)
        total_seconds = len(pcm) / sr if sr else 0
        if total_seconds < 6:
            logger.warning("Shazamio: track too short (%.1fs)", total_seconds)
            return None

        snippet_seconds = min(20, max(8, int(total_seconds / 6)))

        loud_starts = await asyncio.to_thread(_pick_loud_centers, pcm, sr, snippet_seconds, 4)
        tmp_dir, snippets = await asyncio.to_thread(
            _write_snippets, pcm, sr, loud_starts, snippet_seconds
        )

        for snippet in snippets:
            result = await _recognize_snippet(snippet)
            if result:
                logger.info(
                    "Shazamio recognized (pass 1): %s - %s",
                    result.get("artist"), result.get("title"),
                )
                return result

        if total_seconds < 30 or len(loud_starts) < 2:
            logger.info("Shazamio: pass 1 missed; track too short for pass 2")
            return None

        shift = int(sr * snippet_seconds / 2)
        max_start = max(0, len(pcm) - int(sr * snippet_seconds))
        shifted = []
        for start in loud_starts:
            new_start = max(0, min(max_start, start + shift))
            if all(abs(new_start - existing) >= int(sr * snippet_seconds / 2) for existing in loud_starts + shifted):
                shifted.append(new_start)
        if not shifted:
            return None

        shutil.rmtree(tmp_dir, ignore_errors=True)
        tmp_dir, snippets = await asyncio.to_thread(
            _write_snippets, pcm, sr, shifted, snippet_seconds
        )
        for snippet in snippets:
            result = await _recognize_snippet(snippet)
            if result:
                logger.info(
                    "Shazamio recognized (pass 2): %s - %s",
                    result.get("artist"), result.get("title"),
                )
                return result

        logger.info("Shazamio: no match across both passes")
        return None
    except Exception as exc:
        logger.debug("Shazamio lookup failed: %s", exc)
        return None
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
