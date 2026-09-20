/**
 * Audio front door for the app. Keeps the same public API it always had
 * (`playVoicing`, `playNotes`, `stopAudio`) but now drives the Karplus–Strong
 * voice in `src/synth/`. See `synth/config.ts` for every tunable knob.
 */

import { DEFAULT_CONFIG, type PluckAudioConfig } from "./synth/config.js";
import { buildSharedGraph, type SharedGraph } from "./synth/shared.js";

const NOTE_START = 0.03;

let context: AudioContext | null = null;
let graph: SharedGraph | null = null;
let workletReady: Promise<void> | null = null;

interface Voice {
  node: AudioWorkletNode;
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
   * Where along the string the pick strikes (0..1, from the bridge). Seeds the
   * K–S loop's initial displacement so this voice excites its own harmonics.
   */
  pickPos?: number;
  /**
   * Second one-pole loop loss (0..1) steepening the tail's high-partial decay,
   * so each string (wound vs plain) darkens along its own curve.
   */
  decay?: number;
  /** Optional per-string tone EQ (pickup voicing) applied before the volume stage. */
  eq?: { lowpassHz?: number; peakHz?: number; peakGainDb?: number; peakQ?: number };
}

/** One plucked string at `time`. */
function startVoice(frequency: number, time: number, params: VoiceParams, config: PluckAudioConfig): void {
  if (!context || !graph) return;
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

  const voice = { node, timer: 0 } as Voice;
  live.add(voice);
  voice.timer = setTimeout(() => freeVoice(voice), ringSeconds(hz, config) * 1000 + 60);
}

function freeVoice(voice: Voice): void {
  if (!live.delete(voice)) return;
  clearTimeout(voice.timer);
  sendStop(voice.node);
  voice.node.disconnect();
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
    const baseTime = context!.currentTime + NOTE_START;
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
        eq: voice.eq,
      };
      startVoice(midiToFreq(midi), baseTime + Math.max(0, offset), params, config);
    }
  });
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
      startVoice(midiToFreq(midi), base + keyIndex * roll, params, config);
    }
  });
}

/** Silences anything still ringing. */
export function stopAudio(): void {
  for (const voice of [...live]) {
    live.delete(voice);
    clearTimeout(voice.timer);
    sendStop(voice.node);
    voice.node.disconnect();
  }
}

export interface AudioDebugEvent {
  kind: "voice";
  /** Absolute schedule time on the AudioContext clock, seconds. */
  time: number;
  /** Scheduled frequency in Hz (after random detune). */
  freq: number;
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
}

/** Ring buffer of the most recent scheduled voices. Zero-cost unless read. */
const debugEvents: AudioDebugEvent[] = [];
const DEBUG_EVENTS_CAP = 128;

/**
 * Debugging aid for `debug/audio-debug.html`. Every note scheduled by
 * `startVoice` is appended here (bounded), so the harness can prove *how many*
 * voices were launched and when — independent of what the ear hears.
 */
export function getAudioDebugEvents(): AudioDebugEvent[] {
  return [...debugEvents];
}

function recordDebugEvent(event: AudioDebugEvent): void {
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