# utils/event_stream_client.py
"""
Async SSE client that consumes rolfsound-core's /events/stream endpoint.

Drop-in replacement for EventPoller: same public API (`on`, `start`, `stop`,
`get_client()` singleton), so the rest of the app doesn't care which
transport is in use — selected via the `core_events_transport` config key.

Why SSE (not WS)
----------------
Core → Web is strictly unidirectional — no reason to pay for WS framing
and a second control channel. SSE is a plain HTTP stream: easy to debug
with curl, natively buffered by httpx, and survives intermediate proxies
that strip WS.

Dispatch model
--------------
Handlers registered via `.on()` are **sync callables**, matching the
EventPoller contract. Existing handlers (state_broadcaster, app.py DB
writes) expect to run off the event loop — some of them call
`asyncio.run_coroutine_threadsafe`, others do blocking SQLite work.

So we run every sync handler via `loop.run_in_executor(None, handler, arg)`.
This keeps the uvicorn loop responsive and preserves the
"handler-runs-in-a-different-thread" assumption that state_broadcaster
relies on.

Resync semantics
----------------
Core sends `event: resync` when our subscription queue overflowed (slow
reader). On resync:
  - `_last_id` is reset to 0 (we can't trust our position anymore)
  - a synthetic `state_refresh` event is dispatched so downstream handlers
    (state_broadcaster) refetch full status

Reconnect
---------
On any stream error we back off exponentially (0.5s → 10s) and retry,
sending `Last-Event-ID: <n>` so core replays the missed tail from its
in-memory ring buffer.
"""

import asyncio
import json
import logging
from typing import Callable

import httpx

from utils.config import get

logger = logging.getLogger(__name__)

BACKOFF_MIN_S = 0.5
BACKOFF_MAX_S = 10.0
CONNECT_TIMEOUT_S = 5.0


class EventStreamClient:
    def __init__(self) -> None:
        self._last_id: int = 0
        self._handlers: dict[str, list[Callable]] = {}
        self._task: asyncio.Task | None = None
        self._stop_event: asyncio.Event | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    # ── Public API (mirrors EventPoller) ─────────────────────────────────

    def on(self, event_type: str, handler: Callable) -> None:
        self._handlers.setdefault(event_type, []).append(handler)

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._loop = asyncio.get_event_loop()
        self._stop_event = asyncio.Event()
        self._task = self._loop.create_task(self._run(), name="event-stream-client")
        logger.info("EventStreamClient started (SSE transport)")

    def stop(self) -> None:
        if self._stop_event:
            # Safe to call from any thread: set() on an asyncio.Event is thread-safe
            # only from within the loop, so we schedule it.
            if self._loop and self._loop.is_running():
                self._loop.call_soon_threadsafe(self._stop_event.set)
            else:
                self._stop_event.set()
        if self._task:
            self._task.cancel()
        logger.info("EventStreamClient stopped")

    # ── Stream loop ──────────────────────────────────────────────────────

    async def _run(self) -> None:
        backoff = BACKOFF_MIN_S
        url = get("core_url", "http://localhost:8765").rstrip("/") + "/events/stream"

        # No total timeout — SSE is long-lived. Only the initial connect matters.
        timeout = httpx.Timeout(None, connect=CONNECT_TIMEOUT_S)

        while not self._stop_event.is_set():
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    headers = {
                        "Accept": "text/event-stream",
                        "Cache-Control": "no-cache",
                        "Last-Event-ID": str(self._last_id),
                    }
                    async with client.stream("GET", url, headers=headers) as resp:
                        resp.raise_for_status()
                        logger.info(f"SSE connected (Last-Event-ID={self._last_id})")
                        backoff = BACKOFF_MIN_S
                        await self._consume(resp)
            except asyncio.CancelledError:
                break
            except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError) as e:
                logger.debug(f"SSE transient error: {type(e).__name__}: {e}")
            except httpx.HTTPStatusError as e:
                logger.warning(f"SSE HTTP {e.response.status_code} — retrying")
            except Exception as e:
                logger.error(f"SSE loop error: {type(e).__name__}: {e}")

            if self._stop_event.is_set():
                break

            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=backoff)
                break  # stop_event set during backoff
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, BACKOFF_MAX_S)

    async def _consume(self, resp: httpx.Response) -> None:
        """Parse SSE frames from the streamed response."""
        event_type = ""
        data_lines: list[str] = []
        event_id: str | None = None

        async for line in resp.aiter_lines():
            if self._stop_event.is_set():
                return

            if line == "":
                # Blank line → dispatch accumulated frame.
                if data_lines:
                    await self._dispatch_frame(event_type, data_lines, event_id)
                event_type = ""
                data_lines = []
                event_id = None
                continue

            if line.startswith(":"):
                # SSE comment (keepalive). Ignore.
                continue

            if ":" in line:
                field, _, value = line.partition(":")
                # Spec: single leading space after the colon is stripped.
                if value.startswith(" "):
                    value = value[1:]
            else:
                field, value = line, ""

            if field == "id":
                event_id = value
            elif field == "event":
                event_type = value
            elif field == "data":
                data_lines.append(value)
            # other fields ("retry", unknown) — ignored

    async def _dispatch_frame(
        self, event_type: str, data_lines: list[str], event_id: str | None
    ) -> None:
        raw = "\n".join(data_lines)

        # Advance position BEFORE dispatching, so a handler error can't
        # cause us to reprocess the same event on reconnect.
        if event_id is not None:
            try:
                new_id = int(event_id)
                if new_id > self._last_id:
                    self._last_id = new_id
            except ValueError:
                pass

        if event_type == "resync":
            logger.warning("SSE resync received — backlog overflowed, refetching state")
            self._last_id = 0
            self._dispatch("state_refresh", {})
            return

        try:
            data = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            logger.warning(f"SSE malformed data for event '{event_type}': {raw!r}")
            return

        # Core's `data:` field carries the inner event payload directly;
        # the event type lives on the `event:` line (mirrors entry.type).
        self._dispatch(event_type, data if isinstance(data, dict) else {})

    def _dispatch(self, event_type: str, data: dict) -> None:
        """Schedule sync handlers on the default executor — matches EventPoller's
        off-loop dispatch semantics (handlers that call run_coroutine_threadsafe
        or block on SQLite must not run on the event loop)."""
        loop = self._loop or asyncio.get_event_loop()

        for handler in self._handlers.get(event_type, []):
            loop.run_in_executor(None, _safe_call, handler, data, event_type)
        for handler in self._handlers.get("*", []):
            loop.run_in_executor(
                None, _safe_call, handler, {"type": event_type, "data": data}, "*"
            )


def _safe_call(handler: Callable, arg, label: str) -> None:
    try:
        handler(arg)
    except Exception as e:
        logger.error(f"Event handler error ({label}): {e}")


# Module-level singleton
_client: EventStreamClient | None = None


def get_client() -> EventStreamClient:
    global _client
    if _client is None:
        _client = EventStreamClient()
    return _client
