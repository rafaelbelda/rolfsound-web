import unittest

from core.ingestors.youtube import ytdlp
from core.ingestors.youtube.search import _parse_ytdlp_line
from utils.subprocess_text import decode_subprocess_text, utf8_subprocess_env


class YoutubeEncodingTests(unittest.TestCase):
    def test_decodes_cp1252_ytdlp_search_output_without_replacement_chars(self):
        raw = "Oz2dMTwY3ns\tCaê - Cecília do Cambuci\t230\tCaê\n".encode("cp1252")

        line = decode_subprocess_text(raw).strip()
        parsed = _parse_ytdlp_line(line)

        self.assertNotIn("\ufffd", line)
        self.assertEqual(parsed["title"], "Caê - Cecília do Cambuci")
        self.assertEqual(parsed["channel"], "Caê")

    def test_ytdlp_subprocess_env_forces_utf8_python_io(self):
        env = utf8_subprocess_env()

        self.assertEqual(env["PYTHONIOENCODING"], "utf-8")
        self.assertEqual(env["PYTHONUTF8"], "1")

    def test_get_metadata_decodes_cp1252_json_stdout(self):
        original_run = ytdlp.subprocess.run
        captured = {}

        class Result:
            stdout = (
                '{"id":"Oz2dMTwY3ns","title":"Caê - Cecília do Cambuci",'
                '"artist":"Caê","duration":230}'
            ).encode("cp1252")

        def fake_run(cmd, **kwargs):
            captured["env"] = kwargs.get("env") or {}
            return Result()

        try:
            ytdlp.subprocess.run = fake_run
            meta = ytdlp.get_metadata("Oz2dMTwY3ns")
        finally:
            ytdlp.subprocess.run = original_run

        self.assertEqual(meta["title"], "Caê - Cecília do Cambuci")
        self.assertEqual(meta["artist"], "Caê")
        self.assertEqual(captured["env"]["PYTHONIOENCODING"], "utf-8")


if __name__ == "__main__":
    unittest.main()
