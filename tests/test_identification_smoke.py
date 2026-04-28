import asyncio
import tempfile
import unittest
from pathlib import Path

from api.services.identification import pipeline
from api.services.identification import shazam
from api.services.identification.cache import cached_fetch, make_cache_key
from api.services.identification.canonical import canonicalize
from api.services.identification.consensus import resolve
from api.services.identification.evidence import Evidence
from api.services.identification.filename import parse_path_hint
from api.services.identification.youtube_meta import parse_video_title
from core.database import database


class IdentificationSmokeTests(unittest.TestCase):
    def setUp(self):
        Path("cache").mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir="cache")
        self.base = Path(self.tmp.name)
        database.init(str(self.base / "library.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_cache_queue_filename_and_consensus(self):
        async def run():
            calls = {"n": 0}

            async def fetcher():
                calls["n"] += 1
                return {"ok": True, "value": 42}

            key = make_cache_key("smoke", "Provider")
            first = await cached_fetch("smoke", key, 3600, fetcher)
            second = await cached_fetch("smoke", key, 3600, fetcher)
            self.assertEqual(first, {"ok": True, "value": 42})
            self.assertEqual(second, first)
            self.assertEqual(calls["n"], 1)

        asyncio.run(run())

        conn = database.get_connection()
        try:
            file_path = str(self.base / "Smoke Artist - Smoke Title.mp3")
            Path(file_path).write_bytes(b"not real audio")
            track_id = database.add_track(conn, {"title": "Smoke Title", "status": "pending_identity"})
            asset_id = database.add_asset(conn, track_id=track_id, file_path=file_path)
            database.upsert_identification_job(conn, asset_id)
            job = database.claim_identification_jobs(conn, limit=1)[0]
            self.assertEqual(job["asset_id"], asset_id)
            database.complete_identification_job(conn, asset_id, success=True)
            self.assertEqual(database.get_identification_job(conn, asset_id)["status"], "done")
        finally:
            conn.close()

        hint = parse_path_hint(str(self.base / "Smoke Artist - Smoke Title.mp3"))
        self.assertEqual(hint["artist"], "Smoke Artist")
        self.assertEqual(hint["title"], "Smoke Title")

        consensus = resolve([
            Evidence(
                source="local_tags",
                confidence=0.78,
                artist="Smoke Artist",
                title="Smoke Title",
                isrc="USSM19900001",
            ),
            Evidence(
                source="mb_by_isrc",
                confidence=0.95,
                artist="Smoke Artist",
                title="Smoke Title",
                isrc="USSM19900001",
            ),
        ])
        self.assertEqual(consensus["status"], "identified")
        self.assertGreaterEqual(consensus["confidence"], 0.95)

    def test_shazam_passes_mix_loud_and_anchor_starts(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("numpy not installed")

        sr = 16000
        snippet_seconds = 10
        pcm = np.zeros(sr * 120, dtype=np.int16)
        pcm[sr * 70:sr * 72] = 20000

        pass1, pass2 = shazam._make_passes(pcm, sr, snippet_seconds)

        self.assertLessEqual(len(pass1), 4)
        self.assertLessEqual(len(pass2), 4)
        self.assertTrue(any(abs(start - (sr * 65)) <= sr * 6 for start in pass1))
        self.assertTrue(any(start in pass1 for start in shazam._pick_anchor_starts(len(pcm), sr, snippet_seconds)))
        self.assertFalse(set(pass1) & set(pass2))

    def test_canonical_identity_ignores_feat_and_extracts_versions(self):
        base = canonicalize("Polyphia", "Fuck Around and Find Out")
        feat = canonicalize("Polyphia, $NOT", "Fuck Around and Find Out (feat. SNOT)")
        instrumental = canonicalize("Polyphia", "Fuck Around and Find Out (Instrumental)")
        tyler = canonicalize("Tyler, The Creator", "EARFQUAKE")
        kendrick_kanye = canonicalize("Kendrick Lamar, Kanye West", "Example")

        self.assertEqual(base.artist_key, feat.artist_key)
        self.assertEqual(base.title_key, feat.title_key)
        self.assertEqual(base.canonical_artist, "Polyphia")
        self.assertEqual(base.canonical_title, "Fuck Around and Find Out")
        self.assertEqual(feat.canonical_artist, "Polyphia")
        self.assertEqual(feat.canonical_title, "Fuck Around and Find Out")
        self.assertIn("SNOT", feat.featured_artists)
        self.assertEqual(tyler.canonical_artist, "Tyler, The Creator")
        self.assertEqual(tyler.artist_key, "tyler the creator")
        self.assertEqual(kendrick_kanye.canonical_artist, "Kendrick Lamar, Kanye West")
        self.assertEqual(instrumental.version_type, "INSTRUMENTAL")
        self.assertEqual(instrumental.title_key, base.title_key)

    def test_consensus_outputs_clean_display_for_spotify_discogs_disagreement(self):
        result = resolve([
            Evidence(
                source="spotify_fuzzy",
                confidence=0.78,
                artist="Polyphia, $NOT",
                title="Fuck Around and Find Out (feat. SNOT)",
                spotify_id="spotify-fafo",
            ),
            Evidence(
                source="discogs",
                confidence=0.86,
                artist="Polyphia",
                title="Fuck Around and Find Out",
                discogs_id=123,
            ),
        ])

        self.assertEqual(result["status"], "identified")
        self.assertEqual(result["artist"], "Polyphia")
        self.assertEqual(result["title"], "Fuck Around and Find Out")
        self.assertEqual(result["canonical_artist"], "Polyphia")
        self.assertEqual(result["canonical_title"], "Fuck Around and Find Out")

    def test_consensus_preserves_specific_version_type(self):
        result = resolve([
            Evidence(
                source="youtube_title",
                confidence=0.78,
                artist="Polyphia",
                title="Fuck Around and Find Out (Instrumental)",
            ),
            Evidence(
                source="spotify_fuzzy",
                confidence=0.78,
                artist="Polyphia",
                title="Fuck Around and Find Out",
                spotify_id="spotify-fafo",
            ),
        ])

        self.assertEqual(result["title"], "Fuck Around and Find Out")
        self.assertEqual(result["version_type"], "INSTRUMENTAL")

    def test_identity_match_merges_feat_and_instrumental_as_mam_versions(self):
        conn = database.get_connection()
        try:
            track_id = database.add_track(conn, {
                "title": "Fuck Around and Find Out (feat. SNOT)",
                "artist": "Polyphia, $NOT",
                "status": "identified",
            })
            database.add_asset(
                conn,
                track_id=track_id,
                file_path=str(self.base / "polyphia-vocal.webm"),
                asset_type="ORIGINAL_MIX",
            )
            conn.commit()

            matches = database.find_identity_matches(conn, {
                "title": "Fuck Around and Find Out (Instrumental)",
                "artist": "Polyphia",
                "identity_source": "spotify_fuzzy",
                "all_sources": ["youtube_title", "spotify_fuzzy"],
                "version_type": "INSTRUMENTAL",
            }, exclude_track_id="new-track")
        finally:
            conn.close()

        self.assertTrue(matches)
        self.assertEqual(matches[0]["track_id"], track_id)
        self.assertGreaterEqual(matches[0]["score"], 0.93)

    def test_database_persists_artist_album_entities_and_searches_guest(self):
        conn = database.get_connection()
        try:
            first_id = database.add_track(conn, {
                "title": "No More Parties in LA",
                "display_artist": "Kendrick Lamar, Kanye West",
                "status": "identified",
            })
            second_id = database.add_track(conn, {
                "title": "Second Track",
                "display_artist": "Kendrick Lamar",
                "status": "identified",
            })
            database.set_track_artist_credits(conn, first_id, [
                {"name": "Kendrick Lamar", "position": 0, "is_primary": True, "role": "main"},
                {"name": "Kanye West", "position": 1, "is_primary": False, "role": "featured"},
            ], display_artist="Kendrick Lamar, Kanye West", source="test")
            database.set_track_artist_credits(conn, second_id, [
                {"name": "Kendrick Lamar", "position": 0, "is_primary": True, "role": "main"},
            ], display_artist="Kendrick Lamar", source="test")
            database.set_track_albums(conn, first_id, [{
                "title": "Untitled Test Album",
                "display_artist": "Kendrick Lamar",
                "year": 2024,
            }], track_number=2, disc_number=1, source="test")
            database.set_track_albums(conn, second_id, [{
                "title": "Untitled Test Album",
                "display_artist": "Kendrick Lamar",
                "year": 2024,
            }], track_number=1, disc_number=1, source="test")
            conn.commit()

            track = database.get_track(conn, first_id)
            self.assertEqual(track["artist"], "Kendrick Lamar, Kanye West")
            self.assertEqual(track["display_artist"], "Kendrick Lamar, Kanye West")
            self.assertEqual([a["name"] for a in track["artists"]], ["Kendrick Lamar", "Kanye West"])

            search = database.search_tracks(conn, "Kanye")
            self.assertEqual([t["id"] for t in search], [first_id])

            guest = next(a for a in database.list_artists(conn) if a["name"] == "Kanye West")
            guest_tracks = database.get_artist_tracks(conn, guest["id"])
            self.assertEqual([t["id"] for t in guest_tracks], [first_id])

            album = database.list_albums(conn)[0]
            album_tracks = database.get_album_tracks(conn, album["id"])
            self.assertEqual([t["title"] for t in album_tracks], ["Second Track", "No More Parties in LA"])
        finally:
            conn.close()

    def test_pipeline_stops_after_strong_isrc_consensus(self):
        async def run():
            originals = {
                "extract_local_tags": pipeline.extract_local_tags,
                "mb_by_isrc": pipeline.mb_by_isrc,
                "sp_by_isrc": pipeline.sp_by_isrc,
                "best_cover_from_recording": pipeline.best_cover_from_recording,
                "_acoustid_lookup": pipeline._acoustid_lookup,
                "_shazam_evidence": pipeline._shazam_evidence,
                "_discogs_evidence": pipeline._discogs_evidence,
                "_spotify_fuzzy_evidence": pipeline._spotify_fuzzy_evidence,
                "mb_by_isrc": pipeline.mb_by_isrc,
                "sp_by_isrc": pipeline.sp_by_isrc,
                "best_cover_from_recording": pipeline.best_cover_from_recording,
            }

            def fake_tags(file_path, track_id):
                return {
                    "title": "Smoke Title",
                    "artist": "Smoke Artist",
                    "year": 2024,
                    "duration": 123.0,
                    "thumbnail": None,
                    "isrc": "USSM19900001",
                    "mb_recording_id": None,
                    "publisher": "Smoke Label",
                }

            async def fake_mb(isrc):
                return {
                    "title": "Smoke Title",
                    "artist": "Smoke Artist",
                    "year": 2024,
                    "duration": 123.0,
                    "mb_recording_id": "mbid-smoke",
                    "labels": ["Smoke Label"],
                    "release_groups": [],
                }

            async def fake_sp(isrc):
                return None

            async def fake_cover(recording):
                return None

            async def forbidden(*args, **kwargs):
                raise AssertionError("expensive provider should not run after strong ISRC consensus")

            try:
                pipeline.extract_local_tags = fake_tags
                pipeline.mb_by_isrc = fake_mb
                pipeline.sp_by_isrc = fake_sp
                pipeline.best_cover_from_recording = fake_cover
                pipeline._acoustid_lookup = forbidden
                pipeline._shazam_evidence = forbidden
                pipeline._discogs_evidence = forbidden
                pipeline._spotify_fuzzy_evidence = forbidden

                result = await pipeline.identify(
                    str(self.base / "Smoke Artist - Smoke Title.mp3"),
                    "track-smoke",
                    hints={},
                )
            finally:
                for name, value in originals.items():
                    setattr(pipeline, name, value)

            self.assertEqual(result["status"], "identified")
            self.assertEqual(result["title"], "Smoke Title")
            self.assertEqual(result["artist"], "Smoke Artist")
            self.assertIn("local_tags", result["sources"])
            self.assertIn("mb_by_isrc", result["sources"])

        asyncio.run(run())

    def test_existing_track_metadata_beats_internal_asset_filename(self):
        async def run():
            captured = {}
            originals = {
                "extract_local_tags": pipeline.extract_local_tags,
                "_acoustid_lookup": pipeline._acoustid_lookup,
                "_shazam_evidence": pipeline._shazam_evidence,
                "_discogs_evidence": pipeline._discogs_evidence,
                "_spotify_fuzzy_evidence": pipeline._spotify_fuzzy_evidence,
                "parse_for_youtube_id": pipeline.parse_for_youtube_id,
            }

            def fake_tags(file_path, track_id):
                return {
                    "title": None,
                    "artist": None,
                    "year": None,
                    "duration": 180.0,
                    "thumbnail": None,
                    "isrc": None,
                    "mb_recording_id": None,
                }

            async def none_ev(*args, **kwargs):
                return None

            async def no_acoustid(*args, **kwargs):
                return None, None, None

            async def fake_spotify(artist, title, duration):
                captured["artist"] = artist
                captured["title"] = title
                return Evidence(
                    source="spotify_fuzzy",
                    confidence=0.78,
                    artist=artist,
                    title=title,
                    isrc="BRTV51100002",
                    spotify_id="spotify-linda",
                    raw={},
                    reasons=["spotify_fuzzy_search"],
                )

            async def fake_mb_by_isrc(isrc):
                captured["mb_isrc"] = isrc
                return {
                    "title": "Linda",
                    "artist": "Caê Rolfsen",
                    "year": 2010,
                    "duration": 180.0,
                    "mb_recording_id": "mbid-linda",
                    "labels": [],
                    "release_groups": [],
                }

            async def fake_sp_by_isrc(isrc):
                return None

            async def fake_cover(recording):
                return None

            try:
                pipeline.extract_local_tags = fake_tags
                pipeline._acoustid_lookup = no_acoustid
                pipeline._shazam_evidence = none_ev
                pipeline._discogs_evidence = none_ev
                pipeline._spotify_fuzzy_evidence = fake_spotify
                pipeline.mb_by_isrc = fake_mb_by_isrc
                pipeline.sp_by_isrc = fake_sp_by_isrc
                pipeline.best_cover_from_recording = fake_cover

                result = await pipeline.identify(
                    str(self.base / "track-id" / "original_mix.webm"),
                    "track-id",
                    hints={
                        "existing_title": "Linda",
                        "existing_artist": "Caê Rolfsen",
                    },
                )
            finally:
                for name, value in originals.items():
                    setattr(pipeline, name, value)

            self.assertEqual(captured["artist"], "Caê Rolfsen")
            self.assertEqual(captured["title"], "Linda")
            self.assertEqual(captured["mb_isrc"], "BRTV51100002")
            self.assertEqual(result["title"], "Linda")
            self.assertEqual(result["artist"], "Caê Rolfsen")
            self.assertEqual(result["mb_recording_id"], "mbid-linda")

        asyncio.run(run())

    def test_youtube_title_parser_strips_upload_noise(self):
        parsed = parse_video_title(
            "Caê Rolfsen - Linda (Official Videoclipe) | OG BEAR",
            "OG BEAR",
        )
        self.assertEqual(parsed["artist"], "Caê Rolfsen")
        self.assertEqual(parsed["title"], "Linda")
        self.assertGreaterEqual(parsed["confidence"], 0.75)

        parsed = parse_video_title("DJ Example - Sunrise [Slowed + Reverb]", "Random Channel")
        self.assertEqual(parsed["artist"], "DJ Example")
        self.assertEqual(parsed["title"], "Sunrise")

    def test_youtube_title_hint_beats_channel_and_internal_filename(self):
        async def run():
            captured = {}
            originals = {
                "extract_local_tags": pipeline.extract_local_tags,
                "_acoustid_lookup": pipeline._acoustid_lookup,
                "_shazam_evidence": pipeline._shazam_evidence,
                "_discogs_evidence": pipeline._discogs_evidence,
                "_spotify_fuzzy_evidence": pipeline._spotify_fuzzy_evidence,
            }

            def fake_tags(file_path, track_id):
                return {
                    "title": None,
                    "artist": None,
                    "year": None,
                    "duration": 180.0,
                    "thumbnail": None,
                    "isrc": None,
                    "mb_recording_id": None,
                }

            async def no_acoustid(*args, **kwargs):
                return None, None, None

            async def none_ev(*args, **kwargs):
                return None

            async def fake_spotify(artist, title, duration):
                captured["artist"] = artist
                captured["title"] = title
                return None

            async def fake_youtube_meta(youtube_id):
                return {}

            try:
                pipeline.extract_local_tags = fake_tags
                pipeline._acoustid_lookup = no_acoustid
                pipeline._shazam_evidence = none_ev
                pipeline._discogs_evidence = none_ev
                pipeline._spotify_fuzzy_evidence = fake_spotify
                pipeline.parse_for_youtube_id = fake_youtube_meta

                result = await pipeline.identify(
                    str(self.base / "track-id" / "original_mix.webm"),
                    "track-id",
                    hints={
                        "youtube_id": "abc123xyz00",
                        "youtube_title": "Caê Rolfsen - Linda (Official Videoclipe) | OG BEAR",
                        "existing_title": "original mix",
                        "existing_artist": "OG BEAR",
                    },
                )
            finally:
                for name, value in originals.items():
                    setattr(pipeline, name, value)

            self.assertEqual(captured["artist"], "Caê Rolfsen")
            self.assertEqual(captured["title"], "Linda")
            self.assertEqual(result["title"], "Linda")
            self.assertEqual(result["artist"], "Caê Rolfsen")

        asyncio.run(run())

    def test_shazam_conflict_does_not_override_youtube_title_context(self):
        async def run():
            captured = {}
            originals = {
                "extract_local_tags": pipeline.extract_local_tags,
                "_acoustid_lookup": pipeline._acoustid_lookup,
                "lookup_shazam": pipeline.lookup_shazam,
                "_discogs_evidence": pipeline._discogs_evidence,
                "_spotify_fuzzy_evidence": pipeline._spotify_fuzzy_evidence,
                "_genius_evidence": pipeline._genius_evidence,
                "parse_for_youtube_id": pipeline.parse_for_youtube_id,
            }

            def fake_tags(file_path, track_id):
                return {
                    "title": None,
                    "artist": None,
                    "year": None,
                    "duration": 210.0,
                    "thumbnail": None,
                    "isrc": None,
                    "mb_recording_id": None,
                }

            async def no_acoustid(*args, **kwargs):
                return None, None, None

            async def wrong_shazam(file_path):
                return {
                    "artist": "Rui Da Silva",
                    "title": "Touch Me",
                    "thumbnail": "https://example.test/wrong.jpg",
                }

            async def none_ev(*args, **kwargs):
                return None

            async def fake_spotify(artist, title, duration):
                captured["artist"] = artist
                captured["title"] = title
                return None

            async def fake_youtube_meta(youtube_id):
                return {}

            try:
                pipeline.extract_local_tags = fake_tags
                pipeline._acoustid_lookup = no_acoustid
                pipeline.lookup_shazam = wrong_shazam
                pipeline._discogs_evidence = none_ev
                pipeline._spotify_fuzzy_evidence = fake_spotify
                pipeline._genius_evidence = none_ev
                pipeline.parse_for_youtube_id = fake_youtube_meta

                result = await pipeline.identify(
                    str(self.base / "track-id" / "original_mix.webm"),
                    "track-id",
                    hints={
                        "youtube_id": "abc123xyz00",
                        "youtube_title": "Polyphia - Fuck Around and Find Out (Official Video)",
                        "existing_title": "original mix",
                        "existing_artist": "Polyphia",
                    },
                )
            finally:
                for name, value in originals.items():
                    setattr(pipeline, name, value)

            self.assertEqual(captured["artist"], "Polyphia")
            self.assertEqual(captured["title"], "Fuck Around and Find Out")
            self.assertEqual(result["title"], "Fuck Around and Find Out")
            self.assertEqual(result["artist"], "Polyphia")
            self.assertIn("shazam_conflict", result["all_sources"])
            self.assertNotIn("shazam", result["sources"])

        asyncio.run(run())

    def test_shazam_agreement_reinforces_youtube_title_context(self):
        async def run():
            originals = {
                "extract_local_tags": pipeline.extract_local_tags,
                "_acoustid_lookup": pipeline._acoustid_lookup,
                "lookup_shazam": pipeline.lookup_shazam,
                "_discogs_evidence": pipeline._discogs_evidence,
                "_spotify_fuzzy_evidence": pipeline._spotify_fuzzy_evidence,
                "_genius_evidence": pipeline._genius_evidence,
                "parse_for_youtube_id": pipeline.parse_for_youtube_id,
            }

            def fake_tags(file_path, track_id):
                return {
                    "title": None,
                    "artist": None,
                    "year": None,
                    "duration": 210.0,
                    "thumbnail": None,
                    "isrc": None,
                    "mb_recording_id": None,
                }

            async def no_acoustid(*args, **kwargs):
                return None, None, None

            async def matching_shazam(file_path):
                return {
                    "artist": "Polyphia",
                    "title": "Fuck Around and Find Out (feat. SNOT)",
                    "thumbnail": "https://example.test/right.jpg",
                }

            async def none_ev(*args, **kwargs):
                return None

            async def fake_youtube_meta(youtube_id):
                return {}

            try:
                pipeline.extract_local_tags = fake_tags
                pipeline._acoustid_lookup = no_acoustid
                pipeline.lookup_shazam = matching_shazam
                pipeline._discogs_evidence = none_ev
                pipeline._spotify_fuzzy_evidence = none_ev
                pipeline._genius_evidence = none_ev
                pipeline.parse_for_youtube_id = fake_youtube_meta

                result = await pipeline.identify(
                    str(self.base / "track-id" / "original_mix.webm"),
                    "track-id",
                    hints={
                        "youtube_id": "abc123xyz00",
                        "youtube_title": "Polyphia - Fuck Around and Find Out (Official Video)",
                        "existing_title": "original mix",
                        "existing_artist": "Polyphia",
                    },
                )
            finally:
                for name, value in originals.items():
                    setattr(pipeline, name, value)

            self.assertEqual(result["status"], "identified")
            self.assertEqual(result["title"], "Fuck Around and Find Out")
            self.assertEqual(result["display_artist"], "Polyphia, SNOT")
            self.assertEqual(result["artist"], "Polyphia, SNOT")
            self.assertEqual([a["name"] for a in result["artists"]], ["Polyphia", "SNOT"])
            self.assertIn("youtube_title", result["sources"])
            self.assertIn("shazam", result["sources"])
            self.assertNotIn("shazam_conflict", result["all_sources"])

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
