# utils/monitor_accumulator.py
import asyncio
import logging
from collections import deque
from time import time

from utils import core_client

logger = logging.getLogger(__name__)


class MonitorAccumulator:
    def __init__(self):
        self._poll_interval: float = 0.02   # overridden in start() from config
        self._buf: deque = deque(maxlen=300) # ~6s at default 20ms poll
        self._last_seq: int = 0
        self._threshold: float = 0.0
        self._recording: bool = False
        self._subscribers: set = set()
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        from utils import config as cfg
        self._poll_interval = cfg.get("monitor_poll_ms", 20) / 1000.0
        self._task = asyncio.create_task(self._run())
        logger.info(f"MonitorAccumulator started (poll={self._poll_interval*1000:.0f}ms)")

    def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def _run(self) -> None:
        while True:
            try:
                data = await core_client.get_monitor_samples(self._last_seq)
                if data:
                    samples    = data.get("samples", [])
                    self._threshold = data.get("threshold", self._threshold)
                    self._recording = data.get("recording", self._recording)
                    latest_seq = data.get("latest_seq", self._last_seq)
                    if latest_seq > self._last_seq:
                        self._last_seq = latest_seq

                    if samples:
                        for s in samples:
                            self._buf.append(s)

                        payload = {
                            "samples":   samples,
                            "threshold": self._threshold,
                            "recording": self._recording,
                        }
                        dead = set()
                        for q in self._subscribers:
                            try:
                                if q.full():
                                    try:
                                        q.get_nowait()
                                    except asyncio.QueueEmpty:
                                        pass
                                q.put_nowait(payload)
                            except Exception:
                                dead.add(q)
                        self._subscribers -= dead

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug(f"MonitorAccumulator poll error: {e}")

            await asyncio.sleep(self._poll_interval)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def get_backfill(self) -> list:
        cutoff = time() - 2.0
        return [s for s in self._buf if s["ts"] >= cutoff]

    def latest_state(self) -> dict:
        rms = self._buf[-1]["rms"] if self._buf else 0.0
        return {
            "threshold":  self._threshold,
            "recording":  self._recording,
            "latest_seq": self._last_seq,
            "rms_level":  rms,
        }


# Module-level singleton — imported by monitor.py and wired up in app.py lifespan
_accumulator = MonitorAccumulator()


def get_accumulator() -> MonitorAccumulator:
    return _accumulator
