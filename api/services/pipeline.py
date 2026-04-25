import asyncio
import logging
import os
import re
import shutil
import time
import uuid
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, Optional

from db import database

logger = logging.getLogger(__name__)


class MusicIngestor(ABC):
    """Base class for sources that bring audio into Rolfsound."""

    @abstractmethod
    async def fetch_media(self, source_data: Any, temp_dir: str) -> Dict[str, Any]:
        pass

    def extract_metadata(self, source_data: dict) -> Dict[str, Any]:
        return {
            "target_track_id": _blank_to_none(source_data.get("target_track_id")),
            "asset_type": source_data.get("asset_type") or "ORIGINAL_MIX",
            "source_ref": _blank_to_none(source_data.get("source_ref")),
            "title": _blank_to_none(source_data.get("title")),
            "artist": _blank_to_none(source_data.get("artist")),
            "thumbnail": _blank_to_none(source_data.get("thumbnail")),
            "duration": source_data.get("duration"),
            "published_date": source_data.get("published_date"),
        }


class UploadIngestor(MusicIngestor):
    async def fetch_media(self, source_data: dict, temp_dir: str) -> Dict[str, Any]:
        file_content = source_data["content"]
        original_filename = source_data["filename"]

        ext = Path(original_filename).suffix.lower()
        temp_file = os.path.join(temp_dir, f"upload_{uuid.uuid4().hex}{ext}")

        with open(temp_file, "wb") as f:
            f.write(file_content)

        return {
            "temp_path": temp_file,
            "filename": Path(original_filename).stem,
            "source": "UPLOAD",
        }


class ExistingFileIngestor(MusicIngestor):
    async def fetch_media(self, source_data: dict, temp_dir: str) -> Dict[str, Any]:
        path = source_data.get("temp_path") or source_data.get("file_path")
        if not path:
            raise ValueError("ExistingFileIngestor requires temp_path or file_path")
        return {
            "temp_path": path,
            "filename": source_data.get("filename") or Path(path).stem,
            "source": source_data.get("source") or "LOCAL_FILE",
        }


class LibraryManager:
    def __init__(self, music_dir: str = "./music", temp_dir: str = "./cache/.tmp"):
        self.music_dir = Path(music_dir)
        self.temp_dir = Path(temp_dir)
        self.music_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir.mkdir(parents=True, exist_ok=True)

    async def process_new_track(self, ingestor: MusicIngestor, source_data: Any) -> Optional[str]:
        """Backwards-compatible name: ingest an asset and return its logical track id."""
        result = await self.process_new_asset(ingestor, source_data)
        return result.get("track_id") if result else None

    async def process_new_asset(self, ingestor: MusicIngestor, source_data: Any) -> Optional[dict]:
        media_info = await ingestor.fetch_media(source_data, str(self.temp_dir))
        metadata = ingestor.extract_metadata(source_data if isinstance(source_data, dict) else {})
        return self.ingest_existing_file({**metadata, **media_info}, schedule_index=True)

    def ingest_existing_file(self, source_data: dict, schedule_index: bool = True) -> Optional[dict]:
        """
        Register a file that already exists on disk.

        The file is normally moved into a MAM bundle. Set move_file=False for
        scans that should register files in place.
        """
        temp_path = Path(source_data["temp_path"])
        if not temp_path.exists():
            logger.error(f"Pipeline: missing ingest file {temp_path}")
            return None

        target_track_id = _blank_to_none(source_data.get("target_track_id"))
        asset_type = _normal_asset_type(source_data.get("asset_type"))
        source = (source_data.get("source") or "UNKNOWN").upper()
        source_ref = _blank_to_none(source_data.get("source_ref"))
        title = _blank_to_none(source_data.get("title")) or source_data.get("filename") or temp_path.stem
        artist = _blank_to_none(source_data.get("artist")) or ""
        thumbnail = _blank_to_none(source_data.get("thumbnail"))
        duration = source_data.get("duration")
        published_date = source_data.get("published_date")
        move_file = source_data.get("move_file", True)

        conn = database.get_connection()
        try:
            created_track = False
            if target_track_id:
                if not database.get_track_row(conn, target_track_id):
                    raise ValueError(f"Target track not found: {target_track_id}")
                track_id = target_track_id
            else:
                track_id = str(uuid.uuid4())
                database.add_track(conn, {
                    "id": track_id,
                    "title": title,
                    "artist": artist,
                    "duration": duration,
                    "thumbnail": thumbnail,
                    "published_date": published_date,
                    "date_added": int(time.time()),
                    "status": "pending_identity",
                })
                created_track = True

            final_path = self._place_file(temp_path, track_id, asset_type, move_file=move_file)
            asset_id = database.add_asset(
                conn,
                track_id=track_id,
                file_path=str(final_path),
                asset_type=asset_type,
                source=source,
                source_ref=source_ref,
                file_format=final_path.suffix.replace(".", "").upper() or "UNKNOWN",
                duration=duration,
                analysis_status="pending",
            )
            conn.commit()

            logger.info(
                "Pipeline: registered asset %s (%s) on track %s from %s",
                asset_id,
                asset_type,
                track_id,
                source,
            )

        except Exception as e:
            conn.rollback()
            logger.error(f"Pipeline: failed to register asset: {e}")
            return None
        finally:
            conn.close()

        allow_identity_resolution = created_track and not target_track_id
        if schedule_index:
            self._schedule_indexer(asset_id, allow_identity_resolution)

        return {
            "track_id": track_id,
            "asset_id": asset_id,
            "file_path": str(final_path),
            "created_track": created_track,
            "allow_identity_resolution": allow_identity_resolution,
        }

    def _place_file(
        self,
        source_path: Path,
        track_id: str,
        asset_type: str,
        move_file: bool = True,
    ) -> Path:
        if not move_file:
            return source_path

        bundle_dir = self.music_dir / track_id
        bundle_dir.mkdir(parents=True, exist_ok=True)

        stem = _safe_filename(asset_type.lower())
        ext = source_path.suffix.lower()
        final_path = bundle_dir / f"{stem}{ext}"
        while final_path.exists():
            final_path = bundle_dir / f"{stem}_{uuid.uuid4().hex[:8]}{ext}"

        shutil.move(str(source_path), str(final_path))
        return final_path

    def _schedule_indexer(self, asset_id: str, allow_identity_resolution: bool) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.debug("Pipeline: no running loop; indexer scheduling skipped")
            return

        async def _run():
            try:
                from api.services.indexer import index_asset
                await index_asset(asset_id, allow_identity_resolution=allow_identity_resolution)
            except Exception as e:
                logger.error(f"Pipeline: indexer failed for asset {asset_id}: {e}")

        loop.create_task(_run())


def _blank_to_none(value):
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    return value


def _normal_asset_type(value: str | None) -> str:
    cleaned = (value or "ORIGINAL_MIX").strip().upper().replace("-", "_").replace(" ", "_")
    return cleaned or "ORIGINAL_MIX"


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_]+", "_", value).strip("_")
    return cleaned or "asset"
