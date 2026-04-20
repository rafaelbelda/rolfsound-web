# utils/ipc_client.py
import asyncio
import json
import logging
import platform

logger = logging.getLogger(__name__)

class IpcClient:
    """Cliente dedicado exclusivamente à Via Expressa de Latência Zero (Porta 8767 / UDS)"""
    def __init__(self):
        self.host = "127.0.0.1"
        self.port = 8767
        self.socket_path = "/tmp/rolfsound.sock"
        self.is_windows = platform.system() == "Windows"
        
        self._writer = None
        self._lock = None  # Inicialização preguiçosa para não quebrar o Event Loop

    async def send_command(self, cmd: str, payload: dict):
        # Garante que o Lock é criado dentro do Event Loop ativo do FastAPI
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

            # Envia a mensagem de facto
            try:
                msg = json.dumps({"cmd": cmd, **payload}) + "\n"
                self._writer.write(msg.encode('utf-8'))
                await self._writer.drain()
            except Exception as e:
                logger.error(f"Conexão IPC perdida ao enviar '{cmd}': {e}")
                self._writer = None # Força a reconectar no próximo comando