import { chordShape, findFingerings, findPositions, parseChordShape } from "../dist/fretboard.js";
import { findPianoKeys, findPianoVoicings } from "../dist/piano.js";
import { chordName, midiName, noteName, parseNotes, parseStringMidi, parseChord } from "../dist/theory.js";
import { parseProgression, planGuitarSong, planPianoSong, rankGuitarVoicings } from "../dist/song.js";
import { parseRiff, secondsPerBeat, stepName } from "../dist/riff.js";
import { RiffTransport } from "../dist/transport.js";
import { readFile } from "node:fs/promises";

const STANDARD = [40, 45, 50, 55, 59, 64];
let failures = 0;

function check(cond, label) {
  if (cond) console.log(`ok   ${label}`);
  else { console.error(`FAIL ${label}`); failures++; }
}

function throws(fn, label) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(threw, label);
}

// parse
const ceg = parseNotes("C E G");
check(ceg.length === 3 && ceg[0] === 0 && ceg[2] === 7, `parse "C E G" -> [${ceg}]`);
const withFlat = parseNotes("Bb C# F");
check(withFlat.length === 3 && withFlat[0] === 10 && withFlat[1] === 1 && withFlat[2] === 5, `parse flats ${withFlat.join(",")}`);
check(midiName(40) === "E2" && midiName(69) === "A4", "midiName E2/A4");
check(parseStringMidi("E2", 0) === 40 && parseStringMidi("Db3", 2) === 49, "parseStringMidi");

// chord naming
check(chordName([0, 4, 7]).primary === "C", `C chord name -> ${chordName([0, 4, 7]).primary}`);
check(chordName([9, 0, 4, 7]).primary === "C6", `ACEG -> ${chordName([9, 0, 4, 7]).primary}`);
check(chordName([9, 0, 4, 7]).alternatives.includes("Am7"), "ACEG alt Am7");

// positions
const pos = findPositions(ceg, STANDARD, 15);
check(pos.length > 5, `found ${pos.length} C-E-G positions on 15 frets`);
const allValid = pos.every((p) => {
  const pc = (STANDARD[p.stringIndex] + p.fret) % 12;
  return ceg.includes(pc);
});
check(allValid, "all positions are target notes");

// fingerings: C major, span 5
const t0 = Date.now();
const res = findFingerings(ceg, STANDARD, 15, 5, 500);
const ms = Date.now() - t0;
check(res.fingerings.length > 0, `C major fingerings (span 5): ${res.fingerings.length}`);
check(res.fingerings.length <= 500, "cap respected");

// Every fingering: strings mute or chord note, all 3 pcs covered, >=3 sounding, span<=5
let shapeOk = 0;
for (const f of res.fingerings) {
  const sounding = [];
  for (let s = 0; s < 6; s++) {
    const fr = f.frets[s];
    if (fr === null) continue;
    const pc = (STANDARD[s] + fr) % 12;
    if (!ceg.includes(pc)) { shapeOk = 1; break; }
    sounding.push(fr);
  }
  if (shapeOk) break;
  check(sounding.length >= 3, "span sanity (should not run)");
}
if (shapeOk) failures++;
console.log(`C major search took ${ms}ms`);

// 2-note (dyad / power-chord) fingerings
const dyad = findFingerings([0, 7], STANDARD, 15, 5, 200);
check(dyad.fingerings.length > 0, `2-note chord fingerings: ${dyad.fingerings.length}`);
let dyadOk = true;
for (const f of dyad.fingerings) {
  const pcs = [];
  for (let s = 0; s < 6; s++) {
    const fr = f.frets[s];
    if (fr === null) continue;
    pcs.push((STANDARD[s] + fr) % 12);
  }
  if (pcs.length < 2 || !pcs.includes(0) || !pcs.includes(7)) dyadOk = false;
}
check(dyadOk, "2-note fingerings cover both notes with >=2 strings");

// Piano mode
const pKeys = findPianoKeys(ceg, 48, 84);
check(pKeys.length > 5, `piano keys found: ${pKeys.length}`);
const pV = findPianoVoicings(ceg, 48, 84, 12, 300);
check(pV.voicings.length > 0, `piano voicings (reach 12): ${pV.voicings.length}`);
let pOk = true;
const seen = new Set();
for (const v of pV.voicings) {
  if (v.keys.length < 2 || v.keys.length > 10) pOk = false;
  if (Math.max(...v.keys) - Math.min(...v.keys) > 12) pOk = false;
  const pcs = v.keys.map((k) => k % 12);
  if (!ceg.every((c) => pcs.includes(c))) pOk = false;
  const key = v.keys.join(",");
  if (seen.has(key)) pOk = false;
  seen.add(key);
}
check(pOk, "piano voicings valid (coverage, count, reach, unique)");

// Worst case perf: 6 notes, span 5, cap 500
const six = parseNotes("C E G Bb Db F");
const t1 = Date.now();
const res6 = findFingerings(six, STANDARD, 15, 5, 500);
const ms6 = Date.now() - t1;
console.log(`6-note set (${noteName(six[0])} family) took ${ms6}ms, fingerings=${res6.fingerings.length}`);
check(res6.fingerings.length > 0, "6-note set yields fingerings");
check(ms6 < 10000, "perf under 10s");

// ---- Song mode: chord parsing ----
check(parseChord("C").pitchClasses.join(",") === "0,4,7", `parseChord C -> [${parseChord("C").pitchClasses}]`);
check(parseChord("Am7").pitchClasses.join(",") === "0,4,7,9", "parseChord Am7");
check(parseChord("Bb7").pitchClasses.join(",") === "2,5,8,10", "parseChord Bb7");
check(parseChord("C6/9").pitchClasses.join(",") === "0,2,4,7,9", "parseChord C6/9 (slash belongs to the suffix)");
check(parseChord("F#m7b5").pitchClasses.join(",") === "0,4,6,9", "parseChord F#m7b5");
check(parseChord("Ddim7").pitchClasses.join(",") === "2,5,8,11", "parseChord Ddim7");
check(parseChord("C/G").pitchClasses.join(",") === "0,4,7" && parseChord("C/G").bass === 7, "parseChord C/G bass kept");
check(parseChord("Cmaj").pitchClasses.join(",") === "0,4,7" && parseChord("CM").pitchClasses.join(",") === "0,4,7", "maj/M spellings");
throws(() => parseChord("Z"), "unknown root rejects");
throws(() => parseChord("Cweird"), "unknown suffix rejects");

// round-trip: every parsed symbol re-parses from its sharp-spelled primary to the same pcs set
const roundTrips = ["C", "G", "Am", "F", "Em7", "Dm7", "G7", "Cadd9", "Bb7", "F#m7b5",
  "C7sus4", "Ddim7", "Csus2", "Eaug", "D6/9", "Cmaj7", "Gsus4", "B7", "Eb", "Am7/G", "C9"];
let rtOk = true;
for (const sym of roundTrips) {
  const pcs = parseChord(sym).pitchClasses;
  const primary = chordName(pcs).primary;
  const reparsed = parseChord(primary).pitchClasses;
  if (pcs.join(",") !== reparsed.join(",")) { rtOk = false; console.error(`  round-trip ${sym}: ${pcs} vs ${reparsed}`); }
}
check(rtOk, "parseChord <-> chordName round-trip (set equality)");

// progression splitting
const sp = parseProgression("C, G | Am  F;Em");
check(sp.length === 5 && sp[0].name === "C" && sp[3].name === "F", `parseProgression separators -> ${sp.length}`);
check(parseProgression("C/G").length === 1 && parseProgression("C/G")[0].bass === 7, "slash chord is one token");

// ---- Song mode: guitar planning ----
// metric oracle (must mirror src/song.ts guitarTransition)
function refGuitar(a, b) {
  let cost = 0;
  let aMin = Infinity, bMin = Infinity;
  for (let s = 0; s < a.frets.length; s++) {
    const fa = a.frets[s], fb = b.frets[s];
    if (fa !== null && fb !== null) {
      cost += Math.abs(fa - fb);
    } else if (fa !== null || fb !== null) {
      cost += 4;
    }
    if (fa !== null && fa > 0) aMin = Math.min(aMin, fa);
    if (fb !== null && fb > 0) bMin = Math.min(bMin, fb);
  }
  if (aMin !== Infinity && bMin !== Infinity) cost += 0.5 * Math.abs(aMin - bMin);
  return cost;
}

const progA = parseProgression("C G Am F");
const tG = Date.now();
const planG = planGuitarSong(progA, STANDARD, 15, 5, 300);
const msG = Date.now() - tG;
let gArrOk = planG !== null && planG.chords.length === 4;
let gShapeOk = true;
let gMoveOk = true;
if (planG) {
  for (let i = 1; i < planG.chords.length; i++) {
    const c = planG.chords[i];
    // transition cost printed must match the oracle
    if (c.move !== refGuitar(planG.chords[i - 1].fingering, c.fingering)) gMoveOk = false;
    // held strings really stay put
    for (const s of c.held) {
      const prev = planG.chords[i - 1].fingering.frets[s];
      if (prev === null || prev !== c.fingering.frets[s]) gMoveOk = false;
    }
  }
  for (const c of planG.chords) {
    const f = c.fingering;
    const sounding = [];
    let lo = Infinity, hi = -Infinity;
    for (let s = 0; s < 6; s++) {
      const fr = f.frets[s];
      if (fr === null) continue;
      sounding.push((STANDARD[s] + fr) % 12);
      lo = Math.min(lo, fr); hi = Math.max(hi, fr);
    }
    if (sounding.length < 2 || !c.chord.pitchClasses.every((p) => sounding.includes(p))) gShapeOk = false;
    if (lo !== Infinity && hi - lo > 5) gShapeOk = false;
  }
  // a real greedy walk must never beat the DP's total
  let prev = planG.chords[0].fingering;
  let greedy = 0;
  for (let i = 1; i < planG.chords.length; i++) {
    let best = Infinity;
    let bestCand = null;
    for (const cand of findFingerings(progA[i].pitchClasses, STANDARD, 15, 5, 300).fingerings) {
      const c = refGuitar(prev, cand);
      if (c < best) { best = c; bestCand = cand; }
    }
    greedy += best;
    prev = bestCand;
  }
  check(planG.totalMove <= greedy, `guitar DP total (${planG.totalMove}) <= greedy (${greedy})`);
}
check(gArrOk, "guitar song plan built for C G Am F");
check(gShapeOk, "guitar song voicings cover their chords within span");
check(gMoveOk, "guitar song move/held values match the transition metric");
console.log(`guitar song plan took ${msG}ms`);
check(msG < 10000, "guitar song perf under 10s");

// ---- Song mode: piano planning ----
function refPiano(a, b) {
  const as = [...a].sort((x, y) => x - y);
  const bs = [...b].sort((x, y) => x - y);
  let cost = 0;
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) cost += Math.abs(as[i] - bs[i]);
  cost += 2 * Math.abs(as.length - bs.length);
  return cost;
}

const tP = Date.now();
const planP = planPianoSong(progA, 48, 84, 12, 300);
const msP = Date.now() - tP;
let pArrOk = planP !== null && planP.chords.length === 4;
let pShapeOk = true;
let pMoveOk = true;
if (planP) {
  for (let i = 1; i < planP.chords.length; i++) {
    const c = planP.chords[i];
    const prev = planP.chords[i - 1].voicing.keys;
    if (c.move !== refPiano(prev, c.voicing.keys)) pMoveOk = false;
    const prevSet = new Set(prev);
    for (const k of c.held) if (!prevSet.has(k) || !c.voicing.keys.includes(k)) pMoveOk = false;
  }
  for (const c of planP.chords) {
    const ks = c.voicing.keys;
    if (ks.length < 2 || ks.length > 10) pShapeOk = false;
    if (ks.length !== new Set(ks).size) pShapeOk = false;
    if (Math.max(...ks) - Math.min(...ks) > 12) pShapeOk = false;
    const pcs = ks.map((k) => k % 12);
    if (!c.chord.pitchClasses.every((p) => pcs.includes(p))) pShapeOk = false;
  }
  let prev = planP.chords[0].voicing.keys;
  let greedy = 0;
  for (let i = 1; i < planP.chords.length; i++) {
    let best = Infinity;
    let bestCand = null;
    for (const cand of findPianoVoicings(progA[i].pitchClasses, 48, 84, 12, 300).voicings) {
      const c = refPiano(prev, cand.keys);
      if (c < best) { best = c; bestCand = cand; }
    }
    greedy += best;
    prev = bestCand.keys;
  }
  check(planP.totalMove <= greedy, `piano DP total (${planP.totalMove}) <= greedy (${greedy})`);
}
check(pArrOk, "piano song plan built for C G Am F");
check(pShapeOk, "piano song voicings valid (coverage, unique ascending keys, reach)");
check(pMoveOk, "piano song move/held values match the transition metric");
console.log(`piano song plan took ${msP}ms`);
check(msP < 10000, "piano song perf under 10s");

/* ---------------- riff notation + transport ---------------- */

const riffOpts = { tuning: STANDARD, maxFrets: 15, span: 5, cap: 200 };

// --- tab lane: cells, runs, mutes, multi-digit frets ---
{
  // Columns are character positions, so the 2-digit fret keeps the lanes aligned.
  //      col:  0 1 2 3 4 5 6 7 8 9
  const r = parseRiff("e|--5-5-10--|\nB|--x-3-----|", riffOpts);
  check(r.events.length === 3, `tab: only columns with a fret become events (got ${r.events.length})`);
  check(r.events[0].notes.length === 1 && r.events[0].notes[0].fret === 5, "tab: col 2 plays the e-string 5");
  check(r.events[0].notes[0].stringIndex === 5, "tab: high e lane is string index 5");
  check(r.events[0].muted.includes(4), "tab: x beside a note is a mute, not a second note");
  check(r.events[1].notes.length === 2, "tab: col 4 stacks two frets into one event");
  check(r.events[1].notes[0].fret === 3 && r.events[1].notes[0].stringIndex === 4, "tab: B lane is string index 4");
  check(r.events[1].notes[0].stringIndex < r.events[1].notes[1].stringIndex, "tab: notes sorted low string first");
  check(r.events[1].strumMs === 55, `tab: multi-note event takes the strum width (${r.events[1].strumMs})`);
  check(r.events[0].strumMs === 0, "tab: single-note event has no strum width");
  check(r.events[2].notes[0].fret === 10, "tab: multi-digit fret 10 parsed as ONE note");
  check(r.events[2].notes.length === 1, "tab: the 10's second character column stays empty");
  check(r.events[0].rootPitchClass === (STANDARD[5] + 5) % 12, "tab: root is the struck note's pitch class");
  check(r.events[0].beat === 1, `tab: first note sits on its character column (beat ${r.events[0].beat})`);
  check(r.events[2].beat === 3, `tab: the 10 sits at its own character column (beat ${r.events[2].beat})`);
}

// --- step size drives beat placement ---
{
  // A fret digit is a whole column, so consecutive notes live in two lanes:
  // e on the even columns, B on the odd ones (columns 0..7 = beats 0..3.5).
  const notes = "e|0-0-0-0-|\nB|-3-3-3-3|";
  const a = parseRiff(notes, riffOpts);
  const b = parseRiff(`${notes}\nstep 1`, riffOpts);
  check(a.events.length === 8, `one event per column across two lanes (got ${a.events.length})`);
  check(a.events[3].beat === 1.5, `default step 0.5 -> beat 1.5 (got ${a.events[3].beat})`);
  check(b.events[3].beat === 3, `step 1 -> beat 3 (got ${b.events[3].beat})`);
}

// --- the grid can be named the way a guitarist says it ---
// `step 0.5` is a count of BEATS, which is not how rhythm is spoken: the
// default grid is "an 8th note" and nobody says "a half beat". So `step` takes
// note-value names as well as numbers, and the name is what the readout calls
// the grid back. Two silent traps this replaces: `parseFloat` read the "1" out
// of "1/8" (a sixteenth became a quarter), and the ordinal rewrite missed
// "16ths" entirely because `\b` never matches before a plural "s".
{
  const lane = "e|--5-5-5-5-|";
  const grid = (spec) => parseRiff(`${spec}\n${lane}`, riffOpts).stepBeats;
  const names = [
    ["step 0.5", 0.5], ["step 0.25", 0.25], ["step .5", 0.5],
    ["step eighths", 0.5], ["step eighth", 0.5], ["step 16ths", 0.25],
    ["step 1/8", 0.5], ["step 1/16", 0.25], ["step 1 / 8", 0.5], ["step 1/8ths", 0.5],
    ["grid sixteenths", 0.25], ["step quarter", 1], ["step half", 2], ["step whole", 4],
    ["STEP Sixteenths", 0.25],
    ["step eighth triplets", 1 / 3], ["step triplet 8ths", 1 / 3], ["step 8th triplets", 1 / 3],
    ["step sixteenth triplets", 1 / 6],
  ];
  for (const [spec, want] of names) {
    check(Math.abs(grid(spec) - want) < 1e-9, `grid "${spec}" -> ${want} beats/column (got ${grid(spec)})`);
  }
  // A name that is not a note length must not fall back to reading a number out
  // of it: "1/5" parses as 1 under parseFloat, which would silently be a
  // quarter note.
  for (const bad of ["step bananas", "grid 1/5", "step 1/5", "step eighths and a half"]) {
    throws(() => parseRiff(`${bad}\n${lane}`, riffOpts), `grid: "${bad}" throws`);
  }
  check(stepName(0.5) === "an 8th note", `stepName(0.5) names the default grid (got ${stepName(0.5)})`);
  check(stepName(0.25) === "a 16th note", `stepName(0.25) (got ${stepName(0.25)})`);
  check(stepName(1 / 3) === "an 8th-note triplet", `stepName(1/3) (got ${stepName(1 / 3)})`);
  // A directive may carry a trailing comment, which is how both this file and
  // the README annotate the default grid.
  check(
    Math.abs(parseRiff(`step eighths  # 8th grid\n${lane}`, riffOpts).stepBeats - 0.5) < 1e-9,
    "grid: a trailing comment does not reach the value parser",
  );
  check(
    parseRiff(`tempo 96  # slow\n${lane}`, riffOpts).bpm === 96,
    "grid: a commented tempo still parses",
  );
}

// --- an auto-voiced chord prints as a shape you can read and override ---
// The notation box says `C`; the app picks the shape. It was always computed
// and drawn in the timeline, but "the voicing you cannot see is the voicing you
// cannot check" is why the readout prints it -- and once it is printed, the
// three-string result is obvious, which is the point.
{
  const shape = chordShape([null, null, 2, 0, 1, null]);
  check(shape === "xx201x", `chordShape reads low string first, x for muted (got ${shape})`);
  check(chordShape([0, 0, 0, 0, 0, 0]) === "000000", "chordShape of an open shape is all digits");
  check(
    chordShape([null, 3, 2, 0, 1, 0]) === "x32010",
    "chordShape matches the printed C shape a guitarist would use (got " + chordShape([null, 3, 2, 0, 1, 0]) + ")",
  );
  const r = parseRiff("C Am F G", riffOpts);
  const shapes = r.events.filter((e) => e.kind === "chord").map((e) => chordShape(e.frets));
  check(
    shapes.every((s) => s.length === 6),
    `every chord shape has one character per string (${shapes.join(" ")})`,
  );
  // Known and deliberately NOT fixed yet: guitarTransition in song.ts charges
  // nothing for a string muted in BOTH voicings, so the shortest path through a
  // progression can drop to three strings. This asserts the shape is printable
  // so that stays visible; changing the cost is a musical decision, not a test.
  check(
    shapes.some((s) => (s.match(/x/g) || []).length >= 3),
    `the current auto-voicing really does drop strings (${shapes.join(" ")}) — the cost function pays no price for a string muted in both chords`,
  );
}

// --- every CHARACTER is a column, spaces included ---
// A space used to be dropped instead of holding its column, which slid every
// following note one column left of where it was printed and made a pair of
// space-separated lanes fail the equal-length check outright. A space is now
// exactly a dash: a rest that holds its column, as in printed tab.
{
  const spaced = parseRiff("e|-- 5 5 7 -|", riffOpts);
  const dashed = parseRiff("e|---5-5-7-|", riffOpts);
  check(
    spaced.events.map((e) => e.beat).join() === dashed.events.map((e) => e.beat).join(),
    `a space is a dash: same character column -> same beat (${spaced.events.map((e) => e.beat).join()})`,
  );
  check(
    spaced.events.map((e) => e.beat).join() === "1.5,2.5,3.5",
    `a spaced lane plays on the column it is written at (${spaced.events.map((e) => e.beat).join()})`,
  );
  check(spaced.events.length === 3, `spaced lane: 3 notes (got ${spaced.events.length})`);
  // Two space-separated lanes of the same CHARACTER width line up and play.
  const pair = parseRiff("e|-- 5 5 7 -|\nB|-- 3 5 - -|", riffOpts);
  check(pair.events.length === 3, `spaced lanes: 3 stacked events (got ${pair.events.length})`);
  check(
    pair.events[0].notes.length === 2 && pair.events[0].notes[0].fret === 3,
    "spaced lanes: a B-lane note stacks under the e-lane note in the same column",
  );
  // A LEADING space is column 0, not decoration.
  const indented = parseRiff("e| --5--5--|\nB| --3--5--|", riffOpts);
  check(indented.events[0].beat === 1.5, `a leading space is a rest column (beat ${indented.events[0].beat})`);
  // ...and a width mismatch is still the error it was, now with the fix in it.
  let msg = "";
  try {
    parseRiff("e|-- 5 5 7 -|\nB|-- 3 5 -|", riffOpts);
  } catch (err) {
    msg = err.message;
  }
  check(/different lengths \(8, 10 columns\)/.test(msg), `spaced lanes of different widths throw (${msg || "no error!"})`);
  check(/pad the short lanes/.test(msg), "the lane-length error says how to fix it");
  // A lane with no closing pipe used to fall through to the chord stream and
  // die as `Unknown chord "e"`, which points at the wrong thing entirely.
  let unclosed = "";
  try {
    parseRiff("e|--5-5-7-", riffOpts);
  } catch (err) {
    unclosed = err.message;
  }
  check(/closing "\|"/.test(unclosed), `an unclosed lane says so (${unclosed || "no error!"})`);
}

// --- directives ---
{
  const r = parseRiff("tempo 140\nbar 3\nstrum 12\nrelease 700\ne|5 5|", riffOpts);
  check(r.bpm === 140, `tempo parsed (${r.bpm})`);
  check(r.beatsPerBar === 3, `bar parsed (${r.beatsPerBar})`);
  check(r.strumMs === 12, `strum parsed (${r.strumMs})`);
  check(r.releaseMs === 700, `release parsed (${r.releaseMs})`);
  check(r.totalBeats % 3 === 0, "totalBeats rounds up to a whole bar");
}

// --- chord stream: one strummed event per bar, voiced by the song DP ---
{
  const r = parseRiff("C Am", riffOpts);
  check(r.events.length === 2, `chord stream: 2 events (got ${r.events.length})`);
  check(r.events[0].beat === 0 && r.events[1].beat === 4, "chord stream: one chord per bar");
  check(r.events.every((e) => e.kind === "chord"), "chord stream: events are chords");
  check(r.events[0].notes.length >= 2, `chord stream: at least 2 strings sound (${r.events[0].notes.length})`);
  check(
    r.events.every((e) => e.chord.pitchClasses.every((pc) => e.notes.some((n) => (STANDARD[n.stringIndex] + n.fret) % 12 === pc))),
    "chord stream: every chord note is present in the chosen voicing",
  );
  check(r.events[0].rootPitchClass === 0, "C chord: root pitch class is C");
}

// --- chords and a tab lane union into one ordered stream ---
{
  const r = parseRiff("tempo 120\nbar 4\nC\ne|5--5--5--|", riffOpts);
  check(r.events.length === 4, `chord + tab: 1 chord + 3 tab notes = 4 events (got ${r.events.length})`);
  const beats = r.events.map((e) => e.beat);
  check(beats.every((b, i) => i === 0 || b >= beats[i - 1]), "chord + tab: events are beat-ordered");
  check(r.events.some((e) => e.kind === "chord") && r.events.some((e) => e.kind === "note"), "chord + tab: both kinds present");
  // A chord on beat 0 and a tab note on beat 0 must both survive (stab under a note).
  check(r.events.filter((e) => e.beat === 0).length === 2, "chord + tab: a stab and a melody note on the same beat both play");
}

// --- validation ---
throws(() => parseRiff("e|--5--|\nB|--3-|", riffOpts), "tab: mismatched lane lengths throw");
throws(() => parseRiff("e|--5-zz-|", riffOpts), "tab: junk cell throws");
throws(() => parseRiff("nope 5", riffOpts), "chord: unparseable chord throws");
throws(() => parseRiff("tempo", riffOpts), "directive: missing number throws");
throws(() => parseRiff("wibble 5", riffOpts), "directive: misspelled keyword throws");
throws(() => parseRiff("# only a comment", riffOpts), "empty riff throws");
{
  const r = parseRiff("e|5 30 5|", riffOpts);
  check(r.warnings.length === 1 && r.events.length === 2, "tab: a fret past the last fret is skipped with a warning");
}

// --- transport: lookahead scheduling on a fake clock ---
{
  // A note on every column 0..7 (two lanes), 120bpm => 0.25s per column, so a
  // 2-beat window is 1.0s per pass with 4 events in it.
  const r = parseRiff("tempo 120\nbar 4\ne|0-0-0-0-|\nB|-3-3-3-3|", riffOpts);
  let clock = 0;
  const fired = [];
  const t = new RiffTransport(
    r,
    secondsPerBeat(r),
    { now: () => clock, onEvent: (e, when) => fired.push({ beat: e.beat, when }) },
    { every: () => 1, clear: () => undefined },  // no real timer; we drive advance()
  );
  t.setLoop(0, 2);
  t.play(0);

  check(t.playing === true, "transport: play() starts the scheduler");
  check(fired.length > 0, `transport: places events ahead of the clock instead of waiting (${fired.length})`);
  check(fired.every((f) => f.when >= clock && f.when <= clock + 0.3001),
    "transport: every event is placed in the future, inside the lookahead");
  check(new Set(fired.map((f) => f.beat)).size === fired.length, "transport: no event is placed twice");

  // Drive 5 seconds of fake time in 20ms steps. The lookahead deliberately
  // places notes slightly PAST the clock, so count what was due by 5.0s and
  // separately assert the overshoot stays inside one lookahead.
  for (let i = 0; i <= 250; i++) { clock = i * 0.02; t.advance(clock); }
  // Notes sit every 0.25s (half a beat at 120bpm) from t=0, so 0..5.0 inclusive
  // is 21 of them.
  const due = fired.filter((f) => f.when <= 5 + 1e-9);
  check(due.length === 21, `transport: 5s of a 1s loop plays 21 notes (got ${due.length})`);
  check(fired.every((f) => f.when <= 5 + 0.3001), "transport: the lookahead overshoot stays bounded");
  check(fired.length - due.length <= 2, "transport: at most one lookahead of extra notes are queued");
  check(Math.max(...fired.map((f) => f.beat)) < 2, "transport: the loop window is half-open (beat 2 excluded)");
  check(fired.every((f, i) => i === 0 || f.when >= fired[i - 1].when - 1e-9),
    "transport: scheduled times never go backwards");
  check(Math.abs((due[1].when - due[0].when) - 0.25) < 1e-6,
    "transport: notes are spaced by the tempo, not by the timer");
  check(due.every((f, i) => i === 0 || Math.abs((f.when - due[i - 1].when) - 0.25) < 1e-6),
    "transport: the spacing stays exact across every loop wrap (no drift)");
  // The repeat period is the window length, derived from the scheduled end
  // rather than the timer — the whole point of anchoring. The (0,2] window
  // holds 4 of the 8 events, so the same event one pass later is 4 along.
  const period = fired[4].when - fired[0].when;
  check(Math.abs(period - 1.0) < 1e-6, `transport: the 2-beat window repeats every 1.0s (got ${period})`);

  // A wider window holds the whole riff: 4 beats at 120bpm is a 2s pass with
  // all 8 events in it, so the same event one pass later is 8 along.
  t.stop();
  t.setLoop(0, 4);
  clock = 0;
  fired.length = 0;
  t.play(0);
  for (let i = 0; i <= 300; i++) { clock = i * 0.02; t.advance(clock); }
  check(Math.abs((fired[8].when - fired[0].when) - 2.0) < 1e-6,
    `transport: a 4-beat window repeats every 2.0s (got ${fired[8].when - fired[0].when})`);
  check(fired.filter((f) => f.when <= 4 + 1e-9).length === 17,
    `transport: 4s of a 2s loop plays 17 notes (got ${fired.filter((f) => f.when <= 4 + 1e-9).length})`);

  t.stop();
  check(t.playing === false, "transport: stop() halts the scheduler");
  const before = fired.length;
  clock += 2;
  t.advance(clock);
  check(fired.length === before, "transport: advance() after stop() places nothing new");
}

// ---- The build stamp (which branch/commit is being served). ----
// dist/ is gitignored, so a stale build is the default failure mode when
// switching branches. npm test builds first, so the stamp must exist and be
// well-formed here, or the ear-check page silently loses its staleness warning.
{
  let stamp = null;
  let raw = "";
  try {
    raw = await readFile(new URL("../dist/__build.json", import.meta.url), "utf8");
    stamp = JSON.parse(raw);
  } catch (err) {
    check(false, `dist/__build.json is written by the build (${err.message})`);
  }
  if (stamp) {
    check(
      typeof stamp.branch === "string" && stamp.branch !== "",
      `the build stamp names a branch (${stamp.branch})`,
    );
    check(
      typeof stamp.commit === "string" && /^[0-9a-f]{4,}$/.test(stamp.commit),
      `the build stamp names a commit (${stamp.commit})`,
    );
    check(
      typeof stamp.builtAt === "string" && !Number.isNaN(Date.parse(stamp.builtAt)),
      "the build stamp has a parseable timestamp",
    );
    check(
      typeof stamp.subject === "string",
      "the build stamp carries the commit subject for the ear-check banner",
    );
  }
  // The ear-check page's whole point is comparing the stamp to the live HEAD,
  // so it must actually ask for both.
  const ear = await readFile(new URL("../debug/riff-debug.html", import.meta.url), "utf8");
  check(ear.includes("__build.json"), "the ear-check page reads the build stamp");
  check(ear.includes("/__git"), "the ear-check page reads the live git state");
  check(
    /STALE BUILD/.test(ear),
    "the ear-check page warns when the build and the branch disagree",
  );
}

// ---- Comments must not eat chord names. ----
{
  // `F#m7` / `Bb7` are ordinary chords here, so a comment marker only opens a
  // comment when it starts a token — a mid-token `#` is a sharp.
  const sharp = parseRiff("C Am F#m7 Bb7 # cadence", { tuning: STANDARD, maxFrets: 24, span: 5 });
  check(
    sharp.events.map((e) => e.label).join(" ") === "C Am F#m7 Bb7",
    `a trailing comment doesn't eat the chords (${sharp.events.map((e) => e.label).join(" ")})`,
  );
  const slash = parseRiff("C G // two chords", { tuning: STANDARD, maxFrets: 24, span: 5 });
  check(slash.events.length === 2, `a trailing // comment works too (${slash.events.length} chords)`);
  const whole = parseRiff("# just a heading\nC G", { tuning: STANDARD, maxFrets: 24, span: 5 });
  check(whole.events.length === 2, "a whole-line comment is ignored");
  // The lane-length error is the one a user hits most, so keep its wording.
  let laneMsg = "";
  try {
    parseRiff("e|5--5--|\nB|5--|", { tuning: STANDARD, maxFrets: 24, span: 5 });
  } catch (err) {
    laneMsg = err.message;
  }
  check(/different lengths/.test(laneMsg), `mismatched lanes are rejected clearly (${laneMsg || "no error!"})`);
}

// ---- The notation we SHIP must parse. ----
// The default in the app's textarea and every notation example in the docs are
// the first things a user copies, and a mismatched tab lane throws a "lanes
// have different lengths" error on a fresh Riff page. Parse them here so the
// docs, the UI and the parser can never drift apart again.
{
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const riffPage = await readFile(new URL("../riff.html", import.meta.url), "utf8");
  const index = await readFile(new URL("../index.html", import.meta.url), "utf8");

  const shipped = riffPage.match(/<textarea[\s\S]*?id="riff-text"[\s\S]*?>([\s\S]*?)<\/textarea\s*>/);
  check(shipped !== null, "riff.html carries a default riff notation");
  // The riff trainer is its own page now, so the finder must not grow it back.
  check(!/id="riff-text"/.test(index), "index.html does not carry the riff notation box");
  check(/riff\.html/.test(index), "index.html links to the riff builder");
  check(
    !/value="riff"/.test(index) && !/id="desc-riff"/.test(index),
    "index.html has no riff mode left in it",
  );
  check(
    /href="\.\/style\.css"/.test(riffPage) && /src="\.\/dist\/riff-main\.js"/.test(riffPage),
    "riff.html is wired to the shared stylesheet and its own entry module",
  );
  // The Pages workflow copies files by name, so a page that is not in the list
  // is a 404 on the live site and nothing local would ever notice.
  const workflow = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  check(
    /cp index\.html riff\.html style\.css _site\//.test(workflow),
    "the Pages workflow copies riff.html (otherwise the live riff builder 404s)",
  );

  // ---- The tool tab strip (Chords / Tab / Text / Settings). ----
  // Pure DOM wiring, invisible to the Node tests, so assert its shape here.
  {
    const styleCss = await readFile(new URL("../style.css", import.meta.url), "utf8");
    const riffMain = await readFile(new URL("../dist/riff-main.js", import.meta.url), "utf8");
    const tabs = [...riffPage.matchAll(/data-tool="(\w+)"/g)].map((m) => m[1]);
    const panels = [...riffPage.matchAll(/data-tool-panel="(\w+)"/g)].map((m) => m[1]);
    check(tabs.length === 4, `riff.html has four tool tabs (${tabs.join(", ")})`);
    check(
      JSON.stringify([...tabs].sort()) === JSON.stringify([...panels].sort()),
      `every tool tab has exactly one panel (tabs: ${tabs}; panels: ${panels})`,
    );
    const activeTabs = (riffPage.match(/fingering-tab is-active/g) ?? []).length;
    const hiddenPanels = (riffPage.match(/data-tool-panel="\w+" hidden/g) ?? []).length;
    check(activeTabs === 1, "exactly one tool tab starts active");
    check(hiddenPanels === tabs.length - 1, "every panel but the first starts hidden");
    // A flex `display` rule beats the hidden attribute's UA style, so the
    // panels all showed at once until the stylesheet started forcing it.
    check(
      /\[hidden\]\s*\{[^}]*display:\s*none/.test(styleCss),
      "style.css forces [hidden] to display:none (otherwise panels never hide)",
    );
    check(
      /data-tool-panel/.test(riffMain) && /dataset\.tool/.test(riffMain),
      "riff-main.ts wires tabs to panels via data-tool",
    );
    // The visual tab editor must exist exactly once (it used to live in two
    // panels at the same id, so the Tab panel was always empty).
    check((riffPage.match(/id="tab-editor"/g) ?? []).length === 1, "one #tab-editor in riff.html");
  }
  if (shipped) {
    const text = shipped[1].replace(/^\s*\n/, "").replace(/\s+$/, "");
    try {
      const riff = parseRiff(text, { tuning: STANDARD, maxFrets: 24, span: 5 });
      check(riff.events.length > 0, `the shipped default plays something (${riff.events.length} events)`);
      check(
        riff.warnings.length === 0,
        `the shipped default has no parse warnings (${riff.warnings.join("; ") || "none"})`,
      );
      check(
        riff.events.some((e) => e.kind === "chord") && riff.events.some((e) => e.kind === "note"),
        "the shipped default exercises both the chord stream and the tab lane",
      );
      // The shipped chord line is padded so each token lands on its bar's
      // character in the bar ruler. That padding is the whole "these two layers
      // share one grid" demonstration, and it is invisible until it drifts —
      // so assert the alignment instead of trusting the eyeball.
      const chordLine = text.split("\n").find((l) => /\bC\b\s+Am\b/.test(l));
      const laneLine = text.split("\n").find((l) => /^[eBGDAE]\|/.test(l));
      if (chordLine && laneLine) {
        const LANE_PREFIX = 2; // a lane body starts after its `e|`
        const perBar = Math.round(riff.beatsPerBar / riff.stepBeats);
        const tokens = chordLine.trim().split(/\s+/);
        check(
          tokens.length === Math.round(riff.totalBeats / riff.beatsPerBar),
          `the shipped chord line has one token per bar (${tokens.length} tokens, ${riff.totalBeats / riff.beatsPerBar} bars)`,
        );
        tokens.forEach((token, bar) => {
          const column = LANE_PREFIX + bar * perBar;
          check(
            chordLine.indexOf(token) === column,
            `chord "${token}" (bar ${bar + 1}) sits at character ${column}, on the ruler mark (got ${chordLine.indexOf(token)})`,
          );
        });
        // And the ruler has to agree with the lane it is measuring: bar N+1
        // starts `perBar` characters into the lane body.
        // Drop the lane letter and BOTH pipes to get its column count.
        const laneBody = laneLine.slice(LANE_PREFIX, -1);
        check(
          laneBody.length === Math.round(riff.totalBeats / riff.beatsPerBar) * perBar,
          `the shipped lane is a whole number of bars (${laneBody.length} columns, ${laneBody.length / perBar} bars)`,
        );
      } else {
        check(false, "the shipped default has both a chord line and a tab lane");
      }
    } catch (err) {
      check(false, `the shipped default parses (${err.message})`);
    }
  }

  // The timeline's horizontal geometry. This is a SOURCE-level check, because
  // the bug it guards was invisible to every runtime signal: the playhead ran
  // progressively behind the notes it passed (77px adrift by the last bar of
  // the shipped riff) and nothing threw, warned, or logged. It only shows up
  // as pixels, which is why it took a headless-browser measurement to find.
  //
  // The invariant: EVERYTHING horizontal is a FRACTION OF THE TRACK. Notes,
  // bar marks, the loop region and the playhead must all measure from the same
  // box in the same unit. It went wrong twice, in two different ways:
  //
  //  1. The track is `flex: 1 0 auto`, so it grows past its declared
  //     `cols * --riff-step`. Notes (a `left: %`) followed it; the playhead,
  //     loop region and bar marks multiplied a px `--riff-step` and did not.
  //  2. `100%` is only the track's width if the containing block IS the
  //     track. It was the scroll viewport, which differs whenever the track
  //     grows to fill a wide panel or overflows a narrow one -- 19px adrift by
  //     beat 10 in a 760px box. Hence `.riff-canvas`.
  const css = await readFile(new URL("../style.css", import.meta.url), "utf8");
  const renderSrc = await readFile(new URL("../dist/render.js", import.meta.url), "utf8");
  const timelineSrc = await readFile(new URL("../dist/timeline.js", import.meta.url), "utf8");
  // These are checks on CODE SHAPE, so run them on code with comments stripped:
  // each of these fixes quotes the line it replaced (to say why it changed), and
  // prose that mentions `tracks[anchorRow]?.` is not that call still existing.
  const code = renderSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // A note sits at its exact beat, never a rounded column index. A tab event's
  // beat IS a column so it is always on-grid, but a chord lands on a bar line,
  // and a bar line is only on-grid when beatsPerBar / step is a whole number
  // (`bar 5` with `step 0.75` put a chord 15px from the playhead's position).
  // The geometry moved into src/timeline.ts so it can be unit-tested without a
  // browser (tests/timeline.test.mjs); these assert the renderer still ROUTES
  // through it rather than recomputing a position inline, which is how the px
  // scale crept back in the first time.
  check(/group\.style\.left = `\$\{noteLeftPercent\(/.test(code),
    "a note is placed at its exact beat, via the shared timeline geometry");
  check(
    !/Math\.round\(event\.beat \/ stepBeats\)/.test(code),
    "a note is not snapped to a whole column (that moved chords off their beat)",
  );
  check(/--riff-bar-start", String\(barMarkFraction\(/.test(code),
    "a bar mark is a fraction of the loop, not a step count");

  // The positioned overlay hangs off a canvas whose width IS gutter + track,
  // so `100%` means the track in both the filling and the scrolling case.
  check(
    /\.riff-canvas\s*\{[\s\S]*?width: max-content;[\s\S]*?min-width: 100%/.test(css),
    ".riff-canvas is content-width with a viewport floor, so 100% is the track",
  );
  check(
    /canvas\.appendChild\(head\)/.test(code) && /box\.appendChild\(canvas\)/.test(code),
    "the playhead is a child of the canvas, not of the scroll viewport",
  );
  check(
    /\.riff-playhead\s*\{[\s\S]*?left: calc\(var\(--riff-gutter\) \+ \(100% - var\(--riff-gutter\)\) \* var\(--riff-head-frac/.test(css),
    "the playhead is placed as a fraction of the track width",
  );
  check(
    /\.riff-loop\s*\{[\s\S]*?left: calc\(var\(--riff-gutter\) \+ \(100% - var\(--riff-gutter\)\) \* var\(--riff-loop-a/.test(css)
      && /width: calc\(\(100% - var\(--riff-gutter\)\) \* \(var\(--riff-loop-b/.test(css),
    "the loop region is placed as a fraction of the track width",
  );
  // The step gridline's period has to be 100%/cols of the track, or it drifts
  // against the notes by exactly the amount the track grew.
  check(
    /repeating-linear-gradient\([\s\S]*?transparent 1px calc\(100% \/ var\(--riff-cols\)\)/.test(css),
    "the step gridline's period is 100%/cols of the track, not a px step",
  );
  // The regression that actually bit: a px step multiplied into a position.
  // `\s*\{` matters: without it this also matches `.riff-bar-track, .riff-track`,
  // whose `--riff-step` is the track's declared minimum WIDTH, not a position.
  const pxPositioned = [...css.matchAll(/^\.(riff-(?:playhead|loop|bar))\s*\{([^}]*)\}/gm)]
    .filter(([, , body]) => /left|width/.test(body) && /var\(--riff-step\)/.test(body))
    .map(([, sel]) => sel);
  // The canvas must be attached BEFORE the note loop looks its rows up through
  // it. A detached canvas makes `querySelectorAll(".riff-track")` empty, every
  // note computes a negative row index, and `tracks[anchorRow]?.appendChild`
  // discards all of them -- the timeline renders bars and rows and NO notes,
  // with nothing thrown and nothing logged. (Cost me one round of exactly
  // that: a geometry probe reported "perfect" because it skipped missing
  // notes, so zero notes read as zero drift.)
  const attachAt = code.indexOf("box.appendChild(canvas)");
  const tracksAt = code.indexOf('const tracks = box.querySelectorAll');
  check(
    attachAt !== -1 && tracksAt !== -1 && attachAt < tracksAt,
    `the canvas is attached before the note loop queries it (attach @${attachAt}, query @${tracksAt})`,
  );
  // And the note loop must not be able to drop a group silently: every event
  // has to reach a real row.
  check(
    !/tracks\[anchorRow\]\?\./.test(code),
    "a note group is appended to a row unconditionally, not via a silent optional chain",
  );
  check(
    pxPositioned.length === 0,
    `no playhead/loop/bar rule positions itself with a px --riff-step (${pxPositioned.join(", ") || "none do"})`,
  );

  // The ear-check page embeds its own copy of the default so it can run the
  // real parser. Two copies of an example WILL drift, so require them equal.
  const earCheck = await readFile(new URL("../debug/riff-debug.html", import.meta.url), "utf8");
  const embedded = earCheck.match(/const DEFAULT_TEXT = `([\s\S]*?)`;/);
  check(embedded !== null, "riff-debug.html embeds a default notation");
  if (shipped && embedded) {
    const norm = (t) => t.replace(/^\s*\n/, "").replace(/\s+$/, "");
    check(
      norm(embedded[1]) === norm(shipped[1]),
      "riff-debug.html and riff.html agree on the default notation",
    );
  }

  // Every fenced notation block in the docs that carries tab lanes must parse.
  for (const [name, doc] of [
    ["README.md", readme],
    ["AGENTS.md", agents],
  ]) {
    // Fences may carry a language tag (```bash), so don't assume a bare ```.
    const blocks = [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
      .map((m) => m[1])
      .filter((b) => /^[eBGDAE]\|/m.test(b));
    check(blocks.length > 0, `${name} documents a notation example with tab lanes`);
    for (const block of blocks) {
      try {
        parseRiff(block, { tuning: STANDARD, maxFrets: 24, span: 5 });
        check(true, `${name} notation example parses`);
      } catch (err) {
        check(false, `${name} notation example parses (${err.message})`);
      }
    }
  }
}

// ---- The voicing browser: pins are commands, the search is only a default. ----
{
  const riffOpts = { tuning: STANDARD, maxFrets: 24, span: 5, cap: 400 };

  // A pin is exactly the frets the user picked, and the search cannot override it.
  const pinned = parseRiff("C Am", { ...riffOpts, pins: [{ name: "C", shape: "x32010" }] });
  check(chordShape(pinned.events[0].frets) === "x32010", "a pinned chord plays exactly the pinned shape");
  check(pinned.events[0].pinned === true, "a pinned chord is flagged as pinned");
  check(pinned.events[1].pinned === false, "an unpinned chord in the same stream is not flagged");
  check(
    chordShape(pinned.events[1].frets) !== chordShape(parseRiff("C Am", riffOpts).events[1].frets),
    "pinning a chord re-optimizes the chords AFTER it around the new shape",
  );

  // Pins are index-aligned with the chord stream, so an edit that changes which
  // chord sits under a pin must drop it rather than re-voice a different chord.
  const stale = parseRiff("C Am", { ...riffOpts, pins: [{ name: "Am", shape: "x02210" }] });
  check(stale.events[0].pinned === false, "a pin whose chord name moved is ignored, not applied to the wrong chord");
  check(chordShape(stale.events[0].frets) === chordShape(parseRiff("C Am", riffOpts).events[0].frets),
    "an ignored pin leaves the auto voicing exactly as it was");

  // A pin that cannot be honored is a hard, legible error — not a silent
  // fallback to auto, which would leave the user hearing a shape they did not pick.
  let threw = null;
  try { parseRiff("C", { ...riffOpts, pins: [{ name: "C", shape: "xX201x" }] }); } catch (e) { threw = e.message; }
  check(threw !== null && /not a shape/.test(threw), `a malformed pinned shape is refused (${threw})`);
  threw = null;
  try { parseRiff("C", { ...riffOpts, pins: [{ name: "C", shape: "x9x9x9" }] }); } catch (e) { threw = e.message; }
  check(threw !== null && /within 5 frets/.test(threw), `a shape outside the span is refused (${threw})`);

  // parseChordShape round-trips, and rejects what a shape cannot be.
  check(JSON.stringify(parseChordShape("x32010")) === JSON.stringify([null, 3, 2, 0, 1, 0]), "parseChordShape reads a printed shape low string first");
  check(parseChordShape("xxxxxx") === null, "a shape with nothing sounding is not a shape");
  check(parseChordShape("x3201") === null, "a five-character shape is not a shape");
  check(parseChordShape("x320100") === null, "a seven-character shape is not a shape");

  // The browse list is the search's own candidate set, ordered by movement.
  const ranked = rankGuitarVoicings(parseProgression("Am")[0].pitchClasses, STANDARD, 24, 5, [null, 3, 2, 0, 1, 0]);
  check(ranked.length > 0, `the browser has candidates to walk (${ranked.length})`);
  check(
    ranked.every((entry, i) => i === 0 || ranked[i - 1].cost <= entry.cost),
    "the browse list is ordered by how little the hand moves",
  );
  const shapes = new Set(ranked.map((entry) => entry.shape));
  check(shapes.size === ranked.length, "the browse list has no duplicate shapes");
  check(
    ranked.slice(0, 5).some((entry) => entry.shape === "x02210"),
    `the classic open Am is reachable near the top of the list (top 5: ${ranked.slice(0, 5).map((e) => e.shape).join(" ")})`,
  );
  // Every step the browser offers must be a shape the search itself would have
  // considered, or stepping could land on something the plan can never play.
  const candidateShapes = new Set(
    findFingerings(parseProgression("Am")[0].pitchClasses, STANDARD, 24, 5, 400).fingerings.map((f) => chordShape(f.frets)),
  );
  check(
    ranked.every((entry) => candidateShapes.has(entry.shape)),
    "every browsable voicing is one the voicing search would have considered",
  );
  check(
    ranked[0].cost <= 6,
    `the top of the list is genuinely close to the previous chord (cost ${ranked[0].cost} from x32010)`,
  );
  // With no previous chord every candidate costs the same, so the order comes
  // down to the tie-break. It has to lead with the shapes a guitarist reaches
  // for, or the browse list is alphabetical noise — and the search's own pick
  // then sits at an arbitrary rank like 350 of 400, with ◀ ▶ walking deeper
  // into the same thin tail instead of toward better shapes.
  const cold = rankGuitarVoicings(parseProgression("C")[0].pitchClasses, STANDARD, 24, 5, null);
  check(
    cold[0].sounded === 6 && cold[0].shape === "032010",
    `a chord with no predecessor leads with the classic open shape (${cold[0].shape}, ${cold[0].sounded} strings)`,
  );
  check(
    cold.every((entry, i) => i === 0 || cold[i - 1].sounded >= entry.sounded),
    "the cold list never gains strings as it goes (fuller first)",
  );
  check(
    cold[0].top <= cold[cold.length - 1].top,
    `the cold list starts low on the neck (top fret ${cold[0].top} first, ${cold[cold.length - 1].top} last)`,
  );
  check(
    cold.findIndex((entry) => entry.shape === "xx201x") > 0,
    "the search's own thin pick is NOT first in the browse list (that is the point of the builder)",
  );
}

// ---- The app must act on what is in the notation box. ----
// The parser is covered above; this is a source check on the wiring, because
// the failure it guards is a SILENT one. The box used to have no `input`
// listener at all, so an edit only took effect when "Find" was pressed, and Play
// then played the previous plan; with `riffPlan` null, `startRiff` returned
// without a sound or a message. Neither shows up in an audio assertion, so
// assert the wiring exists.
{
  const entry = await readFile(new URL("../src/riff-main.ts", import.meta.url), "utf8");
  check(
    /text\.addEventListener\("input"/.test(entry),
    "the riff notation box re-plans as you type (input listener present)",
  );
  check(
    /RIFF_EDIT_MS/.test(entry),
    "the re-plan is debounced (a re-voice per keystroke is wasted work)",
  );
  // The invariant is "the plan is rebuilt before the transport that plays it",
  // not "before some other call" — assert the two in order rather than pinning
  // the check to whatever else happens to sit between them.
  const start = entry.slice(entry.indexOf("function start()"), entry.indexOf("playButton.addEventListener"));
  const refreshed = start.indexOf("refresh()");
  const built = start.indexOf("new RiffTransport");
  check(
    refreshed >= 0 && built >= 0 && refreshed < built,
    "Play re-plans before playing, so it can never play a stale plan",
  );
  check(
    /stop\(\)/.test(entry.slice(entry.indexOf('text.addEventListener("input"'))),
    "editing the notation stops playback (a redrawn timeline must not argue with a ringing loop)",
  );

  // The strum box writes the shared audio config and must NOT re-plan: a
  // re-plan rewrites the field from that config on every keystroke, which
  // silently undoes the edit (type 40, field snaps back to 140). A pure
  // re-planning page cannot catch this — it is only visible as a value that
  // refuses to change — so assert the wiring shape: strum has its own handler
  // and is absent from the re-plan list.
  check(
    /strumInput\.addEventListener\("input", applyStrum\)/.test(entry),
    "the strum box has its own handler",
  );
  check(
    /const rePlan = \[[^\]]*\]/.test(entry) || /for \(const input of \[tuningSelect[^\]]*\]/.test(entry),
    "the re-plan input list exists to assert strum is not in it",
  );
  const rePlanList = (entry.match(/for \(const input of \[([^\]]*)\]/) || [, ""])[1];
  check(
    !/strumInput/.test(rePlanList),
    `strum is not in the re-plan list (that is what made the field un-editable): ${rePlanList.trim()}`,
  );

}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);