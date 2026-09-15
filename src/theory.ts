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