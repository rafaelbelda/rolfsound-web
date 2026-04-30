from __future__ import annotations

import locale
import os
import sys


def utf8_subprocess_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def _candidate_encodings() -> list[str]:
    encodings = ["utf-8-sig", locale.getpreferredencoding(False)]
    if sys.platform == "win32":
        encodings.append("mbcs")
    encodings.extend(["cp1252", "latin-1"])

    seen: set[str] = set()
    result: list[str] = []
    for encoding in encodings:
        if not encoding:
            continue
        normalized = encoding.lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        result.append(encoding)
    return result


def decode_subprocess_text(data: bytes | str | None) -> str:
    if data is None:
        return ""
    if isinstance(data, str):
        return data

    for encoding in _candidate_encodings():
        try:
            return data.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("utf-8", errors="replace")
