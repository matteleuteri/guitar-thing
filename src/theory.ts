export const SEMITONES = 12;

export const SHARP_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

export const FLAT_NAMES = [
  "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
] as const;

/** Combined sharp/flat label for the note buttons, e.g. "C#/Db" or "C". */
export function noteLabels(pitchClass: number): string {
  const i = ((pitchClass % SEMITONES) + SEMITONES) % SEMITONES;
  const s = SHARP_NAMES[i]!;
  const f = FLAT_NAMES[i]!;
  return s === f ? s : `${s}/${f}`;
}

const ALIASES = new Map<string, number>();
SHARP_NAMES.forEach((n, i) => ALIASES.set(n.toLowerCase(), i));
for (const [alias, pitchClass] of [
  ["db", 1], ["eb", 3], ["gb", 6], ["ab", 8], ["bb", 10],
] as [string, number][]) {
  ALIASES.set(alias, pitchClass);
}

/** Pitch class → sharp-spelled note name, e.g. 9 → "A". */
export function noteName(pitchClass: number): string {
  return SHARP_NAMES[((pitchClass % SEMITONES) + SEMITONES) % SEMITONES];
}

/** Parse a free-text list of notes (space/comma/semicolon/bar) into unique pitch classes. */
export function parseNotes(input: string): number[] {
  const tokens = input.split(/[\s,;|]+/).filter(Boolean);
  if (tokens.length === 0) throw new Error("Enter at least one note.");
  const found: number[] = [];
  for (const raw of tokens) {
    const pitchClass = ALIASES.get(raw.toLowerCase());
    if (pitchClass === undefined) throw new Error(`Unknown note "${raw}".`);
    if (!found.includes(pitchClass)) found.push(pitchClass);
  }
  return found;
}

const DEFAULT_OCTAVES = [2, 2, 3, 3, 3, 4];

/** Parse "Db3" into a MIDI note; an omitted octave uses the per-string default. */
export function parseStringMidi(value: string, index: number): number {
  const match = /^([A-Ga-g])([#bB]?)\s*(\d+)?$/.exec(value.trim());
  if (!match) throw new Error(`Bad string note "${value}". Use e.g. E2, A2, Db3.`);
  const letter = match[1]!.toUpperCase();
  let pitchClass = ALIASES.get(letter.toLowerCase())!;
  if (match[2] === "#") pitchClass = (pitchClass + 1) % SEMITONES;
  else if (match[2] === "b" || match[2] === "B") pitchClass = (pitchClass - 1 + SEMITONES) % SEMITONES;
  const octave = match[3] ? parseInt(match[3], 10) : DEFAULT_OCTAVES[index] ?? 2;
  return (octave + 1) * SEMITONES + pitchClass;
}

/** MIDI note number → name with octave, e.g. 57 → "A3". */
export function midiName(midi: number): string {
  const pitchClass = ((midi % SEMITONES) + SEMITONES) % SEMITONES;
  const octave = Math.floor(midi / SEMITONES) - 1;
  return `${noteName(pitchClass)}${octave}`;
}

export interface Tuning {
  id: string;
  label: string;
  midi: number[];
}

/** Built-in tunings (index 0 = thickest string) plus "Custom…". */
export const TUNINGS: Tuning[] = [
  { id: "standard", label: "Standard E A D G B E", midi: [40, 45, 50, 55, 59, 64] },
  { id: "dropD", label: "Drop D D A D G B E", midi: [38, 45, 50, 55, 59, 64] },
  { id: "halfDown", label: "Half-step down Eb Ab Db Gb Bb Eb", midi: [39, 44, 49, 54, 58, 63] },
  { id: "wholeDown", label: "Whole-step down D G C F A D", midi: [38, 43, 48, 53, 57, 62] },
  { id: "openG", label: "Open G D G D G B D", midi: [38, 43, 50, 55, 59, 62] },
  { id: "openD", label: "Open D D A D F# A D", midi: [38, 45, 50, 54, 57, 62] },
  { id: "dadgad", label: "DADGAD D A D G A D", midi: [38, 45, 50, 55, 57, 62] },
  { id: "custom", label: "Custom…", midi: [40, 45, 50, 55, 59, 64] },
];

export interface ChordPattern {
  intervals: number[];
  name: string;
}

/** Interval patterns for chord naming; display suffix ("" = major). */
const CHORD_PATTERNS: ChordPattern[] = [
  { intervals: [0, 1, 4, 7, 10], name: "7b9" },
  { intervals: [0, 3, 4, 7, 10], name: "7#9" },
  { intervals: [0, 2, 3, 7, 10], name: "m9" },
  { intervals: [0, 2, 4, 7, 10], name: "9" },
  { intervals: [0, 2, 4, 7, 11], name: "maj9" },
  { intervals: [0, 2, 5, 7, 10], name: "7sus2" },
  { intervals: [0, 2, 4, 7, 9], name: "6/9" },
  { intervals: [0, 2, 4, 5, 7, 10], name: "11" },
  { intervals: [0, 2, 4, 7, 9, 10], name: "13" },
  { intervals: [0, 2, 4, 7, 9, 11], name: "maj13" },
  { intervals: [0, 4, 6, 7, 11], name: "maj7#11" },
  { intervals: [0, 2, 4, 6, 7, 11], name: "maj9#11" },
  { intervals: [0, 3, 6, 10], name: "m7b5" },
  { intervals: [0, 3, 6, 9], name: "dim7" },
  { intervals: [0, 3, 7, 10], name: "m7" },
  { intervals: [0, 3, 7, 11], name: "mMaj7" },
  { intervals: [0, 4, 6, 10], name: "7b5" },
  { intervals: [0, 4, 7, 10], name: "7" },
  { intervals: [0, 4, 8, 10], name: "7#5" },
  { intervals: [0, 4, 8, 11], name: "maj7#5" },
  { intervals: [0, 5, 7, 10], name: "7sus4" },
  { intervals: [0, 4, 7, 11], name: "maj7" },
  { intervals: [0, 3, 7, 9], name: "m6" },
  { intervals: [0, 4, 7, 9], name: "6" },
  { intervals: [0, 2, 4, 7], name: "add9" },
  { intervals: [0, 3, 7], name: "m" },
  { intervals: [0, 4, 7], name: "" },
  { intervals: [0, 3, 6], name: "dim" },
  { intervals: [0, 4, 8], name: "aug" },
  { intervals: [0, 2, 7], name: "sus2" },
  { intervals: [0, 5, 7], name: "sus4" },
  { intervals: [0, 2, 5, 7], name: "sus24" },
];

export interface ChordName {
  primary: string;
  alternatives: string[];
}

function sameIntervals(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Identify a chord's name from its pitch classes; prefers the lowest as root. */
export function chordName(pitchClasses: number[]): ChordName {
  const sorted = [...pitchClasses].sort((a, b) => a - b);
  const primary = sorted.map(noteName).join(" ");
  if (sorted.length < 3) return { primary, alternatives: [] };

  const candidates: { root: number; name: string }[] = [];
  for (const root of sorted) {
    const intervals = [...new Set(sorted.map((p) => (p - root + SEMITONES) % SEMITONES))]
      .sort((a, b) => a - b);
    for (const pattern of CHORD_PATTERNS) {
      if (sameIntervals(pattern.intervals, intervals)) {
        candidates.push({ root, name: `${noteName(root)}${pattern.name}` });
      }
    }
  }
  if (candidates.length === 0) return { primary, alternatives: [] };

  const preferred = candidates.filter((c) => c.root === sorted[0]);
  const chosen = preferred[0] ?? candidates[0];
  const altList = Array.from(
    new Set(candidates.filter((c) => c.name !== chosen.name).map((c) => c.name)),
  ).slice(0, 3);
  return { primary: chosen.name, alternatives: altList };
}

export interface ParsedChord {
  /** The raw token as typed, e.g. "C/G" or "Bb7". */
  name: string;
  /** Root pitch class 0..11. */
  root: number;
  /** Bass pitch class from a slash chord ("C/G" -> G), or null. */
  bass: number | null;
  /** Full pitch-class set, sorted ascending. */
  pitchClasses: number[];
}

const SUFFIX_INTERVALS = new Map<string, number[]>(
  CHORD_PATTERNS.map((p) => [p.name, p.intervals]),
);

/** Normalize chord-symbol spellings ("M7"/"Maj7" -> "maj7", "Cmaj" -> major). */
function canonicalSuffix(raw: string): string {
  if (raw === "M" || raw === "Maj" || raw === "MAJ" || raw === "maj") return "";
  if (raw.charAt(0) === "M") {
    let rest = raw.slice(1).toLowerCase();
    if (rest.startsWith("aj")) rest = rest.slice(2);
    return rest === "" ? "" : `maj${rest}`;
  }
  return raw.toLowerCase();
}

const ROOT_ALIASES = new Map<string, number>();
SHARP_NAMES.forEach((n, i) => ROOT_ALIASES.set(n.toLowerCase(), i));
for (const [alias, pitchClass] of [
  ["ab", 8], ["bb", 10], ["db", 1], ["eb", 3], ["gb", 6],
] as [string, number][]) {
  ROOT_ALIASES.set(alias, pitchClass);
}

function parseRootSuffix(main: string): { root: number; suffix: string } | null {
  const letter = main.charAt(0).toLowerCase();
  let root = ROOT_ALIASES.get(letter);
  if (root === undefined) return null;
  const accidental = main.charAt(1);
  if (accidental === "#") { root = (root + 1) % SEMITONES; return { root, suffix: main.slice(2) }; }
  if (accidental === "b") { root = (root - 1 + SEMITONES) % SEMITONES; return { root, suffix: main.slice(2) }; }
  return { root, suffix: main.slice(1) };
}

function parseBassPitchClass(token: string): number | null {
  const match = /^([A-Ga-g])([#b]?)$/.exec(token.trim());
  if (!match) return null;
  let pitchClass = ROOT_ALIASES.get(match[1]!.toLowerCase())!;
  if (match[2] === "#") pitchClass = (pitchClass + 1) % SEMITONES;
  else if (match[2] === "b") pitchClass = (pitchClass - 1 + SEMITONES) % SEMITONES;
  return pitchClass;
}

/**
 * Parse a chord symbol into pitch classes: optional root with #/b, then a
 * quality suffix from `CHORD_PATTERNS` (bare root = major; "M"/"Maj" also
 * major), optionally followed by "/bass" for slash/inversion chords.
 */
export function parseChord(input: string): ParsedChord {
  const token = input.trim();
  if (!token) throw new Error("Empty chord name.");
  let main = token;
  let bass: number | null = null;

  const parts = token.split("/");
  if (parts.length > 1) {
    for (let k = parts.length - 1; k >= 1; k--) {
      const candidateMain = parts.slice(0, k).join("/");
      const candidateBass = parseBassPitchClass(parts.slice(k).join("/"));
      if (parseRootSuffix(candidateMain) && candidateBass !== null) {
        main = candidateMain;
        bass = candidateBass;
        break;
      }
    }
  }

  const parsed = parseRootSuffix(main);
  if (!parsed) throw new Error(`Unknown chord "${token}".`);
  const intervals = SUFFIX_INTERVALS.get(canonicalSuffix(parsed.suffix));
  if (intervals === undefined) throw new Error(`Unknown chord "${token}".`);
  const pitchClasses = [...new Set(intervals.map((i) => (parsed.root + i) % SEMITONES))]
    .sort((a, b) => a - b);
  return { name: token, root: parsed.root, bass, pitchClasses };
}