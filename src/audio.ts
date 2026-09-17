/**
 * Audio front door for the app. Keeps the same public API it always had
 * (`playVoicing`, `playNotes`, `stopAudio`) but now drives the Karplus–Strong
 * voice in `src/synth/`. See `synth/config.ts` for every tunable knob.
 */

import { DEFAULT_CONFIG, type PluckAudioConfig } from "./synth/config.js";
import { buildSharedGraph, type SharedGraph } from "./synth/shared.js";

const NOTE_START = 0.03;

let ctx: AudioContext | null = null;
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

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function ringSeconds(freq: number, cfg: PluckAudioConfig): number {
  return Math.max(0.8, (cfg.ring.baseMs - (cfg.ring.perKHzMs * freq) / 1000) / 1000);
}

function workletUrl(): URL {
  return new URL("./synth/pluck-worklet.js", import.meta.url);
}

/** Create the context + shared graph once; load the worklet module once. */
function ensure(): Promise<void> {
  if (!ctx) {
    ctx = new AudioContext();
    ctx.resume().catch(() => undefined);
    graph = buildSharedGraph(ctx, DEFAULT_CONFIG);
  } else if (ctx.state === "suspended") {
    ctx.resume().catch(() => undefined);
  }
  if (!workletReady) {
    workletReady = ctx.audioWorklet.addModule(workletUrl().href).catch((err) => {
      workletReady = null;
      throw err;
    });
  }
  return workletReady;
}

/** Humanize: random detune (cents) and a random start offset (ms). */
function humanize(freq: number, cfg: PluckAudioConfig): { freq: number; jitter: number } {
  const detune = (Math.random() * 2 - 1) * cfg.micro.detuneCents;
  return {
    freq: freq * Math.pow(2, detune / 1200),
    jitter: (Math.random() * cfg.micro.jitterMs) / 1000,
  };
}

/**
 * Per-note sound parameters, fully resolved before the note is scheduled.
 * `playVoicing` builds these from the systematic string `voices` + `roles`
 * tables; `playNotes` uses the piano path (plain random profile).
 */
interface VoiceParams {
  scoopCents: number;
  peak: number;
  /** Noise-burst loudness (0..1). */
  brightness: number;
  /** Loop lowpass (0..1). */
  damping: number;
  /** Loop gain per sample (0..1). */
  sustain: number;
  /** Pick-scrape transient level (0..1). */
  pick: number;
  /** Stereo pan -1..1. */
  pan: number;
  /** "root" when the note is the chord's root pitch class, else "color". */
  role: "root" | "color";
  /** Host-side gain ramp in ms: slow = bass thump, fast = treble snap. */
  attackMs: number;
  /** Optional per-string tone EQ (pickup voicing) applied before the volume stage. */
  eq?: { lowpassHz?: number; peakHz?: number; peakGainDb?: number; peakQ?: number };
}

/** One plucked string at `t`. */
function startVoice(freq: number, t: number, p: VoiceParams, cfg: PluckAudioConfig): void {
  if (!ctx || !graph) return;
  const { freq: hz, jitter } = humanize(freq, cfg);
  const start = t + jitter;
  recordDebugEvent({
    kind: "voice",
    t: start,
    freq: hz,
    peak: p.peak,
    pan: p.pan,
    role: p.role,
    brightness: p.brightness,
    damping: p.damping,
    sustain: p.sustain,
    pick: p.pick,
    attackMs: p.attackMs,
  });

  const node = new AudioWorkletNode(ctx, "pluck-string", {
    processorOptions: {
      freq: hz,
      sustain: p.sustain,
      brightness: p.brightness,
      damping: p.damping,
      excitationMs: cfg.string.excitationMs,
      pickLevel: p.pick,
      pickMs: cfg.attack.pickMs,
      scoopCents: p.scoopCents,
      scoopMs: cfg.scoop.ms,
      ringFrames: Math.floor(ctx.sampleRate * ringSeconds(hz, cfg)),
    },
  });

  // Each string gets its own pickup-style tone EQ before the volume stage,
  // so it rings with a genuinely different color — not just a brightness knob.
  let tail: AudioNode = node;
  if (p.eq) {
    if (p.eq.lowpassHz) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = p.eq.lowpassHz;
      f.Q.value = 0.7;
      tail.connect(f);
      tail = f;
    }
    if (p.eq.peakHz) {
      const f = ctx.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = p.eq.peakHz;
      f.gain.value = p.eq.peakGainDb ?? 0;
      f.Q.value = p.eq.peakQ ?? 1;
      tail.connect(f);
      tail = f;
    }
  }

  // Fade in over a few ms so the noise burst can't click; `peak` sets volume.
  // `attackMs` varies per string: bass strings thump in slow, treble snaps fast.
  // CRITICAL: a GainNode's AudioParam starts at 1.0, and an AudioWorkletNode
  // sounds the moment it is connected — so without zeroing the gain from the
  // very start, every voice leaks at full volume immediately and the whole
  // strum collapses into one simultaneous pluck. Hold silence until `start`.
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, 0);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.02, p.peak), start + Math.max(0.0002, p.attackMs / 1000));
  tail.connect(g);
  // Pan spreads the strings across the stereo field (0 = center, e.g. piano).
  const panner = ctx.createStereoPanner();
  panner.pan.value = p.pan;
  g.connect(panner);
  panner.connect(graph.voiceIn);

  const voice = { node, timer: 0 } as Voice;
  live.add(voice);
  voice.timer = setTimeout(() => freeVoice(voice), ringSeconds(hz, cfg) * 1000 + 60);
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

/** Pluck every sounding string of a voicing (muted strings skipped). */
export function playVoicing(frets: (number | null)[], tuning: number[]): void {
  const strings = frets.map((f, s) => ({ fret: f, s })).filter((x) => x.fret !== null);
  const cfg = DEFAULT_CONFIG;
  schedule(async () => {
    await ensure();
    const base = ctx!.currentTime + NOTE_START;
    const gap = cfg.strum.guitarMs / 1000;
    const jitter = cfg.strum.jitterMs / 1000;
    const count = strings.length;
    if (count === 0) return;
    // The chord's root is its lowest sounding pitch class, so `roles` accent
    // the same voice every time the same chord is played (no wiring needed).
    const rootPc = Math.min(...strings.map((x) => (tuning[x.s]! + x.fret!) % 12));
    // Downstroke: treble strings first, thick low string last, like a hand.
    const ordered = [...strings].sort((a, b) => b.s - a.s);
    for (let k = 0; k < ordered.length; k++) {
      const { fret, s } = ordered[k]!;
      const midi = tuning[s]! + fret!;
      const pc = midi % 12;
      const isRoot = pc === rootPc;
      const v = cfg.voices[s] ?? cfg.voices[0]!;
      const r = cfg.roles;
      const role: "root" | "color" = isRoot ? "root" : "color";
      // Hand-shaped spacing: burst out on treble, bloom into the bass.
      let pat = 0;
      for (let j = 0; j < k; j++) pat += cfg.strum.pattern[j] ?? 1;
      const off = gap * pat + (Math.random() * 2 - 1) * jitter;
      // A hand doesn't hit every string at the same force.
      const vel = 1 + (Math.random() * 2 - 1) * cfg.variation.velocitySpread;
      const peak =
        (cfg.micro.peak * (isRoot ? r.rootVel : r.colorVel) * (s === 0 ? cfg.balance.bassBoost : 1) * (count / 6) ** 0.5 + 0.06) *
        vel;
      // Bass strings go left, treble right, so voices separate in the stereo field.
      const pan = count > 1 ? ((s / (count - 1)) * 2 - 1) * cfg.panning.spread : 0;
      // Systematic identity: the string's fixed character, accented by its role,
      // with only a thin random sliver left over for humanity.
      const brightness = clamp01(v.brightness * (isRoot ? r.rootBright : r.colorBright) + (Math.random() * 2 - 1) * cfg.variation.brightnessSpread);
      const damping = clamp01(v.damping * (isRoot ? r.rootDamp : r.colorDamp) + (Math.random() * 2 - 1) * cfg.variation.dampingSpread);
      const sustain = clamp01(v.sustain + (isRoot ? r.rootSustainAdd : r.colorSustainAdd) + (Math.random() * 2 - 1) * cfg.variation.sustainSpread);
      const pick = clamp01(v.pick * (isRoot ? r.rootPick : r.colorPick));
      const scoop = v.scoopCents;
      startVoice(midiToFreq(midi), base + Math.max(0, off), { scoopCents: scoop, peak, brightness, damping, sustain, pick, pan, role, attackMs: v.attackMs, eq: v.eq }, cfg);
    }
  });
}

/** Pluck a set of MIDI keys together (piano voicing). */
export function playNotes(midis: number[]): void {
  if (midis.length === 0) return;
  const cfg = DEFAULT_CONFIG;
  schedule(async () => {
    await ensure();
    const base = ctx!.currentTime + NOTE_START;
    const roll = cfg.strum.pianoMs / 1000;
    for (let i = 0; i < midis.length; i++) {
      const peak = (cfg.micro.peak * (i === 0 ? 1.3 : 1) * (midis.length / 6) ** 0.5 + 0.06) * 0.9;
      const spread = cfg.variation;
      startVoice(
        midiToFreq(midis[i]!),
        base + i * roll,
        {
          scoopCents: 0,
          peak,
          brightness: clamp01(cfg.string.brightness + (Math.random() * 2 - 1) * spread.brightnessSpread),
          damping: clamp01(cfg.string.damping + (Math.random() * 2 - 1) * spread.dampingSpread),
          sustain: clamp01(cfg.string.sustain + (Math.random() * 2 - 1) * spread.sustainSpread),
          pick: cfg.attack.pickLevel,
          pan: 0,
          role: "color",
          attackMs: 3,
        },
        cfg,
      );
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
  t: number;
  /** Scheduled frequency in Hz (after random detune). */
  freq: number;
  /** Per-string peak amplitude. */
  peak: number;
  /** Stereo pan -1..1. */
  pan: number;
  /** "root" when the note is the chord's root pitch class, else "color". */
  role: "root" | "color";
  /** Noise-burst loudness of this voice (0..1). */
  brightness: number;
  /** Loop lowpass of this voice (0..1). */
  damping: number;
  /** Loop gain of this voice (0..1). */
  sustain: number;
  /** Pick-scrape level of this voice (0..1). */
  pick: number;
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

function recordDebugEvent(ev: AudioDebugEvent): void {
  debugEvents.push(ev);
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
  if (!ctx || !graph) return null;
  const a = ctx.createAnalyser();
  a.fftSize = 4096;
  a.smoothingTimeConstant = 0;
  a.connect(ctx.destination);
  graph.master.connect(a);
  return a;
}