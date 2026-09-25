/**
 * smplr guitar engine (progress 21) — the sampled-guitar front door. One GM
 * steel-guitar kit (self-hosted `assets/guitar-steel-ogg.js`, the MusyngKite
 * `acoustic_guitar_steel`) is fetched ONCE (a once-caching wrapper around
 * smplr's storage) and then SIX Soundfont instances — one per string — each
 * decode it into a shared `SampleLoader` and write into their own
 * `[gate → stereo panner]` chain onto the app's master bus. The gate is ours
 * (holds silence from t=0, ramps at the note's strum slot), so the "one
 * sound" guard that protects the K–S and sample paths holds here too, and the
 * per-string instances give each string a fixed stereo seat (bass left →
 * treble right) the same way the synthesized voices do.
 *
 * Testability: `scripts/audio-sched.mjs` stubs Web Audio but not smplr, so the
 * audio graph assertions are run against OUR gate/panner nodes while a fake
 * smplr (via `globalThis.__SMPLR_FAKE__`) records the `start()` calls — notes,
 * per-string order, roles and times — as the ground truth.
 */

import type { PluckAudioConfig } from "./config.js";

// The app ships unbundled: tsc just compiles, and the browser resolves every
// specifier. `node_modules/` is never deployed, so smplr's self-contained ESM
// build is vendored at `assets/smplr.mjs` and imported by __module-relative__
// URL — the same trick the worklet module and the kit URL use, so it works
// from the root app AND the `/debug` harness AND the `/guitar-thing/` Pages
// subdirectory. (@ts-expect-error: the vendored build has no bundled types;
// the pieces this engine touches are typed by `KitInstrument` below.)
// @ts-expect-error — vendored smplr ESM, no bundled .d.ts
import * as realSmplr from "../../assets/smplr.mjs";

function lib(): typeof realSmplr {
  const fake = (globalThis as { __SMPLR_FAKE__?: typeof realSmplr }).__SMPLR_FAKE__;
  return fake ?? realSmplr;
}

/**
 * Site assets live beside `dist/` (repo root → `/assets/...` locally, under
 * `/guitar-thing/assets/...` on Pages). Resolving against the module's URL —
 * not the page — means `config.engine.kitUrl` works from the root app AND the
 * debug harness (which runs from `/debug/`), and survives the Pages subdir.
 */
const ASSET_BASE = new URL("../../", import.meta.url);

/** The parts of smplr's storage contract our wrapper touches. */
interface KitStorageFetch {
  fetch(url: string): Promise<{
    readonly status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

/**
 * smplr's Soundfont fetches the kit text per instance, so six per-string
 * instances would download ~2.6 MB six times. Wrapping the default storage to
 * fetch each URL once (caching the PROMISE, so parallel instances share one
 * request) keeps the kit to a single download. Buffer DECODE still happens per
 * instance (smplr decodes before it reaches the shared loader) — revisit with
 * a preset-first loader if the first-load cost ever shows.
 */
function onceFetchStore(inner: KitStorageFetch): KitStorageFetch {
  const cache = new Map<string, ReturnType<KitStorageFetch["fetch"]>>();
  return {
    fetch(url) {
      let p = cache.get(url);
      if (!p) {
        p = inner.fetch(url);
        cache.set(url, p);
      }
      return p;
    },
  };
}

/** The parts of a smplr instrument our engine touches (matches the real and
 *  the fake). `stopId` lets a single note be stopped without killing the
 *  whole string (each string is its own instrument instance). */
interface KitInstrument {
  start(opts: {
    note: number;
    velocity?: number;
    time?: number;
    duration?: number;
    stopId?: string | number;
  }): () => void;
  stop(stopId?: string | number): void;
  ready?: Promise<unknown>;
  load?: Promise<unknown>;
  loadProgress?: { loaded: number; total: number };
}

export interface SmplrPlayHandle {
  stop: () => void;
  timer: number;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function guitarPeak(params: { peak: number; engineGain: number }): number {
  return params.peak * params.engineGain;
}

export class SmplrGuitarEngine {
  /** Resolves once every string's kit is decoded and playable. */
  readonly ready: Promise<void>;
  /** Loaded/total samples across the six instances (for a progress bar). */
  readonly progress = { loaded: 0, total: 0 };

  private readonly instruments: KitInstrument[] = [];
  private readonly gates: GainNode[] = [];
  private nextStopId = 1;

  constructor(
    context: BaseAudioContext,
    master: AudioNode,
    private readonly config: PluckAudioConfig,
  ) {
    const { Soundfont, SampleLoader, HttpStorage } = lib() as {
      Soundfont: (context: BaseAudioContext, options: Record<string, unknown>) => unknown;
      SampleLoader: (context: BaseAudioContext, options?: Record<string, unknown>) => unknown;
      HttpStorage?: KitStorageFetch;
    };
    const loader = SampleLoader(context);
    const kit = new URL(config.engine.kitUrl, ASSET_BASE).href;
    // Whatever smplr does in parallel, the ~2.6 MB kit text is downloaded once.
    const storage = HttpStorage ? onceFetchStore(HttpStorage) : undefined;
    const spread = config.panning.spread;

    // One instrument per string. All share the same loader; each instance's
    // destination is its own gate → panner chain, giving every string a fixed
    // stereo seat into the master bus.
    const verses: Promise<unknown>[] = [];
    for (let stringIndex = 0; stringIndex < 6; stringIndex++) {
      const gate = context.createGain();
      gate.gain.value = 0.0001;
      const panner = context.createStereoPanner();
      // Fixed seat (unlike the synth's count-relative pan): the physical low
      // E always sits left, the high E right, spread by `config.panning.spread`.
      panner.pan.value = ((stringIndex / 5) * 2 - 1) * spread;
      const inst = Soundfont(context, {
        instrumentUrl: kit,
        loader,
        storage,
        volume: 127,
        destination: gate,
        onLoadProgress: ({ loaded, total }: { loaded: number; total: number }) => {
          this.progress.loaded = loaded;
          this.progress.total = total;
        },
      });
      const kitInst = inst as KitInstrument;
      this.instruments.push(kitInst);
      this.gates.push(gate);
      if (kitInst.ready) verses.push(kitInst.ready);
      else if (kitInst.load) verses.push(kitInst.load);
      gate.connect(panner);
      panner.connect(master);
    }
    this.ready = Promise.all(verses).then(() => undefined);
  }

  /**
   * Schedule one fretted note through its string's instrument. Returns a
   * per-note handle so the app can stop exactly this voice. `velocity` (0..127)
   * may be supplied by the caller so the debug log shows the same number the
   * sampler receives; otherwise it is derived from the roles like a synth
   * voice's peak.
   */
  play(midi: number, stringIndex: number, time: number, params: {
    peak: number;
    role: "root" | "color";
    attackMs: number;
    velocity?: number;
  }): SmplrPlayHandle {
    const inst = this.instruments[stringIndex];
    if (!inst) {
      return { stop: () => undefined, timer: 0 };
    }
    const stopId = this.nextStopId++;
    // Root louder, colors ride their role factor — the same `roles` that
    // accent the synthesized voices, here reaching the sampler's velocity.
    const roles = this.config.roles;
    const roleFactor = params.role === "root" ? roles.rootVel : roles.colorVel;
    const velocity = params.velocity ?? Math.round(
      clamp01((this.config.engine.velocity / 100) * roleFactor) * 127,
    );

    // Same one-sound guard as the worklet and sample paths: hold the gate
    // silent from t=0 and only open it at this note's strum slot. Because the
    // gate is shared per string, a RE-play on the same string re-arms it —
    // rapid repeated chords cut the previous note (fine: chords are
    // one-handed, and `stopAudio` silences everything anyway).
    const gate = this.gates[stringIndex];
    gate.gain.setValueAtTime(0.0001, 0);
    gate.gain.setValueAtTime(0.0001, time);
    gate.gain.exponentialRampToValueAtTime(
      Math.max(0.02, guitarPeak({ peak: params.peak, engineGain: this.config.engine.gain })),
      time + Math.max(0.002, this.config.engine.attackMs / 1000),
    );

    inst.start({ note: midi, velocity, time, stopId });
    return { stop: () => inst.stop(stopId), timer: 0 };
  }

  /** Silence every string's instrument (used by `stopAudio`). */
  stopAll(): void {
    for (const inst of this.instruments) inst.stop();
  }

  /** Tear down the chains (used when an offline render replaces the engine). */
  dispose(): void {
    this.stopAll();
  }
}

/**
 * Build the guitar engine for a context + master bus and start loading the
 * kit. Loading is asynchronous (`engine.ready`); notes scheduled before it
 * resolves are handled by the caller's fallback.
 */
export function createSmplrEngine(
  context: BaseAudioContext,
  master: AudioNode,
  config: PluckAudioConfig,
): SmplrGuitarEngine {
  return new SmplrGuitarEngine(context, master, config);
}