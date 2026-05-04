from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from utils import config as cfg

from .keys import normalize_key

logger = logging.getLogger(__name__)
PROJECT_ROOT = Path(__file__).resolve().parents[3]


class AudioAnalysisError(RuntimeError):
    """Raised when the external MIR extractor cannot produce usable output."""


def _configured_extractor_path() -> str:
    return str(cfg.get("essentia_extractor_path", "essentia_streaming_extractor_music") or "").strip()


def _repo_local_extractor_paths() -> list[Path]:
    if os.name == "nt":
        names = [
            "essentia_streaming_extractor_music.exe",
            "streaming_extractor_music.exe",
        ]
    else:
        names = [
            "essentia_streaming_extractor_music",
            "streaming_extractor_music",
        ]
    return [PROJECT_ROOT / "tools" / "essentia" / name for name in names]


def _resolve_executable(path_value: str) -> str:
    if not path_value:
        raise AudioAnalysisError("essentia_extractor_path is empty")

    path = Path(path_value)
    if path.is_absolute() or os.sep in path_value or (os.altsep and os.altsep in path_value):
        resolved = path.resolve(strict=False)
        if not resolved.exists():
            raise AudioAnalysisError(f"Essentia extractor not found: {resolved}")
        return str(resolved)

    for local in _repo_local_extractor_paths():
        if local.exists():
            return str(local.resolve(strict=False))

    found = shutil.which(path_value)
    if not found:
        raise AudioAnalysisError(f"Essentia extractor not found on PATH: {path_value}")
    return found


def _configured_profile_path() -> str | None:
    value = str(cfg.get("essentia_profile_path", "./config/essentia_profile.yaml") or "").strip()
    if not value:
        return None
    path = Path(value).resolve(strict=False)
    return str(path) if path.exists() else None


def _ffmpeg_executable() -> str:
    configured = str(cfg.get("ffmpeg_path", "") or "").strip()
    if configured:
        return _resolve_executable(configured)

    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        found = shutil.which("ffmpeg")
        if found:
            return found
    raise AudioAnalysisError("ffmpeg not found for audio-analysis transcode fallback")


def _needs_transcode_fallback(exc: AudioAnalysisError) -> bool:
    message = str(exc).lower()
    return any(token in message for token in (
        "process step: read metadata",
        "read metadata",
        "supported filetype",
        "metadatareader",
        "pcmmetadata",
        "cannot read files which are neither",
        "could not open codec",
    ))


def _decode_process_message(stdout: bytes, stderr: bytes, *, label: str, returncode: int) -> str:
    parts: list[str] = []
    for stream in (stderr, stdout):
        text = stream.decode("utf-8", errors="replace").strip()
        if text and text not in parts:
            parts.append(text)
    return "\n".join(parts) or f"{label} exited with code {returncode}"


async def _run_process(cmd: list[str], *, timeout: float, label: str) -> tuple[bytes, bytes]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise AudioAnalysisError(f"{label} executable not found: {cmd[0]}") from exc

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise AudioAnalysisError(f"{label} timed out after {timeout:.0f}s") from exc

    if proc.returncode != 0:
        message = _decode_process_message(stdout, stderr, label=label, returncode=proc.returncode)
        raise AudioAnalysisError(message)

    return stdout, stderr


async def _run_extractor_once(
    extractor: str,
    input_path: str,
    output_path: str,
    profile: str | None,
    timeout: float,
) -> dict[str, Any]:
    cmd = [extractor, input_path, output_path]
    if profile:
        cmd.append(profile)

    await _run_process(cmd, timeout=timeout, label="Essentia analysis")

    try:
        with open(output_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError as exc:
        raise AudioAnalysisError("Essentia did not write an output JSON file") from exc
    except json.JSONDecodeError as exc:
        raise AudioAnalysisError(f"Essentia output is not valid JSON: {exc}") from exc


async def _transcode_to_wav(source_path: str, output_path: str, *, timeout: float) -> None:
    ffmpeg = _ffmpeg_executable()
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        source_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "44100",
        "-sample_fmt",
        "s16",
        output_path,
    ]
    await _run_process(cmd, timeout=timeout, label="Audio-analysis transcode")


async def run_essentia_extractor(file_path: str, *, timeout_s: float | None = None) -> dict[str, Any]:
    extractor = _resolve_executable(_configured_extractor_path())
    timeout = float(timeout_s if timeout_s is not None else cfg.get("audio_analysis_timeout_seconds", 240))
    profile = _configured_profile_path()

    with tempfile.TemporaryDirectory(prefix="rolfsound_essentia_") as tmpdir:
        output_path = str(Path(tmpdir) / "analysis.json")
        try:
            return await _run_extractor_once(
                extractor,
                file_path,
                output_path,
                profile,
                timeout,
            )
        except AudioAnalysisError as exc:
            if not _needs_transcode_fallback(exc):
                raise
            wav_path = str(Path(tmpdir) / "analysis_input.wav")
            logger.info("Essentia direct analysis failed; retrying via WAV fallback for %s", file_path)
            await _transcode_to_wav(file_path, wav_path, timeout=timeout)
            return await _run_extractor_once(
                extractor,
                wav_path,
                output_path,
                profile,
                timeout,
            )


def _lookup(data: dict[str, Any], *paths: str) -> Any:
    for path in paths:
        if path in data:
            return data[path]
        current: Any = data
        found = True
        for part in path.split("."):
            if isinstance(current, dict) and part in current:
                current = current[part]
            else:
                found = False
                break
        if found:
            return current
    return None


def _float_or_none(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    return round(number, 2)


def parse_essentia_json(data: dict[str, Any]) -> dict[str, Any]:
    bpm = _float_or_none(_lookup(data, "rhythm.bpm"))
    key = None

    root_note = _lookup(
        data,
        "tonal.key_key",
        "tonal.key",
    )
    root_scale = _lookup(
        data,
        "tonal.key_scale",
        "tonal.scale",
    )
    key = normalize_key(root_note, root_scale)

    if not key:
        for algorithm in ("key_edma", "key_krumhansl", "key_temperley"):
            note = _lookup(
                data,
                f"tonal.{algorithm}.key",
                f"tonal.{algorithm}_key",
                f"tonal.{algorithm}",
            )
            scale = _lookup(
                data,
                f"tonal.{algorithm}.scale",
                f"tonal.{algorithm}_scale",
            )
            if isinstance(note, dict):
                scale = note.get("scale") if scale is None else scale
                note = note.get("key")
            key = normalize_key(note, scale)
            if key:
                break

    if not key:
        key = normalize_key(
            _lookup(data, "tonal.chords_key"),
            _lookup(data, "tonal.chords_scale"),
        )

    return {
        "bpm": bpm,
        "musical_key": key.musical_key if key else None,
        "camelot_key": key.camelot_key if key else None,
    }


async def analyze_file(file_path: str) -> dict[str, Any]:
    raw = await run_essentia_extractor(file_path)
    analysis = parse_essentia_json(raw)
    if not any(analysis.values()):
        raise AudioAnalysisError("Essentia output did not include BPM or musical key")
    return analysis
