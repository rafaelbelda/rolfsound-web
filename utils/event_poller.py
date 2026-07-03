# utils/event_poller.py
"""
Polls rolfsound-core for events and dispatches them to registered handlers.
Runs in a dedicated background daemon thread.

TRANSPORTE HTTP
───────────────
Esta thread usa um httpx.Client SÍNCRONO próprio — nunca o AsyncClient
compartilhado do core_client. O padrão antigo (asyncio.run() por chamada
sobre o client compartilhado) funcionava por acidente enquanto o core
fechava a conexão a cada request (HTTP/1.0); com keep-alive, as conexões
criadas no event-loop descartável da thread iam parar no pool do uvicorn
e explodiam com "bound to a different event loop" — podendo derrubar
chamadas de playback. Thread bloqueante → client bloqueante.

POLL_INTERVAL is intentionally conservative — this is for server-side
event tracking (stream counts, history), not the UI. The dashboard has
its own polling via /api/status and /api/monitor.
"""

import logging
import threading
import time
from typing import Callable

import httpx

from utils.config import get as cfg_get

logger = logging.getLogger(__name__)

POLL_INTERVAL = 2.0   # seconds — conservative, this is background bookkeeping

# Mesmos timeouts do core_client: core é local, mas pode estar sob pressão
# do sounddevice durante transições de playback.
_TIMEOUT = httpx.Timeout(5.0, connect=2.0)


class EventPoller:
    def __init__(self):
        self._last_event_id: int = 0
        self._handlers: dict[str, list[Callable]] = {}
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._http: httpx.Client | None = None

    def on(self, event_type: str, handler: Callable) -> None:
        self._handlers.setdefault(event_type, []).append(handler)

    def start(self) -> None:
        self._stop_event.clear()
        self._http = httpx.Client(timeout=_TIMEOUT)
        self._thread = threading.Thread(
            target=self._poll_loop,
            name="event-poller",
            daemon=True,
        )
        self._thread.start()
        logger.info("EventPoller started")

    def stop(self) -> None:
        self._stop_event.set()
        if self._http is not None:
            try:
                self._http.close()
            except Exception:
                pass
            self._http = None
        logger.info("EventPoller stopped")

    def _poll_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._poll_once()
            except Exception as e:
                logger.error(f"EventPoller error: {e}")
            time.sleep(POLL_INTERVAL)

    def _fetch_events(self) -> dict | None:
        if self._http is None:
            return None
        url = cfg_get("core_url", "http://127.0.0.1:8765").rstrip("/") + "/events"
        try:
            r = self._http.get(url, params={"since": self._last_event_id})
            r.raise_for_status()
            return r.json()
        except httpx.ConnectError:
            logger.debug("EventPoller: core unreachable")
        except httpx.TimeoutException:
            logger.debug("EventPoller: core timeout")
        except Exception as e:
            logger.debug(f"EventPoller get_events failed: {e}")
        return None

    def _poll_once(self) -> None:
        result = self._fetch_events()
        if result is None:
            return

        events = result.get("events", [])
        if not events:
            return

        events.sort(key=lambda e: e["id"])

        first_id = events[0]["id"]
        if first_id > self._last_event_id + 1 and self._last_event_id > 0:
            logger.warning(
                f"Event ID gap ({self._last_event_id} -> {first_id}) — "
                "triggering state refresh."
            )
            self._dispatch("state_refresh", {})

        for event in events:
            if event["id"] <= self._last_event_id:
                continue
            self._last_event_id = event["id"]
            self._dispatch(event["type"], event.get("data", {}))

    def _dispatch(self, event_type: str, data: dict) -> None:
        for handler in self._handlers.get(event_type, []):
            try:
                handler(data)
            except Exception as e:
                logger.error(f"Event handler error ({event_type}): {e}")
        for handler in self._handlers.get("*", []):
            try:
                handler({"type": event_type, "data": data})
            except Exception as e:
                logger.error(f"Wildcard handler error: {e}")


# Module-level singleton
_poller: EventPoller | None = None


def get_poller() -> EventPoller:
    global _poller
    if _poller is None:
        _poller = EventPoller()
    return _poller
