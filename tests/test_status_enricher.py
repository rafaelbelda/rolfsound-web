import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from api.services import status_enricher


TRACK_ID = "48909d0f-b95c-4d73-bd07-dc43c662e9f6"
REL_PATH = f"music\\{TRACK_ID}\\original_mix.flac"
THUMBNAIL = f"music\\{TRACK_ID}\\cover.jpg"


def _raw_status(current_track: str) -> dict:
    return {
        "playback": {
            "playing": True,
            "paused": False,
            "current_track": current_track,
            "position_s": 0,
            "duration_s": 10,
            "position_updated_at": 1,
            "volume": 1.0,
        },
        "queue": {
            "tracks": [],
            "current_index": -1,
            "repeat_mode": "off",
            "shuffle": False,
        },
    }


class StatusEnricherPathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "library.db"
        self._init_db(title="Nikes", artist="Frank Ocean", thumbnail=THUMBNAIL)
        status_enricher.clear_track_cache()

    def tearDown(self):
        status_enricher.clear_track_cache()
        self.tmp.cleanup()

    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self, title: str, artist: str, thumbnail: str):
        conn = self._connect()
        try:
            conn.executescript("""
                CREATE TABLE tracks (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    artist TEXT,
                    display_artist TEXT,
                    thumbnail TEXT,
                    bpm REAL,
                    musical_key TEXT,
                    camelot_key TEXT
                );
                CREATE TABLE assets (
                    id TEXT PRIMARY KEY,
                    track_id TEXT,
                    file_path TEXT,
                    bpm REAL,
                    musical_key TEXT,
                    camelot_key TEXT
                );
            """)
            conn.execute(
                "INSERT INTO tracks (id, title, artist, display_artist, thumbnail, bpm, musical_key, camelot_key) VALUES (?, ?, ?, ?, ?, NULL, 'C minor', '5A')",
                (TRACK_ID, title, artist, artist, thumbnail),
            )
            conn.execute(
                "INSERT INTO assets (id, track_id, file_path, bpm, musical_key, camelot_key) VALUES ('asset-1', ?, ?, 124.5, 'A minor', '8A')",
                (TRACK_ID, REL_PATH),
            )
            conn.commit()
        finally:
            conn.close()

    def _update_track(self, title: str, artist: str, thumbnail: str):
        conn = self._connect()
        try:
            conn.execute(
                "UPDATE tracks SET title = ?, artist = ?, display_artist = ?, thumbnail = ? WHERE id = ?",
                (title, artist, artist, thumbnail, TRACK_ID),
            )
            conn.commit()
        finally:
            conn.close()

    def _enrich(self, current_track: str) -> dict:
        with patch.object(status_enricher.database, "get_connection", self._connect):
            return status_enricher.enrich_status(_raw_status(current_track))

    def test_enriches_relative_and_absolute_asset_paths(self):
        absolute = str((status_enricher._PROJECT_ROOT / REL_PATH).resolve(strict=False))

        for current_track in (REL_PATH, absolute):
            status_enricher.clear_track_cache()
            enriched = self._enrich(current_track)
            self.assertEqual(enriched["track_id"], TRACK_ID)
            self.assertEqual(enriched["title"], "Nikes")
            self.assertEqual(enriched["artist"], "Frank Ocean")
            self.assertEqual(enriched["thumbnail"], THUMBNAIL)
            self.assertEqual(enriched["bpm"], 124.5)
            self.assertEqual(enriched["musical_key"], "A minor")
            self.assertEqual(enriched["camelot_key"], "8A")

    def test_cache_invalidation_reloads_updated_metadata(self):
        self._update_track("", "", "")
        absolute = str((status_enricher._PROJECT_ROOT / REL_PATH).resolve(strict=False))

        first = self._enrich(absolute)
        self.assertEqual(first["title"], Path(REL_PATH).name)
        self.assertEqual(first["artist"], "")

        self._update_track("Nikes", "Frank Ocean", THUMBNAIL)
        status_enricher.clear_track_cache(track_id=TRACK_ID)

        refreshed = self._enrich(absolute)
        self.assertEqual(refreshed["title"], "Nikes")
        self.assertEqual(refreshed["artist"], "Frank Ocean")
        self.assertEqual(refreshed["thumbnail"], THUMBNAIL)


if __name__ == "__main__":
    unittest.main()
