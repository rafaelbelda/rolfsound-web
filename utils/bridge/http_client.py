import logging
import httpx
from utils.config import get

logger = logging.getLogger(__name__)
TIMEOUT = httpx.Timeout(5.0, connect=2.0)

class CoreHttpClient:
    def __init__(self):
        self._client: httpx.AsyncClient | None = None
        self.base_url = get("core_url", "http://localhost:8765").rstrip("/")

    def init_client(self) -> None:
        self._client = httpx.AsyncClient(timeout=TIMEOUT)
        logger.info("CoreHttpClient: persistent AsyncClient created")

    async def close_client(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None
            logger.info("CoreHttpClient: AsyncClient closed")

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            logger.warning("CoreHttpClient: client not initialised — creating on demand")
            self._client = httpx.AsyncClient(timeout=TIMEOUT)
        return self._client

    async def get(self, path: str, params: dict = None) -> dict | None:
        try:
            r = await self._get_client().get(self.base_url + path, params=params)
            r.raise_for_status()
            return r.json()
        except httpx.ConnectError:
            logger.debug(f"Core unreachable: GET {path}")
        except httpx.TimeoutException:
            logger.debug(f"Core timeout: GET {path}")
        except httpx.HTTPStatusError as e:
            status = e.response.status_code
            if status < 500:
                logger.debug(f"Core {status}: GET {path}")
            else:
                logger.error(f"Core {status}: GET {path}")
        except Exception as e:
            logger.error(f"Core error GET {path}: {e}")
        return None

    async def post(self, path: str, data: dict = None) -> dict | None:
        try:
            r = await self._get_client().post(self.base_url + path, json=data or {})
            r.raise_for_status()
            return r.json()
        except httpx.ConnectError:
            logger.debug(f"Core unreachable: POST {path}")
        except httpx.TimeoutException:
            logger.debug(f"Core timeout: POST {path}")
        except httpx.HTTPStatusError as e:
            status = e.response.status_code
            if status < 500:
                logger.debug(f"Core {status}: POST {path}")
            else:
                logger.error(f"Core {status}: POST {path}")
        except Exception as e:
            logger.error(f"Core error POST {path}: {e}")
        return None
