/**
 * The note identifier's pitch detector.
 *
 * It must read a monophonic tone's fundamental from a raw PCM frame: the
 * nearest equal-tempered MIDI note and the cents offset from it. These tests
 * drive it with synthetic sines (harmonics included, since a real string has
 * them) rather than a recording, so they are exact and dependency-free.
 *
 * The failure mode they guard: a detector that silently reports an octave
 * (or a fifth) off, or that returns a confident note for silence — both read
 * as "it hears the wrong note" with no error.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectPitch } from "../dist/pitch.js";

const SR = 44100;

/** A frame of a tone: fundamental plus `harmonics` partials at 1/n amplitude. */
function tone(freq, { seconds = 0.05, harmonics = 4, amp = 0.5 } = {}) {
  const n = Math.round(SR * seconds);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * freq * h * t) / h;
    buf[i] = v * amp * 0.5;
  }
  return buf;
}

test("identifies a concert A (440 Hz) as MIDI 69 with ~0 cents", () => {
  const res = detectPitch(tone(440), SR);
  assert.ok(res, "a clean 440 Hz tone must be detected");
  assert.equal(res.midi, 69);
  assert.ok(Math.abs(res.cents) <= 5, `cents should be ~0, got ${res.cents}`);
  assert.ok(Math.abs(res.freq - 440) < 2, `freq should be ~440, got ${res.freq}`);
});

test("identifies the open low E of a guitar (E2, 82.41 Hz)", () => {
  const res = detectPitch(tone(82.4069), SR, 60, 1400);
  assert.ok(res, "82.41 Hz must be above the low cutoff");
  assert.equal(res.midi, 40);
  assert.ok(Math.abs(res.cents) <= 5, `cents ~0, got ${res.cents}`);
});

test("identifies the open high E of a guitar (E4, 329.63 Hz)", () => {
  const res = detectPitch(tone(329.6276), SR, 60, 1400);
  assert.ok(res);
  assert.equal(res.midi, 64);
  assert.ok(Math.abs(res.cents) <= 5);
});

test("reads a sharp note and reports positive cents", () => {
  // A4 pushed 30 cents sharp
  const freq = 440 * 2 ** (30 / 1200);
  const res = detectPitch(tone(freq), SR);
  assert.ok(res);
  assert.equal(res.midi, 69);
  assert.ok(res.cents >= 20 && res.cents <= 40, `expected ~+30, got ${res.cents}`);
});

test("reads a flat note and reports negative cents", () => {
  const freq = 440 * 2 ** (-35 / 1200);
  const res = detectPitch(tone(freq), SR);
  assert.ok(res);
  assert.equal(res.midi, 69);
  assert.ok(res.cents <= -25 && res.cents >= -45, `expected ~-35, got ${res.cents}`);
});

test("a loud octave partial does not become the reported note", () => {
  // A3 (220 Hz) whose 440 Hz partial is louder. A peak-finder reads the loud
  // partial (A4); the true fundamental is A3, and an octave-down-biased
  // autocorrelation reads A2 — the detector must report neither.
  const n = Math.round(SR * 0.05);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    buf[i] = 0.15 * Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t);
  }
  const res = detectPitch(buf, SR);
  assert.ok(res);
  assert.equal(res.midi, 57, "should read the fundamental A3, not the octave A4/A2");
});

test("returns null for silence (no confident note)", () => {
  const silence = new Float32Array(2048);
  assert.equal(detectPitch(silence, SR), null);
});

test("returns null for a frame shorter than the minimum window", () => {
  assert.equal(detectPitch(new Float32Array(256), SR), null);
});

test("rejects a tone below the configured minimum frequency", () => {
  // 40 Hz (near E1) with a 60 Hz floor: must not claim a note.
  const res = detectPitch(tone(40, { seconds: 0.1 }), SR, 60, 1400);
  assert.equal(res, null);
});
