import { chordShape, findFingerings, parseChordShape, type Fingering } from "./fretboard.js";
import { findPianoVoicings, type PianoVoicing } from "./piano.js";
import { parseChord, chordName, SEMITONES, type ParsedChord } from "./theory.js";

/**
 * Song mode: given a progression, pick one voicing per chord so the whole
 * arrangement moves as little as possible (Viterbi over the per-chord
 * candidate voicings). Shared frets/keys that stay put are "held" — the
 * notes a rhythm guitarist keeps her fingers on when changing chords.
 */

const SONG_CAP = 400;                // per-chord candidate budget for the DP
const MUTE_CHANGE = 4;               // effort to clamp/un-clamp a string
const EXTRA_KEY_PENALTY = 2;         // effort to grow/shrink a piano grip
const POSITION_WEIGHT = 0.5;         // extra penalty per fret of hand shift
const BASS_PENALTY = 2;              // penalty when the lowest note != written bass

/** Split a chord-sheet line into chord tokens (space/comma/semicolon/bar). */
/** A pin that cannot be honoured: a malformed shape, or one the span excludes. */
export class PinError extends Error {}

export function parseProgression(input: string): ParsedChord[] {
  const tokens = input.split(/[\s,;|]+/).map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error("Enter at least one chord, e.g. C G Am F.");
  if (tokens.some((token) => token.toUpperCase() === "N.C.")) {
    throw new Error('"N.C." (no chord) is not supported yet.');
  }
  return tokens.map((token) => parseChord(token));
}

/**
 * A user-chosen voicing for one chord of a progression, overriding the search.
 * `name` is the chord the choice was made for and is checked before the pin is
 * honoured, so editing the chord stream drops a pin that no longer refers to the
 * chord under it instead of silently re-voicing a different chord.
 */
export interface VoicingPin {
  name: string;
  shape: string;
}

/** Generic shortest-path selection: dp[i][j] = min cost ending chord i at voicing j. */
function bestPath<T>(
  candidates: T[][],
  nodeCost: (candidate: T, chordIndex: number) => number,
  edgeCost: (from: T, to: T, chordIndex: number) => number,
): { path: T[]; total: number } | null {
  const chordCount = candidates.length;
  if (chordCount === 0) return null;
  if (candidates.some((c) => c.length === 0)) return null;

  let previousBest = candidates[0].map((candidate) => nodeCost(candidate, 0));
  const back: number[][] = [];
  for (let chordIndex = 1; chordIndex < chordCount; chordIndex++) {
    const current = candidates[chordIndex];
    const previous = candidates[chordIndex - 1];
    const currentBest = new Array<number>(current.length).fill(Infinity);
    const currentBack = new Array<number>(current.length).fill(-1);
    for (let j = 0; j < current.length; j++) {
      let best = Infinity;
      let bestPrevious = -1;
      for (let k = 0; k < previous.length; k++) {
        const cost = previousBest[k] + edgeCost(previous[k], current[j], chordIndex);
        if (cost < best) { best = cost; bestPrevious = k; }
      }
      currentBest[j] = nodeCost(current[j], chordIndex) + best;
      currentBack[j] = bestPrevious;
    }
    back.push(currentBack);
    previousBest = currentBest;
  }

  let j = 0;
  for (let k = 1; k < previousBest.length; k++) if (previousBest[k] < previousBest[j]) j = k;
  const total = previousBest[j];
  const path = new Array<T>(chordCount);
  for (let i = chordCount - 1; i >= 0; i--) {
    path[i] = candidates[i][j];
    if (i > 0) j = back[i - 1][j];
  }
  return { path, total };
}

/* ------------------------------- guitar ------------------------------ */

export interface GuitarSongChord {
  chord: ParsedChord;
  fingering: Fingering;
  /** 0-based string indices whose fret is unchanged from the previous chord. */
  held: number[];
  /** Transition cost to the previous chord (node cost only for the first). */
  move: number;
  bassMatches: boolean;
}

export interface GuitarSongPlan {
  kind: "guitar";
  chords: GuitarSongChord[];
  totalMove: number;
  truncated: boolean;
}

/** Movement cost between two guitar fingerings + the held string indices. */
function guitarTransition(from: Fingering, to: Fingering): { cost: number; held: number[] } {
  let cost = 0;
  const held: number[] = [];
  let fromMinFret = Infinity;
  let toMinFret = Infinity;
  for (let stringIndex = 0; stringIndex < from.frets.length; stringIndex++) {
    const fromFret = from.frets[stringIndex];
    const toFret = to.frets[stringIndex];
    if (fromFret !== null && toFret !== null) {
      if (fromFret === toFret) held.push(stringIndex);
      cost += Math.abs(fromFret - toFret);
    } else if (fromFret !== null || toFret !== null) {
      cost += MUTE_CHANGE;
    }
    if (fromFret !== null && fromFret > 0) fromMinFret = Math.min(fromMinFret, fromFret);
    if (toFret !== null && toFret > 0) toMinFret = Math.min(toMinFret, toFret);
  }
  if (fromMinFret !== Infinity && toMinFret !== Infinity) cost += POSITION_WEIGHT * Math.abs(fromMinFret - toMinFret);
  return { cost, held };
}

/** 0 when the lowest sounding string matches the written bass, else `BASS_PENALTY`. */
function guitarNodeCost(chord: ParsedChord, fingering: Fingering, tuning: number[]): number {
  if (chord.bass === null) return 0;
  for (let stringIndex = 0; stringIndex < fingering.frets.length; stringIndex++) {
    const fret = fingering.frets[stringIndex];
    if (fret !== null) {
      return ((tuning[stringIndex] + fret) % SEMITONES) === chord.bass ? 0 : BASS_PENALTY;
    }
  }
  return BASS_PENALTY;
}

/**
 * One voicing per chord of `progression` on the guitar, chained with minimal
 * overall movement (per-string fret deltas, mute changes, hand-position shift,
 * written-bass preference). `cap` bounds the per-chord DP candidates (each of
 * `cap` and the built-in SONG_CAP applies). Returns null if any chord has no
 * voicing within the span.
 */
export function planGuitarSong(
  progression: ParsedChord[],
  tuning: number[],
  maxFrets: number,
  span: number,
  cap = SONG_CAP,
  pins: VoicingPin[] = [],
): GuitarSongPlan | null {
  const budget = Math.max(1, Math.min(cap, SONG_CAP));
  let truncated = false;
  const candidates = progression.map((chord, index) => {
    const result = findFingerings(chord.pitchClasses, tuning, maxFrets, span, budget);
    if (result.truncated) truncated = true;
    const pin = pins[index];
    if (!pin || pin.name !== chord.name) return result.fingerings;
    // A pin is a command, not a preference: narrow to the one shape. It has to
    // be in the candidate set to be playable at all, so a shape outside the
    // fret span is a hard error rather than a silent fallback to auto.
    const wanted = parseChordShape(pin.shape);
    const pinned = result.fingerings.filter((f) => chordShape(f.frets) === pin.shape);
    if (pinned.length === 0) {
      throw new PinError(
        wanted === null
          ? `Chord "${chord.name}": "${pin.shape}" is not a shape (six characters, one per string, x for a muted string).`
          : `Chord "${chord.name}": ${pin.shape} does not sound the chord within ${span} frets.`,
      );
    }
    return pinned;
  });
  if (candidates.some((c) => c.length === 0)) return null;

  const path = bestPath(
    candidates,
    (fingering, chordIndex) => guitarNodeCost(progression[chordIndex], fingering, tuning),
    (from, to) => guitarTransition(from, to).cost,
  );
  if (!path) return null;

  const chords: GuitarSongChord[] = [];
  let totalMove = 0;
  for (let i = 0; i < path.path.length; i++) {
    const fingering = path.path[i];
    const previous = i > 0 ? path.path[i - 1] : null;
    const transition = previous ? guitarTransition(previous, fingering) : { cost: 0, held: [] };
    if (i > 0) totalMove += transition.cost;
    chords.push({
      chord: progression[i],
      fingering,
      held: transition.held,
      move: transition.cost,
      bassMatches: guitarNodeCost(progression[i], fingering, tuning) === 0,
    });
  }
  return { kind: "guitar", chords, totalMove, truncated };
}

/**
 * Every voicing of one chord, ordered by how well it moves from `from` (the
 * previous chord's chosen shape, or null for the first chord). This is what the
 * riff builder's voicing browser walks: the search proposes the smoothest
 * options first, the user overrides by stepping through them. The candidate set
 * is the same one the DP would choose from, so stepping cannot land on a shape
 * the search would have refused.
 */
export function rankGuitarVoicings(
  pitchClasses: number[],
  tuning: number[],
  maxFrets: number,
  span: number,
  from: (number | null)[] | null,
  cap = SONG_CAP,
): { frets: (number | null)[]; shape: string; cost: number; sounded: number; top: number }[] {
  const budget = Math.max(1, Math.min(cap, SONG_CAP));
  const result = findFingerings(pitchClasses, tuning, maxFrets, span, budget);
  const origin: Fingering | null = from ? { frets: from } : null;
  return result.fingerings
    .map((fingering) => {
      const fretted = fingering.frets.filter((fret): fret is number => fret !== null);
      return {
        frets: fingering.frets,
        shape: chordShape(fingering.frets),
        cost: origin ? guitarTransition(origin, fingering).cost : 0,
        sounded: fretted.length,
        // The highest fret actually stopped: "how far up the neck is this".
        top: fretted.length > 0 ? Math.max(...fretted) : 0,
      };
    })
    .sort((a, b) =>
      a.cost - b.cost ||
      // Ties are broken toward the shape a guitarist would reach for: more
      // strings sounding first, then lower on the neck. Without this the list
      // falls through to alphabetical order, and the first chord — where every
      // candidate costs the same, since there is nothing to move from — lands
      // the search's own pick at an arbitrary rank like 382 of 400, so stepping
      // through the list walks into noise instead of toward better shapes.
      b.sounded - a.sounded ||
      a.top - b.top ||
      a.shape.localeCompare(b.shape),
    );
}

/* -------------------------------- piano ------------------------------ */

export interface PianoSongChord {
  chord: ParsedChord;
  voicing: PianoVoicing;
  /** MIDI note numbers held unchanged from the previous chord. */
  held: number[];
  move: number;
  bassMatches: boolean;
}

export interface PianoSongPlan {
  kind: "piano";
  chords: PianoSongChord[];
  totalMove: number;
  truncated: boolean;
}

/** Movement cost between two piano key sets + the held MIDI notes. */
function pianoTransition(from: number[], to: number[]): { cost: number; held: number[] } {
  const fromKeys = [...from].sort((x, y) => x - y);
  const toKeys = [...to].sort((x, y) => x - y);
  const held: number[] = [];
  let cost = 0;
  const paired = Math.min(fromKeys.length, toKeys.length);
  for (let i = 0; i < paired; i++) {
    const distance = Math.abs(fromKeys[i] - toKeys[i]);
    if (distance === 0) held.push(fromKeys[i]);
    cost += distance;
  }
  cost += EXTRA_KEY_PENALTY * Math.abs(fromKeys.length - toKeys.length);
  return { cost, held };
}

/** 0 when the lowest key matches the written bass, else `BASS_PENALTY`. */
function pianoNodeCost(chord: ParsedChord, keys: number[]): number {
  if (chord.bass === null) return 0;
  const lowestKey = Math.min(...keys);
  return ((lowestKey % SEMITONES) + SEMITONES) % SEMITONES === chord.bass ? 0 : BASS_PENALTY;
}

/**
 * Same contract as `planGuitarSong` for piano: min overall key movement,
 * written-bass preference, `hold` = keys shared between consecutive chords.
 */
export function planPianoSong(
  progression: ParsedChord[],
  low: number,
  high: number,
  reach: number,
  cap = SONG_CAP,
): PianoSongPlan | null {
  const budget = Math.max(1, Math.min(cap, SONG_CAP));
  let truncated = false;
  const candidates = progression.map((chord) => {
    const result = findPianoVoicings(chord.pitchClasses, low, high, reach, budget);
    if (result.truncated) truncated = true;
    return result.voicings;
  });
  if (candidates.some((c) => c.length === 0)) return null;

  const path = bestPath(
    candidates,
    (voicing, chordIndex) => pianoNodeCost(progression[chordIndex], voicing.keys),
    (from, to) => pianoTransition(from.keys, to.keys).cost,
  );
  if (!path) return null;

  const chords: PianoSongChord[] = [];
  let totalMove = 0;
  for (let i = 0; i < path.path.length; i++) {
    const voicing = path.path[i];
    const previous = i > 0 ? path.path[i - 1] : null;
    const transition = previous ? pianoTransition(previous.keys, voicing.keys) : { cost: 0, held: [] };
    totalMove += transition.cost;
    chords.push({
      chord: progression[i],
      voicing,
      held: transition.held,
      move: transition.cost,
      bassMatches: pianoNodeCost(progression[i], voicing.keys) === 0,
    });
  }
  return { kind: "piano", chords, totalMove, truncated };
}

/** Human-readable fallback names for the plan's chord display. */
export function planChordLabel(chord: ParsedChord): string {
  const named = chordName(chord.pitchClasses);
  return chord.name === named.primary ? named.primary : `${chord.name}  (${named.primary})`;
}