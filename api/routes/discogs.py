# api/routes/discogs.py
"""
Discogs OAuth 1.0a flow - Arquitetura de Banco de Dados com Sync Local.
"""

import logging
import time
import urllib.parse
import uuid
import httpx
import os
from pathlib import Path

from db import database
from utils import config as cfg
from utils.image_processor import process_release_cover
from fastapi import APIRouter, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger(__name__)

# Shared HTTP client — reuses TCP connections across all Discogs API calls
_http_client = httpx.AsyncClient(timeout=30)

# Absolute path to covers directory, independent of CWD
_COVERS_DIR = Path(__file__).resolve().parent.parent.parent / "static" / "covers"

# Memória temporária APENAS para o handshake inicial do OAuth
_pending: dict[str, dict] = {}

_REQUEST_TOKEN_URL = "https://api.discogs.com/oauth/request_token"
_AUTHORIZE_URL     = "https://www.discogs.com/oauth/authorize"
_ACCESS_TOKEN_URL  = "https://api.discogs.com/oauth/access_token"
_IDENTITY_URL      = "https://api.discogs.com/oauth/identity"
_USER_AGENT        = "Rolfsound/1.0"


# ── OAuth 1.0a Helpers ────────────────────────────────────────────────────────

def _oauth_header(
    consumer_key: str,
    consumer_secret: str,
    token: str = "",
    token_secret: str = "",
    verifier: str = "",
    callback: str = "",
) -> str:
    """Gera o header de autorização OAuth 1.0a (PLAINTEXT)."""
    params = {
        "oauth_consumer_key":     consumer_key,
        "oauth_nonce":            uuid.uuid4().hex,
        "oauth_signature_method": "PLAINTEXT",
        "oauth_timestamp":        str(int(time.time())),
        "oauth_version":          "1.0",
    }
    if token:
        params["oauth_token"] = token
    if verifier:
        params["oauth_verifier"] = verifier
    if callback:
        params["oauth_callback"] = callback

    # Assinatura PLAINTEXT para Discogs
    params["oauth_signature"] = (
        f"{urllib.parse.quote(consumer_secret, safe='')}"
        f"&{urllib.parse.quote(token_secret, safe='')}"
    )

    parts = ", ".join(
        f'{k}="{urllib.parse.quote(v, safe="")}"'
        for k, v in sorted(params.items())
    )
    return f"OAuth {parts}"


def _consumer():
    """Busca as chaves globais da aplicação no arquivo de config."""
    return (
        cfg.get("discogs_consumer_key",   ""),
        cfg.get("discogs_consumer_secret", ""),
    )


# ── Gerenciamento de Conta (Banco de Dados) ──────────────────────────────────

@router.get("/discogs/account")
async def get_account():
    """Retorna a conta conectada direto do banco de dados."""
    conn = database.get_connection()
    try:
        account = database.get_discogs_account(conn)
    finally:
        conn.close()

    if not account:
        return {"connected": False}

    return {
        "connected": True,
        "username":  account["username"],
        "connected_at": account["connected_at"]
    }


@router.delete("/discogs/account")
async def disconnect():
    """Desconecta a conta limpando o registro no banco de dados."""
    conn = database.get_connection()
    try:
        database.delete_discogs_account(conn)
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


# ── Coleção 3D (Otimizada para Hardware) ────────────────────────────────

@router.get("/discogs/collection")
async def get_collection():
    """
    Leitura ultra-rápida (1 ms). O front-end chama esta rota.
    Não há internet envolvida. Apenas lê o SQLite e entrega os dados formatados.
    """
    conn = database.get_connection()
    try:
        releases = database.get_discogs_collection(conn)
        
        colecao_formatada = []
        for r in releases:
            colecao_formatada.append({
                "title": r["title"],
                "artist": r["artist"],
                "cover": r["local_cover_url"], # Caminho local: /static/covers/...
                "spine_color": r["spine_color"], # Cor HEX já calculada!
                "year": r.get("year", 0), 
                "date_added": r.get("date_added", "")
            })
            
        return {"releases": colecao_formatada}
    finally:
        conn.close()


@router.post("/discogs/sync")
async def sync_collection():
    """
    Sincronização de Estado Profunda (State Reconciliation).
    """
    conn = database.get_connection()
    try:
        account = database.get_discogs_account(conn)
        if not account:
            return JSONResponse({"error": "not_connected"}, status_code=400)

        ck, cs = _consumer()
        header = _oauth_header(ck, cs, account["access_token"], account["access_secret"])

        remote_items = {}
        page = 1
        total_pages = 1

        # 1. VARREDURA COMPLETA NO DISCOGS
        while page <= total_pages:
            resp = await _http_client.get(
                f"https://api.discogs.com/users/{account['username']}/collection/folders/0/releases",
                headers={"Authorization": header, "User-Agent": _USER_AGENT},
                params={"page": page, "per_page": 100}, 
                timeout=30
            )

            if resp.status_code != 200:
                return JSONResponse({"error": resp.text}, status_code=resp.status_code)

            data = resp.json()
            total_pages = data.get("pagination", {}).get("pages", 1)

            for item in data.get("releases", []):
                remote_items[item["id"]] = item

            page += 1

        # 2. A MATEMÁTICA DOS CONJUNTOS
        remote_ids = set(remote_items.keys())
        local_ids = database.get_all_discogs_ids(conn)

        ids_to_add = remote_ids - local_ids       
        ids_to_remove = local_ids - remote_ids    

        # 3. O CAMINHÃO DE LIXO (Removendo os discos vendidos)
        for rid in ids_to_remove:
            database.delete_discogs_release(conn, rid)
            file_path = _COVERS_DIR / f"{rid}.jpg"
            if file_path.exists():
                file_path.unlink()

        # 4. O MORDOMO (Baixando os discos novos)
        for rid in ids_to_add:
            item = remote_items[rid]
            bi = item.get("basic_information", {})
            title = bi.get("title", "Unknown Title")
            artist = " / ".join([a.get("name", "").rstrip(" 0123456789").strip("() ") for a in bi.get("artists", [])])
            cover_url = bi.get("cover_image", "")
            
            # Extraindo dados para os Filtros
            year = bi.get("year", 0)
            date_added = item.get("date_added", "")

            if cover_url:
                processed = await process_release_cover(str(rid), cover_url, {"User-Agent": _USER_AGENT})
                local_url = processed["local_url"]
                spine_color = processed["spine_color"]
            else:
                local_url = ""
                spine_color = "#111111"

            database.upsert_discogs_release(conn, rid, title, artist, local_url, spine_color, year, date_added)
        
        conn.commit()
        return {
            "ok": True, 
            "message": "Sincronização perfeita.",
            "added": len(ids_to_add),
            "removed": len(ids_to_remove)
        }
        
    except Exception as exc:
        logger.error("Erro no sync: %s", exc)
        return JSONResponse({"error": str(exc)}, status_code=502)
    finally:
        conn.close()


# ── OAuth Handshake (Fluxo de Conexão) ──────────────────────────────────────

@router.post("/discogs/request-token")
async def request_token(request: Request):
    global _pending
    now = time.time()
    _pending = {k: v for k, v in _pending.items() if now - v["created_at"] < 600}

    ck, cs = _consumer()
    if not ck or not cs:
        return JSONResponse({"error": "Configurações de Consumer Key/Secret faltando."}, status_code=500)

    callback = str(request.base_url).rstrip("/") + "/api/discogs/callback"
    header = _oauth_header(ck, cs, callback=callback)

    resp = await _http_client.post(_REQUEST_TOKEN_URL, headers={"Authorization": header, "User-Agent": _USER_AGENT})

    if resp.status_code != 200:
        return JSONResponse({"error": resp.text}, status_code=resp.status_code)

    tokens = dict(urllib.parse.parse_qsl(resp.text))
    oauth_token = tokens.get("oauth_token", "")

    _pending[oauth_token] = {
        "request_secret": tokens.get("oauth_token_secret", ""),
        "status": "pending",
        "created_at": now
    }

    return {
        "authorizeUrl": f"{_AUTHORIZE_URL}?oauth_token={oauth_token}", 
        "oauthToken": oauth_token
    }


@router.get("/discogs/callback")
async def oauth_callback(oauth_token: str, oauth_verifier: str):
    flow = _pending.get(oauth_token)
    if not flow:
        return HTMLResponse("<h2>Sessão expirada.</h2>", status_code=400)

    ck, cs = _consumer()
    header = _oauth_header(ck, cs, oauth_token, flow["request_secret"], oauth_verifier)

    resp = await _http_client.post(_ACCESS_TOKEN_URL, headers={"Authorization": header, "User-Agent": _USER_AGENT})

    if resp.status_code != 200:
        return HTMLResponse(f"<h2>Erro no Discogs: {resp.text}</h2>", status_code=500)

    ts = dict(urllib.parse.parse_qsl(resp.text))
    access_token = ts["oauth_token"]
    access_secret = ts["oauth_token_secret"]

    id_h = _oauth_header(ck, cs, access_token, access_secret)
    id_r = await _http_client.get(_IDENTITY_URL, headers={"Authorization": id_h, "User-Agent": _USER_AGENT})
    username = id_r.json().get("username")

    conn = database.get_connection()
    try:
        database.save_discogs_account(conn, access_token, access_secret, username, int(time.time()))
        conn.commit()
    finally:
        conn.close()

    flow["status"] = "authorized"
    _pending.pop(oauth_token, None)

    return HTMLResponse("""
        <html><body style="font-family:sans-serif; text-align:center; padding-top:50px;">
        <h2>Autorizado com sucesso!</h2>
        <p>Esta janela fechará em instantes.</p>
        <script>setTimeout(() => window.close(), 2000);</script>
        </body></html>
    """)


@router.get("/discogs/token-status")
async def token_status(oauthToken: str):
    flow = _pending.get(oauthToken)
    if not flow: return {"status": "not_found"}
    return {"status": flow["status"]}


@router.get("/discogs/test")
async def test_connection():
    """Valida se o token do banco ainda é aceito pelo Discogs."""
    conn = database.get_connection()
    try:
        account = database.get_discogs_account(conn)
    finally:
        conn.close()
    
    if not account: return {"ok": False}
    
    ck, cs = _consumer()
    h = _oauth_header(ck, cs, account["access_token"], account["access_secret"])
    r = await _http_client.get(_IDENTITY_URL, headers={"Authorization": h, "User-Agent": _USER_AGENT})
    return {"ok": r.status_code == 200, "username": account["username"]}

@router.get("/discogs/check-updates")
async def check_updates():
    """
    Ping bidirecional: Detecta tanto compras (adições) quanto vendas (remoções).
    """
    conn = database.get_connection()
    try:
        account = database.get_discogs_account(conn)
        if not account:
            return {"has_updates": False}

        local_count = conn.execute("SELECT COUNT(*) FROM discogs_collection").fetchone()[0]

        ck, cs = _consumer()
        header = _oauth_header(ck, cs, account["access_token"], account["access_secret"])
        
        resp = await _http_client.get(
            f"https://api.discogs.com/users/{account['username']}/collection/folders/0",
            headers={"Authorization": header, "User-Agent": _USER_AGENT},
            timeout=10
        )

        if resp.status_code == 200:
            discogs_count = resp.json().get("count", 0)
            diff = discogs_count - local_count

            if diff != 0:
                return {"has_updates": True, "diff": diff}

        return {"has_updates": False}
    except Exception as exc:
        logger.error("Erro no check-updates: %s", exc)
        return {"has_updates": False}
    finally:
        conn.close()