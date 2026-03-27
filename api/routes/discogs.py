# api/routes/discogs.py
"""
Discogs OAuth 1.0a flow - Arquitetura de Banco de Dados.
As chaves de acesso são persistidas no SQLite via db/database.py.
"""

import logging
import time
import urllib.parse
import uuid
import httpx

from db import database
from utils import config as cfg
from fastapi import APIRouter, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger(__name__)

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


# ── Coleção e Imagens (Sincronizados com DB) ────────────────────────────────

@router.get("/discogs/collection")
async def get_collection(page: int = 1, per_page: int = 50):
    """Busca a coleção do usuário usando o token persistido no banco."""
    conn = database.get_connection()
    try:
        account = database.get_discogs_account(conn)
    finally:
        conn.close()

    if not account:
        return JSONResponse({"error": "not_connected"}, status_code=404)

    ck, cs = _consumer()
    header = _oauth_header(ck, cs, account["access_token"], account["access_secret"])

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(
                f"https://api.discogs.com/users/{account['username']}/collection/folders/0/releases",
                headers={"Authorization": header, "User-Agent": _USER_AGENT},
                params={
                    "page": page,
                    "per_page": per_page,
                    "sort": "added",
                    "sort_order": "desc",
                },
                timeout=20
            )
            
            if resp.status_code != 200:
                return JSONResponse({"error": resp.text}, status_code=resp.status_code)

            data = resp.json()
            releases = []
            for item in data.get("releases", []):
                bi = item.get("basic_information", {})
                releases.append({
                    "title": bi.get("title", "Unknown Title"),
                    "artist": " / ".join([a.get("name", "").rstrip(" 0123456789").strip("() ") for a in bi.get("artists", [])]),
                    "cover": bi.get("cover_image", ""),
                    "thumb": bi.get("thumb", "")
                })
            
            return {"releases": releases, "pagination": data.get("pagination", {})}
            
        except Exception as exc:
            logger.error("Erro ao buscar coleção: %s", exc)
            return JSONResponse({"error": str(exc)}, status_code=502)


@router.get("/discogs/image")
async def proxy_image(url: str = Query(...)):
    """Proxy de imagem assinado via servidor para evitar CORS no Three.js."""
    conn = database.get_connection()
    try:
        account = database.get_discogs_account(conn)
    finally:
        conn.close()

    headers = {"User-Agent": _USER_AGENT}
    
    # Assina o download da imagem com o token do banco se existir
    if account:
        ck, cs = _consumer()
        headers["Authorization"] = _oauth_header(ck, cs, account["access_token"], account["access_secret"])

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(url, headers=headers, timeout=15)
            if resp.status_code != 200:
                return Response(status_code=resp.status_code)

            return Response(
                content=resp.content, 
                media_type=resp.headers.get("Content-Type", "image/jpeg")
            )
        except Exception as exc:
            logger.error("Erro no proxy de imagem: %s", exc)
            return Response(status_code=502)


# ── OAuth Handshake (Fluxo de Conexão) ──────────────────────────────────────

@router.post("/discogs/request-token")
async def request_token(request: Request):
    ck, cs = _consumer()
    if not ck or not cs:
        return JSONResponse({"error": "Configurações de Consumer Key/Secret faltando."}, status_code=500)

    callback = str(request.base_url).rstrip("/") + "/api/discogs/callback"
    header = _oauth_header(ck, cs, callback=callback)

    async with httpx.AsyncClient() as client:
        resp = await client.post(_REQUEST_TOKEN_URL, headers={"Authorization": header, "User-Agent": _USER_AGENT})
        
    if resp.status_code != 200:
        return JSONResponse({"error": resp.text}, status_code=resp.status_code)

    tokens = dict(urllib.parse.parse_qsl(resp.text))
    oauth_token = tokens.get("oauth_token", "")
    
    _pending[oauth_token] = {
        "request_secret": tokens.get("oauth_token_secret", ""),
        "status": "pending"
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

    async with httpx.AsyncClient() as client:
        resp = await client.post(_ACCESS_TOKEN_URL, headers={"Authorization": header, "User-Agent": _USER_AGENT})
    
    if resp.status_code != 200:
        return HTMLResponse(f"<h2>Erro no Discogs: {resp.text}</h2>", status_code=500)

    ts = dict(urllib.parse.parse_qsl(resp.text))
    access_token = ts["oauth_token"]
    access_secret = ts["oauth_token_secret"]

    # Busca o Username antes de salvar
    id_h = _oauth_header(ck, cs, access_token, access_secret)
    async with httpx.AsyncClient() as client:
        id_r = await client.get(_IDENTITY_URL, headers={"Authorization": id_h, "User-Agent": _USER_AGENT})
        username = id_r.json().get("username")

    # SALVA NO BANCO DE DADOS
    conn = database.get_connection()
    try:
        database.save_discogs_account(conn, access_token, access_secret, username, int(time.time()))
        conn.commit()
    finally:
        conn.close()

    flow["status"] = "authorized"
    
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
    async with httpx.AsyncClient() as client:
        r = await client.get(_IDENTITY_URL, headers={"Authorization": h, "User-Agent": _USER_AGENT})
        return {"ok": r.status_code == 200, "username": account["username"]}