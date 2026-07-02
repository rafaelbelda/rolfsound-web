
import os
import re


def sanitize_path(path: str) -> str:

    if not path:
        return path

    # Step 1: replace all backslashes with forward slashes.
    # This is safe on Windows (Python accepts both) and a no-op elsewhere.
    path = path.replace("\\", "/")

    # Step 2: only make absolute if actually relative.
    # A path is considered absolute if it starts with "/" or matches a
    # Windows drive pattern like "C:/...".  If the backslash corruption
    # ate the colon too (extremely rare), we can't recover — but at least
    # we don't make it worse by prepending CWD.
    is_absolute = path.startswith("/") or re.match(r"^[A-Za-z]:/", path)
    if not is_absolute:
        path = os.path.abspath(path).replace("\\", "/")

    return path


def sanitize_track(track: dict) -> dict:

    if not isinstance(track, dict):
        return track
    fp = track.get("filepath", "")
    if fp:
        track = dict(track, filepath=sanitize_path(fp))
    return track