import asyncio
import time
import unittest
from unittest.mock import AsyncMock, patch

from api.ws import state_broadcaster


class FakeManager:
    def __init__(self):
        self.frames = []
        self.client_count = 1

    async def broadcast(self, frame):
        self.frames.append(frame)


def _raw_status(position=0):
    return {
        "playback": {
            "playing": True,
            "paused": False,
            "current_track": "",
            "position_s": position,
            "duration_s": 120,
            "position_updated_at": 1,
            "volume": 0.7,
        },
        "queue": {
            "tracks": [],
            "current_index": -1,
            "repeat_mode": "off",
            "shuffle": False,
        },
        "remix": {},
    }


def _reset_broadcaster(manager):
    for attr in ("_audio_flush_task", "_progress_flush_task", "_snapshot_flush_task"):
        task = getattr(state_broadcaster, attr)
        if task and not task.done():
            task.cancel()
        setattr(state_broadcaster, attr, None)

    state_broadcaster._manager = manager
    state_broadcaster._loop = asyncio.get_running_loop()
    state_broadcaster._pending_audio = None
    state_broadcaster._pending_progress = None
    state_broadcaster._last_audio_emit_at = 0.0
    state_broadcaster._last_progress_emit_at = 0.0
    state_broadcaster._last_snapshot_emit_at = 0.0


class StateBroadcasterBackpressureTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        _reset_broadcaster(None)
        await asyncio.sleep(0)

    async def test_audio_monitor_burst_coalesces_to_latest_telemetry_audio(self):
        manager = FakeManager()
        _reset_broadcaster(manager)

        with patch.object(state_broadcaster, "_AUDIO_MIN_INTERVAL_S", 0.01):
            for seq in range(1000):
                await state_broadcaster._handle_audio({"level": seq, "peak": seq})
            await asyncio.sleep(0.03)

        self.assertLessEqual(len(manager.frames), 2)
        self.assertTrue(manager.frames)
        self.assertTrue(all(frame["type"] == "telemetry.audio" for frame in manager.frames))
        self.assertEqual(manager.frames[-1]["payload"]["level"], 999)

    async def test_playback_tick_burst_emits_one_latest_progress_frame_per_interval(self):
        manager = FakeManager()
        _reset_broadcaster(manager)
        state_broadcaster._last_progress_emit_at = time.monotonic()

        with patch.object(state_broadcaster, "_PROGRESS_MIN_INTERVAL_S", 0.01):
            for position in range(100):
                await state_broadcaster._handle_tick({
                    "position": position,
                    "duration": 300,
                    "server_ts": 1234,
                })
            await asyncio.sleep(0.03)

        self.assertEqual(len(manager.frames), 1)
        self.assertEqual(manager.frames[0]["type"], "event.progress")
        self.assertEqual(manager.frames[0]["payload"]["position"], 99)

    async def test_snapshot_requests_are_debounced_to_four_hz_style_latest(self):
        manager = FakeManager()
        _reset_broadcaster(manager)

        status_mock = AsyncMock(side_effect=lambda: _raw_status(12))

        with patch.object(state_broadcaster, "_SNAPSHOT_MIN_INTERVAL_S", 0.1), \
             patch.object(state_broadcaster.core, "get_status", status_mock):
            await state_broadcaster._broadcast_snapshot()
            await state_broadcaster._broadcast_snapshot()
            await state_broadcaster._broadcast_snapshot()
            self.assertEqual(len(manager.frames), 1)

            await asyncio.sleep(0.13)

        playback_frames = [f for f in manager.frames if f["type"] == "state.playback"]
        self.assertEqual(len(playback_frames), 2)
        self.assertEqual(playback_frames[-1]["payload"]["position"], 12)
        self.assertNotIn("playback", playback_frames[-1]["payload"])


if __name__ == "__main__":
    unittest.main()
