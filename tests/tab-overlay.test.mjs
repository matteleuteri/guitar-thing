/**
 * The tab overlay: how chord events and tab events combine into one grid.
 *
 * This is the layer that decides which string shows which fret at which column,
 * and it is the most bug-prone part of the riff builder — a chord is auto-voiced
 * by a DP that knows nothing about the tab lanes, so the two can disagree on the
 * same string. The tab note must win (it is the explicit escape hatch).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseRiff } from "../dist/riff.js";
import { buildOverlay } from "../dist/tab-overlay.js";

const OPTS = {
  pins: [], beatsPerBar: 4, stepBeats: 0.5, span: 5, cap: 400,
  defaultStrumMs: 55, tuning: [40, 45, 50, 55, 59, 64], maxFrets: 24,
};
const parse = (text) => parseRiff(text, OPTS);

/** Fret at (string, column) from the overlay, or null (rest). */
function at(lanes, stringIndex, col) {
  const lane = lanes.get(stringIndex);
  if (!lane || col >= lane.length) return null;
  const v = lane[col];
  return v === "x" ? "x" : (v ?? null);
}

test("a chord's notes land on their own string rows at the bar line", () => {
  const riff = parse("tempo 120\nbar 4\n  C\n");
  const lanes = buildOverlay(riff);
  const chord = riff.events.find((e) => e.kind === "chord");
  // Every note in the chord sits at column 0 (the bar line), on its own string.
  for (const note of chord.notes) {
    assert.equal(at(lanes, note.stringIndex, 0), note.fret, `string ${note.stringIndex} lost its chord note`);
  }
  // No string has a note at a later column — a chord is one strum, not a run.
  for (const lane of lanes.values()) {
    for (let c = 1; c < lane.length; c++) {
      assert.equal(lane[c], null, `a chord note leaked into column ${c}`);
    }
  }
});

test("a chord's notes spread across different strings, not stacked on one", () => {
  const riff = parse("tempo 120\nbar 4\n  C  Am  F  G\n");
  const lanes = buildOverlay(riff);
  const strings = [...lanes.keys()];
  assert.ok(strings.length >= 3, `a C chord uses ${strings.length} strings — expected at least 3`);
});

test("tab notes land at their own step columns", () => {
  const riff = parse("tempo 120\nbar 4\ne|0-0-0-0-|\nB|--------|");
  const lanes = buildOverlay(riff);
  // High e (string 5) has notes at columns 0, 2, 4, 6.
  assert.equal(at(lanes, 5, 0), 0);
  assert.equal(at(lanes, 5, 2), 0);
  assert.equal(at(lanes, 5, 4), 0);
  assert.equal(at(lanes, 5, 6), 0);
  assert.equal(at(lanes, 5, 1), null, "a rest column became a note");
});

test("a tab note overrides a chord note on the same string", () => {
  // C is auto-voiced; the tab puts fret 5 on the high e string. The tab wins.
  const riff = parse("tempo 120\nbar 4\n  C\ne|5-------|\nB|--------|");
  const lanes = buildOverlay(riff);
  // High e (string 5) should show the tab's fret 5, not the chord's voicing.
  assert.equal(at(lanes, 5, 0), 5, "the tab note did not override the chord on the high e string");
});

test("a chord note survives on a string the tab does not touch", () => {
  const riff = parse("tempo 120\nbar 4\n  C\ne|5-------|\nB|--------|");
  const lanes = buildOverlay(riff);
  const chord = riff.events.find((e) => e.kind === "chord");
  for (const note of chord.notes) {
    if (note.stringIndex === 5) continue; // overridden by the tab
    assert.equal(at(lanes, note.stringIndex, 0), note.fret, `string ${note.stringIndex} lost its chord note`);
  }
});

test("a multi-digit fret occupies two columns in the overlay", () => {
  // Both lanes are exactly 8 columns: --10---- (8) and -------- (8).
  const riff = parse("tempo 120\nbar 4\ne|--10----|\nB|--------|");
  const lanes = buildOverlay(riff);
  // The 10 is at columns 2-3; column 3 must not become a separate note.
  assert.equal(at(lanes, 5, 2), 10);
  assert.equal(at(lanes, 5, 3), null, "the second digit of a two-digit fret became a note");
});

test("two chords land on different bar lines", () => {
  const riff = parse("tempo 120\nbar 4\n  C       F\n");
  const lanes = buildOverlay(riff);
  // Bar 1 chord at column 0, bar 2 chord at column 8 (4 beats / 0.5 step).
  const cChord = riff.events.find((e) => e.label === "C");
  const fChord = riff.events.find((e) => e.label === "F");
  for (const note of cChord.notes) assert.equal(at(lanes, note.stringIndex, 0), note.fret);
  for (const note of fChord.notes) assert.equal(at(lanes, note.stringIndex, 8), note.fret);
});

test("an empty riff produces an empty overlay", () => {
  // No events at all — buildOverlay should not throw or return junk.
  const empty = { events: [], stepBeats: 0.5, beatsPerBar: 4, totalBeats: 0 };
  const lanes = buildOverlay(empty);
  assert.equal(lanes.size, 0);
});
