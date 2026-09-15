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

/** One plucked string at `t`. `scoopCents` varies per note; `pan` is -1..1. */
function startVoice(
  freq: number,
  t: number,
  scoopCents: number,
  peak: number,
  cfg: PluckAudioConfig,
  pan: number,
): void {
  if (!ctx || !graph) return;
  const { freq: hz, jitter } = humanize(freq, cfg);
  const start = t + jitter;
  recordDebugEvent({ kind: "voice", t: start, freq: hz, peak, pan });

  // Per-note timbre spreads so not every string uses one identical sound.
  const brightness = clamp01(cfg.string.brightness + (Math.random() * 2 - 1) * cfg.variation.brightnessSpread);
  const damping = clamp01(cfg.string.damping + (Math.random() * 2 - 1) * cfg.variation.dampingSpread);
  const sustain = clamp01(cfg.string.sustain + (Math.random() * 2 - 1) * cfg.variation.sustainSpread);

  const node = new AudioWorkletNode(ctx, "pluck-string", {
    processorOptions: {
      freq: hz,
      sustain,
      brightness,
      damping,
      excitationMs: cfg.string.excitationMs,
      pickLevel: cfg.attack.pickLevel,
      pickMs: cfg.attack.pickMs,
      scoopCents,
      scoopMs: cfg.scoop.ms,
      ringFrames: Math.floor(ctx.sampleRate * ringSeconds(hz, cfg)),
    },
  });

  // Fade in over a few ms so the noise burst can't click; `peak` sets volume.
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.02, peak), start + 0.004);
  node.connect(g);
  // Pan spreads the strings across the stereo field (0 = center, e.g. piano).
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
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
    for (const { fret, s } of strings) {
      const freq = midiToFreq(tuning[s]! + fret!);
      // Downstroke: the treble strings sound first and the thick low string
      // last, one at a time like a hand moving across the fretboard.
      const off = (count - 1 - s) * gap + (Math.random() * 2 - 1) * jitter;
      // Low, thick strings get the attack bend; the rest strike clean.
      const scoop = s <= 1 ? cfg.scoop.cents : 0;
      const peak = cfg.micro.peak * (s === 0 ? cfg.balance.bassBoost : 1) * (count / 6) ** 0.5 + 0.06;
      // A hand doesn't hit every string at the same force.
      const vel = 1 + (Math.random() * 2 - 1) * cfg.variation.velocitySpread;
      // Bass strings go left, treble right, so voices separate in the stereo field.
      const pan = count > 1 ? ((s / (count - 1)) * 2 - 1) * cfg.panning.spread : 0;
      startVoice(freq, base + Math.max(0, off), scoop, peak * vel, cfg, pan);
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
      const freq = midiToFreq(midis[i]!);
      const peak = (cfg.micro.peak * (i === 0 ? 1.3 : 1) * (midis.length / 6) ** 0.5 + 0.06) * 0.9;
      startVoice(freq, base + i * roll, 0, peak, cfg, 0);
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