# api/routes/discogs.py
"""
Discogs OAuth 1.0a flow.

App credentials (Consumer Key/Secret) are read from config — users never
enter them.  The resulting Access Token/Secret are stored in the SQLite DB.

Endpoints
---------
<<<<<<< Updated upstream
GET    /api/discogs/account        – current connected account (or null)
DELETE /api/discogs/account        – disconnect (wipes DB record)
POST   /api/discogs/request-token  – start OAuth: returns authorize URL
GET    /api/discogs/callback        – Discogs redirects here after approval
GET    /api/discogs/token-status   – frontend polls until status == "authorized"
GET    /api/discogs/test           – verify stored token is still valid
=======
POST /api/discogs/request-token   – get a Discogs request token and return the authorize URL
GET  /api/discogs/callback        – Discogs redirects here after user approves
GET  /api/discogs/token-status    – frontend polls this until status == "authorized"
GET  /api/discogs/test            – verify a stored access token is still valid
GET  /api/discogs/collection      – fetch user collection
GET  /api/discogs/image           – proxy to bypass CORS for WebGL textures
>>>>>>> Stashed changes
"""

import logging
import time
import urllib.parse
import uuid

import httpx
<<<<<<< Updated upstream
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse

from db import database
from utils import config as cfg
=======
from fastapi import APIRouter, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel
>>>>>>> Stashed changes

router = APIRouter()
logger = logging.getLogger(__name__)

# Temporary in-memory store for in-flight OAuth handshakes only.
# Keyed by the Discogs request token (oauth_token).
# Cleared after the handshake completes (authorized or failed).
_pending: dict[str, dict] = {}

_REQUEST_TOKEN_URL = "https://api.discogs.com/oauth/request_token"
_AUTHORIZE_URL     = "https://www.discogs.com/oauth/authorize"
_ACCESS_TOKEN_URL  = "https://api.discogs.com/oauth/access_token"
_IDENTITY_URL      = "https://api.discogs.com/oauth/identity"
_USER_AGENT        = "Rolfsound/1.0"


# ── OAuth 1.0a helpers ────────────────────────────────────────────────────────

def _oauth_header(
    consumer_key: str,
    consumer_secret: str,
    token: str = "",
    token_secret: str = "",
    verifier: str = "",
    callback: str = "",
) -> str:
    """Return an OAuth 1.0a Authorization header using the PLAINTEXT signature method."""
    params: dict[str, str] = {
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
    """Return (consumer_key, consumer_secret) from config."""
    return (
        cfg.get("discogs_consumer_key",    ""),
        cfg.get("discogs_consumer_secret", ""),
    )


# ── Account endpoints ─────────────────────────────────────────────────────────

@router.get("/discogs/account")
async def get_account():
    """Return the stored Discogs account, or null if not connected."""
    conn = database.get_connection()
    try:
        account = database.get_discogs_account(conn)
    finally:
        conn.close()

    if not account:
        return {"connected": False}

    return {
        "connected":    True,
        "username":     account["username"],
        "connected_at": account["connected_at"],
        # Return a masked token so the UI can display something meaningful
        "token_hint":   account["access_token"][:8] + "••••••••" + account["access_token"][-4:]
            if account["access_token"] else None,
    }


@router.delete("/discogs/account")
async def disconnect():
    """Remove the stored Discogs account from the database."""
    conn = database.get_connection()
    try:
        database.delete_discogs_account(conn)
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


# ── OAuth flow ────────────────────────────────────────────────────────────────

@router.post("/discogs/request-token")
async def request_token(request: Request):
    """
    Step 1 of the OAuth flow.
    Uses app credentials from config — no user input needed.
    Returns the Discogs authorize URL for the frontend to open.
    """
    consumer_key, consumer_secret = _consumer()
    if not consumer_key or not consumer_secret:
        return JSONResponse(
            {"error": "not_configured", "message": "Discogs app credentials are not set in config."},
            status_code=500,
        )

    callback = str(request.base_url).rstrip("/") + "/api/discogs/callback"

    header = _oauth_header(
        consumer_key=consumer_key,
        consumer_secret=consumer_secret,
        callback=callback,
    )

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(
                _REQUEST_TOKEN_URL,
                headers={
                    "Authorization": header,
                    "Content-Type":  "application/x-www-form-urlencoded",
                    "User-Agent":    _USER_AGENT,
                },
                timeout=15,
            )
        except httpx.RequestError as exc:
            logger.error("Discogs request-token network error: %s", exc)
            return JSONResponse({"error": "network_error", "message": str(exc)}, status_code=502)

    if resp.status_code != 200:
        logger.error("Discogs request-token %d: %s", resp.status_code, resp.text)
        return JSONResponse(
            {"error": "discogs_error", "message": resp.text},
            status_code=resp.status_code,
        )

    tokens = dict(urllib.parse.parse_qsl(resp.text))
    oauth_token        = tokens.get("oauth_token", "")
    oauth_token_secret = tokens.get("oauth_token_secret", "")

    if not oauth_token:
        return JSONResponse(
            {"error": "missing_token", "message": "Discogs returned no token"},
            status_code=502,
        )

    _pending[oauth_token] = {
        "request_secret": oauth_token_secret,
        "status":         "pending",
    }

    authorize_url = f"{_AUTHORIZE_URL}?oauth_token={urllib.parse.quote(oauth_token)}"
    return {"authorizeUrl": authorize_url, "oauthToken": oauth_token}


@router.get("/discogs/callback")
async def oauth_callback(oauth_token: str, oauth_verifier: str):
    """
    Step 2: Discogs redirects the user's browser here after they approve.
    Exchange the request token + verifier for an access token and save it to the DB.
    """
    flow = _pending.get(oauth_token)
    if not flow:
        return HTMLResponse(
            "<html><body style='font-family:sans-serif;padding:40px'>"
            "<h2>Session expired</h2><p>Close this window and try connecting again.</p>"
            "</body></html>",
            status_code=400,
        )

    consumer_key, consumer_secret = _consumer()

    header = _oauth_header(
        consumer_key=consumer_key,
        consumer_secret=consumer_secret,
        token=oauth_token,
        token_secret=flow["request_secret"],
        verifier=oauth_verifier,
    )

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(
                _ACCESS_TOKEN_URL,
                headers={
                    "Authorization": header,
                    "Content-Type":  "application/x-www-form-urlencoded",
                    "User-Agent":    _USER_AGENT,
                },
                timeout=15,
            )
        except httpx.RequestError as exc:
            logger.error("Discogs access-token network error: %s", exc)
            flow["status"] = "failed"
            return HTMLResponse(
                f"<html><body style='font-family:sans-serif;padding:40px'>"
                f"<h2>Error</h2><p>{exc}</p></body></html>",
                status_code=502,
            )

    if resp.status_code != 200:
        logger.error("Discogs access-token %d: %s", resp.status_code, resp.text)
        flow["status"] = "failed"
        return HTMLResponse(
            f"<html><body style='font-family:sans-serif;padding:40px'>"
            f"<h2>Discogs error</h2><p>{resp.text}</p></body></html>",
            status_code=resp.status_code,
        )

    access_tokens  = dict(urllib.parse.parse_qsl(resp.text))
    access_token   = access_tokens.get("oauth_token", "")
    access_secret  = access_tokens.get("oauth_token_secret", "")

    # Fetch the Discogs username
    username = None
    identity_header = _oauth_header(
        consumer_key=consumer_key,
        consumer_secret=consumer_secret,
        token=access_token,
        token_secret=access_secret,
    )
    async with httpx.AsyncClient() as client:
        try:
            id_resp = await client.get(
                _IDENTITY_URL,
                headers={"Authorization": identity_header, "User-Agent": _USER_AGENT},
                timeout=15,
            )
            if id_resp.status_code == 200:
                username = id_resp.json().get("username")
        except Exception as exc:
            logger.warning("Could not fetch Discogs identity: %s", exc)

    # Persist to database
    connected_at = int(time.time())
    conn = database.get_connection()
    try:
        database.save_discogs_account(conn, access_token, access_secret, username, connected_at)
        conn.commit()
    finally:
        conn.close()

    # Update in-memory state so the polling endpoint knows it's done
    flow["status"]       = "authorized"
    flow["username"]     = username
    flow["connected_at"] = connected_at

    return HTMLResponse("""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Discogs — Authorised</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    background: #f5f5f0;
    display: flex; align-items: center; justify-content: center; height: 100vh;
  }
  .card { text-align: center; }
  .check {
    width: 48px; height: 48px; border-radius: 50%; background: #e8f3ed;
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto 20px;
  }
  .check svg { width: 22px; height: 22px; stroke: #1a6e3c; stroke-width: 2; fill: none; }
  h2 { font-size: 18px; font-weight: 400; margin-bottom: 8px; color: #0a0a0a; }
  p  { font-size: 13px; color: #7a7a72; }
</style>
</head>
<body>
<div class="card">
  <div class="check">
    <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
  </div>
  <h2>Authorised</h2>
  <p>You can close this window — Rolfsound has your token.</p>
</div>
<script>
  if (window.opener) { try { window.opener.postMessage('discogs_authorized', '*'); } catch(_) {} }
  setTimeout(() => window.close(), 2500);
</script>
</body>
</html>""")


@router.get("/discogs/token-status")
async def token_status(oauthToken: str):
    """Poll endpoint: returns the current status for a pending OAuth handshake."""
    flow = _pending.get(oauthToken)
    if not flow:
        return {"status": "not_found"}
    if flow["status"] == "authorized":
        return {
            "status":      "authorized",
            "username":    flow.get("username"),
            "connected_at": flow.get("connected_at"),
        }
    return {"status": flow["status"]}


@router.get("/discogs/test")
async def test_connection():
    """Verify the stored access token is still accepted by Discogs."""
    conn = database.get_connection()
    try:
        account = database.get_discogs_account(conn)
    finally:
        conn.close()

    if not account:
        return JSONResponse({"ok": False, "error": "not_connected"}, status_code=404)

    consumer_key, consumer_secret = _consumer()
    header = _oauth_header(
        consumer_key=consumer_key,
        consumer_secret=consumer_secret,
        token=account["access_token"],
        token_secret=account["access_secret"],
    )

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(
                _IDENTITY_URL,
                headers={"Authorization": header, "User-Agent": _USER_AGENT},
                timeout=15,
            )
            if resp.status_code == 200:
                return {"ok": True, "username": resp.json().get("username")}
        except Exception as exc:
            logger.error("Discogs test connection error: %s", exc)

    return JSONResponse({"ok": False, "error": "request_failed"}, status_code=502)


@router.get("/discogs/collection")
async def get_collection(
    request: Request,
    page: int = 1,
    per_page: int = 100,
):
    """
    Fetch the authenticated user's Discogs collection.
    Frontend sends:  Authorization: Bearer {access_token}
    """
    bearer       = request.headers.get("Authorization", "")
    access_token = bearer.removeprefix("Bearer ").strip()

    if not access_token:
        return JSONResponse({"error": "no_token"}, status_code=401)

    flow = next(
        (f for f in _pending.values() if f.get("access_token") == access_token),
        None,
    )
    if not flow:
        return JSONResponse({"error": "token_not_found"}, status_code=404)

    username = flow.get("username")
    header   = _oauth_header(
        consumer_key=flow["consumer_key"],
        consumer_secret=flow["consumer_secret"],
        token=access_token,
        token_secret=flow["access_secret"],
    )

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(
                f"https://api.discogs.com/users/{username}/collection/folders/0/releases",
                headers={"Authorization": header, "User-Agent": _USER_AGENT},
                params={
                    "page":       page,
                    "per_page":   per_page,
                    "sort":       "added",
                    "sort_order": "desc",
                },
                timeout=20,
            )
        except httpx.RequestError as exc:
            logger.error("Discogs collection fetch error: %s", exc)
            return JSONResponse({"error": str(exc)}, status_code=502)

    if resp.status_code != 200:
        logger.error("Discogs collection %d: %s", resp.status_code, resp.text)
        return JSONResponse({"error": resp.text}, status_code=resp.status_code)

    data     = resp.json()
    releases = []

    for item in data.get("releases", []):
        bi = item.get("basic_information", {})

        # Clean artist names (Discogs appends " (2)" etc. for disambiguation)
        raw_artists = bi.get("artists", [])
        artist = " / ".join(
            a.get("name", "").rstrip(" 0123456789").strip("() ").strip()
            for a in raw_artists
        ) if raw_artists else "Unknown Artist"

        releases.append({
            "id":          item.get("id"),
            "instance_id": item.get("instance_id"),
            "date_added":  item.get("date_added"),
            "title":       bi.get("title",  "Unknown Title"),
            "year":        bi.get("year"),
            "artist":      artist,
            "cover":       bi.get("cover_image", ""),
            "thumb":       bi.get("thumb", ""),
            "formats":     [f.get("name", "") for f in bi.get("formats", [])],
            "labels":      [l.get("name", "") for l in bi.get("labels",  [])],
            "genres":      bi.get("genres", []),
            "styles":      bi.get("styles", []),
            "discogs_id":  bi.get("id"),
        })

    return {
        "releases":   releases,
        "pagination": data.get("pagination", {}),
        "username":   username,
    }


@router.get("/discogs/image")
async def proxy_image(url: str = Query(...)):
    """
    Proxy para buscar imagens do Discogs e contornar o bloqueio de CORS do WebGL.
    O Discogs exige um User-Agent válido para retornar imagens.
    """
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(
                url, 
                headers={"User-Agent": _USER_AGENT},
                timeout=15
            )
            
            if resp.status_code != 200:
                logger.error("Erro no proxy de imagem (Status %s): %s", resp.status_code, resp.text)
                return Response(status_code=resp.status_code)

            return Response(
                content=resp.content, 
                media_type=resp.headers.get("Content-Type", "image/jpeg")
            )
        except Exception as exc:
            logger.error("Erro ao buscar imagem no proxy: %s", exc)
            return Response(status_code=502)