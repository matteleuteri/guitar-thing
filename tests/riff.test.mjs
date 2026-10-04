/**
 * The notation: what the user types, and what comes back.
 *
 * This is the app's front door — a typo in here silently changes what the
 * timeline draws and what the transport plays, and the error message is the only
 * thing standing between a mistyped box and a wrong riff. So the parser is
 * tested as a user-facing surface: what it accepts, what it rejects, and
 * crucially WHAT IT REJECTS WITH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseRiff, stepName } from "../dist/riff.js";

const OPTS = {
  pins: [], beatsPerBar: 4, stepBeats: 0.5, span: 5, cap: 400,
  defaultStrumMs: 55, tuning: [40, 45, 50, 55, 59, 64], maxFrets: 24,
};
const parse = (text, extra = {}) => parseRiff(text, { ...OPTS, ...extra });

/** Two tab lanes of equal length, with `step` in force. */
const tabbed = (step, high, low) => `tempo 120\nbar 4\nstep ${step}\ne|${high}|\nB|${low}|`;
/** Beats of every note in a `0-0-0-0-` lane: notes on columns 0, 2, 4, 6. */
const QUARTERS = [0, 1, 2, 3];
const SIXTEENTHS = [0, 0.5, 1, 1.5];
const TRIPLET_QUARTERS = [0, 2 / 3, 4 / 3, 2];

test("the shipped example parses cleanly, and the loop covers all of it", () => {
  const shipped = `tempo 96        # directives: tempo|bpm, bar, step|grid, strum, release
bar 4           # beats per bar (default 4)
step eighths    # how long one column lasts (default: an 8th note)
strum 55        # default strum width ms for multi-note events (0 = blocked)
  C       Am      F       G    # a chord line: one chord per bar
e|5---5---7---7---8---8---7---5---|
B|----------------3---5---5---3---|
G|--------------------------------|`;
  const riff = parse(shipped);
  assert.deepEqual(riff.warnings, [], "the notation we ship must parse without warnings");
  assert.equal(riff.bpm, 96);
  assert.equal(riff.totalBeats, 16, "4 bars of 4 beats");
  // The playhead "gave up partway through" complaint traced back to a loop that
  // did not cover the timeline the user can see.
  assert.equal(riff.loop.start, 0);
  assert.equal(riff.loop.end, riff.totalBeats);
});

test("a chord line and a tab lane both land on the beat grid", () => {
  // Lanes must be one width, so this is a short riff; the shipped example's
  // full-width lanes are covered by the parse test above.
  const riff = parse("tempo 96\nbar 4\nstep eighths\n  C       Am\ne|5---5---|\nB|----3---|\nG|--------|");
  const chords = riff.events.filter((e) => e.kind === "chord");
  assert.deepEqual(chords.map((e) => e.beat), [0, 4], "one chord per bar");
  const tab = riff.events.filter((e) => e.kind === "note");
  assert.deepEqual(tab.map((e) => e.beat), [0, 2], "tab notes on their columns");
  assert.ok(tab.every((e) => Number.isInteger(e.beat / 0.5)), "a tab note is off the step grid");
});

test("a chord and a tab note on the same beat are both kept", () => {
  // The union is deliberate: a chord chart printed above tab is additive, so the
  // two must not collapse into one event.
  const riff = parse("tempo 120\nbar 4\nstep eighths\n  C\ne|0-------|\nB|--------|");
  const atZero = riff.events.filter((e) => e.beat === 0);
  assert.equal(atZero.length, 2, "the chord and the tab note collided into one event");
  assert.ok(atZero.some((e) => e.notes.length > 1), "lost the chord");
  assert.ok(atZero.some((e) => e.notes.length === 1), "lost the tab note");
});

test("every character is a column, spaces included", () => {
  // A space used to be dropped instead of holding its column, which slid every
  // following note one column left of where it was printed and made two
  // space-separated lanes of equal length fail the width check.
  const riff = parse(tabbed("eighths", "0---3---5---7-", "----5---5-----"));
  assert.deepEqual(riff.events.map((e) => e.beat), [0, 2, 4, 6], "columns 0, 4, 8, 12 at 0.5 beats");
  // The 3 is in column 2, so it lands on beat 1 — a dropped space would have
  // put it on beat 0.5. Both lanes' notes in one column merge into one event.
  const spaced = parse(tabbed("eighths", "0 3", "  3"));
  assert.deepEqual(spaced.events.map((e) => e.beat), [0, 1], "a space did not hold its column");
});

test("a multi-digit fret takes two character positions", () => {
  const riff = parse(tabbed("eighths", "--10---12-", "----------"));
  assert.deepEqual(riff.events.map((e) => e.notes[0].fret), [10, 12]);
  assert.deepEqual(riff.events.map((e) => e.beat), [1, 3.5], "cols 2 and 7 at 0.5 beats");
});

test("mutes and rests are accepted, and only frets are notes", () => {
  const riff = parse(tabbed("eighths", "0-x-.-_", "- - - -"));
  const notes = riff.events.flatMap((e) => e.notes);
  assert.equal(notes.length, 1, "a rest or a mute became a note");
  assert.equal(notes[0].fret, 0);
});

test("articulation marks are accepted and ignored", () => {
  // The mark is swallowed into the fret's own cell, so the marked lane is the
  // same seven columns as the plain one: the note sounds as if the mark were
  // a dash. (A mark that cost its own column would shift every later note.)
  const plain = parse(tabbed("eighths", "0-3-5-7-", "--------")).events.map((e) => e.beat);
  const marked = parse(tabbed("eighths", "0'-3~-5h-7p", "-------")).events.map((e) => e.beat);
  assert.deepEqual(marked, plain, "an articulation mark changed the timing");
});

test("lanes of unequal length are padded with a warning, not rejected", () => {
  // A two-digit fret makes its lane one column longer than the rest; rather
  // than kill the whole parse, the short lanes get dashes and a warning.
  const riff = parse("tempo 120\nbar 4\ne|0-0-0-0|\nB|3-3-|");
  const all = riff.events.filter((e) => e.kind === "note").flatMap((e) => e.notes);
  assert.equal(all.length, 6, "both lanes keep playing");
  const eNotes = riff.events.filter((e) => e.notes.some((n) => n.stringIndex === 5)).map((e) => e.beat);
  const bNotes = riff.events.filter((e) => e.notes.some((n) => n.stringIndex === 4)).map((e) => e.beat);
  assert.deepEqual(eNotes, [0, 1, 2, 3]);
  assert.deepEqual(bNotes, [0, 1], "the short lane's notes still sit on their columns");
  assert.ok(
    riff.warnings.some((w) => /lane "B"/.test(w) && /padded/.test(w)),
    `the short lane is named in a warning (${riff.warnings.join("; ") || "none"})`,
  );
});

test("a lane that never closes its pipe is reported as a lane problem", () => {
  assert.throws(
    () => parse("tempo 120\nbar 4\ne|0-0-0-0\nC"),
    (err) => /lane/i.test(err.message) && /closing/i.test(err.message),
  );
});

test("an unknown chord names the token", () => {
  assert.throws(() => parse("  C  Hwat\n"), (err) => /Hwat/.test(err.message));
});

test("a comment only opens at the start of a token, so a mid-token # is a sharp", () => {
  const riff = parse("tempo 120\nbar 4\n  C Am F#m7 Bb7 # cadence\n");
  assert.equal(riff.events.length, 4, "the trailing comment swallowed a chord");
  assert.ok(riff.events.some((e) => /F#/.test(e.label)), "F#m7 was lost");
});

test("a note-value name and a beat count mean the same thing", () => {
  for (const spelling of ["eighths", "eighth", "8ths", "1/8", "1/eighth", "0.5"]) {
    const riff = parse(tabbed(spelling, "0-0-0-0-", "--------"));
    assert.deepEqual(riff.events.map((e) => e.beat), QUARTERS, `"${spelling}" parsed wrong`);
  }
  for (const spelling of ["sixteenths", "sixteenth", "16ths", "1/16", "0.25"]) {
    const riff = parse(tabbed(spelling, "0-0-0-0-", "--------"));
    assert.deepEqual(riff.events.map((e) => e.beat), SIXTEENTHS, `"${spelling}" parsed wrong`);
  }
  for (const spelling of ["quarter", "1", "1/4"]) {
    const riff = parse(tabbed(spelling, "0-0-0-0-", "--------"));
    assert.deepEqual(riff.events.map((e) => e.beat), [0, 2, 4, 6], `"${spelling}" parsed wrong`);
  }
});

test("a fraction is a note length, not its leading digit", () => {
  // `Number.parseFloat("1/8")` is 1, which would silently turn a sixteenth into
  // a quarter note and move every note in the lane.
  assert.notDeepEqual(
    parse(tabbed("1/16", "0-0-0-0-", "--------")).events.map((e) => e.beat),
    parse(tabbed("1/8", "0-0-0-0-", "--------")).events.map((e) => e.beat),
    "1/16 and 1/8 parsed the same",
  );
});

test("a triplet grid is a third of a beat, and either word order works", () => {
  for (const spelling of ["eighth triplets", "triplet 8ths", "eighth triplet"]) {
    const riff = parse(tabbed(spelling, "0-0-0-0-", "--------"));
    assert.deepEqual(riff.events.map((e) => e.beat), TRIPLET_QUARTERS, `"${spelling}" parsed wrong`);
  }
  assert.equal(stepName(1 / 3), "an 8th-note triplet");
});

test("the grid is named back to the user in words, not counted", () => {
  assert.equal(stepName(0.5), "an 8th note");
  assert.equal(stepName(0.25), "a 16th note");
  assert.equal(stepName(1), "a quarter note");
  assert.equal(stepName(0.75), "0.75 beats", "an unnamed grid says so plainly");
});

test("an unreadable note length is rejected, and the message suggests real ones", () => {
  assert.throws(
    () => parse("tempo 120\nbar 4\nstep wibble\ne|0-0|\nB|----|"),
    (err) => /wibble/.test(err.message) && /eighths/.test(err.message),
  );
});

test("a directive may carry a trailing comment", () => {
  const riff = parse("tempo 96   # the tempo\nbar 4\nstep 0.5  # the grid\n  C\n");
  assert.equal(riff.bpm, 96);
  assert.equal(riff.totalBeats, 4);
});

test("bar length changes where the chords land", () => {
  const riff = parse("tempo 120\nbar 3\n  C  F  G\n");
  assert.deepEqual(riff.events.map((e) => e.beat), [0, 3, 6]);
  assert.equal(riff.totalBeats, 9);
});

test("a chord voicing is playable: at least two strings, all inside the span", () => {
  const riff = parse("tempo 120\nbar 4\n  C  Am  F  G\n");
  for (const event of riff.events) {
    if (event.notes.length < 2) continue;
    const fretted = event.notes.filter((n) => n.fret > 0).map((n) => n.fret);
    assert.ok(event.notes.length >= 2, `a chord played on ${event.notes.length} string(s)`);
    if (fretted.length >= 2) {
      const span = Math.max(...fretted) - Math.min(...fretted);
      assert.ok(span <= 5, `a chord spread over ${span} frets, past the 5-fret span`);
    }
  }
});

test("a multi-note event never puts two notes on one string", () => {
  const riff = parse("tempo 96\nbar 4\n  C  Am  F  G\n");
  for (const event of riff.events) {
    const strings = event.notes.map((n) => n.stringIndex);
    assert.equal(new Set(strings).size, strings.length, `two notes on one string at beat ${event.beat}`);
  }
});

test("an empty box is refused with an example, not a stack trace", () => {
  assert.throws(() => parse(""), (err) => /nothing to play/i.test(err.message) && /\|/.test(err.message));
});

// --- rest bars (`-` in the chord stream) ---

test("a rest bar holds its position: no chord event, later chords keep their bars", () => {
  // What a chord drag writes: C was dragged off bar 1 onto F's bar.
  const riff = parse("tempo 96\nbar 4\n- Am C G");
  const chords = riff.events.filter((e) => e.kind === "chord");
  assert.deepEqual(
    chords.map((e) => [e.label, e.beat]),
    [["Am", 4], ["C", 8], ["G", 12]],
    "bar 1 is empty, and Am/C/G still sit on bars 2/3/4",
  );
});

test("a trailing rest is still an empty bar (totalBeats counts chord tokens)", () => {
  const riff = parse("tempo 96\nbar 4\nC Am F -");
  assert.equal(riff.totalBeats, 16, "silence past the last event still shows as grid");
});

test("a stream of only rests is refused like an empty box", () => {
  assert.throws(() => parse("tempo 96\n- - -"), /nothing to play/i);
});

test("a rest bar still counts as a bar beside the tab lanes", () => {
  // A rest in the middle of the stream with lanes present: the union keeps
  // the tab notes at their own beats, and the chords at theirs.
  const riff = parse("tempo 96\nbar 4\nstep eighths\nC - F G\ne|5---7---|");
  const chords = riff.events.filter((e) => e.kind === "chord");
  assert.deepEqual(chords.map((e) => e.beat), [0, 8, 12]);
  assert.equal(riff.totalBeats, 16);
});
