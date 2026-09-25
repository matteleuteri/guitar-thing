/**
 * Audio front door for the app. Keeps the same public API it always had
 * (`playVoicing`, `playNotes`, `stopAudio`) but now drives the Karplus–Strong
 * voice in `src/synth/`. See `synth/config.ts` for every tunable knob.
 */

import { DEFAULT_CONFIG, type PluckAudioConfig } from "./synth/config.js";
import { buildSharedGraph, type SharedGraph } from "./synth/shared.js";
import {
  nearestSample,
  setSample as bankSetSample,
  clearSamples as bankClearSamples,
  loadStoredSamples,
  sampleStatus,
  sampleWav,
  type NearestMatch,
  type SampleBankStatus,
} from "./synth/samples.js";
import {
  mixToMono,
  resampleLinear,
  trimToOnset,
  capLength,
  normalizePeak,
  encodeWavMono,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  lowpassOnePole,
  attackFade,
} from "./synth/ir.js";
import { createSmplrEngine, type SmplrGuitarEngine } from "./synth/smplr.js";

const NOTE_START = 0.03;

let context: AudioContext | null = null;
let graph: SharedGraph | null = null;
let workletReady: Promise<void> | null = null;

/**
 * The smplr sampled-guitar engine (progress 21): six per-string Soundfont
 * instances sharing one kit decode, each gated + panned onto the master bus.
 * Built fire-and-forget by `primeGuitarEngine`; scheduling only routes to it
 * once `guitarEngineReady` flips (the first play after a load may still be
 * synth/sample — same first-click lag as the worklet module).
 */
let guitarEngine: SmplrGuitarEngine | null = null;
let guitarEngineReady = false;

/** Recorded body IR: the one "box" that passes as the instrument (progress 19).
 *  Stored as PCM + its own sample rate so it can be rebuilt on any context
 *  (live or offline) at that context's rate. */
let irSource: { pcm: Float32Array; sampleRate: number; origin: "recording" | "asset" } | null = null;
const IR_STORAGE_KEY = "guitar-thing.body-ir";

/**
 * A live voice we might still want to silence or free. Worklet voices stop via
 * a worklet message; sample voices stop their `BufferSource`.
 */
interface Voice {
  stop: () => void;
  timer: ReturnType<typeof setTimeout>;
}
/** Voices we might still want to silence or free. */
const live = new Set<Voice>();
/** Completes when the previous click's voices have been placed. */
let chain: Promise<void> = Promise.resolve();

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function lerp(a: number, b: number, position: number): number {
  return a + (b - a) * position;
}

function ringSeconds(freq: number, config: PluckAudioConfig): number {
  return Math.max(0.8, (config.ring.baseMs - (config.ring.perKHzMs * freq) / 1000) / 1000);
}

function workletUrl(): URL {
  return new URL("./synth/pluck-worklet.js", import.meta.url);
}

/** Create the context + shared graph once; load the worklet module once. */
function ensure(): Promise<void> {
  if (!context) {
    context = new AudioContext();
    context.resume().catch(() => undefined);
    graph = buildSharedGraph(context, DEFAULT_CONFIG);
    applyBodyIR(context, graph);
    // Fire-and-forget: pick up a stored/shipped body IR and any recorded
    // string samples so they're ready for the first play without blocking the
    // click that built the audio path.
    void loadStoredBodyIR();
    void loadStoredSamples();
    primeGuitarEngine();
  } else if (context.state === "suspended") {
    context.resume().catch(() => undefined);
  }
  if (!workletReady) {
    workletReady = context.audioWorklet.addModule(workletUrl().href).catch((err) => {
      workletReady = null;
      throw err;
    });
  }
  return workletReady;
}

/**
 * Build the smplr guitar engine when the config wants it (fire-and-forget; the
 * kit decodes over a second or two and the first play may precede it). If the
 * engine throws at construction (bad kit path, offline-missing fetch) we log
 * and leave `guitarEngine` null — scheduling then falls back to the recorded
 * samples / K–S synth, which never depend on it.
 */
function primeGuitarEngine(): void {
  if (guitarEngine || !context || !graph) return;
  if (DEFAULT_CONFIG.engine.mode !== "smplr") return;
  try {
    const engine = createSmplrEngine(context, graph.master, DEFAULT_CONFIG);
    guitarEngine = engine;
    // Only route to the kit once it decoded (OGG decoding can fail — e.g.
    // Safari can't decode ogg/vorbis — in which case samples/synth stay on).
    void engine.ready
      .then(() => {
        guitarEngineReady = true;
      })
      .catch((err) => {
        console.warn("smplr guitar kit failed to load, staying on samples/synth:", err);
        guitarEngine = null;
        guitarEngineReady = false;
      });
  } catch (err) {
    console.warn("smplr guitar engine failed to build:", err);
  }
}

/**
 * Build the audio path inside the current user gesture (so the context is
 * unlocked and the worklet loaded), without playing anything. The harness uses
 * this before an auto-strum after a body-IR capture — otherwise the browser
 * would defer the context to the next click.
 */
export function prewarm(): void {
  void ensure();
}

/**
 * Switch the guitar engine live (used by the debug harness's engine selector
 * and the scheduling test): writes the mode and, when switching TO the smplr
 * kit, starts building the engine so the next play can route to it. Switching
 * to "synth"/"samples" leaves a loaded kit in place — it's just no longer
 * routed to.
 */
export function setEngineMode(mode: PluckAudioConfig["engine"]["mode"]): void {
  DEFAULT_CONFIG.engine.mode = mode;
  if (mode === "smplr") primeGuitarEngine();
}

/** Set (or clear) the recorded-body IR convolver on an existing graph: null →
 *  bypass (wet 0), otherwise rebuild the buffer at this context's sample rate. */
function applyBodyIR(ctx: BaseAudioContext, g: SharedGraph): void {
  const wet = g.ir.wet;
  if (!irSource) {
    g.ir.con.buffer = null;
    wet.gain.value = 0;
    return;
  }
  const pcm = resampleLinear(irSource.pcm, irSource.sampleRate, ctx.sampleRate);
  const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
  buf.copyToChannel(new Float32Array(pcm), 0);
  g.ir.con.buffer = buf;
  wet.gain.value = DEFAULT_CONFIG.ir.level;
}

/** Trim / cap / smooth / normalize a raw recording into the body-IR source. */
function processIr(pcm: Float32Array, sampleRate: number): { pcm: Float32Array; sampleRate: number } {
  const { maxMs, smoothHz, attackMs } = DEFAULT_CONFIG.ir;
  const trimmed = trimToOnset(pcm, -45);
  const capped = capLength(trimmed, sampleRate, maxMs);
  // Laptop-mic knocks clip full-scale for a few ms; the saturating edges read
  // as "static" convolved into every pluck. Body modes are ~all below 1 kHz,
  // so band-limit to the body band and round the pinned attack.
  const smoothed = lowpassOnePole(capped, sampleRate, smoothHz);
  const faded = attackFade(smoothed, sampleRate, attackMs);
  return { pcm: normalizePeak(faded), sampleRate };
}

function persistIr(): void {
  try {
    if (!irSource) {
      localStorage.removeItem(IR_STORAGE_KEY);
      return;
    }
    const wav = encodeWavMono(irSource.pcm, irSource.sampleRate);
    localStorage.setItem(IR_STORAGE_KEY, arrayBufferToBase64(wav));
  } catch {
    /* storage full/unavailable — the IR just won't survive a reload */
  }
}

/** Best-effort: restore the body IR from localStorage, then a shipped asset. */
async function loadStoredBodyIR(): Promise<void> {
  try {
    const stored = localStorage.getItem(IR_STORAGE_KEY);
    const from = (buf: ArrayBuffer, origin: "recording" | "asset"): void => {
      void context?.decodeAudioData(buf).then((audioBuffer) => {
        const mono = mixToMono(audioBuffer);
        irSource = { ...processIr(mono, audioBuffer.sampleRate), origin };
        if (context && graph) applyBodyIR(context, graph);
      }).catch(() => undefined);
    };
    if (stored) {
      from(base64ToArrayBuffer(stored), "recording");
      return;
    }
    const res = await fetch("assets/body-ir.wav"); // page-relative → site root
    if (res.ok) from(await res.arrayBuffer(), "asset");
  } catch {
    /* no stored IR and no shipped asset — plain EQ body, as approved */
  }
}

/** Load a body-IR recording (a Blob from the mic or a file) and apply it live. */
export async function setBodyIRBuffer(blob: Blob): Promise<void> {
  await ensure();
  if (!context) return;
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await context.decodeAudioData(arrayBuffer);
  setBodyIRFromPcm(mixToMono(audioBuffer), audioBuffer.sampleRate);
}

/** Apply raw mono PCM (e.g. the harness's crop window) as the body IR. */
export function setBodyIRFromPcm(pcm: Float32Array, sampleRate: number): void {
  irSource = { ...processIr(pcm, sampleRate), origin: "recording" };
  persistIr();
  if (context && graph) {
    applyBodyIR(context, graph);
  } else {
    // No audio path yet (harness can set the IR before the first play): building
    // the context applies the IR immediately (ensure() → applyBodyIR).
    void ensure();
  }
}

/** Remove the recorded body IR and fall back to the static EQ body. */
export function clearBodyIR(): void {
  irSource = null;
  persistIr();
  if (context && graph) applyBodyIR(context, graph);
}

/** Live IR wet-level knob (writes `config.ir.level`, re-applies the blend). */
export function setBodyIRLevel(level: number): void {
  const v = clamp01(level);
  DEFAULT_CONFIG.ir.level = v;
  if (context && graph) applyBodyIR(context, graph);
}

export interface BodyIRStatus {
  origin: "recording" | "asset" | null;
  lengthMs: number;
  sampleRate: number | null;
}
export function getBodyIRStatus(): BodyIRStatus {
  const active = !!irSource && !!context && !!graph && graph.ir.wet.gain.value > 0;
  const origin = active ? irSource!.origin : null;
  return {
    origin,
    lengthMs: irSource ? Math.round((irSource.pcm.length / irSource.sampleRate) * 1000) : 0,
    sampleRate: irSource?.sampleRate ?? null,
  };
}

/** The normalized body-IR WAV as a Blob (to save/commit as `assets/body-ir.wav`). */
export function getBodyIRWav(): Blob | null {
  if (!irSource) return null;
  return new Blob([encodeWavMono(irSource.pcm, irSource.sampleRate)], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// Real-guitar samples (progress 20): the harness records the six open strings
// once; `setSample` stores each as a normalized 24 kHz mono sample and guitar
// voicings then transpose the nearest recorded string to any fretted note.
// ---------------------------------------------------------------------------

/** Record/store one open string's sample (the debug harness's capture path). */
export function setSample(stringIndex: number, midi: number, pcm: Float32Array, sampleRate: number): void {
  bankSetSample(stringIndex, midi, pcm, sampleRate);
}

/** Drop every recorded sample (back to pure synth). */
export function clearSamples(): void {
  bankClearSamples();
}

/** Live on/off for sample playback (writes `config.samples.enabled`). */
export function setSamplesEnabled(enabled: boolean): void {
  DEFAULT_CONFIG.samples.enabled = enabled;
}

export function getSamplesStatus(): SampleBankStatus {
  return sampleStatus();
}

/** A single string's sample as a WAV Blob (to save/commit as an asset). */
export function getSampleWav(stringIndex: number): Blob | null {
  return sampleWav(stringIndex);
}

/** Humanize: random detune (cents) and a random start offset (ms). */
function humanize(freq: number, config: PluckAudioConfig): { freq: number; jitter: number } {
  const detune = (Math.random() * 2 - 1) * config.micro.detuneCents;
  return {
    freq: freq * Math.pow(2, detune / 1200),
    jitter: (Math.random() * config.micro.jitterMs) / 1000,
  };
}

/**
 * Per-note sound parameters, fully resolved before the note is scheduled.
 * `playVoicing` builds these from the systematic string `voices` + `roles`
 * tables; `playNotes` uses the piano register profile (`cfg.piano`) + `roles`.
 */
interface VoiceParams {
  scoopCents: number;
  peak: number;
  /** Excitation loudness (0..1): amplitude of the seeded pluck. */
  brightness: number;
  /** Loop lowpass (0..1). */
  damping: number;
  /** Loop gain per sample (0..1). */
  sustain: number;
  /** Pick-scrape transient level (0..1). */
  pick: number;
  /**
   * Brightness of this voice's scrape transient (0..1 → highpass cutoff
   * ~350 Hz..9 kHz). Wound lows scrape dark/plosive, plain highs bright/thin.
   */
  pickBright?: number;
  /** Length of this voice's scrape transient in ms. */
  pickDecayMs?: number;
  /** Stereo pan -1..1. */
  pan: number;
  /** "root" when the note is the chord's root pitch class, else "color". */
  role: "root" | "color";
  /** Host-side gain ramp in ms: slow = bass thump, fast = treble snap. */
  attackMs: number;
  /**
   * Attack bloom (0..~0.35) — extra early level this note's onset carries
   * before settling into the sustained tone (see `config.bloom`). High
   * strings bloom more; 0/absent keeps the note flat-level like a plain
   * fallback. The brightness half of the bloom is always on (starts at
   * `bloomStartDamp`), gated by this level.
   */
  bloom?: number;
  /** Settle time constant for the bloom in ms (`config.bloom.ms`). */
  bloomMs?: number;
  /** Loop-damping coefficient the note starts at (`config.bloom.startDamp`). */
  bloomStartDamp?: number;
  /**
   * Where along the string the pick strikes (0..1, from the bridge). Seeds the
   * K–S loop's initial displacement so this voice excites its own harmonics.
   */
  pickPos?: number;
  /**
   * Second one-pole loop loss (0..1) steepening the tail's high-partial decay,
   * so each string (wound vs plain) darkens along its own curve.
   */
  decay?: number;
  /**
   * Slow amplitude-wobble depth (0..1, small) that keeps this string's loop
   * breathing — the "string life" knob. Wound lows get a touch more.
   */
  lifeAmt?: number;
  /** Max life pitch waver in cents (tiny; < 3 or it reads as vibrato). */
  lifePitchCents?: number;
  /** Body-thump "box hit" level for this voice (0..1); guitar strings set it. */
  thump?: number;
  /** Optional per-string tone EQ (pickup voicing) applied before the volume stage. */
  eq?: { lowpassHz?: number; peakHz?: number; peakGainDb?: number; peakQ?: number };
}

/**
 * Schedule one plucked string at `time` on an arbitrary context/graph — the
 * live one from `playVoicing`/`playNotes`, or an `OfflineAudioContext` for the
 * debug harness's real-guitar comparison. Resolves humanization, builds the
 * worklet node + per-string EQ + gated pan, and hands back the voice so the
 * caller can track/free it (live) or ignore it (offline render).
 */
function scheduleVoice(
  context: BaseAudioContext,
  graph: SharedGraph,
  frequency: number,
  time: number,
  params: VoiceParams,
  config: PluckAudioConfig,
): Voice {
  const { freq: hz, jitter } = humanize(frequency, config);
  const start = time + jitter;
  recordDebugEvent({
    kind: "voice",
    time: start,
    freq: hz,
    peak: params.peak,
    pan: params.pan,
    role: params.role,
    brightness: params.brightness,
    damping: params.damping,
    sustain: params.sustain,
    pick: params.pick,
    pickBright: params.pickBright ?? config.attack.pickBright,
    pickDecayMs: params.pickDecayMs ?? config.attack.pickMs,
    attackMs: params.attackMs,
    decay: params.decay ?? 0.25,
    lifeAmt: params.lifeAmt ?? 0,
    thump: params.thump ?? 0,
    bloom: params.bloom ?? 0,
  });

  const node = new AudioWorkletNode(context, "pluck-string", {
    processorOptions: {
      freq: hz,
      sustain: params.sustain,
      brightness: params.brightness,
      damping: params.damping,
      pickLevel: params.pick,
      pickBright: params.pickBright ?? config.attack.pickBright,
      pickDecayMs: params.pickDecayMs ?? config.attack.pickMs,
      scoopCents: params.scoopCents,
      scoopMs: config.scoop.ms,
      pickPos: params.pickPos ?? 0.2,
      decay: params.decay ?? 0.25,
      ringFrames: Math.floor(context.sampleRate * ringSeconds(hz, config)),
      // String life: each note gets its own random phase and a ±`hzSpread`
      // rate, so the voices of a chord never breathe in unison.
      lifeAmt: params.lifeAmt ?? 0,
      lifeHz: Math.max(0.05, config.life.hz + (Math.random() * 2 - 1) * config.life.hzSpread),
      lifePhase: Math.random() * Math.PI * 2,
      lifePitchCents: params.lifePitchCents ?? 0,
      lifeBloomMs: config.life.bloomMs,
      thumpLevel: params.thump ?? 0,
      thumpHz: config.thump.hz,
      thumpDecayMs: config.thump.decayMs,
      // Attack bloom: start brighter + a touch louder, settle into the tone.
      bloomLevel: params.bloom ?? 0,
      bloomMs: params.bloomMs ?? config.bloom.ms,
      bloomStartDamp: params.bloomStartDamp ?? config.bloom.startDamp,
    },
  });

  // Each string gets its own pickup-style tone EQ before the volume stage,
  // so it rings with a genuinely different color — not just a brightness knob.
  let tail: AudioNode = node;
  if (params.eq) {
    if (params.eq.lowpassHz) {
      const f = context.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = params.eq.lowpassHz;
      f.Q.value = 0.7;
      tail.connect(f);
      tail = f;
    }
    if (params.eq.peakHz) {
      const f = context.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = params.eq.peakHz;
      f.gain.value = params.eq.peakGainDb ?? 0;
      f.Q.value = params.eq.peakQ ?? 1;
      tail.connect(f);
      tail = f;
    }
  }

  // Fade in over a few ms so the attack can't click; `peak` sets volume.
  // `attackMs` varies per string: bass strings thump in slow, treble snaps fast.
  // CRITICAL: a GainNode's AudioParam starts at 1.0, and an AudioWorkletNode
  // sounds the moment it is connected — so without zeroing the gain from the
  // very start, every voice leaks at full volume immediately and the whole
  // strum collapses into one simultaneous pluck. Hold silence until `start`.
  const gate = context.createGain();
  gate.gain.setValueAtTime(0.0001, 0);
  gate.gain.setValueAtTime(0.0001, start);
  gate.gain.exponentialRampToValueAtTime(Math.max(0.02, params.peak), start + Math.max(0.0002, params.attackMs / 1000));
  tail.connect(gate);
  // Pan spreads the strings across the stereo field (0 = center, e.g. piano).
  const panner = context.createStereoPanner();
  panner.pan.value = params.pan;
  gate.connect(panner);
  panner.connect(graph.voiceIn);

  const voice: Voice = {
    stop: () => {
      sendStop(node);
      node.disconnect();
    },
    timer: 0,
  };
  voice.timer = setTimeout(() => freeVoice(voice), ringSeconds(hz, config) * 1000 + 60);
  return voice;
}

/**
 * Fixed stereo seat for a smplr string: the physical low E always sits left,
 * the high E right, spread by `config.panning.spread` — matches the engine's
 * per-string panners (and keeps the debug log's pan truthful).
 */
function enginePan(stringIndex: number, config: PluckAudioConfig): number {
  return ((stringIndex / 5) * 2 - 1) * config.panning.spread;
}

/**
 * Schedule one note through the smplr sampled-guitar engine (progress 21).
 * The music is the same as the other paths — root/color roles become sampler
 * velocities, the note lands in its string's gate (held silent from t=0,
 * opened at this note's strum slot) and a fixed stereo seat — for the price
 * of a real recorded guitar instead of a synthesized string.
 */
function scheduleKitVoice(
  engine: SmplrGuitarEngine,
  midi: number,
  stringIndex: number,
  time: number,
  params: VoiceParams,
  config: PluckAudioConfig,
): Voice {
  const jitter = (Math.random() * config.micro.jitterMs) / 1000;
  const start = time + jitter;
  const roles = config.roles;
  const velocity = Math.round(
    clamp01((config.engine.velocity / 100) * (params.role === "root" ? roles.rootVel : roles.colorVel)) * 127,
  );
  recordDebugEvent({
    kind: "kit",
    time: start,
    freq: midiToFreq(midi),
    midi,
    velocity,
    peak: params.peak,
    pan: enginePan(stringIndex, config),
    role: params.role,
    brightness: 0,
    damping: 0,
    sustain: 0,
    pick: 0,
    pickBright: 0,
    pickDecayMs: 0,
    attackMs: config.engine.attackMs,
    decay: 0,
    lifeAmt: 0,
    thump: 0,
    bloom: 0,
  });
  const handle = engine.play(midi, stringIndex, start, {
    peak: params.peak,
    role: params.role,
    attackMs: config.engine.attackMs,
    velocity,
  });
  const voice: Voice = {
    stop: () => handle.stop(),
    timer: 0,
  };
  voice.timer = setTimeout(
    () => freeVoice(voice),
    ringSeconds(midiToFreq(midi), config) * 1000 + 200,
  );
  return voice;
}

/**
 * Play one fretted note from the recorded string-sample bank (progress 20).
 * The sample whose open note is nearest to `midi` is transposed by playback
 * rate; the note keeps the same gate-from-zero, strum slot, role and pan as a
 * synthesized voice, but skips the synthesized body EQ / IR / room — the
 * recording already contains the real guitar, body and room.
 */
function scheduleSampleVoice(
  context: BaseAudioContext,
  graph: SharedGraph,
  midi: number,
  time: number,
  params: VoiceParams,
  config: PluckAudioConfig,
  match: NearestMatch,
): Voice {
  const { sample, shift } = match;
  const jitter = (Math.random() * config.micro.jitterMs) / 1000;
  const start = time + jitter;
  const rate = Math.pow(2, shift / 12) * Math.pow(2, ((Math.random() * 2 - 1) * config.micro.detuneCents) / 1200);
  recordDebugEvent({
    kind: "sample",
    time: start,
    freq: midiToFreq(midi),
    midi,
    shift,
    peak: params.peak,
    pan: params.pan,
    role: params.role,
    brightness: 0,
    damping: 0,
    sustain: 0,
    pick: 0,
    pickBright: 0,
    pickDecayMs: 0,
    attackMs: config.samples.attackMs,
    decay: 0,
    lifeAmt: 0,
    thump: 0,
    bloom: 0,
  });

  const buf = context.createBuffer(1, sample.pcm.length, sample.sampleRate);
  const pcm = new Float32Array(sample.pcm.length);
  pcm.set(sample.pcm);
  buf.copyToChannel(pcm, 0);
  const source = context.createBufferSource();
  source.buffer = buf;
  source.playbackRate.value = rate;

  // CRITICAL (the same one-sound bug as the worklet path): a BufferSource
  // sounds the moment it starts, and the gate defaults to 1.0 — hold it
  // silent from time 0 and only open at this voice's strum slot.
  const gate = context.createGain();
  gate.gain.setValueAtTime(0.0001, 0);
  gate.gain.setValueAtTime(0.0001, start);
  gate.gain.exponentialRampToValueAtTime(
    Math.max(0.02, params.peak * config.samples.gain),
    start + Math.max(0.002, config.samples.attackMs / 1000),
  );
  source.connect(gate);

  const panner = context.createStereoPanner();
  panner.pan.value = params.pan;
  gate.connect(panner);
  panner.connect(graph.master);

  source.start(start);
  const durationMs = (sample.pcm.length / sample.sampleRate) * 1000 / rate;
  const voice: Voice = {
    stop: () => {
      try {
        source.stop();
      } catch {
        /* already finished */
      }
      source.disconnect();
    },
    timer: 0,
  };
  voice.timer = setTimeout(() => freeVoice(voice), durationMs + 100);
  return voice;
}

function freeVoice(voice: Voice): void {
  if (!live.delete(voice)) return;
  clearTimeout(voice.timer);
  voice.stop();
}

function sendStop(node: AudioWorkletNode): void {
  try {
    node.port.postMessage({ type: "stop" });
  } catch {
    /* context already gone */
  }
}

function schedule(work: () => Promise<void>): void {
  chain = chain
    .then(work)
    .catch((err) => console.error("audio:", err));
}

/** A hand doesn't hit every string at the same force. */
function velocity(config: PluckAudioConfig): number {
  const spread = config.variation.velocitySpread;
  return 1 + (Math.random() * 2 - 1) * spread;
}

/**
 * Hand-shaped strum offset: the k-th hit lands `gap * sum(pattern[0..k-1])`
 * after the base time, so the treble bursts out and a final wide gap blooms
 * into the bass string; random jitter loosens it like a real hand.
 */
function strumOffset(hitIndex: number, gapSeconds: number, jitterSeconds: number, pattern: number[]): number {
  let patternSum = 0;
  for (let i = 0; i < hitIndex; i++) patternSum += pattern[i] ?? 1;
  return gapSeconds * patternSum + (Math.random() * 2 - 1) * jitterSeconds;
}

/** Peak amplitude for one guitar string, scaled by role, bass boost and how
 * many strings sound (`count/6` keeps chords from clipping). */
function guitarPeak(params: {
  config: PluckAudioConfig;
  isRoot: boolean;
  stringIndex: number;
  soundingCount: number;
  velocity: number;
}): number {
  const { config, isRoot, stringIndex, soundingCount, velocity } = params;
  const roles = config.roles;
  const velocityFactor = isRoot ? roles.rootVel : roles.colorVel;
  const bassBoost = stringIndex === 0 ? config.balance.bassBoost : 1;
  return (config.micro.peak * velocityFactor * bassBoost * (soundingCount / 6) ** 0.5 + 0.06) * velocity;
}

/** Peak amplitude for one piano key; the register-aware path accents the root
 * and the bass, the plain path keeps single fretboard dots at their old level. */
function keyPeak(params: {
  config: PluckAudioConfig;
  register: boolean;
  isRoot: boolean;
  keyIndex: number;
  keyCount: number;
  velocity: number;
}): number {
  const { config, register, isRoot, keyIndex, keyCount, velocity } = params;
  const roles = config.roles;
  if (register) {
    const velocityFactor = isRoot ? roles.rootVel : roles.colorVel;
    const bassBoost = keyIndex === 0 ? config.balance.bassBoost : 1;
    return (config.micro.peak * velocityFactor * bassBoost * (keyCount / 10) ** 0.5 + 0.06) * velocity;
  }
  const firstKeyBoost = keyIndex === 0 ? 1.3 : 1;
  return (config.micro.peak * firstKeyBoost * (keyCount / 6) ** 0.5 + 0.06) * 0.9;
}

/** Pluck every sounding string of a voicing (muted strings skipped). */
export function playVoicing(frets: (number | null)[], tuning: number[]): void {
  const config = DEFAULT_CONFIG;
  schedule(async () => {
    await ensure();
    if (!context || !graph) return;
    scheduleGuitarVoicing(context, graph, frets, tuning, config, context.currentTime + NOTE_START);
  });
}

/**
 * Schedule every sounding string of a guitar voicing as its own voice (muted
 * strings skipped). Shared by live playback (`playVoicing`) and the debug
 * harness's offline render, so a comparison uses the exact same voices.
 */
function scheduleGuitarVoicing(
  context: BaseAudioContext,
  graph: SharedGraph,
  frets: (number | null)[],
  tuning: number[],
  config: PluckAudioConfig,
  baseTime: number,
  trackLive = true,
): void {
  const gap = config.strum.guitarMs / 1000;
  const jitter = config.strum.jitterMs / 1000;
  const soundingStrings = frets
    .map((fret, stringIndex) => ({ fret, stringIndex }))
    .filter((entry): entry is { fret: number; stringIndex: number } => entry.fret !== null);
  if (soundingStrings.length === 0) return;
  // The chord's root is its lowest sounding pitch class, so `roles` accent
  // the same voice every time the same chord is played (no wiring needed).
  const rootPitchClass = Math.min(
    ...soundingStrings.map((entry) => (tuning[entry.stringIndex] + entry.fret) % 12),
  );
  // Downstroke: treble strings first, thick low string last, like a hand.
  const ordered = [...soundingStrings].sort((a, b) => b.stringIndex - a.stringIndex);
  const roles = config.roles;

  for (let hitIndex = 0; hitIndex < ordered.length; hitIndex++) {
    const { fret, stringIndex } = ordered[hitIndex];
    const midi = tuning[stringIndex] + fret;
    const pitchClass = midi % 12;
    const isRoot = pitchClass === rootPitchClass;
    const voice = config.voices[stringIndex] ?? config.voices[0];
    const role: "root" | "color" = isRoot ? "root" : "color";
    const offset = strumOffset(hitIndex, gap, jitter, config.strum.pattern);
    // Systematic identity: the string's fixed character, accented by its role,
    // with only a thin random sliver left over for humanity.
    const params: VoiceParams = {
      scoopCents: voice.scoopCents,
      peak: guitarPeak({
        config,
        isRoot,
        stringIndex,
        soundingCount: soundingStrings.length,
        velocity: velocity(config),
      }),
      brightness: clamp01(
        voice.brightness * (isRoot ? roles.rootBright : roles.colorBright) +
        (Math.random() * 2 - 1) * config.variation.brightnessSpread,
      ),
      damping: clamp01(
        voice.damping * (isRoot ? roles.rootDamp : roles.colorDamp) +
        (Math.random() * 2 - 1) * config.variation.dampingSpread,
      ),
      sustain: clamp01(
        voice.sustain + (isRoot ? roles.rootSustainAdd : roles.colorSustainAdd) +
        (Math.random() * 2 - 1) * config.variation.sustainSpread,
      ),
      pick: clamp01(voice.pick * (isRoot ? roles.rootPick : roles.colorPick)),
      // Bass strings go left, treble right, so voices separate in the stereo field.
      pan: soundingStrings.length > 1
        ? ((stringIndex / (soundingStrings.length - 1)) * 2 - 1) * config.panning.spread
        : 0,
      role,
      attackMs: voice.attackMs,
      decay: voice.decay,
      pickBright: voice.pickBright,
      pickDecayMs: voice.pickDecayMs,
      pickPos: voice.pickPos,
      // Wound/thick low strings breathe a little more than the plains.
      lifeAmt: config.life.amt * (1 - 0.45 * (stringIndex / 5)),
      lifePitchCents: config.life.pitchCents * (1 - 0.35 * (stringIndex / 5)),
      thump: voice.thump ?? 0,
      // High strings bloom deep, lows barely settle — matches the measured
      // "highs 10..25 dB below peak within a second" curve from the harness.
      bloom: voice.bloom ?? 0,
      eq: voice.eq,
    };
    const match = nearestSample(midi);
    // Engine routing (progress 21): the smplr kit is the default; the
    // recorded-string bank and the K–S synth remain selectable for A/B, and
    // both are fallbacks whenever the chosen engine isn't ready (kit still
    // decoding) or can't cover the note (no sample within shift budget).
    const useKit = config.engine.mode === "smplr" && guitarEngine !== null && guitarEngineReady;
    const useSamples = match && !useKit && config.engine.mode !== "synth";
    const hit = useKit
      ? scheduleKitVoice(guitarEngine!, midi, stringIndex, baseTime + Math.max(0, offset), params, config)
      : useSamples && match
        ? scheduleSampleVoice(context, graph, midi, baseTime + Math.max(0, offset), params, config, match)
        : scheduleVoice(context, graph, midiToFreq(midi), baseTime + Math.max(0, offset), params, config);
    if (trackLive) live.add(hit);
  }
}

/**
 * Interpolate the piano register profile (dark thumpy lows → bright snappy
 * highs) for one MIDI key, so no two keys of a voicing share a sound.
 * `peak`, the caller-defined parts, `pan`, and `role` are supplied after.
 */
function registerParams(
  midi: number,
  config: PluckAudioConfig,
): Omit<VoiceParams, "peak" | "pan" | "role"> {
  const { low, high } = config.piano;
  const position = clamp01((midi - low.midi) / (high.midi - low.midi));
  // Interpolate each EQ knob where both endpoints define it; otherwise fall
  // back to the endpoint that has it.
  const interpolate = (a: number | undefined, b: number | undefined): number | undefined => {
    if (a === undefined && b === undefined) return undefined;
    if (a === undefined) return b;
    if (b === undefined) return a;
    return lerp(a, b, position);
  };
  const lowpassHz = interpolate(low.eq?.lowpassHz, high.eq?.lowpassHz);
  const peakHz = interpolate(low.eq?.peakHz, high.eq?.peakHz);
  return {
    scoopCents: lerp(low.scoopCents, high.scoopCents, position),
    brightness: lerp(low.brightness, high.brightness, position),
    damping: lerp(low.damping, high.damping, position),
    sustain: lerp(low.sustain, high.sustain, position),
    pick: lerp(low.pick, high.pick, position),
    attackMs: lerp(low.attackMs, high.attackMs, position),
    eq:
      lowpassHz !== undefined || peakHz !== undefined
        ? {
            lowpassHz,
            peakHz,
            peakGainDb: interpolate(low.eq?.peakGainDb, high.eq?.peakGainDb),
            peakQ: interpolate(low.eq?.peakQ, high.eq?.peakQ),
          }
        : undefined,
  };
}

/**
 * Play MIDI keys. With `register` (piano) each key resolves its own identity
 * from `cfg.piano` by register, is accented as root/color like a guitar
 * voicing, and is panned bass-left → treble-right — so the notes of a piano
 * chord ring out individually instead of fusing like one identical pluck.
 * Without it (single guitar-fretboard dots) behavior is unchanged: a plain
 * random profile.
 */
export function playNotes(midis: number[], register = false): void {
  if (midis.length === 0) return;
  const config = DEFAULT_CONFIG;
  schedule(async () => {
    await ensure();
    const base = context!.currentTime + NOTE_START;
    const roll = config.strum.pianoMs / 1000;
    const count = midis.length;
    const rootPitchClass = count > 1 ? Math.min(...midis.map((midi) => midi % 12)) : -1;
    const roles = config.roles;
    for (let keyIndex = 0; keyIndex < count; keyIndex++) {
      const midi = midis[keyIndex];
      const isRoot = count > 1 && midi % 12 === rootPitchClass;
      const profile = register ? registerParams(midi, config) : null;
      // Neutral multipliers when there's no breakdown to accent (single
      // guitar-fretboard dots keep their historical plain profile untouched).
      const accent = register
        ? {
            brightness: isRoot ? roles.rootBright : roles.colorBright,
            damping: isRoot ? roles.rootDamp : roles.colorDamp,
            sustainAdd: isRoot ? roles.rootSustainAdd : roles.colorSustainAdd,
            pick: isRoot ? roles.rootPick : roles.colorPick,
          }
        : { brightness: 1, damping: 1, sustainAdd: 0, pick: 1 };
      const params: VoiceParams = {
        scoopCents: profile?.scoopCents ?? 0,
        peak: keyPeak({
          config,
          register,
          isRoot,
          keyIndex,
          keyCount: count,
          velocity: velocity(config),
        }),
        pan: register && count > 1 ? ((keyIndex / (count - 1)) * 2 - 1) * config.panning.spread : 0,
        role: isRoot ? "root" : "color",
        brightness: clamp01(
          (profile?.brightness ?? config.string.brightness) * accent.brightness +
          (Math.random() * 2 - 1) * config.variation.brightnessSpread,
        ),
        damping: clamp01(
          (profile?.damping ?? config.string.damping) * accent.damping +
          (Math.random() * 2 - 1) * config.variation.dampingSpread,
        ),
        sustain: clamp01(
          (profile?.sustain ?? config.string.sustain) + accent.sustainAdd +
          (Math.random() * 2 - 1) * config.variation.sustainSpread,
        ),
        pick: clamp01((profile?.pick ?? config.attack.pickLevel) * accent.pick),
        attackMs: profile?.attackMs ?? 3,
        eq: profile?.eq,
      };
      const voice = scheduleVoice(context!, graph!, midiToFreq(midi), base + keyIndex * roll, params, config);
      live.add(voice);
    }
  });
}

/**
 * Render a guitar voicing off the live DSP graph (an `OfflineAudioContext`),
 * returning raw stereo audio. The debug harness uses this to compare the real
 * synth's envelope/decay against a recorded guitar clip. Voices are scheduled
 * by the same `scheduleGuitarVoicing` as live playback — just not tracked or
 * debug-logged — then the whole graph renders into a buffer.
 */
export async function renderOfflineVoicing(
  frets: (number | null)[],
  tuning: number[],
  seconds = 3,
): Promise<{ left: Float32Array; right: Float32Array } | null> {
  if (frets.every((fret) => fret === null)) return null;
  const config = DEFAULT_CONFIG;
  const sampleRate = 48000;
  try {
    const offline = new OfflineAudioContext(2, Math.max(1, Math.floor(sampleRate * seconds)), sampleRate);
    await offline.audioWorklet.addModule(workletUrl().href);
    const graph = buildSharedGraph(offline, config);
    applyBodyIR(offline, graph);
    const prevRecording = debugRecording;
    debugRecording = false;
    // In smplr mode, render through the same kit the live path uses — its own
    // offline engine sharing nothing but the config. If the kit can't load in
    // an offline/render context (fetch unavailable, decode failure) we fall
    // back to the synthesized voices so the comparison still renders.
    const prevEngine = guitarEngine;
    const prevEngineReady = guitarEngineReady;
    let kitEngine: SmplrGuitarEngine | null = null;
    if (config.engine.mode === "smplr") {
      try {
        kitEngine = createSmplrEngine(offline, graph.master, config);
        guitarEngine = kitEngine;
        guitarEngineReady = true;
        await kitEngine.ready;
      } catch (err) {
        guitarEngine = null;
        guitarEngineReady = false;
        console.warn("offline smplr engine unavailable, falling back to synth:", err);
      }
    }
    try {
      scheduleGuitarVoicing(offline, graph, frets, tuning, config, offline.currentTime + NOTE_START, false);
    } finally {
      debugRecording = prevRecording;
      guitarEngine = prevEngine;
      guitarEngineReady = prevEngineReady;
      kitEngine?.dispose();
    }
    const rendered = await offline.startRendering();
    return { left: rendered.getChannelData(0), right: rendered.getChannelData(1) };
  } catch (err) {
    console.error("offline render:", err);
    return null;
  }
}

/** Silences anything still ringing. */
export function stopAudio(): void {
  for (const voice of [...live]) {
    live.delete(voice);
    clearTimeout(voice.timer);
    voice.stop();
  }
  guitarEngine?.stopAll();
}

/**
 * Status of the smplr guitar engine for the debug harness: which engine is
 * active, whether its kit has finished loading, and the load progress.
 */
export function getSmplrStatus(): {
  mode: PluckAudioConfig["engine"]["mode"];
  ready: boolean;
  progress: { loaded: number; total: number };
} {
  return {
    mode: DEFAULT_CONFIG.engine.mode,
    ready: guitarEngineReady,
    progress: guitarEngine ? { ...guitarEngine.progress } : { loaded: 0, total: 0 },
  };
}

/**
 * JSON-safe copy of the full sound config at this moment. The debug harness
 * snapshots it next to each comparison so a saved "synth -40dB at 850ms" can be
 * reproduced with exactly the knobs that produced it.
 */
export function configSnapshot(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

export interface AudioDebugEvent {
  /** "voice" = the synthesized K–S string; "sample" = a recorded string
   *  sample; "kit" = a note from the smplr sampled-guitar engine. */
  kind: "voice" | "sample" | "kit";
  /** Absolute schedule time on the AudioContext clock, seconds. */
  time: number;
  /** Scheduled frequency in Hz (after random detune). */
  freq: number;
  /** For sample voices: the target MIDI note and the transposition in
   *  semitones from the recorded open string (0 = the exact open string).
   *  For kit voices: the MIDI note and the sampler velocity (0..127). */
  midi?: number;
  shift?: number;
  velocity?: number;
  /** Per-string peak amplitude. */
  peak: number;
  /** Stereo pan -1..1. */
  pan: number;
  /** "root" when the note is the chord's root pitch class, else "color". */
  role: "root" | "color";
  /** Excitation loudness of this voice (0..1). */
  brightness: number;
  /** Loop lowpass of this voice (0..1). */
  damping: number;
  /** Loop gain of this voice (0..1). */
  sustain: number;
  /** Pick-scrape level of this voice (0..1). */
  pick: number;
  /** Scrape brightness (0..1): dark/plosive lows → bright/snappy highs. */
  pickBright: number;
  /** Scrape length in ms (lows linger, highs snap). */
  pickDecayMs: number;
  /** Second one-pole loop loss — how fast high partials burn off (0..1). */
  decay: number;
  /** Host-side gain ramp in ms. */
  attackMs: number;
  /** Slow loop-wobble depth ("string life") for this voice (0..1, small). */
  lifeAmt: number;
  /** Body-thump "box hit" level (0..1); wound lows shake the box. */
  thump: number;
  /** Attack-bloom level (0..~0.35); high strings bloom deeper. */
  bloom: number;
}

/** Ring buffer of the most recent scheduled voices. Zero-cost unless read. */
const debugEvents: AudioDebugEvent[] = [];
const DEBUG_EVENTS_CAP = 128;
/**
 * Offline renders (a debug-harness feature) schedule the same voices but we
 * don't want them mixed into the live debug log — toggled off while rendering.
 */
let debugRecording = true;

/**
 * Debugging aid for `debug/audio-debug.html`. Every note scheduled by
 * `scheduleVoice` is appended here (bounded), so the harness can prove *how many*
 * voices were launched and when — independent of what the ear hears.
 */
export function getAudioDebugEvents(): AudioDebugEvent[] {
  return [...debugEvents];
}

function recordDebugEvent(event: AudioDebugEvent): void {
  if (!debugRecording) return;
  debugEvents.push(event);
  if (debugEvents.length > DEBUG_EVENTS_CAP) debugEvents.shift();
}

/**
 * Debugging aid for `debug/audio-debug.html`. Returns an AnalyserNode tapped
 * into the master bus (pre-compressor, so you see the real strum dynamics) and
 * wired to the destination so it hears live audio. No-op unless called, so it
 * adds nothing to the normal app path.
 */
export function debugTap(): AnalyserNode | null {
  void ensure();
  if (!context || !graph) return null;
  const analyser = context.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  analyser.connect(context.destination);
  graph.master.connect(analyser);
  return analyser;
}