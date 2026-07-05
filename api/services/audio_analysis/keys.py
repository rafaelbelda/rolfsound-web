from __future__ import annotations

_NOTE_TO_PC = {
    "C": 0, "B#": 0,
    "C#": 1, "DB": 1,
    "D": 2,
    "D#": 3, "EB": 3,
    "E": 4, "FB": 4,
    "F": 5, "E#": 5,
    "F#": 6, "GB": 6,
    "G": 7,
    "G#": 8, "AB": 8,
    "A": 9,
    "A#": 10, "BB": 10,
    "B": 11, "CB": 11,
}

_MAJOR_DISPLAY = {
    0: "C", 1: "Db", 2: "D", 3: "Eb", 4: "E", 5: "F",
    6: "F#", 7: "G", 8: "Ab", 9: "A", 10: "Bb", 11: "B",
}

_MINOR_DISPLAY = {
    0: "C", 1: "C#", 2: "D", 3: "Eb", 4: "E", 5: "F",
    6: "F#", 7: "G", 8: "Ab", 9: "A", 10: "Bb", 11: "B",
}


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


def normalize_key(note: str | None, scale: str | None) -> str | None:
    """Nota+escala do extrator Essentia -> formato 'A min' / 'C# maj' que
    o front já entende (o dicionário CAMELOT de search-engine.js indexa por
    essa mesma string, sem precisar de uma coluna separada de Camelot)."""
    pc = normalize_note(note)
    mode = normalize_scale(scale)
    if pc is None or mode is None:
        return None
    display = _MAJOR_DISPLAY[pc] if mode == "major" else _MINOR_DISPLAY[pc]
    return f"{display} {'maj' if mode == 'major' else 'min'}"
