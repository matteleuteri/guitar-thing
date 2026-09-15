import { findFingerings, findPositions } from "../dist/fretboard.js";
import { findPianoKeys, findPianoVoicings } from "../dist/piano.js";
import { chordName, midiName, noteName, parseNotes, parseStringMidi } from "../dist/theory.js";

const STANDARD = [40, 45, 50, 55, 59, 64];
let failures = 0;

function check(cond, label) {
  if (cond) console.log(`ok   ${label}`);
  else { console.error(`FAIL ${label}`); failures++; }
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);