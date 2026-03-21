# utils/config.py
"""
Configuration loader for rolfsound-control.
Loads from config.json and provides typed access.
"""

import json
import logging
from pathlib import Path
from copy import deepcopy

logger = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).parent.parent / "config.json"

_DEFAULTS = {
    "core_url":                  "http://localhost:8765",
    "server_port":               8766,
    "music_directory":           "./music",
    "recordings_directory":      "./recordings",
    "database_path":             "./db/library.db",
    "download_temp_directory":   "./cache",
    "max_search_results":        10,
    "download_audio_format":     "webm",   # native Opus stream, no transcode
    "cleanup_enabled":           True,
    "cleanup_min_streams":       3,
    "cleanup_days":              30,
    "allow_guest_queue_control": True,
    # YouTube Data API v3 key — enables fast reliable search.
    # Leave empty to use yt-dlp as fallback.
    # Get a free key at: console.cloud.google.com
    # Enable "YouTube Data API v3", create an API key, paste it here.
    # Free quota: 10,000 units/day (~100 searches/day at 100 units each).
    "youtube_api_key":           "",
}

_config: dict = {}


def load() -> None:
    global _config
    if CONFIG_PATH.exists():
        with CONFIG_PATH.open("r", encoding="utf-8") as f:
            loaded = json.load(f)
        _config = {**_DEFAULTS, **loaded}
    else:
        _config = deepcopy(_DEFAULTS)
        save()
    logger.info(f"Config loaded from {CONFIG_PATH}")


def save() -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CONFIG_PATH.open("w", encoding="utf-8") as f:
        json.dump(_config, f, indent=4)
    logger.info("Config saved")


def get(key: str, default=None):
    if not _config:
        load()
    return _config.get(key, default)


def set_value(key: str, value) -> None:
    if not _config:
        load()
    _config[key] = value
    save()


def all_settings() -> dict:
    if not _config:
        load()
    return deepcopy(_config)


def update(data: dict) -> None:
    if not _config:
        load()
    _config.update(data)
    save()