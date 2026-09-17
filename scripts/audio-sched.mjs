/**
 * Dependency-free audio-scheduling test. Web Audio can't run under Node, so we
 * stub just enough of it to exercise the *host-side* voice graph built by
 * `dist/audio.js` and assert the invariants that matter for "a chord must
 * sound like separate strings":
 *
 *   1. Every scheduled voice must be silent from time 0 until its strum slot.
 *      (Regression guard: a GainNode's AudioParam defaults to 1.0 and an
 *      AudioWorkletNode sounds the moment it is connected, so if we forget to
 *      zero the gain the whole chord leaks at once and fuses into one pluck —
 *      this was the real "it still sounds like one sound" bug.)
 *   2. The voices must be spread out over time, not stacked at one instant.
 *   3. Each voice must carry a distinct systematic identity (brightness,
 *      attack, role), not just random variation.
 *
 * Runs via `npm test` after `npm run build`.
 */

class Param {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(value, time) {
    this.events.push({ type: "set", value, time });
    return this;
  }
  exponentialRampToValueAtTime(value, time) {
    this.events.push({ type: "ramp", value, time });
    return this;
  }
}

class Node {
  connect() {
    return this;
  }
  disconnect() {}
}

class Ctx {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = "running";
    this.destination = new Node();
    this.audioWorklet = { addModule: async () => {} };
  }
  resume() {
    return Promise.resolve();
  }
  createGain() {
    return Object.assign(new Node(), { gain: new Param(1) });
  }
  createStereoPanner() {
    return Object.assign(new Node(), { pan: new Param(0) });
  }
  createBiquadFilter() {
    return Object.assign(new Node(), { type: "", frequency: new Param(), gain: new Param(), Q: new Param() });
  }
  createDelay() {
    return Object.assign(new Node(), { delayTime: new Param() });
  }
  createDynamicsCompressor() {
    return Object.assign(new Node(), {
      threshold: new Param(),
      knee: new Param(),
      ratio: new Param(),
      attack: new Param(),
      release: new Param(),
    });
  }
  createAnalyser() {
    return Object.assign(new Node(), { fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 2048 });
  }
}

const failures = [];
const check = (ok, msg) => {
  console.log((ok ? "ok   " : "FAIL ") + msg);
  if (!ok) failures.push(msg);
};

globalThis.AudioContext = Ctx;
globalThis.AudioWorkletNode = class extends Node {
  constructor() {
    super();
    this.port = { onmessage: null, postMessage() {} };
  }
};

const audio = await import(new URL("../dist/audio.js", import.meta.url).href);
const { playVoicing, getAudioDebugEvents } = audio;
// Make the test deterministic: the *systematic* per-string identity must be
// distinct on its own; random humanization is layered on top in the app.
const { DEFAULT_CONFIG } = await import(new URL("../dist/synth/config.js", import.meta.url).href);
DEFAULT_CONFIG.variation.brightnessSpread = 0;
DEFAULT_CONFIG.variation.dampingSpread = 0;
DEFAULT_CONFIG.variation.sustainSpread = 0;
DEFAULT_CONFIG.variation.velocitySpread = 0;

// Capture every gain created so we can find the per-voice gate nodes.
const gains = [];
const origCreateGain = Ctx.prototype.createGain;
Ctx.prototype.createGain = function () {
  const g = origCreateGain.call(this);
  gains.push(g);
  return g;
};

playVoicing([3, 3, 2, 0, 1, 0], [40, 45, 50, 55, 59, 64]); // open C
await new Promise((r) => setTimeout(r, 30));

const evs = getAudioDebugEvents();
check(evs.length === 6, `open C schedules 6 voices (got ${evs.length})`);

// The voice gates are the gains that got an exponential ramp.
const gates = gains.filter((g) => g.gain.events.some((e) => e.type === "ramp"));
check(gates.length === evs.length, `one volume gate per voice (gates=${gates.length}, voices=${evs.length})`);

// 1. Silent hold from time 0 until the strum slot.
let gatedFromZero = 0;
for (const g of gates) {
  const first = g.gain.events[0];
  if (first && first.type === "set" && first.time === 0 && first.value <= 0.001) gatedFromZero++;
}
check(gatedFromZero === gates.length, `every voice is silent from t=0 (${gatedFromZero}/${gates.length}) — no simultaneous leak`);

// 2. Spread over time, not stacked.
const starts = evs.map((e) => e.t).sort((a, b) => a - b);
const span = starts[starts.length - 1] - starts[0];
check(span > 0.4, `voices are strummed over time (span ${(span * 1000).toFixed(0)}ms > 400ms)`);
let monotonic = true;
for (let i = 1; i < starts.length; i++) if (starts[i] <= starts[i - 1]) monotonic = false;
check(monotonic, "voice start times are strictly increasing (a real downstroke)");

// 3. Systematic per-voice identity (not one identical param set).
const bright = new Set(evs.map((e) => e.brightness.toFixed(3)));
const att = new Set(evs.map((e) => e.attackMs));
check(bright.size === evs.length, `each voice has a distinct brightness (${bright.size}/${evs.length})`);
check(att.size === evs.length, `each voice has a distinct attack envelope (${att.size}/${evs.length})`);
check(evs.some((e) => e.role === "root") && evs.some((e) => e.role === "color"), "root and color roles are both assigned");

// High strings must be far brighter / snappier than low strings.
const high = evs[0];
const low = evs[evs.length - 1];
check(high.brightness > low.brightness + 0.3, `high string is much brighter (${high.brightness.toFixed(2)} vs ${low.brightness.toFixed(2)})`);
check(high.attackMs < low.attackMs, `high string attacks faster (${high.attackMs}ms vs ${low.attackMs}ms)`);

if (failures.length) {
  console.error(`\nAUDIO FAILURES (${failures.length})`);
  process.exit(1);
}
console.log("\nAUDIO ALL PASS");
