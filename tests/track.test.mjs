/**
 * Track regions: where each event's region ends.
 *
 * The track renders every event as a DAW-style region — left edge at its
 * beat, width = its span — and the span rule is the only non-DOM logic in
 * it: the model has no durations, so a region runs until the next event OF
 * THE SAME KIND. If that rule silently changed (say, to "until the next
 * event of ANY kind"), every chord under a melody would shrink to a sliver
 * and the track would still look plausible at a glance — so it is asserted
 * here, in Node, with no browser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseRiff } from "../dist/riff.js";
import { regionEnds } from "../dist/track.js";

const TUNING = [40, 45, 50, 55, 59, 64];
const riffOpts = {
  pins: [], beatsPerBar: 4, stepBeats: 0.5, span: 5, cap: 400,
  defaultStrumMs: 55, tuning: TUNING, maxFrets: 24,
};

/** Events + their region ends, looked up by (beat, kind). */
function spans(text) {
  const riff = parseRiff(text, riffOpts);
  const ends = regionEnds(riff.events, riff.totalBeats);
  return {
    totalBeats: riff.totalBeats,
    end: (beat, kind) => {
      const index = riff.events.findIndex((e) => e.beat === beat && e.kind === kind);
      assert.notEqual(index, -1, `no ${kind} event at beat ${beat}`);
      return ends[index];
    },
  };
}

test("a chord's region ends at the next chord; the last runs to the end of the piece", () => {
  const s = spans("tempo 96\nC Am F G");
  assert.equal(s.end(0, "chord"), 4, "C spans its whole bar");
  assert.equal(s.end(4, "chord"), 8);
  assert.equal(s.end(8, "chord"), 12);
  assert.equal(s.end(12, "chord"), s.totalBeats, "G rings out to the end");
});

test("a tab note's region ends at the next tab note, ringing through rests", () => {
  // Notes at columns 0 and 4 of an eighth-note grid = beats 0 and 2.
  const s = spans("tempo 96\ne|5---7---|");
  assert.equal(s.end(0, "note"), 2);
  assert.equal(s.end(2, "note"), s.totalBeats, "the last note rings out");
});

test("a lone tab note rings one full bar, not to the end of the piece", () => {
  // Tab note at column 0 = beat 0; the lane covers 20 columns (10 beats).
  // Its region used to bleed to beat 10; now caps at the same OFFBEAT-EVEN
  // bar boundary — the empty-bar clamp from `regionEnds` is what enforces it.
  const s = spans("tempo 96\ne|5-------------------|");
  assert.equal(s.end(0, "note"), 4, "the note spans one 4-beat bar from beat 0");
});

test("a chord and a tab note on the same beat keep their own spans", () => {
  // The union case: C (beat 0) plays with a tab note on top (beat 0). The
  // chord must NOT be cut short by the melody notes above it.
  const s = spans("tempo 96\nC Am F G\ne|5---7---|");
  assert.equal(s.end(0, "chord"), 4, "the chord still spans its bar");
  assert.equal(s.end(0, "note"), 2, "the note spans to the next note");
});

test("degenerate inputs still give an end per event", () => {
  assert.deepEqual(regionEnds([], 16), []);
  const s = spans("tempo 96\nC");
  assert.equal(s.end(0, "chord"), s.totalBeats, "a lone chord rings to the end");
});
