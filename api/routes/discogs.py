# api/routes/discogs.py
"""
Discogs OAuth 1.0a flow.

Endpoints
---------
POST /api/discogs/request-token   – get a Discogs request token and return the authorize URL
GET  /api/discogs/callback        – Discogs redirects here after user approves
GET  /api/discogs/token-status    – frontend polls this until status == "authorized"
GET  /api/discogs/test            – verify a stored access token is still valid
"""

import logging
import time
import urllib.parse
import uuid

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger(__name__)

# In-memory store keyed by oauth_token (request token).
# Each entry:  { request_secret, consumer_key, consumer_secret,
#               status: "pending"|"authorized"|"failed",
#               access_token, access_secret, username }
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

    # PLAINTEXT signature:  percent_encode(consumer_secret) & percent_encode(token_secret)
    params["oauth_signature"] = (
        f"{urllib.parse.quote(consumer_secret, safe='')}"
        f"&{urllib.parse.quote(token_secret, safe='')}"
    )

    parts = ", ".join(
        f'{k}="{urllib.parse.quote(v, safe="")}"'
        for k, v in sorted(params.items())
    )
    return f"OAuth {parts}"


# ── Routes ────────────────────────────────────────────────────────────────────

class RequestTokenBody(BaseModel):
    consumerKey: str
    consumerSecret: str
    callbackUrl: str = ""


@router.post("/discogs/request-token")
async def request_token(body: RequestTokenBody, request: Request):
    """
    Ask Discogs for a request token, store it in memory, and return the
    authorize URL for the frontend to open.
    """
    callback = (
        body.callbackUrl
        or str(request.base_url).rstrip("/") + "/api/discogs/callback"
    )

    header = _oauth_header(
        consumer_key=body.consumerKey,
        consumer_secret=body.consumerSecret,
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
        return JSONResponse({"error": "missing_token", "message": "Discogs returned no token"}, status_code=502)

    _pending[oauth_token] = {
        "request_secret":  oauth_token_secret,
        "consumer_key":    body.consumerKey,
        "consumer_secret": body.consumerSecret,
        "status":          "pending",
        "access_token":    None,
        "access_secret":   None,
        "username":        None,
    }

    authorize_url = f"{_AUTHORIZE_URL}?oauth_token={urllib.parse.quote(oauth_token)}"
    return {"authorizeUrl": authorize_url, "oauthToken": oauth_token}


@router.get("/discogs/callback")
async def oauth_callback(oauth_token: str, oauth_verifier: str):
    """
    Discogs redirects the user's browser here after they approve access.
    Exchange the request token + verifier for a permanent access token.
    """
    flow = _pending.get(oauth_token)
    if not flow:
        return HTMLResponse(
            "<html><body style='font-family:sans-serif;padding:40px'>"
            "<h2>Session expired</h2><p>Close this window and try connecting again.</p>"
            "</body></html>",
            status_code=400,
        )

    header = _oauth_header(
        consumer_key=flow["consumer_key"],
        consumer_secret=flow["consumer_secret"],
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

    # Fetch the Discogs username while we have credentials
    username = None
    identity_header = _oauth_header(
        consumer_key=flow["consumer_key"],
        consumer_secret=flow["consumer_secret"],
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

    flow.update(
        status="authorized",
        access_token=access_token,
        access_secret=access_secret,
        username=username,
    )

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
    """Poll endpoint: returns the current status for a pending OAuth flow."""
    flow = _pending.get(oauthToken)
    if not flow:
        return {"status": "not_found"}
    if flow["status"] == "authorized":
        return {
            "status":      "authorized",
            "accessToken": flow["access_token"],
            "accessSecret": flow["access_secret"],
            "username":    flow["username"],
        }
    return {"status": flow["status"]}


@router.get("/discogs/test")
async def test_connection(request: Request):
    """
    Verify that a stored access token is still accepted by Discogs.
    The frontend sends:  Authorization: Bearer {access_token}
    The server looks up the matching flow for the consumer credentials.
    """
    bearer = request.headers.get("Authorization", "")
    access_token = bearer.removeprefix("Bearer ").strip()
    if not access_token:
        return JSONResponse({"ok": False, "error": "no_token"}, status_code=400)

    flow = next(
        (f for f in _pending.values() if f.get("access_token") == access_token),
        None,
    )
    if not flow:
        return JSONResponse({"ok": False, "error": "token_not_found"}, status_code=404)

    header = _oauth_header(
        consumer_key=flow["consumer_key"],
        consumer_secret=flow["consumer_secret"],
        token=access_token,
        token_secret=flow["access_secret"],
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
