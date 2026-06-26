// static/js/utils/keyShift.js
// Simple musical-key + Camelot transposition for the remix pitch control.
//
// A track's key is derived once from its metadata (camelot_key preferred, then
// musical_key) into a { pc, mode } pair, where pc is the tonic pitch-class
// (0 = C … 11 = B) and mode is 'major' | 'minor'. Shifting by N semitones is
// then just an index step around the chromatic circle, so the displayed key and
// Camelot code always stay in sync with the pitch gauge.

// Index = tonic pitch-class (0 = C … 11 = B).
const NAME_MINOR    = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
const NAME_MAJOR    = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];

const NOTE_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// Reverse lookups: 'XA'/'XB' Camelot code → pitch-class.
const CAMELOT_TO_PC = (() => {
  const map = {};
  CAMELOT_MINOR.forEach((code, pc) => { map[code] = { pc, mode: 'minor' }; });
  CAMELOT_MAJOR.forEach((code, pc) => { map[code] = { pc, mode: 'major' }; });
  return map;
})();

const mod12 = n => ((n % 12) + 12) % 12;

/** Parse a Camelot code like "2A" / "11B" → { pc, mode } or null. */
export function parseCamelot(value) {
  const code = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  return CAMELOT_TO_PC[code] || null;
}

/** Parse a musical key like "Ebm", "F# minor", "C", "A major" → { pc, mode } or null. */
export function parseMusicalKey(value) {
  const text = String(value || '')
    .trim()
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b');
  const match = text.match(/^([A-Ga-g])\s*([#b]?)\s*[-\s]?\s*(major|minor|maj|min|m)?\s*$/i);
  if (!match) return null;

  let pc = NOTE_PC[match[1].toLowerCase()];
  if (pc == null) return null;
  if (match[2] === '#') pc = mod12(pc + 1);
  else if (match[2] === 'b') pc = mod12(pc - 1);

  const modeToken = String(match[3] || '').toLowerCase();
  const mode = (modeToken === 'minor' || modeToken === 'min' || modeToken === 'm') ? 'minor' : 'major';
  return { pc, mode };
}

/**
 * Derive the base key from a track's metadata. Prefers the Camelot code (which
 * encodes mode unambiguously) and falls back to the spelled key.
 * @returns {{ pc: number, mode: 'major'|'minor' }|null}
 */
export function deriveBaseKey({ camelot_key, musical_key } = {}) {
  return parseCamelot(camelot_key) || parseMusicalKey(musical_key) || null;
}

/**
 * Transpose a base key by a number of semitones.
 * @param {{ pc: number, mode: 'major'|'minor' }|null} base
 * @param {number} semitones
 * @returns {{ name: string, camelot: string }|null}
 */
export function shiftKey(base, semitones) {
  if (!base) return null;
  const pc = mod12(base.pc + Math.round(semitones || 0));
  return base.mode === 'major'
    ? { name: NAME_MAJOR[pc], camelot: CAMELOT_MAJOR[pc] }
    : { name: NAME_MINOR[pc], camelot: CAMELOT_MINOR[pc] };
}
