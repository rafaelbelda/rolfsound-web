# api/routes/upload.py
"""
Intake do cofre — importação de arquivos de áudio arrastados para o app.

POST /api/library/upload            recebe o arquivo, lê TODAS as etiquetas
                                    (mutagen), extrai a capa embutida, salva
                                    no diretório de música e cataloga no DB
                                    com artista/álbum/capa alocados.
GET  /api/library/{id}/dossier      a mesma ficha técnica para uma faixa que
                                    já está no cofre (menu "Ficha técnica").

A ficha ("dossiê") devolvida contém: a linha do DB, os fatos do arquivo
(codec, kHz, kbps, canais, bits, tamanho), o manifesto — cada etiqueta crua
que o arquivo carrega — e um aviso de possível duplicata por fingerprint.
"""

import logging
import os
import re
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File

from db import database
from utils.config import get as cfg_get
from youtube.ytdlp import AUDIO_EXTENSIONS

logger = logging.getLogger(__name__)

router = APIRouter()

# Caracteres proibidos em nomes de arquivo no Windows + controles.
_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# Mapeia a classe do mutagen para um rótulo de codec legível.
_CODEC_LABEL = {
    "MP3": "MP3", "FLAC": "FLAC", "WAVE": "WAV", "MP4": "AAC · M4A",
    "OggOpus": "Opus", "OggVorbis": "Ogg Vorbis", "AAC": "AAC", "AIFF": "AIFF",
}


# ── Leitura do arquivo ────────────────────────────────────────────────────────

def _load_audio(path: str):
    """(easy, raw) do mutagen — qualquer um pode ser None (ex.: webm)."""
    import mutagen
    easy = raw = None
    try:
        easy = mutagen.File(path, easy=True)
    except Exception as e:
        logger.debug(f"mutagen easy falhou: {e}")
    try:
        raw = mutagen.File(path)
    except Exception as e:
        logger.debug(f"mutagen raw falhou: {e}")
    return easy, raw


def _tag_first(tags, *keys) -> str:
    """Primeiro valor não-vazio entre as chaves (interface easy/VComment)."""
    if not tags:
        return ""
    for k in keys:
        try:
            v = tags.get(k)
        except Exception:
            v = None
        if v:
            v = v[0] if isinstance(v, (list, tuple)) else v
            s = str(v).strip()
            if s:
                return s
    return ""


def _raw_text(raw, *frame_keys) -> str:
    """Texto de um frame ID3/MP4 cru (para chaves fora da interface easy)."""
    tags = getattr(raw, "tags", None)
    if not tags:
        return ""
    for k in frame_keys:
        try:
            if k in tags:
                v = tags[k]
                if hasattr(v, "text"):
                    v = v.text
                v = v[0] if isinstance(v, (list, tuple)) and v else v
                s = str(v).strip()
                if s:
                    return s
        except Exception:
            continue
    return ""


def _norm_tags(easy, raw) -> dict:
    """Etiquetas normalizadas independentes do formato."""
    t = getattr(easy, "tags", None)
    tags = {
        "title":       _tag_first(t, "title"),
        "artist":      _tag_first(t, "artist"),
        "album":       _tag_first(t, "album"),
        "albumartist": _tag_first(t, "albumartist"),
        "date":        _tag_first(t, "date", "year", "originaldate"),
        "genre":       _tag_first(t, "genre"),
        "tracknumber": _tag_first(t, "tracknumber"),
        "discnumber":  _tag_first(t, "discnumber"),
        "composer":    _tag_first(t, "composer"),
        "label":       _tag_first(t, "organization", "label", "publisher"),
        "bpm":         _tag_first(t, "bpm"),
        "key":         _tag_first(t, "initialkey", "key"),
        "comment":     _tag_first(t, "comment", "description"),
    }
    # Chaves que a interface easy não cobre em ID3/MP4.
    if not tags["key"]:
        tags["key"] = _raw_text(raw, "TKEY")
    if not tags["bpm"]:
        tags["bpm"] = _raw_text(raw, "TBPM", "tmpo")
    if not tags["label"]:
        tags["label"] = _raw_text(raw, "TPUB")
    return tags


def _year_of(date_str: str) -> int | None:
    m = re.search(r"\d{4}", date_str or "")
    return int(m.group()) if m else None


def _tracknum_of(s: str) -> int | None:
    """Número da faixa a partir da tag 'tracknumber' (aceita '3' ou '3/12')."""
    m = re.match(r"\s*(\d+)", s or "")
    return int(m.group(1)) if m else None


def _float_of(s: str) -> float | None:
    try:
        v = float(str(s).replace(",", "."))
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


def _render_value(v) -> str:
    """Valor de etiqueta como texto seguro (binários viram descrição)."""
    if isinstance(v, (list, tuple)):
        return " · ".join(_render_value(x) for x in list(v)[:8])
    if isinstance(v, bytes):
        return f"dados binários · {max(1, len(v) // 1024)} KB"
    data = getattr(v, "data", None)
    if isinstance(data, bytes) and len(data) > 256:
        mime = getattr(v, "mime", "") or "binário"
        return f"{mime} · {max(1, len(data) // 1024)} KB"
    if hasattr(v, "text"):
        try:
            return " · ".join(str(x) for x in v.text)
        except Exception:
            pass
    s = str(v)
    return s[:300] + "…" if len(s) > 300 else s


def _manifest(raw) -> list[dict]:
    """O manifesto: cada etiqueta crua que o arquivo carrega, em ordem."""
    tags = getattr(raw, "tags", None)
    if not tags:
        return []
    items = []
    try:
        for key, val in tags.items():
            try:
                items.append({"k": str(key), "v": _render_value(val)})
            except Exception:
                continue
    except Exception:
        return items
    items.sort(key=lambda x: x["k"].lower())
    return items[:120]


def _probe_av(path: str) -> dict:
    """Fallback PyAV para formatos que o mutagen não lê (ex.: webm)."""
    try:
        import av
        with av.open(path) as c:
            stream = c.streams.audio[0] if c.streams.audio else None
            cc = stream.codec_context if stream else None
            return {
                "duration":    (c.duration or 0) / 1_000_000 or None,
                "bitrate":     round((c.bit_rate or 0) / 1000) or None,
                "sample_rate": getattr(cc, "sample_rate", None),
                "channels":    getattr(cc, "channels", None),
                "codec":       (cc.codec.name.upper() if cc and cc.codec else None),
            }
    except Exception:
        return {}


def _file_facts(path: str, raw) -> dict:
    """Fatos técnicos do arquivo: codec, kHz, kbps, canais, bits, tamanho."""
    p = Path(path)
    info = getattr(raw, "info", None)
    facts = {
        "name":        p.name,
        "ext":         p.suffix.lstrip(".").upper(),
        "size":        p.stat().st_size if p.exists() else 0,
        "duration":    getattr(info, "length", None),
        "bitrate":     round(getattr(info, "bitrate", 0) / 1000) or None,
        "sample_rate": getattr(info, "sample_rate", None),
        "channels":    getattr(info, "channels", None),
        "bits":        getattr(info, "bits_per_sample", None),
        "codec":       _CODEC_LABEL.get(type(raw).__name__) if raw else None,
    }
    if not facts["duration"] or not facts["codec"]:
        probe = _probe_av(path)
        for k, v in probe.items():
            if not facts.get(k) and v:
                facts[k] = v
    return facts


# ── Capa embutida ─────────────────────────────────────────────────────────────

def _extract_cover(raw) -> tuple[bytes, str] | None:
    """(bytes, mime) da arte embutida — ID3 APIC, MP4 covr, FLAC, Ogg/Opus."""
    if raw is None:
        return None
    # FLAC
    pics = getattr(raw, "pictures", None)
    if pics:
        return pics[0].data, pics[0].mime or "image/jpeg"
    tags = getattr(raw, "tags", None)
    if tags is None:
        return None
    # ID3 (MP3, WAV, AIFF)
    try:
        apics = tags.getall("APIC") if hasattr(tags, "getall") else []
        if apics:
            return apics[0].data, apics[0].mime or "image/jpeg"
    except Exception:
        pass
    # MP4 / M4A
    try:
        if "covr" in tags and tags["covr"]:
            from mutagen.mp4 import MP4Cover
            cover = tags["covr"][0]
            fmt = getattr(cover, "imageformat", MP4Cover.FORMAT_JPEG)
            mime = "image/png" if fmt == MP4Cover.FORMAT_PNG else "image/jpeg"
            return bytes(cover), mime
    except Exception:
        pass
    # Ogg Vorbis / Opus
    try:
        mbp = tags.get("metadata_block_picture") if hasattr(tags, "get") else None
        if mbp:
            import base64
            from mutagen.flac import Picture
            pic = Picture(base64.b64decode(mbp[0]))
            return pic.data, pic.mime or "image/jpeg"
    except Exception:
        pass
    return None


def _save_cover(raw, music_dir: Path, stem: str) -> str | None:
    """Grava a arte embutida como sidecar {stem}.jpg|.png; devolve URL /thumbs."""
    found = _extract_cover(raw)
    if not found:
        return None
    data, mime = found
    ext = ".png" if "png" in (mime or "").lower() else ".jpg"
    dest = music_dir / f"{stem}{ext}"
    try:
        dest.write_bytes(data)
        return f"/thumbs/{dest.name}"
    except Exception as e:
        logger.warning(f"não gravou capa embutida: {e}")
        return None


# ── Nomeação e duplicatas ─────────────────────────────────────────────────────

def _safe_stem(filename: str) -> str:
    stem = _UNSAFE.sub("", Path(filename).stem).strip(" .")
    stem = re.sub(r"\s+", " ", stem)
    return stem[:80] or f"faixa-{int(time.time())}"


def _unique_stem(conn, music_dir: Path, stem: str) -> str:
    """Stem livre no disco E no DB (o id da faixa é o stem, como no scan)."""
    candidate, n = stem, 2
    while True:
        on_disk = any((music_dir / f"{candidate}{ext}").exists() for ext in AUDIO_EXTENSIONS)
        in_db = database.get_track(conn, candidate) is not None
        if not on_disk and not in_db:
            return candidate
        candidate = f"{stem} ({n})"
        n += 1


def _find_duplicate(conn, track_id: str, fp: str | None) -> dict | None:
    if not fp:
        return None
    row = conn.execute(
        "SELECT id, title, artist FROM tracks WHERE fingerprint = ? AND id != ? LIMIT 1",
        (fp, track_id),
    ).fetchone()
    return dict(row) if row else None


# ── Dossiê ────────────────────────────────────────────────────────────────────

def _build_dossier(conn, track_id: str) -> dict:
    """Ficha técnica completa de uma faixa catalogada (lê o arquivo ao vivo)."""
    track = database.get_track(conn, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    path = track.get("file_path") or ""
    if path and os.path.exists(path):
        easy, raw = _load_audio(path)
        facts = _file_facts(path, raw)
        manifest = _manifest(raw)
        tags = _norm_tags(easy, raw)
    else:
        facts, manifest, tags = {"missing": True, "name": Path(path).name if path else ""}, [], {}

    return {
        "ok": True,
        "track": track,
        "file": facts,
        "manifest": manifest,
        "tags": tags,
        "cover": track.get("thumbnail") or None,
        "duplicate_of": _find_duplicate(conn, track_id, track.get("fingerprint")),
    }


# ── Rotas ─────────────────────────────────────────────────────────────────────

@router.post("/library/upload")
async def upload_track(file: UploadFile = File(...)):
    """
    Intake: salva o arquivo no diretório de música, lê as etiquetas, extrai a
    capa embutida e cataloga. Sem etiquetas de título/artista a faixa entra
    como 'unidentified' — a UI dispara /identify em seguida.
    """
    ext = Path(file.filename or "").suffix.lower()
    if ext not in AUDIO_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail=f"Formato não suportado: {ext or 'sem extensão'}",
        )

    music_dir = Path(cfg_get("music_directory", "./music")).resolve()
    music_dir.mkdir(parents=True, exist_ok=True)

    conn = database.get_connection()
    try:
        stem = _unique_stem(conn, music_dir, _safe_stem(file.filename or "faixa"))
    finally:
        conn.close()

    dest = music_dir / f"{stem}{ext}"
    try:
        with dest.open("wb") as out:
            shutil.copyfileobj(file.file, out, length=1024 * 1024)
    except Exception as e:
        logger.error(f"upload: falha ao gravar {dest.name}: {e}")
        raise HTTPException(status_code=500, detail="Falha ao gravar o arquivo")
    finally:
        await file.close()

    easy, raw = _load_audio(str(dest))
    tags = _norm_tags(easy, raw)
    facts = _file_facts(str(dest), raw)
    thumb = _save_cover(raw, music_dir, stem)

    identified = bool(tags["title"] and tags["artist"])
    track_id = stem

    conn = database.get_connection()
    try:
        # Álbum: tag de álbum ⇒ find-or-create por (artista, álbum) e semeia
        # year/genre; sem tag de álbum a faixa vira seu próprio single.
        if tags["album"]:
            album_id = database.find_or_create_album(
                conn, tags["album"], tags["artist"] or "",
                year=_year_of(tags["date"]), genre=tags["genre"] or None)
        else:
            album_id = database.create_single_album(
                conn, tags["title"] or stem, tags["artist"] or "")
        database.insert_track(conn, {
            "id":             track_id,
            "title":          tags["title"] or stem,
            "artist":         tags["artist"],
            "duration":       int(facts["duration"]) if facts.get("duration") else None,
            "thumbnail":      thumb,
            "file_path":      str(dest),
            "date_added":     int(time.time()),
            "published_date": None,
            "streams":        0,
            "source":         "upload",
            "status":         "identified" if identified else "unidentified",
            "mb_recording_id": None,
            "discogs_id":     None,
            "label":          tags["label"] or None,
            "album_id":       album_id,
        })
        embedded_bpm = _float_of(tags["bpm"])
        embedded_key = tags["key"] or None
        database.update_track_metadata(conn, track_id, {
            "bpm":      embedded_bpm,
            "key":      embedded_key,
            "track_no": _tracknum_of(tags["tracknumber"]),
        })
        conn.commit()
    finally:
        conn.close()

    # Fingerprint para detecção de duplicata (silencioso se indisponível).
    fp_str = None
    try:
        from api.services.indexer import fingerprint
        fp = await fingerprint(str(dest))
        if fp and fp.get("fingerprint"):
            fp_str = fp["fingerprint"]
            conn = database.get_connection()
            try:
                database.update_track_metadata(conn, track_id, {"fingerprint": fp_str})
                if not facts.get("duration") and fp.get("duration"):
                    database.update_track_metadata(
                        conn, track_id, {"duration": int(fp["duration"])})
                conn.commit()
            finally:
                conn.close()
    except Exception as e:
        logger.debug(f"upload: fingerprint indisponível: {e}")

    # BPM/tom via Essentia — em background e um arquivo de cada vez (fila em
    # api/services/indexer.py), nunca bloqueia a resposta do upload nem
    # dispara N processos Essentia concorrentes numa importação em lote. Só
    # preenche o que o arquivo não já trouxe embutido (etiqueta do arquivo é
    # tratada como autoritativa). Ao contrário do fluxo /identify,
    # upload_track nunca chama index_file quando o arquivo já tem
    # título/artista embutidos (identified=True logo acima) — sem isso,
    # faixas já etiquetadas nunca seriam analisadas.
    from api.services import indexer
    if not embedded_bpm or not embedded_key:
        indexer.enqueue_bpm_key_analysis(track_id, str(dest), embedded_bpm, embedded_key)

    # Forma de onda real (Remixer) — nunca vem embutida no arquivo, então
    # sempre enfileira, ao contrário do BPM/tom acima.
    indexer.enqueue_waveform_analysis(track_id, str(dest))

    conn = database.get_connection()
    try:
        dossier = _build_dossier(conn, track_id)
    finally:
        conn.close()

    logger.info(
        f"upload: {dest.name} catalogado como '{track_id}' "
        f"({'etiquetado' if identified else 'sem etiquetas'})"
    )
    return dossier


@router.get("/library/{track_id}/dossier")
async def get_dossier(track_id: str):
    """Ficha técnica de uma faixa já catalogada."""
    conn = database.get_connection()
    try:
        return _build_dossier(conn, track_id)
    finally:
        conn.close()
