export const SEMITONES = 12;

export const SHARP_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

export const FLAT_NAMES = [
  "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
] as const;

/** Combined sharp/flat label for the note buttons, e.g. "C#/Db" or "C". */
export function noteLabels(pc: number): string {
  const i = ((pc % SEMITONES) + SEMITONES) % SEMITONES;
  const s = SHARP_NAMES[i]!;
  const f = FLAT_NAMES[i]!;
  return s === f ? s : `${s}/${f}`;
}

const ALIASES = new Map<string, number>();
SHARP_NAMES.forEach((n, i) => ALIASES.set(n.toLowerCase(), i));
for (const [alias, pc] of [
  ["db", 1], ["eb", 3], ["gb", 6], ["ab", 8], ["bb", 10],
] as [string, number][]) {
  ALIASES.set(alias, pc);
}

export function noteName(pc: number): string {
  return SHARP_NAMES[((pc % SEMITONES) + SEMITONES) % SEMITONES];
}

export function parseNotes(input: string): number[] {
  const tokens = input.split(/[\s,;|]+/).filter(Boolean);
  if (tokens.length === 0) throw new Error("Enter at least one note.");
  const out: number[] = [];
  for (const raw of tokens) {
    const pc = ALIASES.get(raw.toLowerCase());
    if (pc === undefined) throw new Error(`Unknown note "${raw}".`);
    if (!out.includes(pc)) out.push(pc);
  }
  return out;
}

const DEFAULT_OCTAVES = [2, 2, 3, 3, 3, 4];

export function parseStringMidi(value: string, index: number): number {
  const m = /^([A-Ga-g])([#bB]?)\s*(\d+)?$/.exec(value.trim());
  if (!m) throw new Error(`Bad string note "${value}". Use e.g. E2, A2, Db3.`);
  const letter = m[1].toUpperCase();
  let pc = ALIASES.get(letter.toLowerCase())!;
  if (m[2] === "#") pc = (pc + 1) % SEMITONES;
  else if (m[2] === "b" || m[2] === "B") pc = (pc - 1 + SEMITONES) % SEMITONES;
  const octave = m[3] ? parseInt(m[3], 10) : DEFAULT_OCTAVES[index] ?? 2;
  return (octave + 1) * SEMITONES + pc;
}

export function midiName(midi: number): string {
  const pc = ((midi % SEMITONES) + SEMITONES) % SEMITONES;
  const octave = Math.floor(midi / SEMITONES) - 1;
  return `${noteName(pc)}${octave}`;
}

export interface Tuning {
  id: string;
  label: string;
  midi: number[];
}

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

export function chordName(pcs: number[]): ChordName {
  const sorted = [...pcs].sort((a, b) => a - b);
  const primary = sorted.map(noteName).join(" ");
  if (sorted.length < 3) return { primary, alternatives: [] };

  const candidates: { root: number; name: string }[] = [];
  for (const root of sorted) {
    const intervals = [...new Set(sorted.map((p) => (p - root + SEMITONES) % SEMITONES))]
      .sort((a, b) => a - b);
    for (const pat of CHORD_PATTERNS) {
      if (sameIntervals(pat.intervals, intervals)) {
        candidates.push({ root, name: `${noteName(root)}${pat.name}` });
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
  pcs: number[];
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
for (const [alias, pc] of [
  ["ab", 8], ["bb", 10], ["db", 1], ["eb", 3], ["gb", 6],
] as [string, number][]) {
  ROOT_ALIASES.set(alias, pc);
}

function parseRootSuffix(main: string): { root: number; suffix: string } | null {
  const letter = main.charAt(0).toLowerCase();
  let root = ROOT_ALIASES.get(letter);
  if (root === undefined) return null;
  const acc = main.charAt(1);
  if (acc === "#") { root = (root + 1) % SEMITONES; return { root, suffix: main.slice(2) }; }
  if (acc === "b") { root = (root - 1 + SEMITONES) % SEMITONES; return { root, suffix: main.slice(2) }; }
  return { root, suffix: main.slice(1) };
}

function parseBassPc(token: string): number | null {
  const m = /^([A-Ga-g])([#b]?)$/.exec(token.trim());
  if (!m) return null;
  let pc = ROOT_ALIASES.get(m[1].toLowerCase())!;
  if (m[2] === "#") pc = (pc + 1) % SEMITONES;
  else if (m[2] === "b") pc = (pc - 1 + SEMITONES) % SEMITONES;
  return pc;
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
      const candMain = parts.slice(0, k).join("/");
      const candBass = parseBassPc(parts.slice(k).join("/"));
      if (parseRootSuffix(candMain) && candBass !== null) {
        main = candMain;
        bass = candBass;
        break;
      }
    }
  }

  const parsed = parseRootSuffix(main);
  if (!parsed) throw new Error(`Unknown chord "${token}".`);
  const intervals = SUFFIX_INTERVALS.get(canonicalSuffix(parsed.suffix));
  if (intervals === undefined) throw new Error(`Unknown chord "${token}".`);
  const pcs = [...new Set(intervals.map((i) => (parsed.root + i) % SEMITONES))].sort((a, b) => a - b);
  return { name: token, root: parsed.root, bass, pcs };
}