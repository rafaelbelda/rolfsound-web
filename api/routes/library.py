# api/routes/library.py

import asyncio
import os
import time
from pathlib import Path
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from api.services.indexer import index_asset
from api.services.identification.jobs import enqueue as enqueue_identification, queue_stats
from api.services.identity_editor import (
    build_override_payload,
    find_override_merge_target,
    merge_track_assets_into_target,
    search_identity_candidates,
)
from api.services.status_enricher import clear_track_cache

from core.database import database
from utils.core import core
from utils.image_processor import cache_remote_cover_candidates_sync

router = APIRouter()

_reindex_state = {
    "running": False,
    "total": 0,
    "done": 0,
    "identified": 0,
    "failed": 0,
    "skipped": 0,
}


class PreferredAssetRequest(BaseModel):
    asset_id: str | None = None


class IdentityOverrideRequest(BaseModel):
    candidate: dict | None = None
    title: str | None = None
    display_artist: str | None = None
    artist: str | None = None
    album_title: str | None = None
    album_artist: str | None = None
    album_year: int | None = None
    cover_image: str | None = None
    thumbnail: str | None = None
    year: int | None = None
    duration: float | None = None
    mb_recording_id: str | None = None
    isrc: str | None = None
    spotify_id: str | None = None
    discogs_id: int | None = None
    label: str | None = None
    track_number: int | None = None
    disc_number: int | None = None
    locked: bool = True


async def _broadcast_track_update(track_id: str) -> dict | None:
    from api.ws.endpoint import get_manager as get_ws_manager

    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
    finally:
        conn.close()

    if not track:
        return None

    clear_track_cache(
        track_id=track_id,
        filepath=track.get("file_path") or track.get("filepath"),
    )
    ws_manager = get_ws_manager()
    if ws_manager:
        await ws_manager.broadcast({
            "type": "event.track_updated",
            "payload": track,
            "ts": int(time.time() * 1000),
        })
    return track


@router.post("/library/scan")
async def scan_library():
    """
    Walk the music directory and add any audio files not already in the DB.
    Handles manually added files, tracks downloaded before DB existed, etc.
    """
    from utils.config import get as cfg_get
    music_dir = cfg_get("music_directory", "./music")
    conn = database.get_connection()
    try:
        asset_ids = database.scan_and_reconcile(conn, music_dir, return_asset_ids=True)
        for asset_id in asset_ids:
            enqueue_identification(asset_id)
        return {"ok": True, "added": len(asset_ids), "asset_ids": asset_ids}
    finally:
        conn.close()


@router.get("/library/identification-stats")
async def identification_stats():
    """Counts of identification jobs by status — observability for the queue."""
    return {"queue": queue_stats()}


# ── Identity candidates (low-confidence matches awaiting user confirmation) ──

@router.get("/library/identity-candidates")
async def list_pending_candidates():
    """Pending candidate identifications — assets the system thinks may match
    an existing track but isn't sure enough to auto-merge."""
    conn = database.get_connection()
    try:
        candidates = database.list_identity_candidates(conn, status="pending")
        enriched = []
        for cand in candidates:
            asset = database.get_asset(conn, cand["asset_id"])
            target_track = database.get_track(conn, cand["candidate_track_id"])
            source_track = database.get_track(conn, asset["track_id"]) if asset else None
            enriched.append({
                **cand,
                "asset": asset,
                "candidate_track": target_track,
                "source_track": source_track,
            })
        return {"candidates": enriched, "total": len(enriched)}
    finally:
        conn.close()


class CandidateDecision(BaseModel):
    decision: str  # "confirm" | "reject"


@router.post("/library/identity-candidates/{candidate_id}")
async def decide_candidate(candidate_id: str, body: CandidateDecision):
    """Confirm: merge the asset into the candidate track. Reject: dismiss."""
    if body.decision not in ("confirm", "reject"):
        raise HTTPException(status_code=400, detail="decision must be 'confirm' or 'reject'")

    conn = database.get_connection()
    try:
        cand = database.get_identity_candidate(conn, candidate_id)
        if not cand:
            raise HTTPException(status_code=404, detail="Candidate not found")
        if cand["status"] != "pending":
            raise HTTPException(status_code=409, detail=f"Candidate already {cand['status']}")

        if body.decision == "reject":
            database.set_identity_candidate_status(conn, candidate_id, "rejected")
            return {"ok": True, "status": "rejected"}

        asset = database.get_asset(conn, cand["asset_id"])
        target = database.get_track(conn, cand["candidate_track_id"])
        if not asset or not target:
            raise HTTPException(status_code=410, detail="Asset or target track missing")

        from api.services.indexer import _move_asset_to_track_bundle, _infer_asset_type
        inferred_type = _infer_asset_type(target.get("title") or "", asset.get("asset_type"))
        new_path = _move_asset_to_track_bundle(asset, target["id"], inferred_type)
        if new_path and new_path != asset["file_path"]:
            database.update_asset_path(conn, asset["id"], new_path)
        database.reassign_asset(
            conn,
            asset_id=asset["id"],
            target_track_id=target["id"],
            asset_type=inferred_type,
            set_primary=False,
        )
        database.set_identity_candidate_status(conn, candidate_id, "confirmed")
        conn.commit()
        return {"ok": True, "status": "confirmed", "merged_into": target["id"]}
    finally:
        conn.close()


@router.get("/library")
async def list_library():
    conn = database.get_connection()
    try:
        tracks = database.list_tracks(conn)
        return {"tracks": tracks, "total": len(tracks)}
    finally:
        conn.close()


@router.get("/library/{track_id}/download")
async def download_track(track_id: str):
    """Serve the audio file as a download attachment."""
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        filepath = track.get("file_path")
        if not filepath or not os.path.exists(filepath):
            raise HTTPException(status_code=404, detail="File not found on disk")
        filename = Path(filepath).name
        return FileResponse(
            path=filepath,
            filename=filename,
            media_type="application/octet-stream",
        )
    finally:
        conn.close()


@router.post("/library/{track_id}/preferred-asset")
async def set_preferred_asset(track_id: str, req: PreferredAssetRequest):
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        if not database.set_preferred_asset(conn, track_id, req.asset_id):
            raise HTTPException(status_code=400, detail="Asset does not belong to this track")
        conn.commit()
        return {"ok": True, "track": database.get_track(conn, track_id)}
    finally:
        conn.close()


@router.get("/library/tracks/{track_id}/identity")
async def get_track_identity(track_id: str):
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        override = database.get_track_identity_override(conn, track_id)
        assets = []
        for asset in track.get("assets", []):
            assets.append({
                **asset,
                "last_identification": database.get_asset_identification_result(conn, asset["id"]),
            })
        track["assets"] = assets
        return {"track": track, "override": override}
    finally:
        conn.close()


@router.get("/library/tracks/{track_id}/identity-search")
async def search_track_identity(track_id: str, q: str = Query("")):
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        local_query = q.strip() or " ".join(
            part for part in [track.get("display_artist") or track.get("artist"), track.get("title")] if part
        )
        local_tracks = database.search_tracks(conn, local_query, limit=8) if local_query else []
    finally:
        conn.close()

    candidates = await search_identity_candidates(track, q, local_tracks)
    return {"candidates": candidates, "total": len(candidates)}


@router.post("/library/tracks/{track_id}/identity-override")
async def set_track_identity_override(track_id: str, req: IdentityOverrideRequest):
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
    finally:
        conn.close()

    try:
        if hasattr(req, "model_dump"):
            body = req.model_dump(exclude_unset=True)
        else:
            body = req.dict(exclude_unset=True)
        payload = build_override_payload(body, track)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    conn = database.get_connection()
    merged_into = None
    moved_asset_ids = []
    try:
        current_track = database.get_track(conn, track_id)
        if not current_track:
            raise HTTPException(status_code=404, detail="Track not found")

        merge_match = find_override_merge_target(conn, track_id, payload, body)
        target_id = merge_match["track_id"] if merge_match else None
        if target_id and target_id != track_id:
            moved_asset_ids = merge_track_assets_into_target(
                conn,
                track_id,
                target_id,
                payload,
                match=merge_match,
            )
            merged_into = target_id
            conn.commit()
        else:
            cover = payload.get("cover_image") or payload.get("thumbnail")
            if cover:
                cached = await asyncio.to_thread(
                    cache_remote_cover_candidates_sync,
                    track_id,
                    [cover],
                    "manual",
                )
                if cached:
                    payload["thumbnail"] = cached
                    payload["cover_image"] = cached

            update = {
                "title": payload.get("title"),
                "display_artist": payload.get("display_artist"),
                "status": "identified",
                "mb_recording_id": payload.get("mb_recording_id"),
                "isrc": payload.get("isrc"),
                "spotify_id": payload.get("spotify_id"),
                "discogs_id": payload.get("discogs_id"),
                "label": payload.get("label"),
                "year": payload.get("year"),
            }
            if payload.get("duration"):
                update["duration"] = payload.get("duration")
            if payload.get("thumbnail") or any(key in body for key in ("cover_image", "thumbnail")):
                update["thumbnail"] = payload.get("thumbnail")
            database.replace_track_identity_metadata(conn, track_id, update)
            database.set_track_artist_credits(
                conn,
                track_id,
                payload.get("artists") or [],
                display_artist=payload.get("display_artist"),
                source=payload.get("source") or "manual",
            )
            if payload.get("albums"):
                database.set_track_albums(
                    conn,
                    track_id,
                    payload.get("albums"),
                    track_number=payload.get("track_number"),
                    disc_number=payload.get("disc_number"),
                    source=payload.get("source") or "manual",
                )
            else:
                database.clear_track_albums(conn, track_id)
            database.set_track_identity_override(
                conn,
                track_id,
                payload,
                source=payload.get("source") or "manual",
                locked=req.locked,
            )
            conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    broadcast_id = merged_into or track_id
    track = await _broadcast_track_update(broadcast_id)
    return {
        "ok": True,
        "track": track,
        "override": payload,
        "merged_into": merged_into,
        "removed_track_id": track_id if merged_into else None,
        "moved_asset_ids": moved_asset_ids,
    }


@router.delete("/library/tracks/{track_id}/identity-override")
async def delete_track_identity_override(track_id: str):
    conn = database.get_connection()
    try:
        if not database.get_track(conn, track_id):
            raise HTTPException(status_code=404, detail="Track not found")
        deleted = database.delete_track_identity_override(conn, track_id)
        conn.commit()
    finally:
        conn.close()
    track = await _broadcast_track_update(track_id)
    return {"ok": True, "deleted": deleted, "track": track}


@router.post("/library/{track_id}/identify")
async def identify_track_route(track_id: str, overwrite_manual: bool = Query(False)):
    """Identifica uma faixa específica via AcoustID + Discogs."""
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        asset_id = track.get("asset_id")
        file_path = track.get("file_path")
        if not asset_id or not file_path or not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail="File not found on disk")
    finally:
        conn.close()

    meta = await index_asset(asset_id, allow_identity_resolution=False, overwrite_manual=overwrite_manual)
    return {"ok": True, "track_id": track_id, **meta}


@router.post("/library/identify-all")
async def identify_all_tracks():
    """Processa todas as faixas com status 'unidentified'."""
    conn = database.get_connection()
    try:
        pending = database.list_pending_assets(conn)
    finally:
        conn.close()

    results = {"identified": 0, "failed": 0, "skipped": 0}
    for asset in pending:
        asset_id = asset.get("id")
        file_path = asset.get("file_path")
        if not asset_id or not file_path or not os.path.exists(file_path):
            results["skipped"] += 1
            continue
        meta = await index_asset(asset_id, allow_identity_resolution=True)
        if meta["status"] == "identified":
            results["identified"] += 1
        else:
            results["failed"] += 1

    return {"ok": True, "total": len(pending), **results}


async def _run_reindex(
    assets: list,
    resolve_identity: bool = True,
    overwrite_manual: bool = False,
):
    global _reindex_state
    for asset in assets:
        asset_id = asset.get("id")
        file_path = asset.get("file_path")
        if not asset_id or not file_path or not os.path.exists(file_path):
            _reindex_state["skipped"] += 1
            _reindex_state["done"] += 1
            continue
        meta = await index_asset(
            asset_id,
            allow_identity_resolution=resolve_identity,
            overwrite_manual=overwrite_manual,
        )
        if meta["status"] == "identified":
            _reindex_state["identified"] += 1
        else:
            _reindex_state["failed"] += 1
        _reindex_state["done"] += 1
    _reindex_state["running"] = False


@router.post("/library/reindex-all")
async def reindex_all_tracks(
    background_tasks: BackgroundTasks,
    resolve_identity: bool = Query(True),
    overwrite_manual: bool = Query(False),
):
    """Força reprocessamento de todas as faixas em background."""
    global _reindex_state
    if _reindex_state["running"]:
        return JSONResponse({"error": "already_running"}, status_code=409)

    conn = database.get_connection()
    try:
        assets = database.list_assets(conn)
    finally:
        conn.close()

    _reindex_state.update({
        "running": True, "total": len(assets),
        "done": 0, "identified": 0, "failed": 0, "skipped": 0,
        "resolve_identity": resolve_identity,
        "overwrite_manual": overwrite_manual,
    })
    background_tasks.add_task(_run_reindex, assets, resolve_identity, overwrite_manual)
    return {
        "ok": True,
        "total": len(assets),
        "resolve_identity": resolve_identity,
        "overwrite_manual": overwrite_manual,
    }


@router.get("/library/reindex-status")
async def reindex_status():
    return _reindex_state


@router.get("/library/duplicates")
async def get_duplicates():
    """Return groups of tracks sharing the same Chromaprint fingerprint."""
    conn = database.get_connection()
    try:
        groups = database.find_duplicate_fingerprints(conn)
        return {"groups": groups, "total_groups": len(groups)}
    finally:
        conn.close()


@router.get("/library/{track_id}")
async def get_track(track_id: str):
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        return track
    finally:
        conn.close()


@router.delete("/library/{track_id}")
async def delete_track(track_id: str):
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")

        files_to_delete = [
            a.get("file_path") for a in track.get("assets", [])
            if a.get("file_path") and os.path.exists(a.get("file_path"))
        ]

        if files_to_delete:
            status = await core.get_status()
            if status and status.get("track_id") == track_id:
                await core.pause()
                await core.skip()
                await asyncio.sleep(0.25)

        for filepath in files_to_delete:
            try:
                os.remove(filepath)
            except PermissionError:
                await asyncio.sleep(0.5)
                try:
                    os.remove(filepath)
                except PermissionError:
                    raise HTTPException(status_code=409, detail="File in use — stop playback and try again")

        # Delete local thumbnail if it's a local path (not a URL)
        thumb = track.get("thumbnail", "")
        if thumb and not thumb.startswith("http") and os.path.exists(thumb):
            os.remove(thumb)

        database.delete_track(conn, track_id)
        conn.commit()
        return {"ok": True, "deleted": track_id}
    finally:
        conn.close()
