import tempfile
import unittest
from pathlib import Path

from core.database import database


class AppPreferenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        database.init(str(Path(self.tmp.name) / "library.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_preference_roundtrip_and_delete(self):
        conn = database.get_connection()
        try:
            self.assertEqual(database.get_app_preference(conn, "missing", {"fallback": True}), {"fallback": True})

            payload = {"version": 1, "blocks": [{"id": "tracks-main", "type": "tracks"}]}
            database.set_app_preference(conn, "library.layout.v1", payload)
            conn.commit()
            self.assertEqual(database.get_app_preference(conn, "library.layout.v1"), payload)

            database.delete_app_preference(conn, "library.layout.v1")
            conn.commit()
            self.assertIsNone(database.get_app_preference(conn, "library.layout.v1"))
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
