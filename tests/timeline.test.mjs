/**
 * Timeline geometry — the invariant the playhead bug lived in.
 *
 * Everything horizontal in the riff timeline is a fraction of the track, so a
 * note, a bar mark, the loop region and the playhead at the SAME beat must
 * resolve to the SAME number. That is a pure-arithmetic property, and it is
 * asserted here rather than in a browser because the two times it broke, it
 * broke silently in a browser: once a fraction was turned back into a
 * count-and-multiply, and once a chord was snapped to a rounded column. Neither
 * threw, and both looked plausible at a glance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  barMarkFraction,
  gridlinePeriodFraction,
  noteLeftPercent,
  stepColumns,
  trackFraction,
} from "../dist/timeline.js";

test("a note and the playhead agree at the same beat, for every beat", () => {
  const totalBeats = 16;
  for (let beat = 0; beat <= totalBeats; beat += 0.125) {
    assert.equal(
      noteLeftPercent(beat, totalBeats),
      trackFraction(beat, totalBeats) * 100,
      `note and playhead disagree at beat ${beat}`,
    );
  }
});

test("a bar mark sits exactly where the playhead sits at that bar's downbeat", () => {
  const totalBeats = 16;
  const beatsPerBar = 4;
  for (let bar = 0; bar * beatsPerBar < totalBeats; bar++) {
    assert.equal(
      barMarkFraction(bar, beatsPerBar, totalBeats),
      trackFraction(bar * beatsPerBar, totalBeats),
      `bar ${bar + 1} mark is not at its own downbeat`,
    );
  }
});

test("a note keeps its exact beat even when the bar line is off the step grid", () => {
  // `bar 5` with `step 0.75`: a chord lands on the bar line, which is only
  // on-grid when beatsPerBar / step is a whole number. Snapping to the nearest
  // column put it 15px from where the playhead crosses.
  const totalBeats = 20;
  const beatsPerBar = 4;
  const stepBeats = 0.75;
  const chordBeat = 4 * beatsPerBar; // bar 5
  assert.equal(stepColumns(totalBeats, stepBeats), 27);
  assert.equal(noteLeftPercent(chordBeat, totalBeats), 80);
  // The snapped column would have been round(16 / 0.75) = 21 -> 21/27 = 77.8%.
  assert.notEqual(Math.round(chordBeat / stepBeats) / stepColumns(totalBeats, stepBeats) * 100,
    noteLeftPercent(chordBeat, totalBeats));
});

test("the timeline starts at the left edge and ends at the right edge", () => {
  assert.equal(trackFraction(0, 16), 0);
  assert.equal(trackFraction(16, 16), 1);
  assert.equal(noteLeftPercent(0, 16), 0);
  assert.equal(noteLeftPercent(16, 16), 100);
});

test("position is clamped, so a playhead pins to an edge instead of leaving the box", () => {
  assert.equal(trackFraction(-2.5, 16), 0, "a lead-in before beat 0 pins left");
  assert.equal(trackFraction(99, 16), 1, "running past the end pins right");
  assert.equal(noteLeftPercent(-1, 16), 0);
});

test("a lead-in puts empty beats before beat 0, and everything shifts together", () => {
  // The riff page opens the track with a one-beat pause: the timeline spans
  // [-leadIn, total], so beat 0 sits one lead-in's width in and the pause
  // sweeps [0, that width) before the first event.
  const total = 16;
  const lead = 1;
  assert.equal(trackFraction(-lead, total, lead), 0, "the pause starts at the left edge");
  assert.equal(trackFraction(0, total, lead), 1 / 17, "beat 0 sits one beat in");
  assert.equal(trackFraction(-0.5, total, lead), 0.5 / 17, "a playhead mid-pause is mid-gap");
  assert.equal(trackFraction(total, total, lead), 1, "the end still pins right");
  assert.equal(trackFraction(-99, total, lead), 0, "before the pause still pins left");
  // The invariant survives the shift: same beat = same fraction, everywhere.
  assert.equal(noteLeftPercent(0, total, lead), trackFraction(0, total, lead) * 100);
  assert.equal(barMarkFraction(0, 4, total, lead), trackFraction(0, total, lead));
  assert.equal(barMarkFraction(3, 4, total, lead), trackFraction(12, total, lead));
  // No lead-in by default: beat 0 is the left edge, exactly as before.
  assert.equal(trackFraction(0, total), 0);
});

test("position increases monotonically with the beat", () => {
  let previous = -Infinity;
  for (let beat = 0; beat <= 16; beat += 0.0625) {
    const value = trackFraction(beat, 16);
    assert.ok(value > previous, `position went backwards at beat ${beat}`);
    previous = value;
  }
});

test("the column count rounds up, so the last event is never clipped", () => {
  assert.equal(stepColumns(16, 0.5), 32);
  assert.equal(stepColumns(16, 1), 16);
  // 16 / 0.75 = 21.33 -> 22 columns, otherwise the final column is cut off.
  assert.equal(stepColumns(16, 0.75), 22);
  assert.ok(stepColumns(10.5, 1) >= 11);
});

test("the gridline period is exactly one column of the track", () => {
  const totalBeats = 16;
  const stepBeats = 0.5;
  const cols = stepColumns(totalBeats, stepBeats);
  assert.equal(gridlinePeriodFraction(stepBeats, totalBeats), 1 / cols);
  // The period is a share of the TRACK, so `cols` of them fill it exactly.
  assert.equal(gridlinePeriodFraction(stepBeats, totalBeats) * cols, 1);
});

test("degenerate inputs give a position, not NaN", () => {
  // An empty piece still renders; a NaN here would land as `left: NaN%` and
  // silently drop every note, which is exactly how the canvas bug presented.
  assert.equal(trackFraction(0, 0), 0);
  assert.equal(noteLeftPercent(4, 0), 0);
  assert.equal(barMarkFraction(0, 4, 0), 0);
  assert.equal(stepColumns(0, 0.5), 1);
  for (const value of [trackFraction(4, 0), noteLeftPercent(4, 0), gridlinePeriodFraction(0.5, 0)]) {
    assert.ok(Number.isFinite(value), `got ${value}`);
  }
});
