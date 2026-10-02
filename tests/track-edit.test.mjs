/**
 * Track edits: what a drag-and-drop means in the notation.
 *
 * These are the rules that can silently lie — a drop that "worked" but
 * shifted every chord between the two bars, or a two-digit fret that grew
 * one lane and broke the parse — so they are pinned down here, in Node.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHORD_REST,
  chordTokensFromText,
  moveChordToken,
  moveLaneNote,
  tokenIndexForChordOrdinal,
} from "../dist/track-edit.js";

// --- chordTokensFromText ---

test("chordTokensFromText finds the chord line and skips everything else", () => {
  const text = "tempo 96\nstrum 55\n# a comment\nC Am F G\ne|5---|\nB|-3---|";
  assert.deepEqual(chordTokensFromText(text), ["C", "Am", "F", "G"]);
  assert.deepEqual(chordTokensFromText("e|5---|"), [], "tab-only notation has no chord line");
  assert.deepEqual(chordTokensFromText("tempo 96"), [], "directives are not a chord line");
  assert.deepEqual(
    chordTokensFromText("C Am F G # cadence"),
    ["C", "Am", "F", "G"],
    "a trailing comment is not a token",
  );
});

// --- moveChordToken ---

test("moving a chord replaces the target and rests the source", () => {
  // The user's replace semantics: drop C onto F's bar -> bar 3 is C, F is
  // gone, bar 1 is a rest. NOT a swap, NOT a shift.
  assert.deepEqual(
    moveChordToken(["C", "Am", "F", "G"], 0, 2),
    [CHORD_REST, "Am", "C", "G"],
  );
});

test("moving a chord past the last bar extends the stream with rests", () => {
  assert.deepEqual(
    moveChordToken(["C", "Am"], 1, 3),
    ["C", CHORD_REST, CHORD_REST, "Am"],
  );
});

test("moving a chord onto itself, or from nowhere, changes nothing", () => {
  const tokens = ["C", "Am", "F", "G"];
  assert.deepEqual(moveChordToken(tokens, 1, 1), tokens);
  assert.deepEqual(moveChordToken(tokens, -1, 2), tokens);
  assert.deepEqual(moveChordToken(tokens, 9, 2), tokens);
});

// --- tokenIndexForChordOrdinal ---

test("chord ordinals skip rest bars, token indices do not", () => {
  const tokens = ["C", CHORD_REST, "Am", "F"];
  assert.equal(tokenIndexForChordOrdinal(tokens, 0), 0, "C is chord 0, token 0");
  assert.equal(tokenIndexForChordOrdinal(tokens, 1), 2, "Am is chord 1, token 2");
  assert.equal(tokenIndexForChordOrdinal(tokens, 2), 3);
  assert.equal(tokenIndexForChordOrdinal(tokens, 3), -1, "no fourth chord");
});

// --- moveLaneNote ---

/** A tiny lane map: string 5 (high e) has fret 5 at column 0, fret 7 at 2. */
function lanes() {
  return new Map([
    [5, [5, null, 7, null]],
    [4, [null, null, 3, null]],
  ]);
}

test("a note moves to its new cell, fret-preserving, clearing the old one", () => {
  const l = lanes();
  assert.equal(moveLaneNote(l, { string: 5, column: 0 }, { string: 5, column: 1 }), true);
  assert.deepEqual(l.get(5), [null, 5, 7, null], "same-string move (rhythm change)");
});

test("moving across strings keeps the fret and overwrites the target", () => {
  const l = lanes();
  assert.equal(moveLaneNote(l, { string: 5, column: 2 }, { string: 4, column: 1 }), true);
  assert.deepEqual(l.get(5), [5, null, null, null]);
  assert.deepEqual(l.get(4), [null, 7, 3, null], "the 7 lands on the new string, the 3 it covered is gone");
});

test("a two-digit fret clears its shadow column at the target", () => {
  const l = new Map([[5, [12, null, null, null]]]);
  assert.equal(moveLaneNote(l, { string: 5, column: 0 }, { string: 5, column: 1 }), true);
  assert.deepEqual(l.get(5), [null, 12, null, null], "column 2 is the shadow, held empty");
});

test("a two-digit fret refuses the last column (its shadow would break the lane width)", () => {
  const l = new Map([[5, [12, null, null, null]]]);
  assert.equal(moveLaneNote(l, { string: 5, column: 0 }, { string: 5, column: 3 }), false);
  assert.deepEqual(l.get(5), [12, null, null, null], "nothing moved");
});

test("a string with no lane yet gets one, and ragged lanes are made uniform", () => {
  const l = lanes(); // string 3 has no lane at all
  assert.equal(moveLaneNote(l, { string: 5, column: 0 }, { string: 3, column: 2 }), true);
  assert.deepEqual(l.get(3), [null, null, 5, null], "the new lane is the full width");
  for (const cells of l.values()) {
    assert.equal(cells.length, 4, "every lane is one width (the notation requires it)");
  }
});

test("an empty source or an out-of-range target moves nothing", () => {
  const l = lanes();
  assert.equal(moveLaneNote(l, { string: 5, column: 1 }, { string: 4, column: 0 }), false);
  assert.equal(moveLaneNote(l, { string: 5, column: 0 }, { string: 4, column: 99 }), false);
  assert.deepEqual(l.get(5), [5, null, 7, null]);
});
