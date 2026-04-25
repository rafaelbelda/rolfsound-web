from utils.bridge.http_client import CoreHttpClient
from utils.bridge.ipc_client import IpcClient

class RolfsoundCoreFacade:
    def __init__(self, http_client: CoreHttpClient, ipc_client: IpcClient):
        self.http = http_client
        self.ipc = ipc_client

    async def get_status(self) -> dict | None:
        return await self.http.get("/status")

    async def get_queue(self) -> dict | None:
        return await self.http.get("/queue")

    async def get_events(self, since: int = 0):
        return await self.http.get("/events", {"since": since})

    async def is_available(self) -> bool:
        return await self.get_status() is not None

    async def play(self, filepath=None, track_id=None) -> dict | None:
        p = {}
        if filepath: p["filepath"] = filepath
        if track_id: p["track_id"] = track_id
        return await self.http.post("/play", p)

    async def pause(self) -> dict | None: return await self.http.post("/pause")
    async def skip(self) -> dict | None: return await self.http.post("/skip")

    async def record_start(self) -> dict | None: return await self.http.post("/recorder/start")
    async def record_stop(self) -> dict | None: return await self.http.post("/recorder/stop")

    async def queue_add(self, track_id, filepath, title="", thumbnail="", artist="", position=None) -> dict | None:
        p = {"track_id": track_id, "filepath": filepath, "title": title, "thumbnail": thumbnail, "artist": artist}
        if position is not None: p["position"] = position
        return await self.http.post("/queue/add", p)

    async def queue_remove(self, position: int) -> dict | None: return await self.http.post("/queue/remove", {"position": position})
    async def queue_move(self, from_pos, to_pos) -> dict | None: return await self.http.post("/queue/move", {"from": from_pos, "to": to_pos})
    async def queue_clear(self) -> dict | None: return await self.http.post("/queue/clear")
    async def queue_previous(self) -> dict | None: return await self.http.post("/queue/previous")
    async def queue_repeat(self, mode: str) -> dict | None: return await self.http.post("/queue/repeat", {"mode": mode})
    async def queue_shuffle(self, enabled: bool) -> dict | None: return await self.http.post("/queue/shuffle", {"enabled": enabled})

    async def remix_reset_flag(self, enabled: bool) -> dict | None:
        return await self.http.post("/remix/reset_flag", {"enabled": bool(enabled)})

    async def seek(self, position: float) -> dict | None:
        await self.ipc.send_command("seek", {"pos": position})
        return {"ok": True}

    async def volume(self, value: float) -> dict | None:
        await self.ipc.send_command("volume", {"val": max(0.0, min(1.0, value))})
        return {"ok": True}

    async def remix_set(self, pitch_semitones: float | None = None, tempo_ratio: float | None = None) -> dict | None:
        p: dict = {}
        if pitch_semitones is not None: p["pitch_semitones"] = float(pitch_semitones)
        if tempo_ratio is not None: p["tempo_ratio"] = float(tempo_ratio)
        await self.ipc.send_command("set_remix", p)
        return {"ok": True}

    async def remix_reset(self) -> dict | None:
        await self.ipc.send_command("reset_remix", {})
        return {"ok": True}
