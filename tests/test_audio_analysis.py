import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from api.services.audio_analysis import essentia, jobs
from api.services.audio_analysis.keys import normalize_key
from core.database import database


class FakeWsManager:
    def __init__(self):
        self.frames = []

    async def broadcast(self, frame):
        self.frames.append(frame)


class AudioAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        database.init(str(self.base / "library.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_camelot_key_mappings(self):
        self.assertEqual(normalize_key("C", "minor").camelot_key, "5A")
        self.assertEqual(normalize_key("A", "minor").camelot_key, "8A")
        self.assertEqual(normalize_key("C", "major").camelot_key, "8B")
        self.assertEqual(normalize_key("Db", "major").camelot_key, "3B")
        self.assertEqual(normalize_key("C#", "major").musical_key, "Db major")
        self.assertEqual(normalize_key("G#", "minor").musical_key, "Ab minor")

    def test_parse_essentia_json_fixture(self):
        raw = {
            "rhythm": {"bpm": 124.984},
            "tonal": {
                "key_edma": {
                    "key": "C",
                    "scale": "minor",
                    "strength": 0.82,
                }
            },
        }

        self.assertEqual(essentia.parse_essentia_json(raw), {
            "bpm": 124.98,
            "musical_key": "C minor",
            "camelot_key": "5A",
        })

    def test_parse_essentia_json_flat_paths(self):
        raw = {
            "rhythm.bpm": 90,
            "tonal.key_krumhansl.key": "Db",
            "tonal.key_krumhansl.scale": "major",
        }

        self.assertEqual(essentia.parse_essentia_json(raw), {
            "bpm": 90.0,
            "musical_key": "Db major",
            "camelot_key": "3B",
        })

    def test_parse_essentia_json_root_key_fields(self):
        raw = {
            "rhythm": {"bpm": 136.87},
            "tonal": {
                "key_key": "E",
                "key_scale": "minor",
                "key_strength": 0.77,
            },
        }

        self.assertEqual(essentia.parse_essentia_json(raw), {
            "bpm": 136.87,
            "musical_key": "E minor",
            "camelot_key": "9A",
        })

    def test_missing_extractor_fails_controlled(self):
        def fake_get(key, default=None):
            if key == "essentia_extractor_path":
                return str(self.base / "missing-extractor")
            return default

        with patch.object(essentia.cfg, "get", side_effect=fake_get):
            with self.assertRaises(essentia.AudioAnalysisError) as ctx:
                asyncio.run(essentia.run_essentia_extractor(str(self.base / "song.mp3")))

        self.assertIn("Essentia extractor not found", str(ctx.exception))

    def test_unsupported_format_retries_with_wav_fallback(self):
        async def run():
            source = str(self.base / "song.webm")
            first_error = essentia.AudioAnalysisError(
                "MetadataReader: File does not seem to be of a supported filetype"
            )
            parsed = {"rhythm": {"bpm": 122.0}}

            with patch.object(essentia, "_resolve_executable", return_value="essentia"), \
                 patch.object(essentia, "_configured_profile_path", return_value=None), \
                 patch.object(essentia, "_transcode_to_wav", AsyncMock()) as transcode, \
                 patch.object(
                     essentia,
                     "_run_extractor_once",
                     AsyncMock(side_effect=[first_error, parsed]),
                 ) as extractor:
                result = await essentia.run_essentia_extractor(source, timeout_s=10)

            self.assertEqual(result, parsed)
            self.assertEqual(extractor.await_count, 2)
            self.assertEqual(extractor.await_args_list[0].args[1], source)
            self.assertTrue(extractor.await_args_list[1].args[1].endswith("analysis_input.wav"))
            transcode.assert_awaited_once()
            self.assertEqual(transcode.await_args.args[0], source)

        asyncio.run(run())

    def test_short_read_metadata_error_also_triggers_wav_fallback(self):
        async def run():
            source = str(self.base / "song.webm")
            first_error = essentia.AudioAnalysisError("Process step: Read metadata")
            parsed = {"rhythm": {"bpm": 118.0}}

            with patch.object(essentia, "_resolve_executable", return_value="essentia"), \
                 patch.object(essentia, "_configured_profile_path", return_value=None), \
                 patch.object(essentia, "_transcode_to_wav", AsyncMock()) as transcode, \
                 patch.object(
                     essentia,
                     "_run_extractor_once",
                     AsyncMock(side_effect=[first_error, parsed]),
                 ) as extractor:
                result = await essentia.run_essentia_extractor(source, timeout_s=10)

            self.assertEqual(result, parsed)
            self.assertEqual(extractor.await_count, 2)
            transcode.assert_awaited_once()

        asyncio.run(run())

    def test_decode_process_message_keeps_stderr_and_stdout_context(self):
        message = essentia._decode_process_message(
            b"MetadataReader: File does not seem to be of a supported filetype",
            b"Process step: Read metadata",
            label="Essentia analysis",
            returncode=1,
        )
        self.assertIn("Process step: Read metadata", message)
        self.assertIn("MetadataReader", message)

    def test_schema_and_job_helpers_persist_audio_analysis(self):
        conn = database.get_connection()
        try:
            track_id = database.add_track(conn, {"title": "Song", "artist": "Artist"})
            asset_id = database.add_asset(conn, track_id=track_id, file_path=str(self.base / "song.mp3"))
            conn.commit()

            database.upsert_audio_analysis_job(conn, asset_id)
            claimed = database.claim_audio_analysis_jobs(conn, limit=1)
            self.assertEqual(claimed[0]["asset_id"], asset_id)

            analysis = {"bpm": 128.5, "musical_key": "A minor", "camelot_key": "8A"}
            database.update_asset_audio_analysis(conn, asset_id, analysis)
            database.update_track_audio_analysis_from_asset(conn, asset_id, analysis)
            database.complete_audio_analysis_job(conn, asset_id, success=True)

            track = database.get_track(conn, track_id)
            asset = database.get_asset(conn, asset_id)
            job = database.get_audio_analysis_job(conn, asset_id)

            self.assertEqual(track["bpm"], 128.5)
            self.assertEqual(track["musical_key"], "A minor")
            self.assertEqual(track["camelot_key"], "8A")
            self.assertEqual(asset["bpm"], 128.5)
            self.assertEqual(asset["musical_key"], "A minor")
            self.assertEqual(asset["camelot_key"], "8A")
            self.assertEqual(job["status"], "done")
        finally:
            conn.close()

    def test_analyze_asset_broadcasts_updated_track_fields(self):
        async def run():
            conn = database.get_connection()
            try:
                track_id = database.add_track(conn, {"title": "Song", "artist": "Artist"})
                file_path = self.base / "song.mp3"
                file_path.write_bytes(b"fake audio")
                asset_id = database.add_asset(conn, track_id=track_id, file_path=str(file_path))
                conn.commit()
            finally:
                conn.close()

            manager = FakeWsManager()
            analysis = {"bpm": 126.0, "musical_key": "C minor", "camelot_key": "5A"}
            with patch.object(essentia, "analyze_file", AsyncMock(return_value=analysis)), \
                 patch("api.ws.endpoint.get_manager", return_value=manager):
                result = await jobs.analyze_asset(asset_id)

            self.assertEqual(result["status"], "done")
            self.assertTrue(manager.frames)
            frame = manager.frames[-1]
            self.assertEqual(frame["type"], "event.track_updated")
            self.assertEqual(frame["payload"]["bpm"], 126.0)
            self.assertEqual(frame["payload"]["musical_key"], "C minor")
            self.assertEqual(frame["payload"]["camelot_key"], "5A")
            self.assertEqual(
                frame["payload"]["_changed_fields"],
                ["bpm", "musical_key", "camelot_key"],
            )

        asyncio.run(run())

    def test_job_failure_records_error_without_crashing(self):
        async def run():
            conn = database.get_connection()
            try:
                track_id = database.add_track(conn, {"title": "Song", "artist": "Artist"})
                file_path = self.base / "song.mp3"
                file_path.write_bytes(b"fake audio")
                asset_id = database.add_asset(conn, track_id=track_id, file_path=str(file_path))
                database.upsert_audio_analysis_job(conn, asset_id)
                conn.commit()
            finally:
                conn.close()

            error = essentia.AudioAnalysisError("Essentia extractor not found: test")
            with patch.object(essentia, "analyze_file", AsyncMock(side_effect=error)):
                await jobs._process_one({"asset_id": asset_id})

            conn = database.get_connection()
            try:
                job = database.get_audio_analysis_job(conn, asset_id)
            finally:
                conn.close()

            self.assertEqual(job["status"], "retry")
            self.assertEqual(job["attempts"], 1)
            self.assertIn("Essentia extractor not found", job["last_error"])

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
