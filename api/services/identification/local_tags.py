"""
Mutagen-based local tag extraction.

Extracts everything TinyTag does, plus deterministic identifiers we lose today:
- ISRC (TXXX:ISRC, TSRC, vorbis ISRC, MP4 ----:com.apple.iTunes:ISRC)
- MusicBrainz Picard recording / release / artist IDs
- Catalog # / barcode / publisher
- Track / disc numbers (so we can hint album context)
- Embedded cover art (any APIC frame, FLAC picture, MP4 cover atom)

Returns a flat dict; missing fields are None / empty.
"""

from __future__ import annotations

import logging
from pathlib import Path

from utils import config as cfg

logger = logging.getLogger(__name__)

_COVER_FILENAME = "cover.jpg"


def _coerce_str(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, list):
        if not value:
            return None
        value = value[0]
    text = str(value).strip()
    return text or None


def _coerce_int(value) -> int | None:
    text = _coerce_str(value)
    if not text:
        return None
    head = text.split("/")[0].strip()
    head = head.split("-")[0].strip()
    try:
        return int(head)
    except ValueError:
        return None


def _id3_text(tags, key: str) -> str | None:
    frame = tags.get(key)
    if frame is None:
        return None
    if hasattr(frame, "text"):
        return _coerce_str(frame.text)
    return _coerce_str(frame)


def _id3_txxx(tags, desc: str) -> str | None:
    for frame in tags.getall("TXXX"):
        if getattr(frame, "desc", "").upper() == desc.upper():
            return _coerce_str(frame.text)
    return None


def _id3_ufid(tags, owner: str) -> str | None:
    for frame in tags.getall("UFID"):
        if getattr(frame, "owner", "") == owner:
            data = getattr(frame, "data", None)
            if data:
                try:
                    return data.decode("ascii", errors="replace").strip() or None
                except Exception:
                    return None
    return None


def _vorbis_first(tags, key: str) -> str | None:
    return _coerce_str(tags.get(key)) or _coerce_str(tags.get(key.upper())) or _coerce_str(tags.get(key.lower()))


def _mp4_first(tags, key: str) -> str | None:
    val = tags.get(key)
    if val is None:
        return None
    if isinstance(val, list) and val:
        v = val[0]
        if hasattr(v, "decode"):
            try:
                return v.decode("utf-8", errors="replace").strip() or None
            except Exception:
                return None
        return _coerce_str(v)
    return _coerce_str(val)


def _save_cover(track_id: str, image_data: bytes) -> str | None:
    if not image_data or len(image_data) < 200:
        return None
    music_dir = Path(cfg.get("music_directory", "./music"))
    cover_path = music_dir / track_id / _COVER_FILENAME
    cover_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(cover_path, "wb") as f:
            f.write(image_data)
        return str(cover_path)
    except OSError as exc:
        logger.debug("local_tags: failed to save embedded cover for %s: %s", track_id, exc)
        return None


def _extract_id3(audio, track_id: str) -> dict:
    tags = audio.tags
    result: dict = {}
    if tags is None:
        return result

    result["title"] = _id3_text(tags, "TIT2")
    result["artist"] = _id3_text(tags, "TPE1") or _id3_text(tags, "TPE2")
    result["albumartist"] = _id3_text(tags, "TPE2")
    result["album"] = _id3_text(tags, "TALB")
    result["year"] = _coerce_int(_id3_text(tags, "TDRC") or _id3_text(tags, "TYER"))
    result["genre"] = _id3_text(tags, "TCON")
    result["publisher"] = _id3_text(tags, "TPUB")
    result["catalog_number"] = _id3_txxx(tags, "CATALOGNUMBER")
    result["barcode"] = _id3_txxx(tags, "BARCODE")
    result["track_number"] = _coerce_int(_id3_text(tags, "TRCK"))
    result["disc_number"] = _coerce_int(_id3_text(tags, "TPOS"))

    isrc = _id3_text(tags, "TSRC") or _id3_txxx(tags, "ISRC")
    result["isrc"] = isrc

    result["mb_recording_id"] = (
        _id3_ufid(tags, "http://musicbrainz.org")
        or _id3_txxx(tags, "MusicBrainz Track Id")
        or _id3_txxx(tags, "MUSICBRAINZ_TRACKID")
        or _id3_txxx(tags, "MUSICBRAINZ_RECORDINGID")
    )
    result["mb_release_id"] = _id3_txxx(tags, "MusicBrainz Album Id") or _id3_txxx(tags, "MUSICBRAINZ_ALBUMID")
    result["mb_release_group_id"] = (
        _id3_txxx(tags, "MusicBrainz Release Group Id")
        or _id3_txxx(tags, "MUSICBRAINZ_RELEASEGROUPID")
    )
    result["mb_artist_id"] = _id3_txxx(tags, "MusicBrainz Artist Id") or _id3_txxx(tags, "MUSICBRAINZ_ARTISTID")

    apic = next((f for f in tags.values() if getattr(f, "FrameID", "") == "APIC"), None)
    if apic and getattr(apic, "data", None):
        cover = _save_cover(track_id, apic.data)
        if cover:
            result["thumbnail"] = cover
    return result


def _extract_vorbis(audio, track_id: str) -> dict:
    tags = audio.tags or {}
    result: dict = {
        "title": _vorbis_first(tags, "title"),
        "artist": _vorbis_first(tags, "artist"),
        "albumartist": _vorbis_first(tags, "albumartist"),
        "album": _vorbis_first(tags, "album"),
        "year": _coerce_int(_vorbis_first(tags, "date") or _vorbis_first(tags, "year")),
        "genre": _vorbis_first(tags, "genre"),
        "publisher": _vorbis_first(tags, "label") or _vorbis_first(tags, "organization") or _vorbis_first(tags, "publisher"),
        "catalog_number": _vorbis_first(tags, "catalognumber"),
        "barcode": _vorbis_first(tags, "barcode"),
        "track_number": _coerce_int(_vorbis_first(tags, "tracknumber")),
        "disc_number": _coerce_int(_vorbis_first(tags, "discnumber")),
        "isrc": _vorbis_first(tags, "isrc"),
        "mb_recording_id": _vorbis_first(tags, "musicbrainz_trackid") or _vorbis_first(tags, "musicbrainz_recordingid"),
        "mb_release_id": _vorbis_first(tags, "musicbrainz_albumid"),
        "mb_release_group_id": _vorbis_first(tags, "musicbrainz_releasegroupid"),
        "mb_artist_id": _vorbis_first(tags, "musicbrainz_artistid"),
    }

    pictures = getattr(audio, "pictures", None) or []
    if pictures:
        cover = _save_cover(track_id, pictures[0].data)
        if cover:
            result["thumbnail"] = cover
    elif "metadata_block_picture" in tags:
        import base64
        try:
            from mutagen.flac import Picture
            pic_data = base64.b64decode(tags["metadata_block_picture"][0])
            picture = Picture(pic_data)
            cover = _save_cover(track_id, picture.data)
            if cover:
                result["thumbnail"] = cover
        except Exception as exc:
            logger.debug("local_tags: vorbis picture decode failed: %s", exc)
    return result


def _extract_mp4(audio, track_id: str) -> dict:
    tags = audio.tags or {}
    iTunes = "----:com.apple.iTunes:"
    result: dict = {
        "title": _mp4_first(tags, "\xa9nam"),
        "artist": _mp4_first(tags, "\xa9ART"),
        "albumartist": _mp4_first(tags, "aART"),
        "album": _mp4_first(tags, "\xa9alb"),
        "year": _coerce_int(_mp4_first(tags, "\xa9day")),
        "genre": _mp4_first(tags, "\xa9gen"),
        "publisher": _mp4_first(tags, f"{iTunes}LABEL") or _mp4_first(tags, f"{iTunes}publisher"),
        "catalog_number": _mp4_first(tags, f"{iTunes}CATALOGNUMBER"),
        "barcode": _mp4_first(tags, f"{iTunes}BARCODE"),
        "isrc": _mp4_first(tags, f"{iTunes}ISRC"),
        "mb_recording_id": (
            _mp4_first(tags, f"{iTunes}MusicBrainz Track Id")
            or _mp4_first(tags, f"{iTunes}MUSICBRAINZ_TRACKID")
        ),
        "mb_release_id": _mp4_first(tags, f"{iTunes}MusicBrainz Album Id"),
        "mb_release_group_id": _mp4_first(tags, f"{iTunes}MusicBrainz Release Group Id"),
        "mb_artist_id": _mp4_first(tags, f"{iTunes}MusicBrainz Artist Id"),
    }

    trkn = tags.get("trkn")
    if trkn and isinstance(trkn, list) and trkn:
        result["track_number"] = trkn[0][0] if isinstance(trkn[0], (tuple, list)) and trkn[0] else None
    disk = tags.get("disk")
    if disk and isinstance(disk, list) and disk:
        result["disc_number"] = disk[0][0] if isinstance(disk[0], (tuple, list)) and disk[0] else None

    covers = tags.get("covr")
    if covers and len(covers):
        cover = _save_cover(track_id, bytes(covers[0]))
        if cover:
            result["thumbnail"] = cover
    return result


_EMPTY: dict = {
    "title": None,
    "artist": None,
    "albumartist": None,
    "album": None,
    "year": None,
    "duration": None,
    "thumbnail": None,
    "genre": None,
    "publisher": None,
    "catalog_number": None,
    "barcode": None,
    "track_number": None,
    "disc_number": None,
    "isrc": None,
    "mb_recording_id": None,
    "mb_release_id": None,
    "mb_release_group_id": None,
    "mb_artist_id": None,
}


def extract_local_tags(file_path: str, track_id: str) -> dict:
    """
    Synchronous; safe to wrap in asyncio.to_thread.

    Returns the _EMPTY shape with keys filled where available. Always returns
    a dict (no exceptions propagate). Embedded cover, when present, is written
    to <music_directory>/<track_id>/cover.jpg and the path is returned in
    `thumbnail`.
    """
    result = dict(_EMPTY)
    try:
        from mutagen import File as MutagenFile
        from mutagen.id3 import ID3
        from mutagen.flac import FLAC
        from mutagen.oggvorbis import OggVorbis
        from mutagen.oggopus import OggOpus
        from mutagen.mp4 import MP4
    except ImportError:
        logger.warning("mutagen not installed; falling back to TinyTag")
        return _legacy_tinytag_extract(file_path, track_id, result)

    try:
        audio = MutagenFile(file_path)
    except Exception as exc:
        logger.debug("mutagen could not open %s: %s", file_path, exc)
        return result

    if audio is None:
        return result

    if getattr(audio, "info", None) is not None:
        try:
            result["duration"] = float(audio.info.length)
        except (AttributeError, TypeError, ValueError):
            pass

    extracted: dict = {}
    try:
        if isinstance(audio.tags, ID3) or (audio.tags and audio.tags.__class__.__name__ == "ID3"):
            extracted = _extract_id3(audio, track_id)
        elif isinstance(audio, (FLAC, OggVorbis, OggOpus)) or hasattr(audio, "pictures"):
            extracted = _extract_vorbis(audio, track_id)
        elif isinstance(audio, MP4):
            extracted = _extract_mp4(audio, track_id)
        elif audio.tags is not None:
            extracted = _extract_vorbis(audio, track_id)
    except Exception as exc:
        logger.debug("mutagen: tag extraction failed for %s: %s", file_path, exc)

    for key, value in extracted.items():
        if value is not None and result.get(key) in (None, ""):
            result[key] = value

    if not result.get("artist") and result.get("albumartist"):
        result["artist"] = result["albumartist"]

    return result


def _legacy_tinytag_extract(file_path: str, track_id: str, result: dict) -> dict:
    try:
        from tinytag import TinyTag
        tag = TinyTag.get(file_path, image=True)
        result["title"] = tag.title
        result["artist"] = tag.artist or tag.albumartist
        result["album"] = tag.album
        result["year"] = int(tag.year[:4]) if tag.year else None
        result["duration"] = tag.duration
        image_data = tag.get_image()
        if image_data:
            cover = _save_cover(track_id, image_data)
            if cover:
                result["thumbnail"] = cover
    except Exception as exc:
        logger.debug("tinytag fallback failed for %s: %s", file_path, exc)
    return result
