import { SEMITONES } from "./theory.js";

/**
 * Piano mode is the linear analogue of the guitar:
 *  - any body row maps every input note to a set of keys (same pitch class),
 *  - a "voicing" is a set of pressed keys within `reach` semitones of each
 *    other, covering every provided note, like a chord shape within `span`
 *    frets on the fretboard.
 */

/** Every MIDI key in `low..high` whose pitch class matches a target. */
export function findPianoKeys(pitchClasses: number[], low: number, high: number): number[] {
  const targets = new Set(pitchClasses);
  const found: number[] = [];
  for (let midi = low; midi <= high; midi++) {
    if (targets.has(((midi % SEMITONES) + SEMITONES) % SEMITONES)) found.push(midi);
  }
  return found;
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
 * Every set of keys in `lowKey..highKey` such that:
 *  - every chord note is sounded at least once,
 *  - at least 2 keys are pressed, at most `MAX_KEYS`,
 *  - all keys lie within `reach` semitones.
 *
 * Voicings are anchored at their lowest key (guarantees unique subsets across
 * windows). Windows wider than 11 semitones can contain a pitch class twice
 * (duplicate octaves), so coverage tracks distinct pitch classes explicitly.
 */
export function findPianoVoicings(
  pitchClasses: number[],
  lowKey: number,
  highKey: number,
  reach: number,
  cap: number,
): PianoVoicingResult {
  const target = [...new Set(pitchClasses)].sort((a, b) => a - b);
  const targetLength = target.length;
  if (targetLength < 2) return { voicings: [], truncated: false };
  if (targetLength > MAX_KEYS) return { voicings: [], truncated: false };
  const targetSet = new Set(target);

  const voicings: PianoVoicing[] = [];
  let truncated = false;
  let nodes = 0;
  const maxAnchor = highKey - reach;

  for (let anchor = lowKey; anchor <= maxAnchor && !truncated; anchor++) {
    const keysInWindow: number[] = [];
    for (let midi = anchor; midi <= anchor + reach; midi++) {
      if (targetSet.has(((midi % SEMITONES) + SEMITONES) % SEMITONES)) keysInWindow.push(midi);
    }
    if (keysInWindow.length < targetLength) continue;

    const count = keysInWindow.length;
    // For each key, the pitch classes still available from this key onward —
    // used to prune branches that can't cover the remaining target notes.
    const suffixPitchClasses: Set<number>[] = new Array(count);
    for (let i = count - 1; i >= 0; i--) {
      const set = new Set<number>();
      const next = i + 1 < count ? suffixPitchClasses[i + 1] : null;
      if (next) for (const pitchClass of next) set.add(pitchClass);
      set.add(((keysInWindow[i] % SEMITONES) + SEMITONES) % SEMITONES);
      suffixPitchClasses[i] = set;
    }

    const selectedKeys: number[] = [];
    const coveredPitchClasses: number[] = [];
    const enumerate = (i: number) => {
      if (truncated) return;
      if (++nodes > NODE_BUDGET) { truncated = true; return; }

      if (i === count) {
        if (coveredPitchClasses.length === targetLength && selectedKeys.length >= 2 && selectedKeys[0] === anchor) {
          voicings.push({ keys: [...selectedKeys] });
          if (voicings.length >= cap) { truncated = true; return; }
        }
        return;
      }

      const needed = targetLength - coveredPitchClasses.length;
      if (needed > 0) {
        let available = 0;
        for (const pitchClass of suffixPitchClasses[i]) {
          if (coveredPitchClasses.indexOf(pitchClass) === -1) available++;
        }
        if (available < needed) return;
      }

      const key = keysInWindow[i];
      const pitchClass = ((key % SEMITONES) + SEMITONES) % SEMITONES;
      selectedKeys.push(key);
      const newlyCovered = coveredPitchClasses.indexOf(pitchClass) === -1;
      if (newlyCovered) coveredPitchClasses.push(pitchClass);
      if (selectedKeys.length <= MAX_KEYS) enumerate(i + 1);
      selectedKeys.pop();
      if (newlyCovered) coveredPitchClasses.pop();
      if (truncated) return;
      enumerate(i + 1);
    };
    enumerate(0);
  }

  return { voicings, truncated };
}