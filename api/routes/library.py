# api/routes/library.py

import os
from pathlib import Path
from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask
from api.services import exporter
from api.services.indexer import index_file
from api.track_view import track_view

from db import database

router = APIRouter()


class TrackMetadataUpdate(BaseModel):
    title: str | None = None
    artist: str | None = None
    # "album" é membership (nome do álbum; vazio/"Single" = single próprio),
    # não um campo da faixa. year/genre do álbum se editam em PATCH /albums.
    album: str | None = None
    track_no: int | None = None
    bpm: float | None = None
    key: str | None = None
    version_label: str | None = None
    tags: list[str] | None = None
    fav: bool | None = None


_reindex_state = {
    "running": False,
    "total": 0,
    "done": 0,
    "identified": 0,
    "failed": 0,
    "skipped": 0,
}


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
        added = database.scan_and_reconcile(conn, music_dir)
        return {"ok": True, "added": added}
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
def download_track(track_id: str, format: str = "original", cover: bool = True):
    """Exporta o áudio como "NN Título.ext" com os metadados do Acervo
    gravados no arquivo; format=flac|mp3|wav converte via PyAV (popup
    "Exportar faixa"). Def síncrono: o trabalho roda no threadpool."""
    if format not in exporter.EXPORT_FORMATS:
        raise HTTPException(status_code=400, detail=f"format deve ser um de {exporter.EXPORT_FORMATS}")
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        filepath = track.get("file_path")
        if not filepath or not os.path.exists(filepath):
            raise HTTPException(status_code=404, detail="File not found on disk")
        filename = exporter.export_filename(track, format)
        try:
            tagged = exporter.export_copy(track, format, cover=cover)
        except Exception:
            raise HTTPException(status_code=500, detail=f"Conversão para {format} falhou")
        if tagged:
            return FileResponse(
                path=tagged,
                filename=filename,
                media_type="application/octet-stream",
                background=BackgroundTask(os.remove, tagged),
            )
        # sem como gravar tags neste formato — serve o original com o nome certo
        return FileResponse(
            path=filepath,
            filename=filename,
            media_type="application/octet-stream",
        )
    finally:
        conn.close()


@router.get("/library/{track_id}/waveform")
async def get_track_waveform(track_id: str):
    """Picos de amplitude (0..1) da faixa inteira, pro Remixer desenhar a
    onda real. 404 enquanto a extração em background ainda não rodou —
    o front cai de volta pro placeholder sintético nesse caso."""
    conn = database.get_connection()
    try:
        waveform = database.get_waveform(conn, track_id)
        if not waveform:
            raise HTTPException(status_code=404, detail="Waveform not analyzed yet")
        return waveform
    finally:
        conn.close()


@router.get("/library/{track_id}/card")
async def get_track_card(track_id: str):
    """Faixa única no MESMO formato do bootstrap (shape de static/js/data.js).
    O front usa isto para inserir a row no Acervo AO VIVO — ex.: quando um
    download do Discovery conclui, sem recarregar a página."""
    conn = database.get_connection()
    try:
        row = database.get_track(conn, track_id)
        if not row:
            raise HTTPException(status_code=404, detail="Track not found")
        # Papéis de stems só existem na variação Stem Ready; primary só quando a
        # faixa representa a "pasta" do seu grupo de versões. Uma faixa recém
        # baixada não tem nem um nem outro, mas resolvemos os dois pra que o
        # endpoint sirva qualquer faixa corretamente.
        src = row.get("stem_source_id")
        stems = database.stems_map(conn).get(src, []) if src else []
        primary = False
        group_id = row.get("version_group_id")
        if group_id:
            g = database.get_version_group(conn, group_id)
            primary = bool(g and g.get("primary_track_id") == track_id)
        return track_view(row, stems, primary)
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


@router.patch("/library/{track_id}")
async def update_track_route(track_id: str, req: TrackMetadataUpdate):
    """Salva edições manuais de metadados (editor "Editar informações")."""
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        data = req.model_dump(exclude_unset=True)

        # "album" é membership: resolve/cria o álbum e reatribui a faixa. Não é
        # coluna da faixa — title/year/genre do álbum se editam em PATCH /albums.
        if "album" in data:
            album_name = (data.pop("album") or "").strip()
            artist = data.get("artist", track.get("artist")) or ""
            if album_name and album_name != "Single":
                album_id = database.find_or_create_album(conn, album_name, artist)
            elif track.get("album_kind") == "single":
                album_id = track.get("album_id")   # já é single: mantém
            else:
                album_id = database.create_single_album(
                    conn, data.get("title") or track.get("title") or "", artist)
            if album_id and album_id != track.get("album_id"):
                database.set_track_album(conn, track_id, album_id)

        database.update_track_metadata(conn, track_id, data)
        # Invariante: single tem o título da própria música — renomear a faixa
        # renomeia o single junto (a membership acima pode ter trocado o álbum,
        # então relê a faixa para decidir sobre o álbum ATUAL).
        new_title = (data.get("title") or "").strip()
        if new_title and new_title != (track.get("title") or ""):
            fresh = database.get_track(conn, track_id) or {}
            if fresh.get("album_kind") == "single" and fresh.get("album_id"):
                database.update_album(conn, fresh["album_id"], {"title": new_title})
        conn.commit()
        return {"ok": True, "track": database.get_track(conn, track_id)}
    finally:
        conn.close()


@router.post("/library/{track_id}/identify")
async def identify_track_route(track_id: str):
    """Identifica uma faixa específica via AcoustID + Discogs."""
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        file_path = track.get("file_path")
        if not file_path or not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail="File not found on disk")
    finally:
        conn.close()

    meta = await index_file(track_id, file_path)
    return {"ok": True, "track_id": track_id, **meta}


@router.post("/library/identify-all")
async def identify_all_tracks():
    """Processa todas as faixas com status 'unidentified'."""
    conn = database.get_connection()
    try:
        pending = database.list_unidentified_tracks(conn)
    finally:
        conn.close()

    results = {"identified": 0, "failed": 0, "skipped": 0}
    for track in pending:
        file_path = track.get("file_path")
        if not file_path or not os.path.exists(file_path):
            results["skipped"] += 1
            continue
        meta = await index_file(track["id"], file_path)
        if meta["status"] == "identified":
            results["identified"] += 1
        else:
            results["failed"] += 1

    return {"ok": True, "total": len(pending), **results}


async def _run_reindex(tracks: list):
    global _reindex_state
    for track in tracks:
        file_path = track.get("file_path")
        if not file_path or not os.path.exists(file_path):
            _reindex_state["skipped"] += 1
            _reindex_state["done"] += 1
            continue
        meta = await index_file(track["id"], file_path)
        if meta["status"] == "identified":
            _reindex_state["identified"] += 1
        else:
            _reindex_state["failed"] += 1
        _reindex_state["done"] += 1
    _reindex_state["running"] = False


@router.post("/library/reindex-all")
async def reindex_all_tracks(background_tasks: BackgroundTasks):
    """Força reprocessamento de todas as faixas em background."""
    global _reindex_state
    if _reindex_state["running"]:
        return JSONResponse({"error": "already_running"}, status_code=409)

    conn = database.get_connection()
    try:
        tracks = database.list_tracks(conn)
    finally:
        conn.close()

    _reindex_state.update({
        "running": True, "total": len(tracks),
        "done": 0, "identified": 0, "failed": 0, "skipped": 0,
    })
    background_tasks.add_task(_run_reindex, tracks)
    return {"ok": True, "total": len(tracks)}


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


@router.delete("/library/{track_id}")
async def delete_track(track_id: str):
    conn = database.get_connection()
    try:
        track = database.get_track(conn, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")

        # Variação Stem Ready: file_path/thumbnail/sidecars pertencem ao
        # MASTER — apagar arquivos aqui destruiria o áudio da original.
        # Só a linha da variação sai (sidecars ficam).
        if track.get("stem_source_id"):
            database.delete_stem_variant(conn, track_id)
            conn.commit()
            return {"ok": True, "deleted": track_id}

        # Delete audio file
        filepath = track.get("file_path")
        if filepath and os.path.exists(filepath):
            os.remove(filepath)

        # Delete stem sidecars ({id}.stem.{role}.ext) — a linha em track_stems
        # cai junto com a faixa em database.delete_track.
        for stem in database.get_stems(conn, track_id):
            spath = stem.get("file_path")
            if spath and os.path.exists(spath):
                try:
                    os.remove(spath)
                except OSError:
                    pass

        # Delete local thumbnail if it's a local path (not a URL).
        # "/thumbs/x.jpg" is the served alias for a sidecar in music_directory.
        thumb = track.get("thumbnail") or ""   # a coluna existe com NULL — o default do .get não pega
        if thumb.startswith("/thumbs/"):
            from utils.config import get as cfg_get
            thumb = os.path.join(cfg_get("music_directory", "./music"), thumb[len("/thumbs/"):])
        if thumb and not thumb.startswith("http") and os.path.exists(thumb):
            os.remove(thumb)

        database.delete_track(conn, track_id)
        conn.commit()
        return {"ok": True, "deleted": track_id}
    finally:
        conn.close()