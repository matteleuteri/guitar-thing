import { findFingerings, type Fingering } from "./fretboard.js";
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
export function parseProgression(input: string): ParsedChord[] {
  const tokens = input.split(/[\s,;|]+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error("Enter at least one chord, e.g. C G Am F.");
  if (tokens.some((t) => t.toUpperCase() === "N.C.")) {
    throw new Error('"N.C." (no chord) is not supported yet.');
  }
  return tokens.map((t) => parseChord(t));
}

/** Generic shortest-path selection: dp[i][j] = min cost ending chord i at voicing j. */
function bestPath<T>(
  candidates: T[][],
  nodeCost: (v: T, chord: number) => number,
  edgeCost: (a: T, b: T, chord: number) => number,
): { path: T[]; total: number } | null {
  const n = candidates.length;
  if (n === 0) return null;
  if (candidates.some((c) => c.length === 0)) return null;

  let prevBest = candidates[0]!.map((v) => nodeCost(v, 0));
  const back: number[][] = [];
  for (let i = 1; i < n; i++) {
    const cur = candidates[i]!;
    const prevCand = candidates[i - 1]!;
    const curBest = new Array<number>(cur.length).fill(Infinity);
    const curBack = new Array<number>(cur.length).fill(-1);
    for (let j = 0; j < cur.length; j++) {
      let best = Infinity;
      let bestK = -1;
      for (let k = 0; k < prevCand.length; k++) {
        const c = prevBest[k]! + edgeCost(prevCand[k]!, cur[j]!, i);
        if (c < best) { best = c; bestK = k; }
      }
      curBest[j] = nodeCost(cur[j]!, i) + best;
      curBack[j] = bestK;
    }
    back.push(curBack);
    prevBest = curBest;
  }

  let j = 0;
  for (let k = 1; k < prevBest.length; k++) if (prevBest[k]! < prevBest[j]!) j = k;
  const total = prevBest[j]!;
  const path = new Array<T>(n);
  for (let i = n - 1; i >= 0; i--) {
    path[i] = candidates[i]![j]!;
    if (i > 0) j = back[i - 1]![j]!;
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
  chords: GuitarSongChord[];
  totalMove: number;
  truncated: boolean;
}

function guitarTransition(a: Fingering, b: Fingering): { cost: number; held: number[] } {
  let cost = 0;
  const held: number[] = [];
  let aMin = Infinity;
  let bMin = Infinity;
  for (let s = 0; s < a.frets.length; s++) {
    const fa = a.frets[s]!;
    const fb = b.frets[s]!;
    if (fa !== null && fb !== null) {
      if (fa === fb) held.push(s);
      cost += Math.abs(fa - fb);
    } else if (fa !== null || fb !== null) {
      cost += MUTE_CHANGE;
    }
    if (fa !== null && fa > 0) aMin = Math.min(aMin, fa);
    if (fb !== null && fb > 0) bMin = Math.min(bMin, fb);
  }
  if (aMin !== Infinity && bMin !== Infinity) cost += POSITION_WEIGHT * Math.abs(aMin - bMin);
  return { cost, held };
}

function guitarNodeCost(chord: ParsedChord, f: Fingering, tuning: number[]): number {
  if (chord.bass === null) return 0;
  for (let s = 0; s < f.frets.length; s++) {
    const fr = f.frets[s];
    if (fr !== null) {
      return ((tuning[s]! + fr) % SEMITONES) === chord.bass ? 0 : BASS_PENALTY;
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
): GuitarSongPlan | null {
  const budget = Math.max(1, Math.min(cap, SONG_CAP));
  let truncated = false;
  const candidates = progression.map((c) => {
    const r = findFingerings(c.pcs, tuning, maxFrets, span, budget);
    if (r.truncated) truncated = true;
    return r.fingerings;
  });
  if (candidates.some((c) => c.length === 0)) return null;

  const path = bestPath(
    candidates,
    (f, i) => guitarNodeCost(progression[i]!, f, tuning),
    (a, b) => guitarTransition(a, b).cost,
  );
  if (!path) return null;

  const chords: GuitarSongChord[] = [];
  let totalMove = 0;
  for (let i = 0; i < path.path.length; i++) {
    const f = path.path[i]!;
    const prev = i > 0 ? path.path[i - 1]! : null;
    const t = prev ? guitarTransition(prev, f) : { cost: 0, held: [] };
    if (i > 0) totalMove += t.cost;
    chords.push({
      chord: progression[i]!,
      fingering: f,
      held: t.held,
      move: t.cost,
      bassMatches: guitarNodeCost(progression[i]!, f, tuning) === 0,
    });
  }
  return { chords, totalMove, truncated };
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
  chords: PianoSongChord[];
  totalMove: number;
  truncated: boolean;
}

function pianoTransition(a: number[], b: number[]): { cost: number; held: number[] } {
  const as = [...a].sort((x, y) => x - y);
  const bs = [...b].sort((x, y) => x - y);
  const held: number[] = [];
  let cost = 0;
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(as[i]! - bs[i]!);
    if (d === 0) held.push(as[i]!);
    cost += d;
  }
  cost += EXTRA_KEY_PENALTY * Math.abs(as.length - bs.length);
  return { cost, held };
}

function pianoNodeCost(chord: ParsedChord, keys: number[]): number {
  if (chord.bass === null) return 0;
  const lo = Math.min(...keys);
  return ((lo % SEMITONES) + SEMITONES) % SEMITONES === chord.bass ? 0 : BASS_PENALTY;
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
  const candidates = progression.map((c) => {
    const r = findPianoVoicings(c.pcs, low, high, reach, budget);
    if (r.truncated) truncated = true;
    return r.voicings;
  });
  if (candidates.some((c) => c.length === 0)) return null;

  const path = bestPath(
    candidates,
    (v, i) => pianoNodeCost(progression[i]!, v.keys),
    (a, b) => pianoTransition(a.keys, b.keys).cost,
  );
  if (!path) return null;

  const chords: PianoSongChord[] = [];
  let totalMove = 0;
  for (let i = 0; i < path.path.length; i++) {
    const v = path.path[i]!;
    const prev = i > 0 ? path.path[i - 1]! : null;
    const t = prev ? pianoTransition(prev.keys, v.keys) : { cost: 0, held: [] };
    totalMove += t.cost;
    chords.push({
      chord: progression[i]!,
      voicing: v,
      held: t.held,
      move: t.cost,
      bassMatches: pianoNodeCost(progression[i]!, v.keys) === 0,
    });
  }
  return { chords, totalMove, truncated };
}

/** Human-readable fallback names for the plan's chord display. */
export function planChordLabel(c: ParsedChord): string {
  const named = chordName(c.pcs);
  return c.name === named.primary ? named.primary : `${c.name}  (${named.primary})`;
}