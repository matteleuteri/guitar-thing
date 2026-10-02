/**
 * Timeline geometry, as pure functions of beats.
 *
 * Everything horizontal in the riff timeline is a FRACTION OF THE TRACK, and
 * this module is the single place that says so. It is deliberately free of DOM
 * and of pixel sizes: the two bugs that made the playhead drift were both a
 * fraction being converted back into a count-and-multiply (`round(beat /
 * step)` columns, `cols * --riff-step` px) somewhere downstream of the maths,
 * and a pure module is where that cannot happen silently — `tests/timeline.test.mjs`
 * asserts the properties directly, in Node, with no browser and no pixels.
 *
 * The invariant these exist to protect: a note, a bar mark, the loop region and
 * the playhead at the SAME beat resolve to the SAME fraction. A note at
 * `left: 0%` and a playhead at beat 0 must land on the same pixel, and so must
 * a note at beat 14 and a playhead passing beat 14.
 *
 * Lead-in: the track can open with empty beats BEFORE beat 0 (the riff page
 * plays a one-beat pause). The timeline then spans [-leadIn, totalBeats], so
 * beat 0 sits one lead-in's width in from the left edge and a playhead in the
 * pause sweeps from 0 up to it. Every position takes the same lead-in, which
 * is the whole point: the invariant above is untouched, just shifted.
 */

/** Empty beats the riff page shows (and plays) before the music starts. */
export const LEAD_IN_BEATS = 1;

/** Column count: one column per step, rounded UP so the last event is never clipped. */
export function stepColumns(totalBeats: number, stepBeats: number): number {
  if (!(stepBeats > 0)) return 1;
  return Math.max(1, Math.ceil(totalBeats / stepBeats));
}

/**
 * A note's `left` offset, as a percentage of the track width. Its EXACT beat,
 * clamped like every other position — a beat outside the piece would otherwise
 * render a note outside the track, which is invisible rather than wrong.
 */
export function noteLeftPercent(beat: number, totalBeats: number, leadInBeats = 0): number {
  return trackFraction(beat, totalBeats, leadInBeats) * 100;
}

/**
 * A playhead (or loop edge) position as a fraction of the track, clamped to
 * [0, 1]. The clamp is what the CSS gets: a playhead that has run past the end
 * pins to the right edge instead of sliding out of the box, and one still in
 * the lead-in (a negative beat, before the music's beat 0) pins to the left.
 */
export function trackFraction(beat: number, totalBeats: number, leadInBeats = 0): number {
  const span = totalBeats + leadInBeats;
  if (!(span > 0)) return 0;
  return Math.max(0, Math.min(1, (beat + leadInBeats) / span));
}

/** A bar mark's position as a fraction of the track. Bar 0 starts the piece. */
export function barMarkFraction(bar: number, beatsPerBar: number, totalBeats: number, leadInBeats = 0): number {
  return trackFraction(bar * beatsPerBar, totalBeats, leadInBeats);
}

/**
 * Inverse of trackFraction: which beat sits at a fraction of the track, for
 * turning a mouse x into a drop target. NOT clamped — a cursor past either
 * end reports a beat outside the piece, which the caller clamps to its own
 * valid range (it knows the range; this function does not).
 */
export function beatAtFraction(fraction: number, totalBeats: number, leadInBeats = 0): number {
  return fraction * (totalBeats + leadInBeats) - leadInBeats;
}

/** Fractional share of one step column, for tests and for the gridline period. */
export function gridlinePeriodFraction(stepBeats: number, totalBeats: number): number {
  const cols = stepColumns(totalBeats, stepBeats);
  return 1 / cols;
}
