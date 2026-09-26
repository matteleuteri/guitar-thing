import { findFingerings, findPositions } from "../dist/fretboard.js";
import { findPianoKeys, findPianoVoicings } from "../dist/piano.js";
import { chordName, midiName, noteName, parseNotes, parseStringMidi, parseChord } from "../dist/theory.js";
import { parseProgression, planGuitarSong, planPianoSong } from "../dist/song.js";
import { parseRiff, secondsPerBeat } from "../dist/riff.js";
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
  const a = parseRiff("e|0 0 0 0|", riffOpts);
  const b = parseRiff("e|0 0 0 0|\nstep 1", riffOpts);
  check(a.events[3].beat === 1.5, `default step 0.5 -> beat 1.5 (got ${a.events[3].beat})`);
  check(b.events[3].beat === 3, `step 1 -> beat 3 (got ${b.events[3].beat})`);
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
  // 4 single notes on the open strings, 120bpm => 0.5s per half-beat step,
  // a 2-bar window = 1.0s per pass, 4 events per pass.
  const r = parseRiff("tempo 120\nbar 4\ne|0 0 0 0|", riffOpts);
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
  // rather than the timer — the whole point of anchoring.
  const period = fired[4].when - fired[0].when;
  check(Math.abs(period - 1.0) < 1e-6, `transport: the 2-beat window repeats every 1.0s (got ${period})`);

  // A wider window repeats more slowly: 4 beats at 120bpm is a 2s pass, and
  // this riff has no notes in its second bar, so they cluster per pass.
  t.stop();
  t.setLoop(0, 4);
  clock = 0;
  fired.length = 0;
  t.play(0);
  for (let i = 0; i <= 300; i++) { clock = i * 0.02; t.advance(clock); }
  check(Math.abs((fired[4].when - fired[0].when) - 2.0) < 1e-6,
    `transport: a 4-beat window repeats every 2.0s (got ${fired[4].when - fired[0].when})`);
  check(fired.filter((f) => f.when <= 4 + 1e-9).length === 9,
    `transport: 4s of a 2s loop plays 9 notes (got ${fired.filter((f) => f.when <= 4 + 1e-9).length})`);

  t.stop();
  check(t.playing === false, "transport: stop() halts the scheduler");
  const before = fired.length;
  clock += 2;
  t.advance(clock);
  check(fired.length === before, "transport: advance() after stop() places nothing new");
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
  const index = await readFile(new URL("../index.html", import.meta.url), "utf8");

  const shipped = index.match(/<textarea id="riff-text"[^>]*>([\s\S]*?)<\/textarea>/);
  check(shipped !== null, "index.html still carries a default riff notation");
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
    } catch (err) {
      check(false, `the shipped default parses (${err.message})`);
    }
  }

  // The ear-check page embeds its own copy of the default so it can run the
  // real parser. Two copies of an example WILL drift, so require them equal.
  const earCheck = await readFile(new URL("../debug/riff-debug.html", import.meta.url), "utf8");
  const embedded = earCheck.match(/const DEFAULT_TEXT = `([\s\S]*?)`;/);
  check(embedded !== null, "riff-debug.html embeds a default notation");
  if (shipped && embedded) {
    const norm = (t) => t.replace(/^\s*\n/, "").replace(/\s+$/, "");
    check(
      norm(embedded[1]) === norm(shipped[1]),
      "riff-debug.html and index.html agree on the default notation",
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);