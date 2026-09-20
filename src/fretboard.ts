import { SEMITONES } from "./theory.js";

export interface Position {
  stringIndex: number; // 0 = lowest (thickest) string
  fret: number;       // 0 = open
  pitchClass: number;
}

/** Every `{stringIndex, fret, pitchClass}` on frets 0..maxFrets whose pitch class is a target. */
export function findPositions(pitchClasses: number[], tuning: number[], maxFrets: number): Position[] {
  const targets = new Set(pitchClasses);
  const found: Position[] = [];
  for (let stringIndex = 0; stringIndex < tuning.length; stringIndex++) {
    for (let fret = 0; fret <= maxFrets; fret++) {
      const pitchClass = (tuning[stringIndex] + fret) % SEMITONES;
      if (targets.has(pitchClass)) found.push({ stringIndex, fret, pitchClass });
    }
  }
  return found;
}

export interface Fingering {
  frets: (number | null)[]; // per string, low -> high; null = muted
}

export interface FingeringResult {
  fingerings: Fingering[];
  truncated: boolean;
}

interface StringOption {
  fret: number | null;
  pitchClass: number | null;
}

/**
 * Every way to voice `chordPitchClasses` on the guitar such that:
 *  - each sounding string plays a chord note (muted strings allowed),
 *  - every chord note is sounded at least once,
 *  - at least 2 strings sound,
 *  - all sounded frets lie within a `span`-fret window (open strings are fret 0).
 */
export function findFingerings(
  chordPitchClasses: number[],
  tuning: number[],
  maxFrets: number,
  span: number,
  cap: number,
): FingeringResult {
  const target = [...new Set(chordPitchClasses)].sort((a, b) => a - b);
  if (target.length < 2) return { fingerings: [], truncated: false };
  const targetSet = new Set(target);
  const targetLength = target.length;

  const fingerings: Fingering[] = [];
  let truncated = false;
  const pitchClassAt = (stringIndex: number, fret: number) => (tuning[stringIndex] + fret) % SEMITONES;
  const stringCount = tuning.length;
  const maxAnchor = Math.max(0, maxFrets - span);
  const minSounding = 2;

  for (let anchor = 0; anchor <= maxAnchor && !truncated; anchor++) {
    const stringOptions: StringOption[][] = tuning.map((_open, stringIndex) => {
      const list: StringOption[] = [{ fret: null, pitchClass: null }];
      for (let fret = anchor; fret <= anchor + span; fret++) {
        const pitchClass = pitchClassAt(stringIndex, fret);
        if (targetSet.has(pitchClass)) list.push({ fret, pitchClass });
      }
      return list;
    });

    // For each string, the pitch classes still available on this string and
    // every string above it — used to prune branches that can't cover the
    // remaining target notes.
    const suffixPitchClasses: Set<number>[] = new Array(stringCount);
    for (let stringIndex = stringCount - 1; stringIndex >= 0; stringIndex--) {
      const set = new Set<number>();
      const next = stringIndex + 1 < stringCount ? suffixPitchClasses[stringIndex + 1] : null;
      if (next) for (const pitchClass of next) set.add(pitchClass);
      for (const option of stringOptions[stringIndex]) {
        if (option.pitchClass !== null) set.add(option.pitchClass);
      }
      suffixPitchClasses[stringIndex] = set;
    }

    const selected: StringOption[] = new Array(stringCount);
    const coveredPitchClasses: number[] = [];

    const enumerate = (stringIndex: number, hasAnchor: boolean, sounded: number) => {
      if (truncated) return;
      if (stringIndex === stringCount) {
        if (hasAnchor && sounded >= minSounding && coveredPitchClasses.length === targetLength) {
          fingerings.push({ frets: selected.map((option) => option.fret) });
          if (fingerings.length >= cap) truncated = true;
        }
        return;
      }
      if (sounded + (stringCount - stringIndex) < minSounding) return;

      const missing = targetLength - coveredPitchClasses.length;
      if (missing > 0) {
        let coverable = coveredPitchClasses.length;
        for (const pitchClass of suffixPitchClasses[stringIndex]) {
          if (coveredPitchClasses.indexOf(pitchClass) === -1) coverable++;
        }
        if (coverable < targetLength) return;
      }

      for (const option of stringOptions[stringIndex]) {
        selected[stringIndex] = option;
        if (option.pitchClass !== null) {
          const isNew = coveredPitchClasses.indexOf(option.pitchClass) === -1;
          if (isNew) coveredPitchClasses.push(option.pitchClass);
          enumerate(
            stringIndex + 1,
            hasAnchor || option.fret === anchor,
            sounded + (option.fret !== null ? 1 : 0),
          );
          if (isNew) coveredPitchClasses.pop();
        } else {
          enumerate(stringIndex + 1, hasAnchor, sounded);
        }
      }
    };

    enumerate(0, false, 0);
  }

  return { fingerings, truncated };
}