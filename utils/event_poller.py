# utils/event_poller.py
"""
Polls rolfsound-core for events and dispatches them to registered handlers.
Runs in a background thread.
"""

import logging
import threading
import time
from typing import Callable

from utils import core_client

logger = logging.getLogger(__name__)

POLL_INTERVAL = 0.75  # seconds


class EventPoller:
    def __init__(self):
        self._last_event_id: int = 0
        self._handlers: dict[str, list[Callable]] = {}
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def on(self, event_type: str, handler: Callable) -> None:
        self._handlers.setdefault(event_type, []).append(handler)

    def start(self) -> None:
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._poll_loop,
            name="event-poller",
            daemon=True,
        )
        self._thread.start()
        logger.info("EventPoller started")

    def stop(self) -> None:
        self._stop_event.set()
        logger.info("EventPoller stopped")

    def _poll_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._poll_once()
            except Exception as e:
                logger.error(f"EventPoller error: {e}")
            time.sleep(POLL_INTERVAL)

    def _poll_once(self) -> None:
        result = core_client.get_events(since=self._last_event_id)
        if result is None:
            return

        events = result.get("events", [])
        if not events:
            return

        # Ensure events are sorted by ID
        events.sort(key=lambda e: e["id"])

        # Detect gap
        first_id = events[0]["id"]
        if first_id > self._last_event_id + 1 and self._last_event_id > 0:
            logger.warning(
                f"Event ID gap detected ({self._last_event_id} → {first_id}). "
                "Triggering state refresh."
            )
            self._dispatch("state_refresh", {})

        for event in events:
            if event["id"] <= self._last_event_id:
                continue  # skip already-processed

            self._last_event_id = event["id"]
            self._dispatch(event["type"], event.get("data", {}))

    def _dispatch(self, event_type: str, data: dict) -> None:
        for handler in self._handlers.get(event_type, []):
            try:
                handler(data)
            except Exception as e:
                logger.error(f"Event handler error ({event_type}): {e}")

        # Also dispatch to wildcard handlers
        for handler in self._handlers.get("*", []):
            try:
                handler({"type": event_type, "data": data})
            except Exception as e:
                logger.error(f"Wildcard handler error ({event_type}): {e}")


# Module-level singleton
_poller: EventPoller | None = None


def get_poller() -> EventPoller:
    global _poller
    if _poller is None:
        _poller = EventPoller()
    return _poller