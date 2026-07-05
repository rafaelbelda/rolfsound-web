from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)

# Baixa taxa proposital: só precisamos de um envelope de amplitude, não de
# detalhe espectral, então decodificar a 11025 Hz é bem mais rápido que no
# sample rate original e o resultado visual é idêntico.
TARGET_SR = 11025
DEFAULT_BUCKETS = 1600


class WaveformExtractionError(RuntimeError):
    """Raised when the audio file can't be decoded into a peak envelope."""


async def extract_peaks(file_path: str, buckets: int = DEFAULT_BUCKETS) -> list[float]:
    """Decodifica file_path (PyAV) e reduz a `buckets` valores de pico 0..1 —
    o formato real da onda da faixa inteira. Decodificação é CPU-bound then
    roda numa thread pra não travar o event loop."""
    return await asyncio.to_thread(_extract_peaks_sync, file_path, buckets)


def _extract_peaks_sync(file_path: str, buckets: int) -> list[float]:
    import av
    import numpy as np

    frames: list[np.ndarray] = []
    with av.open(file_path) as container:
        resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=TARGET_SR)
        for packet in container.demux(audio=0):
            for frame in packet.decode():
                resampled = resampler.resample(frame)
                for rf in (resampled if isinstance(resampled, list) else [resampled]):
                    arr = rf.to_ndarray().flatten()
                    if arr.size:
                        frames.append(arr)

    if not frames:
        raise WaveformExtractionError(f"no audio frames decoded from {file_path}")

    samples = np.concatenate(frames).astype(np.float32) / 32768.0
    n = samples.size
    if n == 0:
        raise WaveformExtractionError(f"empty audio stream: {file_path}")

    buckets = max(1, min(buckets, n))
    edges = np.linspace(0, n, buckets + 1, dtype=np.int64)
    peaks = np.empty(buckets, dtype=np.float32)
    for i in range(buckets):
        lo, hi = edges[i], edges[i + 1]
        chunk = samples[lo:hi] if hi > lo else samples[lo:lo + 1]
        peaks[i] = np.abs(chunk).max() if chunk.size else 0.0

    top = float(peaks.max()) or 1.0
    normalized = np.minimum(peaks / top, 1.0)
    return [round(float(p), 4) for p in normalized]
