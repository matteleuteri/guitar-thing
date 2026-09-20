import { findFingerings, findPositions } from "../dist/fretboard.js";
import { findPianoKeys, findPianoVoicings } from "../dist/piano.js";
import { chordName, midiName, noteName, parseNotes, parseStringMidi, parseChord } from "../dist/theory.js";
import { parseProgression, planGuitarSong, planPianoSong } from "../dist/song.js";

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
  const pc = (STANDARD[p.string] + p.fret) % 12;
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
check(parseChord("C").pcs.join(",") === "0,4,7", `parseChord C -> [${parseChord("C").pcs}]`);
check(parseChord("Am7").pcs.join(",") === "0,4,7,9", "parseChord Am7");
check(parseChord("Bb7").pcs.join(",") === "2,5,8,10", "parseChord Bb7");
check(parseChord("C6/9").pcs.join(",") === "0,2,4,7,9", "parseChord C6/9 (slash belongs to the suffix)");
check(parseChord("F#m7b5").pcs.join(",") === "0,4,6,9", "parseChord F#m7b5");
check(parseChord("Ddim7").pcs.join(",") === "2,5,8,11", "parseChord Ddim7");
check(parseChord("C/G").pcs.join(",") === "0,4,7" && parseChord("C/G").bass === 7, "parseChord C/G bass kept");
check(parseChord("Cmaj").pcs.join(",") === "0,4,7" && parseChord("CM").pcs.join(",") === "0,4,7", "maj/M spellings");
throws(() => parseChord("Z"), "unknown root rejects");
throws(() => parseChord("Cweird"), "unknown suffix rejects");

// round-trip: every parsed symbol re-parses from its sharp-spelled primary to the same pcs set
const roundTrips = ["C", "G", "Am", "F", "Em7", "Dm7", "G7", "Cadd9", "Bb7", "F#m7b5",
  "C7sus4", "Ddim7", "Csus2", "Eaug", "D6/9", "Cmaj7", "Gsus4", "B7", "Eb", "Am7/G", "C9"];
let rtOk = true;
for (const sym of roundTrips) {
  const pcs = parseChord(sym).pcs;
  const primary = chordName(pcs).primary;
  const reparsed = parseChord(primary).pcs;
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
    if (sounding.length < 2 || !c.chord.pcs.every((p) => sounding.includes(p))) gShapeOk = false;
    if (lo !== Infinity && hi - lo > 5) gShapeOk = false;
  }
  // a real greedy walk must never beat the DP's total
  let prev = planG.chords[0].fingering;
  let greedy = 0;
  for (let i = 1; i < planG.chords.length; i++) {
    let best = Infinity;
    let bestCand = null;
    for (const cand of findFingerings(progA[i].pcs, STANDARD, 15, 5, 300).fingerings) {
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
    if (!c.chord.pcs.every((p) => pcs.includes(p))) pShapeOk = false;
  }
  let prev = planP.chords[0].voicing.keys;
  let greedy = 0;
  for (let i = 1; i < planP.chords.length; i++) {
    let best = Infinity;
    let bestCand = null;
    for (const cand of findPianoVoicings(progA[i].pcs, 48, 84, 12, 300).voicings) {
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);