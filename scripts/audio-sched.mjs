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
 *      attack, tail decay, scrape brightness/length, role), not just random
 *      variation.
 *
 * Plus a piano scenario (`playNotes(keys, true)`): a piano voicing's keys must
 * each ring with their own register identity too (bright/attack/sustain differ
 * by MIDI note, bass→treble), so a piano chord stops reading as one pluck.
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
  createConvolver() {
    return Object.assign(new Node(), { normalize: false, buffer: null });
  }
  createBuffer() {
    return { copyToChannel() {} };
  }
  createBufferSource() {
    return Object.assign(new Node(), {
      buffer: null,
      playbackRate: new Param(1),
      detune: new Param(0),
      start() {},
      stop() {},
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
const { playVoicing, playNotes, getAudioDebugEvents, setSample, setEngineMode } = audio;
// Deterministic engines: scenario 1 exercises the synthesized K–S voices, then
// the engine is switched per scenario. (In the real app the default is "smplr"
// — the first play then primes the kit — but here each path is tested in turn,
// and the real smplr package is never constructed because it would try to load
// a 2.6 MB kit under Node.)
setEngineMode("synth");
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
const starts = evs.map((e) => e.time).sort((a, b) => a - b);
const span = starts[starts.length - 1] - starts[0];
check(span > 0.4, `voices are strummed over time (span ${(span * 1000).toFixed(0)}ms > 400ms)`);
let monotonic = true;
for (let i = 1; i < starts.length; i++) if (starts[i] <= starts[i - 1]) monotonic = false;
check(monotonic, "voice start times are strictly increasing (a real downstroke)");

// 3. Systematic per-voice identity (not one identical param set).
const bright = new Set(evs.map((e) => e.brightness.toFixed(3)));
const att = new Set(evs.map((e) => e.attackMs));
const dcy = new Set(evs.map((e) => e.decay.toFixed(3)));
const pb = new Set(evs.map((e) => e.pickBright.toFixed(3)));
const pd = new Set(evs.map((e) => e.pickDecayMs));
check(bright.size === evs.length, `each voice has a distinct brightness (${bright.size}/${evs.length})`);
check(att.size === evs.length, `each voice has a distinct attack envelope (${att.size}/${evs.length})`);
check(dcy.size === evs.length, `each voice has a distinct tail decay (${dcy.size}/${evs.length})`);
check(pb.size === evs.length, `each voice has a distinct scrape brightness (${pb.size}/${evs.length})`);
check(pd.size === evs.length, `each voice has a distinct scrape length (${pd.size}/${evs.length})`);
// Attack bloom: each string settles a different amount (measured: the highs
// shed 10..25 dB of transient energy in the first second, the lows barely),
// so every voice's early level follows its own curve.
const blo = new Set(evs.map((e) => e.bloom.toFixed(3)));
check(blo.size === evs.length, `each voice has a distinct attack bloom (${blo.size}/${evs.length})`);
// String life: the wobble depth and the body thump follow the string's place
// in the instrument (more on the wound lows), so they stay systematic too.
const lif = new Set(evs.map((e) => e.lifeAmt.toFixed(4)));
const thu = new Set(evs.map((e) => e.thump.toFixed(3)));
check(lif.size === evs.length, `each voice has a distinct string-life wobble (${lif.size}/${evs.length})`);
check(thu.size === evs.length, `each voice has a distinct body thump (${thu.size}/${evs.length})`);
check(evs.some((e) => e.role === "root") && evs.some((e) => e.role === "color"), "root and color roles are both assigned");

// High strings must be far brighter / snappier than low strings.
const high = evs[0];
const low = evs[evs.length - 1];
check(high.brightness > low.brightness + 0.3, `high string is much brighter (${high.brightness.toFixed(2)} vs ${low.brightness.toFixed(2)})`);
check(high.attackMs < low.attackMs, `high string attacks faster (${high.attackMs}ms vs ${low.attackMs}ms)`);
// And darken slower: wound lows lose high partials fast, plain highs keep them.
check(high.decay < low.decay, `high string's tail stays brighter (decay ${high.decay.toFixed(2)} vs ${low.decay.toFixed(2)})`);
// The onsets themselves must differ: high string scrapes bright and short,
// low string dark and lingering — separation from the very first sample.
check(high.pickBright > low.pickBright, `high string's scrape is brighter (${high.pickBright.toFixed(2)} vs ${low.pickBright.toFixed(2)})`);
check(high.pickDecayMs < low.pickDecayMs, `high string's scrape is shorter (${high.pickDecayMs}ms vs ${low.pickDecayMs}ms)`);
// And the highs bloom deepest: their transient energy shed is the measured
// reason chords fused into a single level-plateau.
check(high.bloom > low.bloom, `high string's attack bloom is deeper (${high.bloom.toFixed(2)} vs ${low.bloom.toFixed(2)})`);
// The box: wound strings shake the top hard, the plains barely touch it —
// and the plains' wobble is the lightest.
check(low.thump > high.thump, `low string's body thump is stronger (${low.thump.toFixed(2)} vs ${high.thump.toFixed(2)})`);
check(low.lifeAmt > high.lifeAmt, `low string's loop wobbles more (${low.lifeAmt.toFixed(4)} vs ${high.lifeAmt.toFixed(4)})`);

// ---------------------------------------------------------------------------
// Piano: keys ring apart by register, not as one identical pluck.
// ---------------------------------------------------------------------------
const gainsBeforePiano = gains.length;
playNotes([48, 52, 55, 59, 64], true); // Cmaj-ish keys across the default range
await new Promise((r) => setTimeout(r, 30));

const pevs = getAudioDebugEvents().slice(evs.length);
check(pevs.length === 5, `piano voicing schedules 5 voices (got ${pevs.length})`);

const pgates = gains.slice(gainsBeforePiano).filter((g) => g.gain.events.some((e) => e.type === "ramp"));
check(pgates.length === pevs.length, `one volume gate per piano voice (gates=${pgates.length}, voices=${pevs.length})`);

let pgatedFromZero = 0;
for (const g of pgates) {
  const first = g.gain.events[0];
  if (first && first.type === "set" && first.time === 0 && first.value <= 0.001) pgatedFromZero++;
}
check(pgatedFromZero === pgates.length, `every piano voice is silent from t=0 (${pgatedFromZero}/${pgates.length})`);

// Register interpolation must give each key its own identity (deterministic:
// variation is zeroed above).
const pbright = new Set(pevs.map((e) => e.brightness.toFixed(3)));
const patt = new Set(pevs.map((e) => e.attackMs));
const psus = new Set(pevs.map((e) => e.sustain.toFixed(6)));
check(pbright.size === pevs.length, `each piano key has a distinct brightness (${pbright.size}/${pevs.length})`);
check(patt.size === pevs.length, `each piano key has a distinct attack envelope (${patt.size}/${pevs.length})`);
check(psus.size === pevs.length, `each piano key has a distinct sustain (${psus.size}/${pevs.length})`);
// The guitar's box thump is a guitar thing — keys stay clean of it.
check(pevs.every((e) => e.thump === 0), "piano keys carry no guitar body thump");

// Low keys must be darker / slower than high keys, and the voicing's bass sits
// left while its treble sits right.
const pbass = pevs[0];
const ptreb = pevs[pevs.length - 1];
check(pbass.brightness < ptreb.brightness - 0.1, `low key is darker (${pbass.brightness.toFixed(2)} vs ${ptreb.brightness.toFixed(2)})`);
check(pbass.attackMs > ptreb.attackMs, `low key thumps slower (${pbass.attackMs}ms vs ${ptreb.attackMs}ms)`);
check(pevs.some((e) => e.role === "root") && pevs.some((e) => e.role === "color"), "piano root and color roles are both assigned");
check(pbass.pan < 0 && ptreb.pan > 0, `piano bass pans left, treble right (${pbass.pan.toFixed(2)} vs ${ptreb.pan.toFixed(2)})`);

// ---------------------------------------------------------------------------
// Recorded-string samples (progress 20): a filled bank plays every sounding
// string from a real recording, transposed to the nearest recorded open
// string. The sample voices must obey the exact same music: silent from t=0
// until their strum slot, spread over time, and transposed to the right note.
// ---------------------------------------------------------------------------
// Give the bank six recorded open strings (E2..E4 standard tuning). A short
// sine keeps trimToOnset happy; what matters here is the scheduling graph.
const TUNING = [40, 45, 50, 55, 59, 64];
const tone = new Float32Array(24000); // 0.5s @ 48000
for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 110 * i) / 48000);
for (let i = 0; i < TUNING.length; i++) setSample(i, TUNING[i], tone, 48000);
setEngineMode("samples");

const gainsBeforeSamples = gains.length;
const samplesStart = getAudioDebugEvents().length;
playVoicing([0, 3, 2, 0, 1, 0], TUNING); // open C, all six strings
await new Promise((r) => setTimeout(r, 30));

const sevs = getAudioDebugEvents().slice(samplesStart);
check(sevs.length === 6, `open C with a full sample bank schedules 6 sample voices (got ${sevs.length})`);
check(sevs.every((e) => e.kind === "sample"), "every voice of the chord is a real recorded sample");
// Each note must be produced by transposing a *recorded* open string to the
// target: source = midi - shift must be one of the banked open notes, within
// the maxShift budget (beyond it the synth should have taken over).
check(
  sevs.every((e) => Math.abs(e.shift) <= 12 && TUNING.includes(e.midi - e.shift)),
  "every transposition maps a recorded open string to the target note",
);

// The sample voices need their own gates — and those gates carry the same
// silent-from-zero rule or the whole chord leaks at once (the one-sound bug).
const sgates = gains.slice(gainsBeforeSamples).filter((g) => g.gain.events.some((e) => e.type === "ramp"));
check(sgates.length === sevs.length, `one volume gate per sample voice (gates=${sgates.length}, voices=${sevs.length})`);
let sgatedFromZero = 0;
for (const g of sgates) {
  const first = g.gain.events[0];
  if (first && first.type === "set" && first.time === 0 && first.value <= 0.001) sgatedFromZero++;
}
check(sgatedFromZero === sgates.length, `every sample voice is silent from t=0 (${sgatedFromZero}/${sgates.length}) — no simultaneous leak`);

const sstarts = sevs.map((e) => e.time).sort((a, b) => a - b);
const sspan = sstarts[sstarts.length - 1] - sstarts[0];
check(sspan > 0.4, `sample voices are strummed over time (span ${(sspan * 1000).toFixed(0)}ms > 400ms)`);
let smonotonic = true;
for (let i = 1; i < sstarts.length; i++) if (sstarts[i] <= sstarts[i - 1]) smonotonic = false;
check(smonotonic, "sample voice start times are strictly increasing (a real downstroke)");
// Root/color roles still apply to the real recordings.
check(sevs.some((e) => e.role === "root") && sevs.some((e) => e.role === "color"), "sample root and color roles are both assigned");

// ---------------------------------------------------------------------------
// smplr kit (progress 21): the sampled-guitar engine drives guitar voicings
// from a real GM kit decoded ONCE into a shared buffer map, replayed through
// SIX per-string Instrument instances, each with its own [gate → pan] seat.
// The music is the same as the other paths — root/color roles reach the
// sampler as velocity, gates hold silent from t=0, the strum spreads AND each
// string keeps a fixed stereo seat (physical lows always left, highs always
// right).
// ---------------------------------------------------------------------------
// Fake smplr: the real package would fetch + decode a 2.6 MB kit, so the
// scheduling graph is exercised against a recording stub instead. Our engine
// reads smplr through `globalThis.__SMPLR_FAKE__`, so both the real and the
// fake take the exact same code path. The engine now decodes the kit ONCE
// (88 notes, not 88×6) and hands the buffer map to six `Instrument` factories,
// so the fake must cover `decodeKit` + `Instrument` + `soundfontToPreset`.
const kitStarts = [];
globalThis.__SMPLR_FAKE__ = {
  SampleLoader: () => ({}),
  decodeKit: () => Promise.resolve({ buffers: new Map(), noteNames: [] }),
  soundfontToPreset: () => ({}),
  Instrument: (plugin) => (ctx, opts) => {
    const inst = {
      ready: null,
      load: null,
      start({ note, velocity, time, stopId }) {
        kitStarts.push({ note, velocity, time, stopId, dest: opts.destination });
      },
      stop() {},
    };
    inst.ready = Promise.resolve(plugin(ctx, opts, { loadInstrument: async () => undefined }));
    if (opts && opts.onLoadProgress) opts.onLoadProgress({ loaded: 1, total: 1 });
    return inst;
  },
};
// Capture BEFORE `setEngineMode` so the six per-string gates the engine builds
// while priming are inside the window we inspect below.
const gainsBeforeKit = gains.length;
const kitEventStart = getAudioDebugEvents().length;
setEngineMode("smplr");
// The kit decodes asynchronously; a play on the very click that primes it
// falls back (like the worklet module's first-click lag). Wait for readiness
// so this scenario asserts the kit path that every LOADED page then uses.
await new Promise((r) => setTimeout(r, 20));
playVoicing([0, 3, 2, 0, 1, 0], TUNING); // open C, all six strings
await new Promise((r) => setTimeout(r, 40));

const kevs = getAudioDebugEvents().slice(kitEventStart);
check(kevs.length === 6, `open C under the smplr engine schedules 6 kit voices (got ${kevs.length})`);
check(kevs.every((e) => e.kind === "kit"), "every voice is a smplr kit note");
// Each note must be the fretted MIDI of its string (treble-first order here,
// so compare as sets):
const expectedMidis = [40, 48, 52, 55, 60, 64];
check(
  [...kevs.map((e) => e.midi)].sort((a, b) => a - b).join() === expectedMidis.join(),
  "every kit note is the fretted midi of its string",
);
// The engine must have been handed each note too — start() got note+velocity.
check(kitStarts.length === 6, `the sampler received 6 starts (got ${kitStarts.length})`);
check(
  [...kitStarts.map((s) => s.note)].sort((a, b) => a - b).join() === expectedMidis.join(),
  "the sampler was handed the same six notes",
);
// Root/color roles reach the sampler as velocity (root >= color; 0..127).
check(kevs.every((e) => e.velocity >= 1 && e.velocity <= 127), `every velocity is in 1..127`);
const kitRoot = kevs.filter((e) => e.role === "root");
const kitColor = kevs.filter((e) => e.role === "color");
check(kitRoot.length >= 1 && kitColor.length >= 1, "kit root and color roles are both assigned");
check(
  Math.min(...kitRoot.map((e) => e.velocity)) >= Math.max(...kitColor.map((e) => e.velocity)),
  "root notes are at least as loud as color notes",
);
// Per-string fixed stereo seats: six distinct pans, lows left, highs right.
const kpans = new Set(kevs.map((e) => e.pan.toFixed(3)));
check(kpans.size === kevs.length, `each string has its own fixed stereo seat (${kpans.size}/${kevs.length})`);
const kitLow = kevs.find((e) => e.midi === 40);
const kitHigh = kevs.find((e) => e.midi === 64);
check(kitLow.pan < 0 && kitHigh.pan > 0, `low E sits left, high E sits right (${kitLow.pan.toFixed(2)} vs ${kitHigh.pan.toFixed(2)})`);
// The kit gates belong to the six per-string instruments built by the engine;
// they must carry the same silent-from-zero rule as every other voice path.
const kgates = gains.slice(gainsBeforeKit).filter((g) => g.gain.events.some((e) => e.type === "ramp"));
check(kgates.length === kevs.length, `six per-string kit gates (gates=${kgates.length}, voices=${kevs.length})`);
let kgatedFromZero = 0;
for (const g of kgates) {
  const first = g.gain.events[0];
  if (first && first.type === "set" && first.time === 0 && first.value <= 0.001) kgatedFromZero++;
}
check(kgatedFromZero === kgates.length, `every kit gate is silent from t=0 (${kgatedFromZero}/${kgates.length}) — no simultaneous leak`);
const kstarts = kevs.map((e) => e.time).sort((a, b) => a - b);
const kspan = kstarts[kstarts.length - 1] - kstarts[0];
check(kspan > 0.4, `kit voices are strummed over time (span ${(kspan * 1000).toFixed(0)}ms > 400ms)`);

if (failures.length) {
  console.error(`\nAUDIO FAILURES (${failures.length})`);
  process.exit(1);
}
console.log("\nAUDIO ALL PASS");
