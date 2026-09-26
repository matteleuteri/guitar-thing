import { planGuitarSong, type VoicingPin } from "./song.js";
import { parseChord, type ParsedChord } from "./theory.js";

/**
 * A riff is a time-ordered list of EVENTS. Every event strikes a set of notes
 * at one instant, and the notes inside it are staggered by `strumMs` — which
 * is the whole trick: a block chord is an event with strumMs 0, a strummed
 * chord is the same event with a real width, an arpeggio is a wide one, and a
 * single-note riff is a run of one-note events. Chords and riffs are therefore
 * one model rather than two features.
 */

export interface RiffNote {
  stringIndex: number;
  fret: number;
}

export interface RiffEvent {
  /** Start time in beats from the top of the piece. */
  beat: number;
  /** Nominal length in beats (display + release hint; `0` = let ring). */
  beats: number;
  /** Per-event strum width in ms: 0 = every note sounds together. */
  strumMs: number;
  /** Notes struck by this event, low string first. */
  notes: RiffNote[];
  /** Per-string frets, `null` where the string is not struck. */
  frets: (number | null)[];
  /** Strings the notation explicitly mutes, for the diagram's `×` markers. */
  muted: number[];
  /** Lowest sounding pitch class — the `role` accent the audio graph uses. */
  rootPitchClass: number;
  label: string;
  kind: "chord" | "note";
  /** The written chord, for chord-stream events. */
  chord: ParsedChord | null;
  /** True when the shape came from a user pin rather than the search. */
  pinned?: boolean;
}

export interface Riff {
  bpm: number;
  beatsPerBar: number;
  /** Beats per tab column. */
  stepBeats: number;
  events: RiffEvent[];
  /** Total length in beats, rounded up to a whole bar. */
  totalBeats: number;
  /** Loop window in beats, clamped to the piece. */
  loop: { start: number; end: number };
  /** Default strum width in ms for multi-note events. */
  strumMs: number;
  /** Default note release in ms (0 = let it ring). */
  releaseMs: number;
  warnings: string[];
}

export interface RiffOptions {
  tuning: number[];
  maxFrets: number;
  /** Voicing span (frets) and candidate cap used to voice the chord stream. */
  span: number;
  cap: number;
  /** Strum width in ms when the notation has no `strum` directive. */
  defaultStrumMs?: number;
  /**
   * User-chosen voicings, index-aligned with the chord stream. A pin whose
   * `name` is not the chord at that index is ignored, so editing the progression
   * cannot leave a choice silently re-voicing a different chord.
   */
  pins?: VoicingPin[];
}

const STRING_LETTERS = "eBGDAE";
// The body is taken RAW between the pipes: a leading space is a rest on column
// 0, not decoration, and trimming it would slide every note left. Nothing but
// a `|` may end the body, so two lanes can't bleed into one another.
const LANE_LINE = /^\s*([eBGDAE])\s*\|([^|]*)\|\s*$/;
/** A lane that opens with a string letter + `|` but never closes its pipe. */
const UNCLOSED_LANE = /^\s*[eBGDAE]\s*\|/;
const MUTE_CHARS = new Set(["x", "X"]);

/**
 * How long one tab column lasts, in beats. `step 0.5` is a number of BEATS,
 * which is not how anyone says rhythm out loud — a guitarist thinks "8ths",
 * "16ths", "triplets". So `step`/`grid` also take note-value names, and the
 * number keeps working. Spelled as a fraction of a whole note (`1/8`) or as a
 * word; triplets are three in the time of two, so `eighth triplets` is a third
 * of a beat.
 */
const STEP_NAMES: Record<string, number> = {
  whole: 4, "1/1": 4,
  half: 2, "1/2": 2, "1/half": 2,
  quarter: 1, "1/4": 1, "1/quarter": 1,
  eighth: 0.5, "1/8": 0.5, "1/eighth": 0.5,
  sixteenth: 0.25, "1/16": 0.25, "1/sixteenth": 0.25,
  "thirty-second": 0.125, "1/32": 0.125, "1/thirty-second": 0.125,
  "eighth triplet": 1 / 3,
  "quarter triplet": 2 / 3,
  "sixteenth triplet": 1 / 6,
};

const ORDINAL_WORDS: Record<string, string> = {
  "1": "one", "2": "two", "3": "three", "4": "four", "6": "six",
  8: "eighth", 16: "sixteenth", 32: "thirty-second",
};
const FRACTION_WORDS: Record<string, string> = {
  one: "1", two: "1/2", three: "1/3", four: "1/4", six: "1/6",
};

/**
 * Name a grid, for the UI. This is the same vocabulary `stepValue` accepts, so
 * what the readout calls the grid is what the notation can ask for: with
 * `step 0.25` it says "one column = a 16th note", which is the thing the
 * notation box never explained.
 */
export function stepName(beats: number): string {
  const table: [number, string][] = [
    [4, "a whole note"], [3, "a dotted half note"], [2, "a half note"],
    [1, "a quarter note"], [2 / 3, "a quarter-note triplet"],
    [0.5, "an 8th note"], [1 / 3, "an 8th-note triplet"],
    [0.25, "a 16th note"], [1 / 6, "a 16th-note triplet"],
    [0.125, "a 32nd note"],
  ];
  for (const [value, name] of table) {
    if (Math.abs(beats - value) < 1e-6) return name;
  }
  return `${beats} beat${beats === 1 ? "" : "s"}`;
}

function stepValue(raw: string): number {
  // Normalize to a lookup key: lowercase, `1 / 8` -> `1/8`, `8ths` -> `eighth`,
  // `triplet 8ths` -> `eighth triplet`, and drop a plural on the fractions.
  let key = raw
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, "/")
    .replace(/\btriplets?\b/g, "triplet")
    // `s?` is required: without it the `\b` never matches in `16ths`, because
    // the trailing `s` is a word character, and the whole word is skipped.
    .replace(/(\d+)(?:st|nd|rd|th)s?\b/g, (_m, digits: string) => `${ORDINAL_WORDS[digits] ?? digits} `)
    .replace(/\b(one|two|three|four|six)\b\//, (_m, n: string) => `${FRACTION_WORDS[n]}/`)
    .replace(/[.,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  // `triplet eighths` is how people say it; the table lists `eighth triplet`.
  const flipped = /^triplet (.+)$/.exec(key);
  if (flipped) key = `${flipped[1].replace(/s$/, "")} triplet`;
  if (!key.endsWith("triplet")) key = key.replace(/s$/, "");

  const named = STEP_NAMES[key];
  if (named !== undefined) return named;
  // Only a WHOLE numeric string is a beat count. `parseFloat` would happily read
  // the "1" out of `1/8` and turn a sixteenth into a quarter.
  if (/^\d*\.?\d+$/.test(key)) return Number.parseFloat(key);
  throw new Error(
    `"${raw}" is not a note length. Use a number of beats (0.5) or a name: ` +
      `whole, half, quarter, eighths, sixteenths, or eighth triplets.`,
  );
}


const REST_CHARS = new Set(["-", ".", "_"]);
/** Suffix markers a player writes after a fret (bend, pull-off, let-ring). */
const FRET_MARKS = new Set(["'", "?", "b", "h", "p", "~", "*"]);
const DIRECTIVES = new Set(["tempo", "bpm", "bar", "step", "grid", "strum", "release"]);

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Scan one tab lane's body into cells. This is a CHARACTER scanner, not a
 * whitespace splitter, so every character is one column and the lanes line up
 * the way they look — which is what printed tab means and what a player
 * actually types. A two-digit fret occupies its own two character columns (its
 * second one empty) so a note in another lane under the `0` still lines up.
 * `-`/`.`/`_`/space are rests that hold their column, `x` is a mute, and
 * `'/?/b/h/p` after a fret are accepted and ignored for now.
 *
 * Spaces were previously *dropped* rather than counted, which silently moved
 * every note after the first one column left of where it was printed and made
 * a pair of space-separated lanes fail the equal-length check.
 */
function laneCells(body: string, lineNo: number): (number | "x" | null)[] {
  const cells: (number | "x" | null)[] = [];
  const chars = [...body];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    // A space is a rest that HOLDS ITS COLUMN, like a dash. Dropping it (the
    // old behavior) moved every following note one column left of where the
    // player wrote it, and broke the equal-length check between lanes.
    if (ch === " " || ch === "\t" || REST_CHARS.has(ch)) {
      cells.push(null);
      continue;
    }
    if (MUTE_CHARS.has(ch)) {
      cells.push("x");
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let digits = ch;
      let width = 1;
      if (i + 1 < chars.length && chars[i + 1] >= "0" && chars[i + 1] <= "9") {
        digits += chars[++i];
        width = 2;
      }
      if (i + 1 < chars.length && FRET_MARKS.has(chars[i + 1])) i++;
      cells.push(Number(digits));
      // Keep the lane's character width so columns stay aligned across lanes.
      for (let pad = 1; pad < width; pad++) cells.push(null);
      continue;
    }
    throw new Error(
      `Line ${lineNo}: "${ch}" is not a fret, x (mute) or dash (hold). Use spaces or dashes between notes.`,
    );
  }
  return cells;
}

/**
 * Parse the riff notation:
 *
 *   tempo 96              # bpm (alias: bpm)
 *   bar 4                 # beats per bar
 *   step 0.5               # beats per tab column
 *   strum 55              # ms between the notes of a multi-note event
 *   release 250           # ms before a struck note is damped (0 = let ring)
 *   C Am F G              # chord stream: one chord per bar
 *   e|--5--5--7--7--|     # tab lanes, e (high) first; columns are steps
 *   B|------3--5--3--|
 *
 * A line shaped like `string|...|` is a tab lane; any other non-directive line
 * is the chord stream. In a lane EVERY character is one column — frets, `-`,
 * `.`, `_`, `x` and plain spaces alike — so lanes line up the way they look
 * and must all be the same character width. Chords are voiced by the same DP
 * `planGuitarSong` uses, so a progression keeps one hand shape across the whole
 * stream. The loop window is a transport setting (the two "Loop ... bar"
 * inputs), not notation.
 */
export function parseRiff(text: string, options: RiffOptions): Riff {
  const warnings: string[] = [];
  let bpm = 96;
  let beatsPerBar = 4;
  let stepBeats = 0.5;
  let strumMs = options.defaultStrumMs ?? 55;
  let releaseMs = 0;

  const chordTokens: string[] = [];
  const lanes = new Map<number, (number | "x" | null)[]>();

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    const directive = /^([a-z]+)\s+(.+)$/i.exec(line);
    const key = directive ? directive[1].toLowerCase() : "";
    // A chord line like `C Am F G` also matches the directive shape, so a line
    // is only treated as a directive when its first word is a KNOWN keyword.
    // A single unknown word followed by a number is a typo'd directive and gets
    // that error; anything else falls through to the chord stream.
    const isDirective = key !== "" && DIRECTIVES.has(key);
    // A directive may carry a trailing comment: `step eighths  # 8th-note
    // grid`. Only the value's own text is parsed, so the comment has to come
    // off before anything tries to read a number or a name out of it.
    const value = directive ? directive[2].split(/(?:#|\/\/)/, 1)[0].trim() : "";
    if (!isDirective && directive && !Number.isNaN(Number.parseFloat(value))) {
      throw new Error(
        `Line ${lineNo}: unknown directive "${directive[1]}" (try ${[...DIRECTIVES].join(", ")}).`,
      );
    }
    const number = (): number => {
      const n = Number.parseFloat(value);
      if (!Number.isFinite(n)) throw new Error(`Line ${lineNo}: "${key}" needs a number.`);
      return n;
    };

    if (isDirective && (key === "tempo" || key === "bpm")) bpm = clamp(number(), 20, 400);
    else if (isDirective && key === "bar") beatsPerBar = clamp(number(), 1, 12);
    else if (isDirective && (key === "step" || key === "grid")) {
      stepBeats = clamp(stepValue(value), 0.0625, beatsPerBar);
    } else if (isDirective && key === "strum") strumMs = clamp(number(), 0, 2000);
    else if (isDirective && key === "release") releaseMs = clamp(number(), 0, 4000);
    else {
      const lane = LANE_LINE.exec(line);
      if (lane) {
        // `e` is the high E = last tuning index; B G D A E run down to 0.
        const stringIndex = 5 - STRING_LETTERS.indexOf(lane[1]);
        if (lanes.has(stringIndex)) {
          throw new Error(`Line ${lineNo}: two lanes for string ${lane[1]}; use one lane per string.`);
        }
        lanes.set(stringIndex, laneCells(lane[2], lineNo));
      } else if (UNCLOSED_LANE.test(line)) {
        // `e|5---5---` with no closing pipe used to fall through to the chord
        // stream and die as `Unknown chord "e"`, which points at the wrong
        // line of the wrong thing entirely.
        throw new Error(`Line ${lineNo}: this tab lane is missing its closing "|".`);
      } else {
        // A token that *starts* with a comment marker opens a trailing comment,
        // so `C Am F G # the accompaniment` works — but `F#m7` and `Bb7` are
        // ordinary chords and must survive, so a `#` only comments when it
        // begins the token (never mid-token).
        for (const token of line.split(/[\s,;|]+/)) {
          if (!token) continue;
          if (token.startsWith("#") || token.startsWith("//")) break;
          chordTokens.push(token);
        }
      }
    }
  }

  const widths = new Set([...lanes.values()].map((cells) => cells.length));
  if (widths.size > 1) {
    const listed = [...widths].sort((a, b) => a - b).join(", ");
    // The counts are CHARACTERS, so the fix is to pad the short lanes with
    // dashes or spaces to the same width — say so, it is the commonest error.
    throw new Error(
      `Tab lanes have different lengths (${listed} columns). Every character counts as one column, so pad the short lanes with "-" or spaces to the same width.`,
    );
  }
  const columns = widths.size === 1 ? [...widths][0] : 0;
  if (columns === 0 && chordTokens.length === 0) {
    throw new Error("Nothing to play: add a chord (C Am F G) or a tab lane (e|--5--5--|).");
  }

  const stringCount = options.tuning.length;
  const events: RiffEvent[] = [];

  const pushEvent = (partial: Omit<RiffEvent, "frets" | "rootPitchClass">): void => {
    const frets: (number | null)[] = new Array(stringCount).fill(null);
    for (const note of partial.notes) frets[note.stringIndex] = note.fret;
    const rootPitchClass = Math.min(
      ...partial.notes.map((note) => (options.tuning[note.stringIndex] + note.fret) % 12),
    );
    events.push({ ...partial, frets, rootPitchClass });
  };

  // ---- chord stream: one chord per bar, voiced by the song DP ----
  if (chordTokens.length > 0) {
    const parsed: ParsedChord[] = chordTokens.map((token) => {
      try {
        return parseChord(token);
      } catch (e) {
        throw new Error(`Chord "${token}": ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    const pins = options.pins ?? [];
    const plan = planGuitarSong(parsed, options.tuning, options.maxFrets, options.span, options.cap, pins);
    if (!plan || plan.kind !== "guitar") {
      throw new Error("A chord in the stream has no voicing within the chosen fret span.");
    }
    plan.chords.forEach((entry, index) => {
      const notes: RiffNote[] = [];
      const muted: number[] = [];
      entry.fingering.frets.forEach((fret, stringIndex) => {
        if (fret === null) muted.push(stringIndex);
        else notes.push({ stringIndex, fret });
      });
      pushEvent({
        beat: index * beatsPerBar,
        beats: beatsPerBar,
        strumMs: notes.length > 1 ? strumMs : 0,
        notes,
        muted,
        label: entry.chord.name,
        kind: "chord",
        chord: entry.chord,
        pinned: pins[index]?.name === entry.chord.name,
      });
    });
  }

  // ---- tab lanes: one event per column that has any note ----
  for (let column = 0; column < columns; column++) {
    const notes: RiffNote[] = [];
    const muted: number[] = [];
    for (const [stringIndex, cells] of lanes) {
      const cell = cells[column];
      if (cell === null || cell === undefined) continue;
      if (cell === "x") {
        muted.push(stringIndex);
        continue;
      }
      if (cell > options.maxFrets) {
        warnings.push(
          `Column ${column + 1}: fret ${cell} is past the ${options.maxFrets}th fret; skipped.`,
        );
        continue;
      }
      notes.push({ stringIndex, fret: cell });
    }
    if (notes.length === 0) continue;
    notes.sort((a, b) => a.stringIndex - b.stringIndex);
    pushEvent({
      beat: column * stepBeats,
      beats: stepBeats,
      strumMs: notes.length > 1 ? strumMs : 0,
      notes,
      muted,
      label: notes.length > 1
        ? notes.map((note) => `${STRING_LETTERS[5 - note.stringIndex]}${note.fret}`).join(" ")
        : `${notes[0].fret}`,
      kind: "note",
      chord: null,
    });
  }

  if (events.length === 0) {
    throw new Error("No playable notes: every tab column was a rest or past the last fret.");
  }

  // By beat; a chord and a tab note landing on the same beat BOTH play (a stab
  // under a melody note), so ties keep the chord first.
  events.sort((a, b) => a.beat - b.beat || (a.kind === "chord" ? -1 : 1));

  const lastEvent = Math.max(...events.map((event) => event.beat + event.beats));
  const totalBeats = Math.ceil(Math.max(lastEvent, columns * stepBeats) / beatsPerBar) * beatsPerBar;

  return {
    bpm,
    beatsPerBar,
    stepBeats,
    events,
    totalBeats,
    loop: { start: 0, end: totalBeats },
    strumMs,
    releaseMs,
    warnings,
  };
}

/**
 * Beat -> seconds for a tempo. The transport's whole clock is this, so a
 * tempo change only has to re-derive the seconds-per-beat factor.
 */
export function secondsPerBeat(riff: Riff, tempoScale = 1): number {
  return 60 / (riff.bpm * tempoScale);
}

/** Build a per-string fret array for a single ad-hoc note (dot clicks, previews). */
export function noteFrets(tuning: number[], notes: RiffNote[]): (number | null)[] {
  const frets: (number | null)[] = new Array(tuning.length).fill(null);
  for (const note of notes) frets[note.stringIndex] = note.fret;
  return frets;
}
