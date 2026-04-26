import os
import hashlib
import logging
import re
import urllib.request
import httpx
from pathlib import Path
from PIL import Image
from io import BytesIO

logger = logging.getLogger(__name__)

# Garante que a pasta de capas locais exista (caminho absoluto, independente do CWD)
COVERS_DIR = Path(__file__).resolve().parent.parent / "static" / "covers"
os.makedirs(COVERS_DIR, exist_ok=True)

# Shared HTTP client — reuses TCP connections for cover downloads
_http_client = httpx.AsyncClient(timeout=15)


def cache_remote_cover_candidates_sync(
    cache_key: str,
    image_urls: list[str | None],
    namespace: str = "cover",
) -> str | None:
    """
    Download the first working remote cover candidate, convert it to JPEG, and
    return a stable /static/covers URL. Local/public URLs are returned as-is.
    """
    for image_url in image_urls:
        public_url = cache_remote_cover_sync(cache_key, image_url, namespace=namespace)
        if public_url:
            return public_url
    return None


def cache_remote_cover_sync(
    cache_key: str,
    image_url: str | None,
    namespace: str = "cover",
) -> str | None:
    raw = str(image_url or "").strip()
    if not raw:
        return None
    if raw.startswith("/static/") or raw.startswith("/thumbs/"):
        return raw
    if not raw.lower().startswith(("http://", "https://")):
        return raw

    safe_namespace = _safe_cover_part(namespace or "cover")
    safe_key = _safe_cover_part(cache_key or hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16])
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8]
    local_filename = f"{safe_namespace}_{safe_key}_{digest}.jpg"
    local_filepath = COVERS_DIR / local_filename
    public_url = f"/static/covers/{local_filename}"

    if local_filepath.exists():
        return public_url

    try:
        req = urllib.request.Request(raw, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = resp.read()

        img = Image.open(BytesIO(payload)).convert("RGB")
        img.thumbnail((1200, 1200), Image.Resampling.LANCZOS)
        img.save(local_filepath, "JPEG", quality=88, optimize=True)
        logger.info("Cached remote cover: %s -> %s", raw, public_url)
        return public_url
    except Exception as exc:
        logger.warning("Cover cache failed for %s: %s", raw, exc)
        return None


def _safe_cover_part(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(value)).strip("._-")
    return (cleaned or "cover")[:80]

async def process_release_cover(release_id: str, discogs_url: str, auth_headers: dict) -> dict:
    """
    Baixa a capa do Discogs, salva localmente e extrai a cor da lombada.
    Retorna o caminho local e a cor em HEX.
    """
    local_filename = f"{release_id}.jpg"
    local_filepath = COVERS_DIR / local_filename
    public_url = f"/static/covers/{local_filename}"

    # Se a capa já existe localmente, a gente não baixa de novo! (Isso poupa a API)
    if local_filepath.exists():
        # Apenas re-calcula a cor caso precise (ou você pode ler do DB no futuro)
        img = Image.open(local_filepath).convert('RGB')
    else:
        # Baixa a imagem da API do Discogs
        resp = await _http_client.get(discogs_url, headers=auth_headers, timeout=15)
        if resp.status_code != 200:
            raise Exception(f"Erro ao baixar imagem: {resp.status_code}")

        img = Image.open(BytesIO(resp.content)).convert('RGB')
        # Salva no cartão SD/SSD do Raspberry Pi (qualidade 85 para economizar espaço)
        img.save(local_filepath, "JPEG", quality=85)

    # --- A MÁGICA DA EXTRAÇÃO DE COR (Sangria de 5%) ---
    width, height = img.size
    border_width = max(1, int(width * 0.05))
    
    # Recorta apenas a tira esquerda da imagem
    left_edge = img.crop((0, 0, border_width, height))
    
    # Redimensiona essa tira para 1x1 pixel. 
    # O próprio Pillow faz a média das cores matematicamente perfeito!
    average_color_img = left_edge.resize((1, 1), resample=Image.Resampling.BILINEAR)
    r, g, b = average_color_img.getpixel((0, 0))

    # Converte RGB para HEX
    hex_color = f"#{r:02x}{g:02x}{b:02x}"

    return {
        "local_url": public_url,
        "spine_color": hex_color
    }
