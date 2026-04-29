import asyncio
import json
import unittest

from api.ws.connection_manager import ConnectionManager, QOS_CRITICAL


class FakeWebSocket:
    def __init__(self):
        self.accepted = False
        self.closed = False
        self.close_code = None
        self.close_reason = None

    async def accept(self):
        self.accepted = True

    async def close(self, code=None, reason=None):
        self.closed = True
        self.close_code = code
        self.close_reason = reason


def _payloads(q):
    return [json.loads(item.text)["payload"] for item in list(q._queue)]


class ConnectionManagerBackpressureTests(unittest.IsolatedAsyncioTestCase):
    async def test_volatile_frames_keep_only_latest_per_type(self):
        manager = ConnectionManager()
        ws = FakeWebSocket()
        q = await manager.connect(ws)

        for seq in range(100):
            await manager.broadcast({
                "type": "telemetry.audio",
                "payload": {"seq": seq},
                "ts": seq,
            })

        self.assertEqual(q.qsize(), 1)
        self.assertEqual(_payloads(q)[0]["seq"], 99)
        self.assertLessEqual(q.qsize(), q.maxsize)
        self.assertFalse(ws.closed)

    async def test_latest_state_frames_keep_only_latest_per_type(self):
        manager = ConnectionManager()
        ws = FakeWebSocket()
        q = await manager.connect(ws)

        for position in range(20):
            await manager.broadcast({
                "type": "state.playback",
                "payload": {"position": position},
                "ts": position,
            })

        self.assertEqual(q.qsize(), 1)
        self.assertEqual(_payloads(q)[0]["position"], 19)

    async def test_critical_frame_drops_discardable_frame_to_make_room(self):
        manager = ConnectionManager()
        ws = FakeWebSocket()
        q = await manager.connect(ws)

        await manager.broadcast({"type": "telemetry.audio", "payload": {"seq": 1}, "ts": 1})
        for idx in range(q.maxsize - 1):
            await manager.broadcast({
                "type": "event.track_updated",
                "payload": {"track_id": f"critical-{idx}"},
                "ts": idx,
            })

        self.assertEqual(q.qsize(), q.maxsize)

        await manager.broadcast({
            "type": "event.track_changed",
            "payload": {"track_id": "now"},
            "ts": 999,
        })

        queued_types = [item.frame_type for item in list(q._queue)]
        self.assertEqual(q.qsize(), q.maxsize)
        self.assertNotIn("telemetry.audio", queued_types)
        self.assertIn("event.track_changed", queued_types)
        self.assertFalse(ws.closed)

    async def test_critical_backpressure_disconnects_when_queue_has_no_discardable_room(self):
        manager = ConnectionManager()
        ws = FakeWebSocket()
        q = await manager.connect(ws)

        for idx in range(q.maxsize):
            await manager.broadcast({
                "type": "event.track_updated",
                "payload": {"track_id": f"critical-{idx}"},
                "ts": idx,
            })

        self.assertTrue(all(item.qos == QOS_CRITICAL for item in list(q._queue)))

        await manager.broadcast({
            "type": "event.track_changed",
            "payload": {"track_id": "overflow"},
            "ts": 1000,
        })

        self.assertTrue(ws.closed)
        self.assertEqual(ws.close_code, 1013)
        self.assertEqual(manager.client_count, 0)


if __name__ == "__main__":
    unittest.main()
