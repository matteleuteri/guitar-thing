import { SEMITONES } from "./theory.js";

export interface Position {
  string: number; // 0 = lowest (thickest) string
  fret: number;   // 0 = open
  pc: number;
}

export function findPositions(pcs: number[], tuning: number[], maxFrets: number): Position[] {
  const targets = new Set(pcs);
  const out: Position[] = [];
  for (let s = 0; s < tuning.length; s++) {
    for (let f = 0; f <= maxFrets; f++) {
      const pc = (tuning[s]! + f) % SEMITONES;
      if (targets.has(pc)) out.push({ string: s, fret: f, pc });
    }
  }
  return out;
}

export interface Fingering {
  frets: (number | null)[]; // per string, low -> high; null = muted
}

export interface FingeringResult {
  fingerings: Fingering[];
  truncated: boolean;
}

interface Option {
  fret: number | null;
  pc: number | null;
}

/**
 * Every way to voice `chordPcs` on the guitar such that:
 *  - each sounding string plays a chord note (muted strings allowed),
 *  - every chord note is sounded at least once,
 *  - at least 2 strings sound,
 *  - all sounded frets lie within a `span`-fret window (open strings are fret 0).
 */
export function findFingerings(
  chordPcs: number[],
  tuning: number[],
  maxFrets: number,
  span: number,
  cap: number,
): FingeringResult {
  const target = [...new Set(chordPcs)].sort((a, b) => a - b);
  if (target.length < 2) return { fingerings: [], truncated: false };
  const targetSet = new Set(target);
  const tlen = target.length;

  const out: Fingering[] = [];
  let truncated = false;
  const pcAt = (s: number, f: number) => (tuning[s]! + f) % SEMITONES;
  const nStrings = tuning.length;
  const maxAnchor = Math.max(0, maxFrets - span);
  const minSound = 2;

  for (let anchor = 0; anchor <= maxAnchor && !truncated; anchor++) {
    const opts: Option[][] = tuning.map((_open, s) => {
      const list: Option[] = [{ fret: null, pc: null }];
      for (let f = anchor; f <= anchor + span; f++) {
        const pc = pcAt(s, f);
        if (targetSet.has(pc)) list.push({ fret: f, pc });
      }
      return list;
    });

    const suffixUnion: Set<number>[] = new Array(nStrings);
    for (let s = nStrings - 1; s >= 0; s--) {
      const set = new Set<number>();
      const next = s + 1 < nStrings ? suffixUnion[s + 1] : null;
      if (next) for (const x of next) set.add(x);
      for (const o of opts[s]!) if (o.pc !== null) set.add(o.pc);
      suffixUnion[s] = set;
    }

    const chosen: Option[] = new Array(nStrings);
    const covered: number[] = [];

    const rec = (s: number, hasAnchor: boolean, count: number) => {
      if (truncated) return;
      if (s === nStrings) {
        if (hasAnchor && count >= minSound && covered.length === tlen) {
          out.push({ frets: chosen.map((c) => c.fret) });
          if (out.length >= cap) truncated = true;
        }
        return;
      }
      if (count + (nStrings - s) < minSound) return;

      const missing = tlen - covered.length;
      if (missing > 0) {
        let coverable = covered.length;
        for (const pc of suffixUnion[s]!) {
          if (covered.indexOf(pc) === -1) coverable++;
        }
        if (coverable < tlen) return;
      }

      for (const o of opts[s]!) {
        chosen[s] = o;
        const added = o.pc !== null && covered.indexOf(o.pc) === -1;
        if (o.pc !== null && added) covered.push(o.pc);
        rec(s + 1, hasAnchor || o.fret === anchor, count + (o.fret !== null ? 1 : 0));
        if (added) covered.pop();
      }
    };

    rec(0, false, 0);
  }

  return { fingerings: out, truncated };
}