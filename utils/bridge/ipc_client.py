import asyncio
import json
import logging
import platform

from utils import config

logger = logging.getLogger(__name__)

class IpcClient:
    def __init__(self):
        self.host = "127.0.0.1"
        self.port = config.get("ipc_port", 8767)
        self.socket_path = "/tmp/rolfsound.sock"
        self.is_windows = platform.system() == "Windows"

        self._writer = None
        self._lock = None

    async def send_command(self, cmd: str, payload: dict):
        if self._lock is None:
            self._lock = asyncio.Lock()

        async with self._lock:
            if self._writer is None or self._writer.is_closing():
                try:
                    if self.is_windows:
                        _, self._writer = await asyncio.wait_for(
                            asyncio.open_connection(self.host, self.port),
                            timeout=1.0
                        )
                    else:
                        _, self._writer = await asyncio.wait_for(
                            asyncio.open_unix_connection(self.socket_path),
                            timeout=1.0
                        )
                except asyncio.TimeoutError:
                    logger.error(f"Timeout na Via Expressa ao enviar '{cmd}'. Core ligado na porta {self.port}?")
                    self._writer = None
                    return
                except Exception as e:
                    logger.error(f"Falha no IPC Socket para '{cmd}': {e}")
                    self._writer = None
                    return

            try:
                msg = json.dumps({"cmd": cmd, **payload}) + "\n"
                self._writer.write(msg.encode('utf-8'))
                await self._writer.drain()
            except Exception as e:
                logger.error(f"Conexão IPC perdida ao enviar '{cmd}': {e}")
                self._writer = None
