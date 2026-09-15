import { SEMITONES } from "./theory.js";

/**
 * Piano mode is the linear analogue of the guitar:
 *  - any body row maps every input note to a set of keys (same pitch class),
 *  - a "voicing" is a set of pressed keys within `reach` semitones of each
 *    other, covering every provided note, like a chord shape within `span`
 *    frets on the fretboard.
 */

export function findPianoKeys(pcs: number[], low: number, high: number): number[] {
  const targets = new Set(pcs);
  const out: number[] = [];
  for (let m = low; m <= high; m++) {
    if (targets.has(((m % SEMITONES) + SEMITONES) % SEMITONES)) out.push(m);
  }
  return out;
}

export interface PianoVoicing {
  keys: number[]; // ascending MIDI note numbers
}

export interface PianoVoicingResult {
  voicings: PianoVoicing[];
  truncated: boolean;
}

const MAX_KEYS = 10; // two hands
const NODE_BUDGET = 500_000;

/**
 * Every set of keys in `low..high` such that:
 *  - every chord note is sounded at least once,
 *  - at least 2 keys are pressed, at most `MAX_KEYS`,
 *  - all keys lie within `reach` semitones.
 *
 * Voicings are anchored at their lowest key (guarantees unique subsets across
 * windows). Windows wider than 11 semitones can contain a pitch class twice
 * (duplicate octaves), so coverage tracks distinct pitch classes explicitly.
 */
export function findPianoVoicings(
  pcs: number[],
  low: number,
  high: number,
  reach: number,
  cap: number,
): PianoVoicingResult {
  const target = [...new Set(pcs)].sort((a, b) => a - b);
  const tlen = target.length;
  if (tlen < 2) return { voicings: [], truncated: false };
  if (tlen > MAX_KEYS) return { voicings: [], truncated: false };
  const tset = new Set(target);

  const out: PianoVoicing[] = [];
  let truncated = false;
  let nodes = 0;
  const maxAnchor = high - reach;

  for (let anchor = low; anchor <= maxAnchor && !truncated; anchor++) {
    const inWin: number[] = [];
    for (let k = anchor; k <= anchor + reach; k++) {
      if (tset.has(((k % SEMITONES) + SEMITONES) % SEMITONES)) inWin.push(k);
    }
    if (inWin.length < tlen) continue;

    const n = inWin.length;
    const suffixUnion: Set<number>[] = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      const set = new Set<number>();
      const next = i + 1 < n ? suffixUnion[i + 1] : null;
      if (next) for (const x of next) set.add(x);
      set.add(((inWin[i]! % SEMITONES) + SEMITONES) % SEMITONES);
      suffixUnion[i] = set;
    }

    const chosen: number[] = [];
    const covered: number[] = [];
    const rec = (i: number) => {
      if (truncated) return;
      if (++nodes > NODE_BUDGET) { truncated = true; return; }

      if (i === n) {
        if (covered.length === tlen && chosen.length >= 2 && chosen[0] === anchor) {
          out.push({ keys: [...chosen] });
          if (out.length >= cap) { truncated = true; return; }
        }
        return;
      }

      const needed = tlen - covered.length;
      if (needed > 0) {
        let avail = 0;
        for (const pc of suffixUnion[i]!) if (covered.indexOf(pc) === -1) avail++;
        if (avail < needed) return;
      }

      const key = inWin[i]!;
      const pc = ((key % SEMITONES) + SEMITONES) % SEMITONES;
      chosen.push(key);
      const added = covered.indexOf(pc) === -1;
      if (added) covered.push(pc);
      if (chosen.length <= MAX_KEYS) rec(i + 1);
      chosen.pop();
      if (added) covered.pop();
      if (truncated) return;
      rec(i + 1);
    };
    rec(0);
  }

  return { voicings: out, truncated };
}