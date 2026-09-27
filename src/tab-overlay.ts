import type { Riff } from "./riff.js";

/**
 * Build a lane map from a parsed riff: one entry per string, an array indexed by
 * step column. Chord events place every note on its own string row at the chord's
 * bar line; tab events place each note at its own step column. A tab note
 * overrides a chord note on the same string — the explicit escape hatch wins.
 *
 * Extracted from the riff page so the overlay is testable without a browser.
 */
export function buildOverlay(riff: Riff): Map<number, (number | "x" | null)[]> {
  const lanes = new Map<number, (number | "x" | null)[]>();
  const ensure = (s: number, col: number): (number | "x" | null)[] => {
    const existing = lanes.get(s) ?? [];
    while (existing.length <= col) existing.push(null);
    lanes.set(s, existing);
    return existing;
  };
  for (const event of riff.events) {
    if (event.kind === "chord") {
      const col = Math.round(event.beat / riff.stepBeats);
      for (const note of event.notes) ensure(note.stringIndex, col)[col] = note.fret;
    } else if (event.kind === "note") {
      const col = Math.round(event.beat / riff.stepBeats);
      for (const note of event.notes) ensure(note.stringIndex, col)[col] = note.fret;
    }
  }
  return lanes;
}
