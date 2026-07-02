# api/deps.py
"""
Dependências compartilhadas das rotas.

require_admin: gate de servidor para recursos exclusivos de conta admin
(hoje: Discovery — busca e download do YouTube via yt-dlp). O tipo de
conta vem de config.json ("account_type"); o padrão é "standard", então
um build distribuído nunca expõe esses endpoints por engano.
"""

from fastapi import HTTPException

from utils.config import get as cfg_get


def is_admin() -> bool:
    return cfg_get("account_type", "standard") == "admin"


def require_admin() -> None:
    if not is_admin():
        raise HTTPException(
            status_code=403,
            detail="Recurso disponível apenas para contas admin",
        )
