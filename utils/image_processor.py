import os
import httpx
from pathlib import Path
from PIL import Image
from io import BytesIO

# Garante que a pasta de capas locais exista (caminho absoluto, independente do CWD)
COVERS_DIR = Path(__file__).resolve().parent.parent / "static" / "covers"
os.makedirs(COVERS_DIR, exist_ok=True)

# Shared HTTP client — reuses TCP connections for cover downloads
_http_client = httpx.AsyncClient(timeout=15)

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