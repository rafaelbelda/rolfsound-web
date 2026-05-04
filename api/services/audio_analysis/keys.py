from __future__ import annotations

from dataclasses import dataclass


_NOTE_TO_PC = {
    "C": 0,
    "B#": 0,
    "C#": 1,
    "DB": 1,
    "D": 2,
    "D#": 3,
    "EB": 3,
    "E": 4,
    "FB": 4,
    "F": 5,
    "E#": 5,
    "F#": 6,
    "GB": 6,
    "G": 7,
    "G#": 8,
    "AB": 8,
    "A": 9,
    "A#": 10,
    "BB": 10,
    "B": 11,
    "CB": 11,
}

_MAJOR_DISPLAY = {
    0: "C",
    1: "Db",
    2: "D",
    3: "Eb",
    4: "E",
    5: "F",
    6: "F#",
    7: "G",
    8: "Ab",
    9: "A",
    10: "Bb",
    11: "B",
}

_MINOR_DISPLAY = {
    0: "C",
    1: "C#",
    2: "D",
    3: "Eb",
    4: "E",
    5: "F",
    6: "F#",
    7: "G",
    8: "Ab",
    9: "A",
    10: "Bb",
    11: "B",
}

_CAMELOT_MAJOR = {
    0: "8B",
    1: "3B",
    2: "10B",
    3: "5B",
    4: "12B",
    5: "7B",
    6: "2B",
    7: "9B",
    8: "4B",
    9: "11B",
    10: "6B",
    11: "1B",
}

_CAMELOT_MINOR = {
    0: "5A",
    1: "12A",
    2: "7A",
    3: "2A",
    4: "9A",
    5: "4A",
    6: "11A",
    7: "6A",
    8: "1A",
    9: "8A",
    10: "3A",
    11: "10A",
}


@dataclass(frozen=True)
class NormalizedKey:
    musical_key: str
    camelot_key: str


def normalize_note(note: str | None) -> int | None:
    if note is None:
        return None
    cleaned = str(note).strip()
    if not cleaned:
        return None
    cleaned = cleaned.replace("♯", "#").replace("♭", "b")
    upper = cleaned.upper()
    if upper in {"NONE", "UNKNOWN", "SILENCE"}:
        return None
    return _NOTE_TO_PC.get(upper)


def normalize_scale(scale: str | None) -> str | None:
    cleaned = str(scale or "").strip().lower()
    if cleaned in {"major", "maj", "ionian"}:
        return "major"
    if cleaned in {"minor", "min", "aeolian"}:
        return "minor"
    return None


def normalize_key(note: str | None, scale: str | None) -> NormalizedKey | None:
    pc = normalize_note(note)
    mode = normalize_scale(scale)
    if pc is None or mode is None:
        return None

    if mode == "major":
        display = _MAJOR_DISPLAY[pc]
        camelot = _CAMELOT_MAJOR[pc]
    else:
        display = _MINOR_DISPLAY[pc]
        camelot = _CAMELOT_MINOR[pc]

    return NormalizedKey(
        musical_key=f"{display} {mode}",
        camelot_key=camelot,
    )
